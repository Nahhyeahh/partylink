// The player's own game files. PartyLink never ships or downloads games: each
// player chooses their games folder, and the scanner crate recognises and
// fingerprints what is in it so the lobby can check everyone has the same copy.

use partylink_scanner::{scan, ScanCache, ScanResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    games_folder: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn games_folder(app: &AppHandle) -> Option<String> {
    load_settings(app).games_folder
}

pub fn scan_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("scan-cache.json"))
}

#[tauri::command]
pub fn get_games_folder(app: AppHandle) -> Option<String> {
    games_folder(&app)
}

/// Opens the system folder picker and remembers the choice.
/// Returns `None` if the player cancels.
#[tauri::command]
pub async fn choose_games_folder(app: AppHandle) -> Result<Option<String>, String> {
    let picker = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        picker.dialog().file().set_title("Choose your games folder").blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let folder = picked.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let mut settings = load_settings(&app);
    settings.games_folder = Some(folder.clone());
    save_settings(&app, &settings)?;
    Ok(Some(folder))
}

/// Scans the games folder, sending "games-scan-progress" events as it goes.
/// Fingerprints are cached, so only new or changed files are read in full.
#[tauri::command]
pub async fn scan_games(app: AppHandle) -> Result<ScanResult, String> {
    let folder = load_settings(&app).games_folder.ok_or("Choose your games folder first.")?;
    let cache_path = scan_cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = ScanCache::load(&cache_path);
        let mut last_event = Instant::now() - Duration::from_secs(1);
        let result = scan(PathBuf::from(&folder).as_path(), &mut cache, |progress| {
            // Large folders have thousands of files; a few updates a second is plenty.
            if last_event.elapsed() >= Duration::from_millis(100) || progress.done == progress.total {
                last_event = Instant::now();
                let _ = app.emit("games-scan-progress", progress);
            }
        })
        .map_err(|e| e.to_string())?;
        // A cache that can't be saved only means the next scan is slower.
        let _ = cache.save(&cache_path);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
