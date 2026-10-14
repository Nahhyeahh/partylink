// RetroArch ---------------------------------------------------------------------
//
// RetroArch runs PS1, SNES, NES and Mega Drive games through "cores". Netplay
// goes through libretro's relay servers, so nobody needs to open router
// ports. A relay session's ID is only published to libretro's lobby list, so
// the host's room is announced there with a password only the party knows,
// and the host's app reads the relay details back from the list.

use crate::clean_nickname;
use serde_json::Value;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The RetroArch cores PartyLink uses. All are in the packed release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Core {
    /// PS1. Deterministic, so it works for netplay, and has a built-in BIOS.
    PcsxRearmed,
    Snes9x,
    Fceumm,
    GenesisPlusGx,
}

impl Core {
    pub fn dll(self) -> &'static str {
        match self {
            Self::PcsxRearmed => "pcsx_rearmed_libretro.dll",
            Self::Snes9x => "snes9x_libretro.dll",
            Self::Fceumm => "fceumm_libretro.dll",
            Self::GenesisPlusGx => "genesis_plus_gx_libretro.dll",
        }
    }
}

/// libretro's relay servers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relay {
    NewYork,
    Madrid,
    SaoPaulo,
    Singapore,
}

impl Relay {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "nyc" => Some(Self::NewYork),
            "madrid" => Some(Self::Madrid),
            "saopaulo" => Some(Self::SaoPaulo),
            "singapore" => Some(Self::Singapore),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::NewYork => "nyc",
            Self::Madrid => "madrid",
            Self::SaoPaulo => "saopaulo",
            Self::Singapore => "singapore",
        }
    }
}

/// Where friends connect to reach the host: a relay server and the host's session on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayRoom {
    pub host: String,
    pub port: u16,
    /// Base64, as RetroArch's `--mitm-session` expects.
    pub session: String,
}

impl RelayRoom {
    fn is_valid(&self) -> bool {
        !self.host.is_empty()
            && self.host.len() <= 64
            && self.host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
            && self.port != 0
            && !self.session.is_empty()
            && self.session.len() <= 64
            && self.session.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
    }
}

/// What the host's app sends friends: the relay room plus the room password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinCode {
    pub room: RelayRoom,
    pub password: String,
}

/// Room passwords are made by the host's app: 8 to 32 letters and digits.
pub fn is_room_password(text: &str) -> bool {
    (8..=32).contains(&text.len()) && text.chars().all(|c| c.is_ascii_alphanumeric())
}

impl JoinCode {
    /// Reads `host|port|session|password`.
    pub fn parse(code: &str) -> Option<Self> {
        let mut parts = code.split('|');
        let (host, port, session, password) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let room = RelayRoom { host: host.into(), port: port.parse().ok()?, session: session.into() };
        (room.is_valid() && is_room_password(password)).then(|| Self { room, password: password.into() })
    }

    pub fn to_code(&self) -> String {
        format!("{}|{}|{}|{}", self.room.host, self.room.port, self.room.session, self.password)
    }
}

fn str_field<'a>(fields: &'a Value, key: &str) -> &'a str {
    fields.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Finds the host's room in libretro's lobby list (http://lobby.libretro.com/list/):
/// the newest relayed, password-protected room under the host's nickname.
pub fn find_relay_room(lobby_json: &str, nickname: &str) -> Option<RelayRoom> {
    let nickname = clean_nickname(nickname);
    let list: Vec<Value> = serde_json::from_str(lobby_json).ok()?;
    list.iter()
        .filter_map(|entry| entry.get("fields"))
        .filter(|f| str_field(f, "username") == nickname)
        .filter(|f| f.get("has_password").and_then(Value::as_bool) == Some(true))
        .filter_map(|f| {
            let port = f.get("mitm_port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok())?;
            let room =
                RelayRoom { host: str_field(f, "mitm_ip").into(), port, session: str_field(f, "mitm_session").into() };
            room.is_valid().then(|| (str_field(f, "updated").to_string(), room))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, room)| room)
}

/// What a netplay session needs; every player's app writes the same settings
/// except for the nickname, because netplay only works if every copy of the
/// game runs identically.
pub struct RetroSession<'a> {
    pub install_dir: &'a Path,
    pub user_dir: &'a Path,
    pub nickname: &'a str,
    pub password: &'a str,
    /// Players in the party, which decides whether a PS1 multitap is plugged in.
    pub players: usize,
    /// Set for the host: the relay server to host through.
    pub host_relay: Option<Relay>,
}

fn cfg_line(key: &str, value: impl std::fmt::Display) -> String {
    format!("{key} = \"{value}\"\n")
}

fn path_str(path: &Path) -> String {
    path.display().to_string()
}

/// Settings that stay with the player across games: where saves go. Written
/// only if missing so anything the player changes is kept.
const MAIN_CONFIG: &str = "retroarch.cfg";
const SESSION_CONFIG: &str = "partylink-session.cfg";
const CORE_OPTIONS: &str = "partylink-core-options.cfg";

/// Writes RetroArch's settings for one session into the player's RetroArch
/// folder (separate from the install, so updating RetroArch keeps saves).
pub fn prepare_retroarch_session(session: &RetroSession) -> io::Result<()> {
    if !is_room_password(session.password) {
        return Err(io::Error::other("bad room password"));
    }
    let user = session.user_dir;
    for dir in ["system", "saves", "states"] {
        fs::create_dir_all(user.join(dir))?;
    }
    let main = user.join(MAIN_CONFIG);
    if !main.exists() {
        let text = [
            cfg_line("system_directory", path_str(&user.join("system"))),
            cfg_line("savefile_directory", path_str(&user.join("saves"))),
            cfg_line("savestate_directory", path_str(&user.join("states"))),
            cfg_line("video_fullscreen", "false"),
        ]
        .concat();
        fs::write(main, text)?;
    }

    // Core options every player shares. The built-in PS1 BIOS keeps everyone
    // identical even if someone has a real BIOS file, and the multitap lets
    // 3 or 4 players join games that support it (like Crash Bash).
    let multitap = if session.players >= 3 { "port 1" } else { "disabled" };
    fs::write(
        user.join(CORE_OPTIONS),
        [cfg_line("pcsx_rearmed_bios", "HLE"), cfg_line("pcsx_rearmed_multitap", multitap)].concat(),
    )?;

    let host = session.host_relay.is_some();
    let mut text = vec![
        // Don't fold this session's settings (like the password) into retroarch.cfg.
        cfg_line("config_save_on_exit", "false"),
        cfg_line("libretro_directory", path_str(&session.install_dir.join("cores"))),
        cfg_line("libretro_info_path", path_str(&session.install_dir.join("info"))),
        cfg_line("core_options_path", path_str(&user.join(CORE_OPTIONS))),
        cfg_line("global_core_options", "true"),
        cfg_line("game_specific_options", "false"),
        cfg_line("check_firmware_before_loading", "false"),
        // Keep running while another window (like PartyLink) has focus.
        cfg_line("pause_nonactive", "false"),
        cfg_line("netplay_nickname", clean_nickname(session.nickname)),
        cfg_line("netplay_password", session.password),
        cfg_line("netplay_spectate_password", ""),
        cfg_line("netplay_start_as_spectator", "false"),
        cfg_line("netplay_nat_traversal", "false"),
        // Only the host announces, so its app can read the relay session back.
        cfg_line("netplay_public_announce", host),
        cfg_line("netplay_use_mitm_server", host),
    ];
    if let Some(relay) = session.host_relay {
        text.push(cfg_line("netplay_mitm_server", relay.id()));
    }
    fs::write(user.join(SESSION_CONFIG), text.concat())
}

fn retroarch_common_args(install_dir: &Path, user_dir: &Path, core: Core) -> Vec<OsString> {
    vec![
        "-L".into(),
        install_dir.join("cores").join(core.dll()).into(),
        "--config".into(),
        user_dir.join(MAIN_CONFIG).into(),
        "--appendconfig".into(),
        user_dir.join(SESSION_CONFIG).into(),
    ]
}

/// Options to open `game` and host it through the relay set in the session.
pub fn retroarch_host_args(install_dir: &Path, user_dir: &Path, core: Core, game: &Path) -> Vec<OsString> {
    let mut args = retroarch_common_args(install_dir, user_dir, core);
    args.extend(["-H".into(), game.into()]);
    args
}

/// Options to open the player's own copy of `game` and join the host's relay room.
pub fn retroarch_join_args(
    install_dir: &Path,
    user_dir: &Path,
    core: Core,
    game: &Path,
    room: &RelayRoom,
) -> Vec<OsString> {
    let mut args = retroarch_common_args(install_dir, user_dir, core);
    args.extend([
        "-C".into(),
        room.host.clone().into(),
        "--port".into(),
        room.port.to_string().into(),
        "--mitm-session".into(),
        room.session.clone().into(),
        game.into(),
    ]);
    args
}

/// The player's RetroArch settings folder, given PartyLink's data folder.
pub fn retroarch_user_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("retroarch-user")
}
