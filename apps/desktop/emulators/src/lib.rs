//! The emulators PartyLink runs games with, and how it starts them.
//!
//! Emulators are downloaded from their projects' own GitHub releases the first
//! time a player needs one, checked against a pinned SHA-256, and unpacked
//! into PartyLink's data folder. They run as separate programs; PartyLink only
//! passes them command-line options.
//!
//! The crate has no Tauri or network dependency so its tests run anywhere.
//! Downloading happens in the desktop app.

use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// An emulator PartyLink knows how to install and run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Emulator {
    /// The Mario Party Netplay build of Dolphin, for GameCube and Wii games.
    /// It adds command-line options to host and join netplay sessions.
    DolphinMpn,
}

impl Emulator {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "dolphin-mpn" => Some(Self::DolphinMpn),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::DolphinMpn => "dolphin-mpn",
        }
    }

    /// Downloads only ever come from this project's GitHub releases.
    fn release_base(self) -> &'static str {
        match self {
            Self::DolphinMpn => "https://github.com/MarioPartyNetplay/Dolphin-MPN/releases/download",
        }
    }

    pub fn exe_name(self) -> &'static str {
        match self {
            Self::DolphinMpn => "Dolphin-MPN.exe",
        }
    }
}

/// A specific release to install. The web app decides which release everyone
/// uses, so a whole party updates together; the desktop app only accepts
/// releases from the emulator's own project and checks the file's hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub emulator: Emulator,
    pub tag: String,
    pub asset: String,
    /// Lowercase hex SHA-256 of the asset.
    pub sha256: String,
}

#[derive(Debug)]
pub enum Error {
    BadRelease(&'static str),
    HashMismatch { expected: String, actual: String },
    Io(io::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::BadRelease(why) => write!(f, "That emulator release isn't allowed: {why}"),
            Error::HashMismatch { .. } => {
                write!(f, "The emulator download was damaged or changed. Please try again.")
            }
            Error::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<zip::result::ZipError> for Error {
    fn from(e: zip::result::ZipError) -> Self {
        Error::Io(io::Error::other(e))
    }
}

fn is_safe_name(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && !s.starts_with('.')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

impl Release {
    pub fn new(emulator: &str, tag: &str, asset: &str, sha256: &str) -> Result<Self, Error> {
        let emulator = Emulator::from_id(emulator).ok_or(Error::BadRelease("unknown emulator"))?;
        if !is_safe_name(tag, 40) {
            return Err(Error::BadRelease("bad tag"));
        }
        if !is_safe_name(asset, 100) || !asset.ends_with(".zip") {
            return Err(Error::BadRelease("bad file name"));
        }
        if sha256.len() != 64 || !sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
            return Err(Error::BadRelease("bad hash"));
        }
        Ok(Self { emulator, tag: tag.into(), asset: asset.into(), sha256: sha256.into() })
    }

    pub fn download_url(&self) -> String {
        format!("{}/{}/{}", self.emulator.release_base(), self.tag, self.asset)
    }

    /// Where this release is unpacked: `<root>/<emulator>/<tag>`.
    pub fn install_dir(&self, root: &Path) -> PathBuf {
        root.join(self.emulator.id()).join(&self.tag)
    }

    pub fn exe_path(&self, root: &Path) -> PathBuf {
        self.install_dir(root).join(self.emulator.exe_name())
    }

    /// True once the release has been fully unpacked and checked.
    pub fn is_installed(&self, root: &Path) -> bool {
        let dir = self.install_dir(root);
        fs::read_to_string(dir.join(INSTALLED_MARKER)).is_ok_and(|s| s.trim() == self.sha256)
            && dir.join(self.emulator.exe_name()).is_file()
    }
}

const INSTALLED_MARKER: &str = ".partylink-installed";

/// Lowercase hex SHA-256 of everything `reader` yields.
pub fn sha256_hex(reader: &mut impl Read) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Checks a downloaded release zip against its pinned hash and unpacks it.
/// Unpacks into a temporary folder first, so a failed or interrupted install
/// never leaves a half-written emulator behind.
pub fn install_from_zip(release: &Release, zip_path: &Path, root: &Path) -> Result<PathBuf, Error> {
    let actual = sha256_hex(&mut File::open(zip_path)?)?;
    if actual != release.sha256 {
        return Err(Error::HashMismatch { expected: release.sha256.clone(), actual });
    }

    let dest = release.install_dir(root);
    let staging = dest.with_extension("partial");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;

    let mut archive = zip::ZipArchive::new(File::open(zip_path)?)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        // enclosed_name rejects absolute paths and "..", so nothing lands outside the folder.
        let Some(relative) = entry.enclosed_name() else { continue };
        let out = staging.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent)?;
            }
            io::copy(&mut entry, &mut File::create(&out)?)?;
        }
    }
    if !staging.join(release.emulator.exe_name()).is_file() {
        fs::remove_dir_all(&staging)?;
        return Err(Error::Io(io::Error::other(format!(
            "The download doesn't contain {}.",
            release.emulator.exe_name()
        ))));
    }
    fs::write(staging.join(INSTALLED_MARKER), &release.sha256)?;

    if dest.exists() {
        fs::remove_dir_all(&dest)?;
    }
    fs::rename(&staging, &dest)?;
    Ok(dest)
}

// Dolphin ----------------------------------------------------------------------

/// Dolphin's traversal room codes are 8 letters and digits.
pub fn is_dolphin_host_code(text: &str) -> bool {
    text.len() == 8 && text.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Keeps names safe to pass as a `-C key=value` option.
fn clean_nickname(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
        .take(20)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() { "Player".into() } else { cleaned.into() }
}

/// Settings every PartyLink Dolphin launch uses. `-C` options apply to this
/// run only, so they never overwrite settings a player changed in Dolphin.
fn dolphin_common_args(user_dir: &Path, games_folder: &Path, nickname: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["-u".into(), user_dir.into()];
    let config = [
        // Skip the first-run question about sending usage statistics.
        "Dolphin.Analytics.PermissionAsked=True".to_string(),
        // Look for games in the player's folder, so joining finds the host's game.
        "Dolphin.General.ISOPaths=1".to_string(),
        format!("Dolphin.General.ISOPath0={}", games_folder.display()),
        "Dolphin.General.RecursiveISOPaths=True".to_string(),
        format!("Dolphin.NetPlay.Nickname={}", clean_nickname(nickname)),
        // Room codes through Dolphin's traversal server, so nobody needs to open router ports.
        "Dolphin.NetPlay.TraversalChoice=traversal".to_string(),
        // Keep the party private: don't list it in Dolphin's public session browser.
        "Dolphin.NetPlay.UseIndex=False".to_string(),
    ];
    for setting in config {
        args.push("-C".into());
        args.push(setting.into());
    }
    args
}

/// Options to open `game` and host a netplay session for it.
pub fn dolphin_host_args(user_dir: &Path, games_folder: &Path, nickname: &str, game: &Path) -> Vec<OsString> {
    let mut args = dolphin_common_args(user_dir, games_folder, nickname);
    // In traversal mode Dolphin-MPN treats this port as the traversal server's
    // port, so it must be the server's default (6262), not a listen port.
    args.extend(["--netplay_host".into(), "6262".into(), "-e".into(), game.into()]);
    args
}

/// Options to join a netplay session by its room code.
pub fn dolphin_join_args(user_dir: &Path, games_folder: &Path, nickname: &str, code: &str) -> Vec<OsString> {
    let mut args = dolphin_common_args(user_dir, games_folder, nickname);
    args.extend(["--netplay_join".into(), code.into()]);
    args
}

/// A starting GameCube controller setup: an Xbox-style controller as player 1.
/// Written only if the player has no controller settings yet.
pub const DOLPHIN_GCPAD_INI: &str = "\
[GCPad1]
Device = XInput/0/Gamepad
Buttons/A = `Button A`
Buttons/B = `Button B`
Buttons/X = `Button X`
Buttons/Y = `Button Y`
Buttons/Z = `Shoulder R`
Buttons/Start = Start
Main Stick/Up = `Left Y+`
Main Stick/Down = `Left Y-`
Main Stick/Left = `Left X-`
Main Stick/Right = `Left X+`
C-Stick/Up = `Right Y+`
C-Stick/Down = `Right Y-`
C-Stick/Left = `Right X-`
C-Stick/Right = `Right X+`
Triggers/L = `Trigger L`
Triggers/R = `Trigger R`
Triggers/L-Analog = `Trigger L`
Triggers/R-Analog = `Trigger R`
D-Pad/Up = `Pad N`
D-Pad/Down = `Pad S`
D-Pad/Left = `Pad W`
D-Pad/Right = `Pad E`
Rumble/Motor = `Motor L` | `Motor R`
";

/// Creates Dolphin's user folder and a default controller file if there isn't one.
pub fn prepare_dolphin_user_dir(user_dir: &Path) -> io::Result<()> {
    let config = user_dir.join("Config");
    fs::create_dir_all(&config)?;
    let pad = config.join("GCPadNew.ini");
    if !pad.exists() {
        fs::write(pad, DOLPHIN_GCPAD_INI)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
