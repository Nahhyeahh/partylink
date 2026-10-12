fn main() {
    // Listing the app's commands makes Tauri generate an "allow-<command>"
    // permission for each, so capabilities/ must grant them explicitly.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "get_games_folder",
        "choose_games_folder",
        "scan_games",
        "emulator_installed",
        "install_emulator",
        "needs_vc_runtime",
        "launch_dolphin",
        "emulator_running",
        "read_dolphin_room_code",
        "launch_retroarch",
        "find_retroarch_room",
    ])))
    .expect("failed to run tauri-build");
}
