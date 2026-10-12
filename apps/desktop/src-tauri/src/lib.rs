// The desktop app is a window around the PartyLink web app hosted on
// Cloudflare (see `build.frontendDist` in tauri.conf.json). Loading the hosted
// app means friends get interface updates without reinstalling, and the app
// talks to the same server as phones and browsers.
//
// Native features, such as launching installed games, will be added here as
// Tauri commands in later milestones.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running PartyLink");
}
