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
    assert!(Release::new("snes9x", "1.0", "a.zip", ABC_SHA256).is_err());
    assert_eq!(
        Release::new("retroarch", "retroarch-1.22.2", "RetroArch.zip", ABC_SHA256).unwrap().download_url(),
        "https://github.com/Nahhyeahh/partylink/releases/download/retroarch-1.22.2/RetroArch.zip"
    );
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
    assert_eq!(&args[args.len() - 4..], ["--netplay_host", "6262", "-e", "/games/Mario Party 4 (USA).rvz"]);
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

const LOBBY: &str = r#"[
  {"model": "lobby.entry", "fields": {"username": "Adrian", "has_password": true, "mitm_ip": "relay.example.org",
   "mitm_port": 55435, "mitm_session": "old+Session/A==", "updated": "2026-10-12T05:00:00Z"}},
  {"model": "lobby.entry", "fields": {"username": "Adrian", "has_password": true, "mitm_ip": "relay.example.org",
   "mitm_port": 55435, "mitm_session": "new+Session/B==", "updated": "2026-10-12T06:00:00Z"}},
  {"model": "lobby.entry", "fields": {"username": "Adrian", "has_password": false, "mitm_ip": "relay.example.org",
   "mitm_port": 55435, "mitm_session": "public", "updated": "2026-10-12T07:00:00Z"}},
  {"model": "lobby.entry", "fields": {"username": "Someone", "has_password": true, "mitm_ip": "relay.example.org",
   "mitm_port": 55435, "mitm_session": "theirs", "updated": "2026-10-12T08:00:00Z"}},
  {"model": "lobby.entry", "fields": {"username": "Adrian", "has_password": true, "mitm_ip": "",
   "mitm_port": 0, "mitm_session": "", "updated": "2026-10-12T09:00:00Z"}}
]"#;

#[test]
fn finds_the_hosts_newest_private_relay_room() {
    let room = find_relay_room(LOBBY, "Adrian").unwrap();
    assert_eq!(room, RelayRoom { host: "relay.example.org".into(), port: 55435, session: "new+Session/B==".into() });
    assert!(find_relay_room(LOBBY, "Nobody").is_none());
    assert!(find_relay_room("not json", "Adrian").is_none());
}

#[test]
fn finds_the_hosts_newest_room_direct_or_relayed() {
    // The last entry above is a direct room, but it has no address.
    let found = find_lobby_room(LOBBY, "Adrian").unwrap();
    assert_eq!(found.room.session, "new+Session/B==");
    assert!(!found.connectable);

    let direct = r#"[
      {"fields": {"id": 42, "username": "Adrian", "has_password": true, "ip": "203.0.113.5", "port": 55435, "mitm_ip": "",
       "mitm_port": 0, "mitm_session": "", "connectable": true, "updated": "2026-10-14T10:00:00Z"}},
      {"fields": {"username": "Adrian", "has_password": true, "ip": "203.0.113.5", "port": 55435,
       "mitm_ip": "asia-southeast1.relay.retroarch.com", "mitm_port": 55435, "mitm_session": "rKtlnu1J",
       "connectable": true, "updated": "2026-10-14T09:00:00Z"}}
    ]"#;
    let found = find_lobby_room(direct, "Adrian").unwrap();
    assert_eq!(found.room, RelayRoom { host: "203.0.113.5".into(), port: 55435, session: String::new() });
    assert!(found.room.is_direct() && found.connectable);
    assert_eq!(found.id, 42);
    // Apps that only know relays still get the relay room.
    assert_eq!(find_relay_room(direct, "Adrian").unwrap().session, "rKtlnu1J");
}

#[test]
fn join_codes_round_trip_and_reject_junk() {
    let direct = JoinCode::parse("203.0.113.5|55435||abcd1234").unwrap();
    assert!(direct.room.is_direct());
    assert_eq!(direct.to_code(), "203.0.113.5|55435||abcd1234");

    let code = "relay.example.org|55435|new+Session/B==|abcd1234";
    let join = JoinCode::parse(code).unwrap();
    assert_eq!(join.room.port, 55435);
    assert_eq!(join.password, "abcd1234");
    assert_eq!(join.to_code(), code);
    for bad in [
        "relay.example.org|55435|sess|short",
        "relay.example.org|0|sess|abcd1234",
        "relay example|55435|sess|abcd1234",
        "relay.example.org|55435|se ss|abcd1234",
        "relay.example.org|55435|sess|abcd1234|extra",
        "a1B2c3D4",
    ] {
        assert!(JoinCode::parse(bad).is_none(), "{bad}");
    }
}

fn session<'a>(dirs: &'a TempDir, host: bool, players: usize) -> RetroSession<'a> {
    RetroSession {
        install_dir: dirs.path(),
        user_dir: dirs.path(),
        nickname: "Adrian",
        password: "abcd1234",
        players,
        host: host.then_some(HostVia::Relay(Relay::Madrid)),
    }
}

#[test]
fn writes_retroarch_settings_for_host_and_friends() {
    let tmp = TempDir::new().unwrap();
    prepare_retroarch_session(&session(&tmp, true, 4)).unwrap();
    let host = fs::read_to_string(tmp.path().join("partylink-session.cfg")).unwrap();
    assert!(host.contains("netplay_public_announce = \"true\""));
    assert!(host.contains("netplay_mitm_server = \"madrid\""));
    assert!(host.contains("netplay_use_mitm_server = \"true\""));
    assert!(host.contains("netplay_nat_traversal = \"false\""));
    assert!(host.contains("netplay_password = \"abcd1234\""));
    assert!(host.contains("netplay_input_latency_frames_min = \"4\""));
    assert!(host.contains("netplay_input_latency_frames_range = \"6\""));
    assert!(host.contains("config_save_on_exit = \"false\""));
    let options = fs::read_to_string(tmp.path().join("partylink-core-options.cfg")).unwrap();
    assert!(options.contains("pcsx_rearmed_multitap = \"port 1\""));
    assert!(options.contains("pcsx_rearmed_bios = \"HLE\""));

    prepare_retroarch_session(&session(&tmp, false, 2)).unwrap();
    let friend = fs::read_to_string(tmp.path().join("partylink-session.cfg")).unwrap();
    assert!(friend.contains("netplay_public_announce = \"false\""));
    assert!(!friend.contains("netplay_mitm_server"));
    let options = fs::read_to_string(tmp.path().join("partylink-core-options.cfg")).unwrap();
    assert!(options.contains("pcsx_rearmed_multitap = \"disabled\""));

    // The player's own settings file is written once and then left alone.
    fs::write(tmp.path().join("retroarch.cfg"), "mine").unwrap();
    prepare_retroarch_session(&session(&tmp, true, 2)).unwrap();
    assert_eq!(fs::read_to_string(tmp.path().join("retroarch.cfg")).unwrap(), "mine");

    let mut direct = session(&tmp, true, 2);
    direct.host = Some(HostVia::Direct);
    prepare_retroarch_session(&direct).unwrap();
    let direct = fs::read_to_string(tmp.path().join("partylink-session.cfg")).unwrap();
    assert!(direct.contains("netplay_nat_traversal = \"true\""));
    assert!(direct.contains("netplay_use_mitm_server = \"false\""));
    assert!(direct.contains("netplay_public_announce = \"true\""));
    assert!(!direct.contains("netplay_mitm_server ="));

    let mut bad = session(&tmp, true, 2);
    bad.password = "short";
    assert!(prepare_retroarch_session(&bad).is_err());
}

#[test]
fn builds_retroarch_host_and_join_options() {
    let install = Path::new("/ra");
    let user = Path::new("/user");
    let game = Path::new("/games/Crash Bash (USA).cue");
    let host = strings(&retroarch_host_args(install, user, Core::PcsxRearmed, game));
    assert_eq!(host[..2], ["-L".to_string(), Path::new("/ra/cores/pcsx_rearmed_libretro.dll").display().to_string()]);
    assert!(host.windows(2).any(|w| w[0] == "--appendconfig" && w[1].ends_with("partylink-session.cfg")));
    assert_eq!(&host[host.len() - 2..], ["-H", "/games/Crash Bash (USA).cue"]);

    let room = RelayRoom { host: "relay.example.org".into(), port: 55435, session: "abc=".into() };
    let join = strings(&retroarch_join_args(install, user, Core::PcsxRearmed, game, &room));
    assert_eq!(
        &join[join.len() - 7..],
        ["-C", "relay.example.org", "--port", "55435", "--mitm-session", "abc=", "/games/Crash Bash (USA).cue"]
    );
    assert!(!join.contains(&"-H".to_string()));

    let direct = RelayRoom { host: "203.0.113.5".into(), port: 55435, session: String::new() };
    let join = strings(&retroarch_join_args(install, user, Core::PcsxRearmed, game, &direct));
    assert_eq!(&join[join.len() - 5..], ["-C", "203.0.113.5", "--port", "55435", "/games/Crash Bash (USA).cue"]);
}

#[test]
fn knows_the_relay_servers() {
    for id in ["nyc", "madrid", "saopaulo", "singapore"] {
        assert_eq!(Relay::from_id(id).unwrap().id(), id);
    }
    assert!(Relay::from_id("custom").is_none());
    assert_eq!(HostVia::from_id("direct"), Some(HostVia::Direct));
    assert_eq!(HostVia::from_id("nyc"), Some(HostVia::Relay(Relay::NewYork)));
}
