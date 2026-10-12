// Installing and starting emulators. The web app says which release the
// party uses and when to start; this side checks everything it's given,
// downloads from the emulator project's own releases, and runs the emulator
// as a separate program.

use crate::games::{games_folder, scan_cache_path};
use partylink_emulators::{self as emu, Release};
use partylink_scanner::{ScanCache, System};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Default)]
pub struct EmulatorState {
    installing: Mutex<HashSet<String>>,
    /// Emulators PartyLink started that are still open.
    running: Arc<Mutex<HashSet<String>>>,
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
pub async fn install_emulator(app: AppHandle, state: State<'_, EmulatorState>, release: ReleaseArg) -> Result<(), String> {
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

fn download_and_install(app: &AppHandle, release: &Release, root: &std::path::Path) -> Result<(), String> {
    let id = release.emulator.id();
    let downloads = root.join("downloads");
    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    let zip_path = downloads.join(&release.asset);

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).build())
        .timeout_connect(Some(Duration::from_secs(20)))
        .build()
        .into();
    let response = agent
        .get(&release.download_url())
        .call()
        .map_err(|e| format!("Couldn't download the emulator: {e}"))?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
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
            let _ = app.emit("emulator-install-progress", InstallProgress { emulator: id, phase: "download", done, total });
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
            let cache = ScanCache::load(&scan_cache_path(&app)?);
            let game = cache.find_by_sha1(&sha1).ok_or("That game isn't in your games folder any more. Try Rescan.")?;
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

    let id = release.emulator.id().to_string();
    if !state.running.lock().unwrap().insert(id.clone()) {
        return Err("Dolphin is already open. Close it to start again.".into());
    }
    let mut child = match Command::new(release.exe_path(&root)).args(args).current_dir(release.install_dir(&root)).spawn() {
        Ok(child) => child,
        Err(e) => {
            state.running.lock().unwrap().remove(&id);
            return Err(format!("Couldn't start Dolphin: {e}"));
        }
    };
    let running = state.running.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        running.lock().unwrap().remove(&id);
        let _ = app.emit("emulator-exited", id);
    });
    Ok(())
}

#[tauri::command]
pub fn emulator_running(state: State<'_, EmulatorState>, emulator: String) -> bool {
    state.running.lock().unwrap().contains(&emulator)
}

/// The host clicks Copy next to the room code in Dolphin; the web app polls
/// this to pick the code up from the clipboard and send it to the party.
#[tauri::command]
pub fn read_dolphin_room_code(app: AppHandle) -> Option<String> {
    let text = app.clipboard().read_text().ok()?;
    let text = text.trim();
    emu::is_dolphin_host_code(text).then(|| text.to_string())
}
