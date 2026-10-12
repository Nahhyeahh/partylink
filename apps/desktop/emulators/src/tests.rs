use super::*;
use std::io::Write;
use tempfile::TempDir;

const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

fn release(sha256: &str) -> Release {
    Release::new("dolphin-mpn", "e433371", "DolphinMPN-windows-x86_64.zip", sha256).unwrap()
}

fn make_zip(dir: &Path, files: &[(&str, &[u8])]) -> PathBuf {
    let path = dir.join("download.zip");
    let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, bytes) in files {
        zip.start_file(*name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
    path
}

fn zip_hash(path: &Path) -> String {
    sha256_hex(&mut File::open(path).unwrap()).unwrap()
}

#[test]
fn hashes_with_sha256() {
    assert_eq!(sha256_hex(&mut &b"abc"[..]).unwrap(), ABC_SHA256);
}

#[test]
fn only_accepts_releases_from_the_emulators_own_project() {
    let r = release(ABC_SHA256);
    assert_eq!(
        r.download_url(),
        "https://github.com/MarioPartyNetplay/Dolphin-MPN/releases/download/e433371/DolphinMPN-windows-x86_64.zip"
    );
    assert!(Release::new("retroarch", "1.0", "a.zip", ABC_SHA256).is_err());
    assert!(Release::new("dolphin-mpn", "../evil", "a.zip", ABC_SHA256).is_err());
    assert!(Release::new("dolphin-mpn", "e433371", "../../x.zip", ABC_SHA256).is_err());
    assert!(Release::new("dolphin-mpn", "e433371", "a.exe", ABC_SHA256).is_err());
    assert!(Release::new("dolphin-mpn", "e433371", "a.zip", &ABC_SHA256.to_uppercase()).is_err());
    assert!(Release::new("dolphin-mpn", "e433371", "a.zip", "abc").is_err());
}

#[test]
fn installs_a_checked_zip() {
    let tmp = TempDir::new().unwrap();
    let zip = make_zip(tmp.path(), &[("Dolphin-MPN.exe", b"exe"), ("Sys/GameSettings/GMP.ini", b"[Core]")]);
    let r = release(&zip_hash(&zip));
    let root = tmp.path().join("emulators");
    assert!(!r.is_installed(&root));

    let dir = install_from_zip(&r, &zip, &root).unwrap();
    assert_eq!(dir, root.join("dolphin-mpn").join("e433371"));
    assert!(r.is_installed(&root));
    assert_eq!(fs::read(dir.join("Sys/GameSettings/GMP.ini")).unwrap(), b"[Core]");
    assert_eq!(r.exe_path(&root), dir.join("Dolphin-MPN.exe"));

    // Installing again replaces the folder cleanly.
    install_from_zip(&r, &zip, &root).unwrap();
    assert!(r.is_installed(&root));
}

#[test]
fn refuses_a_zip_with_the_wrong_hash() {
    let tmp = TempDir::new().unwrap();
    let zip = make_zip(tmp.path(), &[("Dolphin-MPN.exe", b"exe")]);
    let root = tmp.path().join("emulators");
    let err = install_from_zip(&release(ABC_SHA256), &zip, &root).unwrap_err();
    assert!(matches!(err, Error::HashMismatch { .. }));
    assert!(!root.join("dolphin-mpn").exists());
}

#[test]
fn refuses_a_zip_without_the_emulator() {
    let tmp = TempDir::new().unwrap();
    let zip = make_zip(tmp.path(), &[("readme.txt", b"hi")]);
    let r = release(&zip_hash(&zip));
    let root = tmp.path().join("emulators");
    assert!(install_from_zip(&r, &zip, &root).is_err());
    assert!(!r.is_installed(&root));
    assert!(!r.install_dir(&root).with_extension("partial").exists());
}

#[test]
fn never_writes_outside_the_install_folder() {
    let tmp = TempDir::new().unwrap();
    let zip = make_zip(tmp.path(), &[("Dolphin-MPN.exe", b"exe"), ("../../escaped.txt", b"bad")]);
    let r = release(&zip_hash(&zip));
    let root = tmp.path().join("emulators");
    install_from_zip(&r, &zip, &root).unwrap();
    assert!(!tmp.path().join("escaped.txt").exists());
    assert!(!root.join("escaped.txt").exists());
}

#[test]
fn recognises_dolphin_room_codes() {
    assert!(is_dolphin_host_code("a1B2c3D4"));
    assert!(!is_dolphin_host_code("a1B2c3D"));
    assert!(!is_dolphin_host_code("a1B2c3D4e"));
    assert!(!is_dolphin_host_code("a1B2 3D4"));
    assert!(!is_dolphin_host_code("hello world"));
}

fn strings(args: &[OsString]) -> Vec<String> {
    args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
}

#[test]
fn builds_dolphin_host_options() {
    let args = strings(&dolphin_host_args(
        Path::new("/data/dolphin-user"),
        Path::new("/games"),
        "Adrian=1\nX",
        Path::new("/games/Mario Party 4 (USA).rvz"),
    ));
    assert_eq!(&args[..2], ["-u", "/data/dolphin-user"]);
    assert!(args.contains(&"Dolphin.General.ISOPath0=/games".to_string()));
    assert!(args.contains(&"Dolphin.NetPlay.TraversalChoice=traversal".to_string()));
    assert!(args.contains(&"Dolphin.NetPlay.UseIndex=False".to_string()));
    assert!(args.contains(&"Dolphin.NetPlay.Nickname=Adrian1X".to_string()), "{args:?}");
    assert_eq!(
        &args[args.len() - 4..],
        ["--netplay_host", "6262", "-e", "/games/Mario Party 4 (USA).rvz"]
    );
    // Every -C is followed by a setting.
    for (i, a) in args.iter().enumerate() {
        if a == "-C" {
            assert!(args[i + 1].contains('='));
        }
    }
}

#[test]
fn builds_dolphin_join_options() {
    let args = strings(&dolphin_join_args(Path::new("/u"), Path::new("/g"), "   ", "a1B2c3D4"));
    assert!(args.contains(&"Dolphin.NetPlay.Nickname=Player".to_string()));
    assert_eq!(&args[args.len() - 2..], ["--netplay_join", "a1B2c3D4"]);
    assert!(!args.contains(&"-e".to_string()), "joining must not pass a game");
}

#[test]
fn writes_a_controller_file_only_once() {
    let tmp = TempDir::new().unwrap();
    let user = tmp.path().join("dolphin-user");
    prepare_dolphin_user_dir(&user).unwrap();
    let pad = user.join("Config/GCPadNew.ini");
    assert!(fs::read_to_string(&pad).unwrap().contains("XInput/0/Gamepad"));

    fs::write(&pad, "[GCPad1]\nDevice = SDL/0/My Pad\n").unwrap();
    prepare_dolphin_user_dir(&user).unwrap();
    assert!(fs::read_to_string(&pad).unwrap().contains("My Pad"), "the player's own setup is kept");
}
