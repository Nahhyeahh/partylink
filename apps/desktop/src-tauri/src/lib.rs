// The desktop app is a window around the PartyLink web app hosted on
// Cloudflare (see `build.frontendDist` in tauri.conf.json). Loading the hosted
// app means friends get interface updates without reinstalling, and the app
// talks to the same server as phones and browsers.
//
// Things a web page can't do, like reading the player's games folder, are
// Tauri commands the web app calls when it runs inside this window. Which
// pages may call them is set in capabilities/.

mod emulators;
mod games;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(emulators::EmulatorState::default())
        .invoke_handler(tauri::generate_handler![
            games::get_games_folder,
            games::choose_games_folder,
            games::scan_games,
            emulators::emulator_installed,
            emulators::install_emulator,
            emulators::needs_vc_runtime,
            emulators::launch_dolphin,
            emulators::emulator_running,
            emulators::read_dolphin_room_code,
            emulators::launch_retroarch,
            emulators::find_retroarch_room,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PartyLink");
}
