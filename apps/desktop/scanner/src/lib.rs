//! Finds game files in a folder and fingerprints them.
//!
//! PartyLink never ships or downloads games. Each player points the app at
//! their own games folder, and this crate works out which console each file is
//! for and computes its SHA-1. Two players can only play together over netplay
//! when their files are identical, so the lobby compares these fingerprints,
//! and the web app looks them up in the No-Intro and Redump lists to show
//! proper names.
//!
//! The crate has no Tauri dependency so its tests run on any machine.

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Consoles PartyLink knows how to run. The ids match `GameSystem` in
/// packages/protocol and the file names in apps/web/public/gamedb.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum System {
    Gc,
    Wii,
    N64,
    Ps1,
    Snes,
    Nes,
    Gba,
    Md,
}

/// One playable game found in the folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameFile {
    /// The file an emulator should open (a .cue for disc games split into tracks).
    pub path: String,
    pub file_name: String,
    pub system: System,
    /// Size in bytes of the fingerprinted data.
    pub size: u64,
    /// Lowercase hex SHA-1 of the game data. For a .cue this is the first
    /// track's .bin, and for a .zip it is the file inside, matching how the
    /// No-Intro and Redump lists record them.
    pub sha1: String,
    /// GameCube and Wii only: the 6-character disc id (such as GMPE01) and revision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disc_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disc_revision: Option<u8>,
    /// GameCube and Wii only: the title stored on the disc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disc_title: Option<String>,
}

/// Remembers fingerprints between scans, keyed by path, so unchanged files
/// (some are several gigabytes) are not hashed again.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ScanCache {
    entries: HashMap<String, CacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    size: u64,
    modified: u64,
    game: Option<GameFile>,
}

impl ScanCache {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, serde_json::to_vec(self)?)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub games: Vec<GameFile>,
    /// Files with a game-like extension that could not be read or recognised.
    pub skipped: Vec<String>,
}

const MAX_DEPTH: usize = 6;

const EXTENSIONS: &[&str] = &[
    "iso", "gcm", "rvz", "wia", "wbfs", "z64", "n64", "v64", "cue", "bin", "sfc", "smc", "nes",
    "gba", "md", "gen", "zip",
];

/// Scans `folder` and its subfolders for games.
pub fn scan(folder: &Path, cache: &mut ScanCache, mut progress: impl FnMut(&Progress)) -> io::Result<ScanResult> {
    if !folder.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "The games folder doesn't exist."));
    }

    let candidates: Vec<PathBuf> = walkdir::WalkDir::new(folder)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| extension(path).is_some_and(|ext| EXTENSIONS.contains(&ext.as_str())))
        .collect();

    // Track files listed by a .cue are opened through the .cue, not on their own.
    let mut tracks = HashSet::new();
    for path in candidates.iter().filter(|p| extension(p).as_deref() == Some("cue")) {
        if let Ok(files) = cue_files(path) {
            tracks.extend(files.into_iter().map(|f| normalize(&f)));
        }
    }

    let total = candidates.len();
    let mut games = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = HashSet::new();

    for (index, path) in candidates.iter().enumerate() {
        progress(&Progress { done: index, total, current: file_name(path) });
        if tracks.contains(&normalize(path)) {
            continue;
        }
        let key = path.to_string_lossy().into_owned();
        seen.insert(key.clone());
        let Ok(meta) = std::fs::metadata(path) else {
            skipped.push(key);
            continue;
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());

        let game = match cache.entries.get(&key) {
            Some(entry) if entry.size == meta.len() && entry.modified == modified => entry.game.clone(),
            _ => {
                let game = identify(path).unwrap_or(None);
                cache.entries.insert(key.clone(), CacheEntry { size: meta.len(), modified, game: game.clone() });
                game
            }
        };
        match game {
            Some(game) => games.push(game),
            None => skipped.push(key),
        }
    }
    progress(&Progress { done: total, total, current: String::new() });

    // Forget files that are gone so the cache doesn't grow forever.
    cache.entries.retain(|path, _| seen.contains(path));
    games.sort_by_key(|game| game.file_name.to_lowercase());
    Ok(ScanResult { games, skipped })
}

/// Works out whether `path` is a game PartyLink can run, and fingerprints it.
/// Returns `Ok(None)` for files that aren't games for a supported console.
pub fn identify(path: &Path) -> io::Result<Option<GameFile>> {
    let Some(ext) = extension(path) else { return Ok(None) };
    let found = match ext.as_str() {
        "iso" | "gcm" => identify_disc_image(path)?,
        "rvz" | "wia" => identify_wia(path)?,
        "wbfs" => identify_wbfs(path)?,
        "z64" | "n64" | "v64" => {
            let head = read_at(path, 0, 4)?;
            is_n64(&head).then(|| plain(path, System::N64)).transpose()?
        }
        "cue" => identify_cue(path)?,
        "bin" => {
            if is_ps1_track(path)? {
                Some(plain(path, System::Ps1)?)
            } else if is_mega_drive(path)? {
                Some(plain(path, System::Md)?)
            } else {
                None
            }
        }
        "sfc" | "smc" => Some(plain(path, System::Snes)?),
        "nes" => (read_at(path, 0, 4)? == b"NES\x1a").then(|| plain(path, System::Nes)).transpose()?,
        "gba" => Some(plain(path, System::Gba)?),
        "md" | "gen" => Some(plain(path, System::Md)?),
        "zip" => identify_zip(path)?,
        _ => None,
    };
    Ok(found)
}

fn plain(path: &Path, system: System) -> io::Result<GameFile> {
    let (sha1, size) = hash_file(path)?;
    Ok(GameFile {
        path: path.to_string_lossy().into_owned(),
        file_name: file_name(path),
        system,
        size,
        sha1,
        disc_id: None,
        disc_revision: None,
        disc_title: None,
    })
}

// GameCube and Wii -----------------------------------------------------------

const WII_MAGIC: [u8; 4] = [0x5D, 0x1C, 0x9E, 0xA3];
const GC_MAGIC: [u8; 4] = [0xC2, 0x33, 0x9F, 0x3D];

/// Reads the system, id, revision and title from a GameCube or Wii disc header.
fn parse_disc_header(header: &[u8]) -> Option<(System, String, u8, String)> {
    if header.len() < 0x60 {
        return None;
    }
    let system = if header[0x18..0x1C] == WII_MAGIC {
        System::Wii
    } else if header[0x1C..0x20] == GC_MAGIC {
        System::Gc
    } else {
        return None;
    };
    let id = &header[0..6];
    if !id.iter().all(u8::is_ascii_alphanumeric) {
        return None;
    }
    let title_bytes = &header[0x20..0x60];
    let end = title_bytes.iter().position(|&b| b == 0).unwrap_or(title_bytes.len());
    let title = String::from_utf8_lossy(&title_bytes[..end]).trim().to_string();
    Some((system, String::from_utf8_lossy(id).into_owned(), header[7], title))
}

fn disc_game(path: &Path, header: &[u8]) -> io::Result<Option<GameFile>> {
    let Some((system, id, revision, title)) = parse_disc_header(header) else { return Ok(None) };
    let mut game = plain(path, system)?;
    game.disc_id = Some(id);
    game.disc_revision = Some(revision);
    game.disc_title = Some(title);
    Ok(Some(game))
}

fn identify_disc_image(path: &Path) -> io::Result<Option<GameFile>> {
    let header = read_at(path, 0, 0x60)?;
    disc_game(path, &header)
}

/// Dolphin's compressed formats (.rvz and .wia) keep a copy of the disc header
/// at offset 0x58: a 0x48-byte file header, then 0x10 bytes before the disc header.
fn identify_wia(path: &Path) -> io::Result<Option<GameFile>> {
    let head = read_at(path, 0, 0x58 + 0x60)?;
    if head.len() < 0x58 + 0x60 || !(head.starts_with(b"RVZ\x01") || head.starts_with(b"WIA\x01")) {
        return Ok(None);
    }
    disc_game(path, &head[0x58..])
}

/// .wbfs files store the disc header one "hard disk sector" in, whose size is
/// 2^(byte 8).
fn identify_wbfs(path: &Path) -> io::Result<Option<GameFile>> {
    let head = read_at(path, 0, 12)?;
    if head.len() < 12 || !head.starts_with(b"WBFS") || !(9..=16).contains(&head[8]) {
        return Ok(None);
    }
    let header = read_at(path, 1u64 << head[8], 0x60)?;
    disc_game(path, &header)
}

// N64 ------------------------------------------------------------------------

/// N64 dumps come in three byte orders (.z64, .v64, .n64); all start with the
/// same four bytes, shuffled.
fn is_n64(head: &[u8]) -> bool {
    matches!(head, [0x80, 0x37, 0x12, 0x40] | [0x37, 0x80, 0x40, 0x12] | [0x40, 0x12, 0x37, 0x80])
}

// PlayStation ----------------------------------------------------------------

/// Lists the track files a .cue sheet refers to, in order.
fn cue_files(cue: &Path) -> io::Result<Vec<PathBuf>> {
    let text = std::fs::read_to_string(cue)?;
    let dir = cue.parent().unwrap_or(Path::new("."));
    Ok(text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("FILE ").or_else(|| line.strip_prefix("file "))?;
            let name = if let Some(quoted) = rest.strip_prefix('"') {
                quoted.split('"').next()?
            } else {
                rest.split_whitespace().next()?
            };
            Some(dir.join(name))
        })
        .collect())
}

fn identify_cue(cue: &Path) -> io::Result<Option<GameFile>> {
    let Some(first) = cue_files(cue)?.into_iter().next() else { return Ok(None) };
    if !first.is_file() || !is_ps1_track(&first)? {
        return Ok(None);
    }
    let (sha1, size) = hash_file(&first)?;
    Ok(Some(GameFile {
        path: cue.to_string_lossy().into_owned(),
        file_name: file_name(cue),
        system: System::Ps1,
        size,
        sha1,
        disc_id: None,
        disc_revision: None,
        disc_title: None,
    }))
}

/// A raw PlayStation data track has "PLAYSTATION" as the system id in the
/// volume descriptor at sector 16. Raw sectors are 2352 bytes, with 24 bytes
/// of sync and headers before the data.
fn is_ps1_track(path: &Path) -> io::Result<bool> {
    const OFFSET: u64 = 16 * 2352 + 24 + 8;
    Ok(read_at(path, OFFSET, 11)? == b"PLAYSTATION")
}

// Mega Drive -----------------------------------------------------------------

fn is_mega_drive(path: &Path) -> io::Result<bool> {
    let header = read_at(path, 0x100, 16)?;
    Ok(header.windows(4).any(|w| w == b"SEGA"))
}

// Zip ------------------------------------------------------------------------

/// Cartridge games are often zipped. A zip holding a single game file is
/// fingerprinted by the file inside, which is what the No-Intro list records
/// and what the emulators read.
fn identify_zip(path: &Path) -> io::Result<Option<GameFile>> {
    let mut archive = zip::ZipArchive::new(File::open(path)?).map_err(io::Error::other)?;
    let files: Vec<usize> = (0..archive.len())
        .filter(|&i| archive.by_index(i).is_ok_and(|f| f.is_file()))
        .collect();
    let [index] = files[..] else { return Ok(None) };
    let mut entry = archive.by_index(index).map_err(io::Error::other)?;
    let inner = PathBuf::from(entry.name().map_err(io::Error::other)?.into_owned());
    let system = match extension(&inner).as_deref() {
        Some("z64" | "n64" | "v64") => System::N64,
        Some("sfc" | "smc") => System::Snes,
        Some("nes") => System::Nes,
        Some("gba") => System::Gba,
        Some("md" | "gen") => System::Md,
        _ => return Ok(None),
    };
    let (sha1, size) = hash_reader(&mut entry)?;
    Ok(Some(GameFile {
        path: path.to_string_lossy().into_owned(),
        file_name: file_name(path),
        system,
        size,
        sha1,
        disc_id: None,
        disc_revision: None,
        disc_title: None,
    }))
}

// Helpers --------------------------------------------------------------------

fn extension(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase())
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Windows paths are case-insensitive, and .cue sheets often disagree with
/// the real file name's case.
fn normalize(path: &Path) -> String {
    path.to_string_lossy().to_lowercase().replace('\\', "/")
}

/// Reads up to `len` bytes at `offset`; returns fewer if the file is shorter.
fn read_at(path: &Path, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    if file.metadata()?.len() < offset {
        return Ok(Vec::new());
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(len);
    file.take(len as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

fn hash_file(path: &Path) -> io::Result<(String, u64)> {
    hash_reader(&mut File::open(path)?)
}

fn hash_reader(reader: &mut impl Read) -> io::Result<(String, u64)> {
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    let digest = hasher.finalize();
    Ok((digest.iter().map(|b| format!("{b:02x}")).collect(), size))
}

#[cfg(test)]
mod tests;
