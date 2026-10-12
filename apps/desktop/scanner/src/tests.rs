use super::*;
use std::io::Write;
use tempfile::TempDir;

const ABC_SHA1: &str = "a9993e364706816aba3e25717850c26c9cd0d89d";

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&path, bytes).unwrap();
    path
}

fn disc_header(system: System, id: &str, revision: u8, title: &str) -> Vec<u8> {
    let mut header = vec![0u8; 0x440];
    header[..6].copy_from_slice(id.as_bytes());
    header[7] = revision;
    match system {
        System::Wii => header[0x18..0x1C].copy_from_slice(&WII_MAGIC),
        System::Gc => header[0x1C..0x20].copy_from_slice(&GC_MAGIC),
        _ => unreachable!(),
    }
    header[0x20..0x20 + title.len()].copy_from_slice(title.as_bytes());
    header
}

fn ps1_track() -> Vec<u8> {
    let mut data = vec![0u8; 17 * 2352];
    let at = 16 * 2352 + 24 + 8;
    data[at..at + 11].copy_from_slice(b"PLAYSTATION");
    data
}

fn scan_dir(dir: &Path) -> ScanResult {
    scan(dir, &mut ScanCache::default(), |_| {}).unwrap()
}

#[test]
fn reads_gamecube_disc_headers() {
    let dir = TempDir::new().unwrap();
    let path = write(dir.path(), "Mario Party 4.iso", &disc_header(System::Gc, "GMPE01", 1, "Mario Party 4"));
    let game = identify(&path).unwrap().unwrap();
    assert_eq!(game.system, System::Gc);
    assert_eq!(game.disc_id.as_deref(), Some("GMPE01"));
    assert_eq!(game.disc_revision, Some(1));
    assert_eq!(game.disc_title.as_deref(), Some("Mario Party 4"));
    assert_eq!(game.sha1.len(), 40);
}

#[test]
fn reads_wii_disc_headers() {
    let dir = TempDir::new().unwrap();
    let path = write(dir.path(), "mp8.iso", &disc_header(System::Wii, "RM8E01", 2, "Mario Party 8"));
    let game = identify(&path).unwrap().unwrap();
    assert_eq!(game.system, System::Wii);
    assert_eq!(game.disc_revision, Some(2));
}

#[test]
fn ignores_iso_files_from_other_consoles() {
    let dir = TempDir::new().unwrap();
    let path = write(dir.path(), "ps2 game.iso", &[0u8; 0x1000]);
    assert_eq!(identify(&path).unwrap(), None);
}

#[test]
fn reads_the_disc_header_inside_rvz_files() {
    let dir = TempDir::new().unwrap();
    let mut bytes = b"RVZ\x01".to_vec();
    bytes.resize(0x58, 0);
    bytes.extend(disc_header(System::Gc, "GP5E01", 0, "Mario Party 5"));
    let path = write(dir.path(), "mp5.rvz", &bytes);
    let game = identify(&path).unwrap().unwrap();
    assert_eq!(game.system, System::Gc);
    assert_eq!(game.disc_id.as_deref(), Some("GP5E01"));
}

#[test]
fn reads_the_disc_header_inside_wbfs_files() {
    let dir = TempDir::new().unwrap();
    let mut bytes = b"WBFS".to_vec();
    bytes.resize(12, 0);
    bytes[8] = 9; // 512-byte sectors
    bytes.resize(512, 0);
    bytes.extend(disc_header(System::Wii, "RMGE01", 0, "Super Mario Galaxy"));
    let path = write(dir.path(), "galaxy.wbfs", &bytes);
    let game = identify(&path).unwrap().unwrap();
    assert_eq!(game.system, System::Wii);
    assert_eq!(game.disc_id.as_deref(), Some("RMGE01"));
}

#[test]
fn recognises_all_three_n64_byte_orders() {
    let dir = TempDir::new().unwrap();
    for (name, head) in [
        ("a.z64", [0x80, 0x37, 0x12, 0x40]),
        ("b.v64", [0x37, 0x80, 0x40, 0x12]),
        ("c.n64", [0x40, 0x12, 0x37, 0x80]),
    ] {
        let path = write(dir.path(), name, &head);
        assert_eq!(identify(&path).unwrap().unwrap().system, System::N64, "{name}");
    }
    let junk = write(dir.path(), "junk.z64", b"nope");
    assert_eq!(identify(&junk).unwrap(), None);
}

#[test]
fn opens_ps1_games_through_their_cue_sheet() {
    let dir = TempDir::new().unwrap();
    let track = ps1_track();
    write(dir.path(), "Crash Bash (USA).bin", &track);
    write(dir.path(), "Crash Bash (USA).cue", b"FILE \"crash bash (usa).bin\" BINARY\n  TRACK 01 MODE2/2352\n");
    // Paths are case-insensitive on Windows only, so on other systems the
    // cue must name the file exactly to be readable.
    if !cfg!(windows) {
        write(dir.path(), "Crash Bash (USA).cue", b"FILE \"Crash Bash (USA).bin\" BINARY\n  TRACK 01 MODE2/2352\n");
    }

    let result = scan_dir(dir.path());
    assert_eq!(result.games.len(), 1, "the .bin is opened through the .cue, not listed twice");
    let game = &result.games[0];
    assert_eq!(game.system, System::Ps1);
    assert!(game.path.ends_with(".cue"));
    assert_eq!(game.sha1, hash_reader(&mut &track[..]).unwrap().0);
    assert_eq!(game.size, track.len() as u64);
}

#[test]
fn tells_ps1_and_mega_drive_bin_files_apart() {
    let dir = TempDir::new().unwrap();
    let ps1 = write(dir.path(), "single track.bin", &ps1_track());
    let mut md = vec![0u8; 0x200];
    md[0x100..0x110].copy_from_slice(b"SEGA MEGA DRIVE ");
    let md = write(dir.path(), "sonic.bin", &md);
    let other = write(dir.path(), "firmware.bin", &[0u8; 0x200]);

    assert_eq!(identify(&ps1).unwrap().unwrap().system, System::Ps1);
    assert_eq!(identify(&md).unwrap().unwrap().system, System::Md);
    assert_eq!(identify(&other).unwrap(), None);
}

#[test]
fn checks_nes_headers() {
    let dir = TempDir::new().unwrap();
    let good = write(dir.path(), "smb.nes", b"NES\x1a rest of the game");
    let bad = write(dir.path(), "notes.nes", b"hello");
    assert_eq!(identify(&good).unwrap().unwrap().system, System::Nes);
    assert_eq!(identify(&bad).unwrap(), None);
}

#[test]
fn fingerprints_the_game_inside_a_zip() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("game.zip");
    let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("Super Game (USA).sfc", options).unwrap();
    zip.write_all(b"abc").unwrap();
    zip.finish().unwrap();

    let game = identify(&path).unwrap().unwrap();
    assert_eq!(game.system, System::Snes);
    assert_eq!(game.sha1, ABC_SHA1);
    assert_eq!(game.size, 3);
}

#[test]
fn ignores_zips_holding_several_files() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("pack.zip");
    let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for name in ["a.sfc", "b.sfc"] {
        zip.start_file(name, options).unwrap();
        zip.write_all(b"abc").unwrap();
    }
    zip.finish().unwrap();
    assert_eq!(identify(&path).unwrap(), None);
}

#[test]
fn scans_subfolders_and_reports_unrecognised_files() {
    let dir = TempDir::new().unwrap();
    write(dir.path(), "SNES/game.sfc", b"abc");
    write(dir.path(), "GBA/deep/er/game.gba", b"abc");
    write(dir.path(), "NES/broken.nes", b"nope");
    write(dir.path(), "readme.txt", b"not a game");

    let result = scan_dir(dir.path());
    let systems: Vec<System> = result.games.iter().map(|g| g.system).collect();
    assert_eq!(result.games.len(), 2);
    assert!(systems.contains(&System::Snes) && systems.contains(&System::Gba));
    assert_eq!(result.skipped.len(), 1, "only the broken .nes; .txt files are never looked at");
    assert!(result.games.iter().all(|g| g.sha1 == ABC_SHA1));
}

#[test]
fn reuses_cached_fingerprints_for_unchanged_files() {
    let dir = TempDir::new().unwrap();
    let path = write(dir.path(), "game.gba", b"abc");
    let mut cache = ScanCache::default();
    scan(dir.path(), &mut cache, |_| {}).unwrap();

    // Pretend the cached fingerprint differs; an unchanged file should keep it.
    let key = path.to_string_lossy().into_owned();
    cache.entries.get_mut(&key).unwrap().game.as_mut().unwrap().sha1 = "cached".into();
    let again = scan(dir.path(), &mut cache, |_| {}).unwrap();
    assert_eq!(again.games[0].sha1, "cached");

    // Deleted files drop out of the cache.
    std::fs::remove_file(&path).unwrap();
    scan(dir.path(), &mut cache, |_| {}).unwrap();
    assert!(cache.entries.is_empty());
}

#[test]
fn cache_round_trips_through_a_file() {
    let dir = TempDir::new().unwrap();
    write(dir.path(), "games/game.gba", b"abc");
    let mut cache = ScanCache::default();
    scan(&dir.path().join("games"), &mut cache, |_| {}).unwrap();
    let file = dir.path().join("cache/scan.json");
    cache.save(&file).unwrap();
    assert_eq!(ScanCache::load(&file).entries.len(), 1);
    assert!(ScanCache::load(&dir.path().join("missing.json")).entries.is_empty());
}

#[test]
fn reports_progress_and_a_missing_folder() {
    let dir = TempDir::new().unwrap();
    write(dir.path(), "a.gba", b"abc");
    write(dir.path(), "b.gba", b"abc");
    let mut updates = Vec::new();
    scan(dir.path(), &mut ScanCache::default(), |p| updates.push((p.done, p.total))).unwrap();
    assert_eq!(updates.last(), Some(&(2, 2)));
    assert!(scan(&dir.path().join("nope"), &mut ScanCache::default(), |_| {}).is_err());
}

#[test]
fn serializes_with_web_friendly_names() {
    let game = GameFile {
        path: "C:/Games/mp4.iso".into(),
        file_name: "mp4.iso".into(),
        system: System::Gc,
        size: 1,
        sha1: ABC_SHA1.into(),
        disc_id: Some("GMPE01".into()),
        disc_revision: Some(0),
        disc_title: None,
    };
    let json = serde_json::to_value(&game).unwrap();
    assert_eq!(json["system"], "gc");
    assert_eq!(json["fileName"], "mp4.iso");
    assert_eq!(json["discId"], "GMPE01");
    assert!(json.get("discTitle").is_none());
}

#[test]
fn finds_cached_games_by_fingerprint() {
    let dir = TempDir::new().unwrap();
    let path = write(dir.path(), "game.gba", b"abc");
    let mut cache = ScanCache::default();
    scan(dir.path(), &mut cache, |_| {}).unwrap();
    assert_eq!(cache.find_by_sha1(ABC_SHA1).map(|g| g.path.clone()), Some(path.to_string_lossy().into_owned()));
    assert!(cache.find_by_sha1("0000").is_none());

    // A file deleted since the last scan isn't offered.
    std::fs::remove_file(&path).unwrap();
    assert!(cache.find_by_sha1(ABC_SHA1).is_none());
}
