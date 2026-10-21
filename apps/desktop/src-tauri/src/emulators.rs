// Installing and starting emulators. The web app says which release the
// party uses and when to start; this side checks everything it's given,
// downloads from the emulator project's own releases, and runs the emulator
// as a separate program.

use crate::games::{games_folder, scan_cache_path};
use partylink_emulators::{self as emu, Release};
use partylink_scanner::{ScanCache, System};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Default)]
pub struct EmulatorState {
    installing: Mutex<HashSet<String>>,
    /// Emulators PartyLink started that are still open, so the app can close them.
    running: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    /// The room code the host's Mupen-MPN printed, once it has made a room.
    mupen_code: Arc<Mutex<Option<String>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseArg {
    emulator: String,
    tag: String,
    asset: String,
    sha256: String,
}

impl ReleaseArg {
    fn parse(&self) -> Result<Release, String> {
        Release::new(&self.emulator, &self.tag, &self.asset, &self.sha256).map_err(|e| e.to_string())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress<'a> {
    emulator: &'a str,
    phase: &'a str,
    done: u64,
    total: Option<u64>,
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("emulators"))
}

#[tauri::command]
pub fn emulator_installed(app: AppHandle, release: ReleaseArg) -> Result<bool, String> {
    Ok(release.parse()?.is_installed(&root(&app)?))
}

/// Downloads and unpacks a release, sending "emulator-install-progress" events.
#[tauri::command]
pub async fn install_emulator(
    app: AppHandle,
    state: State<'_, EmulatorState>,
    release: ReleaseArg,
) -> Result<(), String> {
    let release = release.parse()?;
    let root = root(&app)?;
    if release.is_installed(&root) {
        return Ok(());
    }
    if !state.installing.lock().unwrap().insert(release.emulator.id().to_string()) {
        return Err("This emulator is already being installed.".into());
    }
    let result = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let release = release.clone();
        move || download_and_install(&app, &release, &root)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    state.installing.lock().unwrap().remove(release.emulator.id());
    result
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .tls_config(ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).build())
        .timeout_connect(Some(Duration::from_secs(20)))
        .build()
        .into()
}

fn download_and_install(app: &AppHandle, release: &Release, root: &std::path::Path) -> Result<(), String> {
    let id = release.emulator.id();
    let downloads = root.join("downloads");
    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    let zip_path = downloads.join(&release.asset);

    let response =
        http_agent().get(&release.download_url()).call().map_err(|e| format!("Couldn't download the emulator: {e}"))?;
    let total = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
    let mut body = response.into_body().into_reader();
    let mut file = File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 16];
    let mut done = 0u64;
    let mut last_event = Instant::now() - Duration::from_secs(1);
    loop {
        let n = body.read(&mut buf).map_err(|e| format!("The download was interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last_event.elapsed() >= Duration::from_millis(200) {
            last_event = Instant::now();
            let _ =
                app.emit("emulator-install-progress", InstallProgress { emulator: id, phase: "download", done, total });
        }
    }
    drop(file);

    let _ = app.emit("emulator-install-progress", InstallProgress { emulator: id, phase: "unpack", done, total });
    let result = emu::install_from_zip(release, &zip_path, root).map(|_| ()).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&zip_path);
    result
}

/// Dolphin needs Microsoft's Visual C++ runtime, which most but not all PCs have.
#[tauri::command]
pub fn needs_vc_runtime() -> bool {
    if !cfg!(windows) {
        return false;
    }
    let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let dir = system.join("System32");
    !["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"].iter().all(|dll| dir.join(dll).is_file())
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum DolphinLaunch {
    /// Open the game with this fingerprint and host a netplay session.
    Host { sha1: String },
    /// Join the session with this room code.
    Join { code: String },
}

#[tauri::command]
pub fn launch_dolphin(
    app: AppHandle,
    state: State<'_, EmulatorState>,
    release: ReleaseArg,
    launch: DolphinLaunch,
    nickname: String,
) -> Result<(), String> {
    let release = release.parse()?;
    if release.emulator != emu::Emulator::DolphinMpn {
        return Err("That isn't Dolphin.".into());
    }
    let root = root(&app)?;
    if !release.is_installed(&root) {
        return Err("Dolphin isn't installed yet.".into());
    }
    let folder = games_folder(&app).ok_or("Choose your games folder first.")?;
    let user_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("dolphin-user");
    emu::prepare_dolphin_user_dir(&user_dir).map_err(|e| e.to_string())?;

    let args = match launch {
        DolphinLaunch::Host { sha1 } => {
            let game = find_game(&app, &sha1)?;
            if !matches!(game.system, System::Gc | System::Wii) {
                return Err("Dolphin only runs GameCube and Wii games.".into());
            }
            emu::dolphin_host_args(&user_dir, folder.as_ref(), &nickname, game.path.as_ref())
        }
        DolphinLaunch::Join { code } => {
            if !emu::is_dolphin_host_code(&code) {
                return Err("That isn't a Dolphin room code.".into());
            }
            emu::dolphin_join_args(&user_dir, folder.as_ref(), &nickname, &code)
        }
    };

    spawn_emulator(app, &state, &release, &root, "Dolphin", args, None)
}

/// Called with each line an emulator prints to its error output.
type LineHandler = Box<dyn Fn(&str) + Send>;

/// Starts the emulator and sends "emulator-exited" when it closes.
fn spawn_emulator(
    app: AppHandle,
    state: &EmulatorState,
    release: &Release,
    root: &Path,
    name: &str,
    args: Vec<OsString>,
    on_stderr_line: Option<LineHandler>,
) -> Result<(), String> {
    let id = release.emulator.id().to_string();
    let mut running = state.running.lock().unwrap();
    if running.contains_key(&id) {
        return Err(format!("{name} is already open. Close it to start again."));
    }
    let mut command = Command::new(release.exe_path(root));
    command.args(args).current_dir(release.install_dir(root));
    if on_stderr_line.is_some() {
        command.stderr(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|e| format!("Couldn't start {name}: {e}"))?;
    if let (Some(handler), Some(stderr)) = (on_stderr_line, child.stderr.take()) {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                handler(&line);
            }
        });
    }
    let child = Arc::new(Mutex::new(child));
    running.insert(id.clone(), child.clone());
    drop(running);
    let running = state.running.clone();
    std::thread::spawn(move || {
        // Checked now and then rather than waited on, so close_emulator can take the lock.
        while matches!(child.lock().unwrap().try_wait(), Ok(None)) {
            std::thread::sleep(Duration::from_millis(250));
        }
        // An emulator the app closed itself was already taken off the list,
        // maybe with a new one opened in its place, and its exit isn't news.
        let mut running = running.lock().unwrap();
        if running.get(&id).is_some_and(|c| Arc::ptr_eq(c, &child)) {
            running.remove(&id);
            drop(running);
            let _ = app.emit("emulator-exited", id);
        }
    });
    Ok(())
}

/// Closes an emulator PartyLink opened, such as the host's RetroArch when it
/// has to reopen through a relay server.
#[tauri::command]
pub fn close_emulator(state: State<'_, EmulatorState>, emulator: String) -> Result<(), String> {
    let child = state.running.lock().unwrap().remove(&emulator);
    if let Some(child) = child {
        let mut child = child.lock().unwrap();
        // It may have closed on its own a moment ago.
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn find_game(app: &AppHandle, sha1: &str) -> Result<partylink_scanner::GameFile, String> {
    let cache = ScanCache::load(&scan_cache_path(app)?);
    cache.find_by_sha1(sha1).cloned().ok_or_else(|| "That game isn't in your games folder any more. Try Rescan.".into())
}

#[tauri::command]
pub fn emulator_running(state: State<'_, EmulatorState>, emulator: String) -> bool {
    state.running.lock().unwrap().contains_key(&emulator)
}

/// The host clicks Copy next to the room code in Dolphin; the web app polls
/// this to pick the code up from the clipboard and send it to the party.
#[tauri::command]
pub fn read_dolphin_room_code(app: AppHandle) -> Option<String> {
    let text = app.clipboard().read_text().ok()?;
    let text = text.trim();
    emu::is_dolphin_host_code(text).then(|| text.to_string())
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum RetroArchLaunch {
    /// Open the game with this fingerprint and host it, directly (`relay` is
    /// `direct`) or through a relay server.
    Host { sha1: String, relay: String, password: String },
    /// Open this player's copy of the game and join the host with their join
    /// code. `near` is set when the room is on the party's own nearby relay.
    Join {
        sha1: String,
        code: String,
        #[serde(default)]
        near: bool,
    },
}

fn retroarch_core(system: System) -> Option<emu::Core> {
    match system {
        System::Ps1 => Some(emu::Core::PcsxRearmed),
        System::Snes => Some(emu::Core::Snes9x),
        System::Nes => Some(emu::Core::Fceumm),
        System::Md => Some(emu::Core::GenesisPlusGx),
        _ => None,
    }
}

#[tauri::command]
pub fn launch_retroarch(
    app: AppHandle,
    state: State<'_, EmulatorState>,
    release: ReleaseArg,
    launch: RetroArchLaunch,
    nickname: String,
    players: usize,
) -> Result<(), String> {
    let release = release.parse()?;
    if release.emulator != emu::Emulator::RetroArch {
        return Err("That isn't RetroArch.".into());
    }
    let root = root(&app)?;
    if !release.is_installed(&root) {
        return Err("RetroArch isn't installed yet.".into());
    }
    let install_dir = release.install_dir(&root);
    let user_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("retroarch-user");

    let (sha1, host, password, join, near_relay) = match &launch {
        RetroArchLaunch::Host { sha1, relay, password } => {
            let via = emu::HostVia::from_id(relay).ok_or("Unknown relay server.")?;
            let near = matches!(via, emu::HostVia::OwnRelay { .. });
            (sha1, Some(via), password.clone(), None, near)
        }
        RetroArchLaunch::Join { sha1, code, near } => {
            let join = emu::JoinCode::parse(code).ok_or("That isn't a RetroArch join code.")?;
            (sha1, None, join.password.clone(), Some(join.room), *near)
        }
    };
    let game = find_game(&app, sha1)?;
    let core = retroarch_core(game.system).ok_or("PartyLink can't play that console's games with RetroArch.")?;
    emu::prepare_retroarch_session(&emu::RetroSession {
        install_dir: &install_dir,
        user_dir: &user_dir,
        nickname: &nickname,
        password: &password,
        players,
        host,
        near_relay,
    })
    .map_err(|e| e.to_string())?;

    let game_path = Path::new(&game.path);
    let args = match &join {
        None => emu::retroarch_host_args(&install_dir, &user_dir, core, game_path),
        Some(room) => emu::retroarch_join_args(&install_dir, &user_dir, core, game_path, room),
    };
    spawn_emulator(app, &state, &release, &root, "RetroArch", args, None)
}

/// The host's relay room as `host|port|session`, once RetroArch has announced
/// it to libretro's lobby, or None while it hasn't yet. The web app adds the
/// room password to make the join code it sends friends.
#[tauri::command]
pub async fn find_retroarch_room(nickname: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let body = read_lobby()?;
        Ok(emu::find_relay_room(&body, &nickname).map(|r| format!("{}|{}|{}", r.host, r.port, r.session)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The host's room as libretro's lobby lists it, once RetroArch has announced it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyRoomOut {
    /// `host|port|session`, with an empty session for a direct room.
    room: String,
    direct: bool,
    /// Whether the lobby could reach the room.
    connectable: bool,
    /// New each time a room opens, to tell a new room from an earlier game's.
    id: u64,
}

/// Like find_retroarch_room, but also finds direct rooms and says whether
/// friends can reach them.
#[tauri::command]
pub async fn find_retroarch_lobby_room(nickname: String) -> Result<Option<LobbyRoomOut>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let body = read_lobby()?;
        Ok(emu::find_lobby_room(&body, &nickname).map(|found| LobbyRoomOut {
            room: format!("{}|{}|{}", found.room.host, found.room.port, found.room.session),
            direct: found.room.is_direct(),
            connectable: found.connectable,
            id: found.id,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether the party's own relay server (`own:<host>:<port>`) is switched on and
/// taking connections, so the host only uses it when it's there.
#[tauri::command]
pub async fn relay_reachable(relay: String) -> Result<bool, String> {
    let Some(emu::HostVia::OwnRelay { host, port }) = emu::HostVia::from_id(&relay) else {
        return Err("That isn't a relay server address.".into());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(addresses) = (host.as_str(), port).to_socket_addrs() else { return false };
        addresses.into_iter().any(|a| TcpStream::connect_timeout(&a, Duration::from_secs(3)).is_ok())
    })
    .await
    .map_err(|e| e.to_string())
}

fn read_lobby() -> Result<String, String> {
    http_agent()
        // The lobby only answers plain http; its https address doesn't connect.
        .get("http://lobby.libretro.com/list/")
        .call()
        .map_err(|e| format!("Couldn't reach RetroArch's lobby: {e}"))?
        .into_body()
        .read_to_string()
        .map_err(|e| e.to_string())
}

/// Opens Mupen-MPN for N64 games. Netplay happens in its Online Play window;
/// PartyLink fills in the player's settings and picks up the host's room code.
#[tauri::command]
pub fn launch_mupen(
    app: AppHandle,
    state: State<'_, EmulatorState>,
    release: ReleaseArg,
    nickname: String,
) -> Result<(), String> {
    let release = release.parse()?;
    if release.emulator != emu::Emulator::MupenMpn {
        return Err("That isn't Mupen-MPN.".into());
    }
    let root = root(&app)?;
    if !release.is_installed(&root) {
        return Err("Mupen-MPN isn't installed yet.".into());
    }
    let folder = games_folder(&app).ok_or("Choose your games folder first.")?;
    let user_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("mupen-user");
    emu::prepare_mupen(&release.install_dir(&root), &user_dir, folder.as_ref(), &nickname)
        .map_err(|e| e.to_string())?;

    *state.mupen_code.lock().unwrap() = None;
    let code = state.mupen_code.clone();
    let on_line = Box::new(move |line: &str| {
        if let Some(found) = emu::parse_mupen_host_code(line) {
            *code.lock().unwrap() = Some(found);
        }
    });
    spawn_emulator(app, &state, &release, &root, "Mupen-MPN", emu::mupen_args(&user_dir), Some(on_line))
}

/// The host's Mupen-MPN room code: what Mupen printed when the room was
/// made, or failing that, a code the host copied with Mupen's Copy button.
#[tauri::command]
pub fn read_mupen_room_code(app: AppHandle, state: State<'_, EmulatorState>) -> Option<String> {
    if let Some(code) = state.mupen_code.lock().unwrap().clone() {
        return Some(code);
    }
    let text = app.clipboard().read_text().ok()?;
    let text = text.trim();
    emu::is_mupen_host_code(text).then(|| text.to_ascii_uppercase())
}

/// Puts the host's room code on a friend's clipboard, ready to paste into Mupen-MPN.
#[tauri::command]
pub fn copy_mupen_room_code(app: AppHandle, code: String) -> Result<(), String> {
    if !emu::is_mupen_host_code(&code) {
        return Err("That isn't a Mupen-MPN room code.".into());
    }
    app.clipboard().write_text(code).map_err(|e| e.to_string())
}
