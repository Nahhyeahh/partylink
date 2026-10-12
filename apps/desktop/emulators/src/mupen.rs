// Mupen-MPN ---------------------------------------------------------------------
//
// Mupen-MPN's netplay only works from its window (Online Play), so PartyLink
// opens it with the player's settings filled in: their nickname, the games
// folder for its game list, no update prompts and sessions kept out of the
// public browser. The host's 7-character room code is read from what Mupen
// prints when the room is made, so PartyLink can send it to friends.

use crate::clean_nickname;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;

/// Mupen-MPN's room codes are 7 hex digits, like `0A1B2C3`.
pub fn is_mupen_host_code(text: &str) -> bool {
    text.len() == 7 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Picks the room code out of a line Mupen-MPN prints, such as
/// `Browse host code: "0A1B2C3" server endpoint: "203.0.113.5:9150"`.
pub fn parse_mupen_host_code(line: &str) -> Option<String> {
    let rest = &line[line.find("Browse host code:")? + "Browse host code:".len()..];
    let code = rest.trim_start().trim_start_matches('"');
    let code = code.get(..7)?;
    is_mupen_host_code(code).then(|| code.to_ascii_uppercase())
}

/// Sets `key = value` in one section of a mupen64plus.cfg-style file,
/// keeping everything else the player or Mupen wrote.
fn set_cfg(text: &str, section: &str, key: &str, value: &str) -> String {
    let header = format!("[{section}]");
    let line = format!("{key} = {value}");
    let mut out: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut found_section = false;
    let mut done = false;
    for raw in text.lines() {
        let trimmed = raw.trim();
        if trimmed.starts_with('[') {
            if in_section && !done {
                // Put it before any blank lines that end the section.
                let at = out.iter().rposition(|l| !l.trim().is_empty()).map_or(0, |i| i + 1);
                out.insert(at, line.clone());
                done = true;
            }
            in_section = trimmed == header;
            found_section |= in_section;
        } else if in_section && !done && trimmed.split('=').next().map(str::trim) == Some(key) {
            out.push(line.clone());
            done = true;
            continue;
        }
        out.push(raw.to_string());
    }
    if !done {
        if !found_section {
            if out.last().is_some_and(|l| !l.trim().is_empty()) {
                out.push(String::new());
            }
            out.push(header);
        }
        out.push(line);
    }
    let mut text = out.join("\n");
    text.push('\n');
    text
}

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('"', ""))
}

/// Gets Mupen-MPN ready to open: portable mode (so `--user-data-dir` is
/// used), and the player's settings in their own Mupen folder.
pub fn prepare_mupen(install_dir: &Path, user_dir: &Path, games_folder: &Path, nickname: &str) -> io::Result<()> {
    fs::write(install_dir.join("portable.txt"), "")?;
    let config_dir = user_dir.join("Config");
    fs::create_dir_all(&config_dir)?;
    let path = config_dir.join("mupen64plus.cfg");
    let mut text = fs::read_to_string(&path).unwrap_or_default();
    for (section, key, value) in [
        ("Mupen MPN", "CheckForUpdates", "False".to_string()),
        ("Mupen MPN Netplay", "Nickname", quoted(&clean_nickname(nickname))),
        // Keep the party's sessions out of Mupen's public session list.
        ("Mupen MPN Netplay", "ShowInBrowser", "False".to_string()),
        ("Mupen MPN Netplay", "UseNatTraversal", "True".to_string()),
        // The game list (where the host picks the game) shows the games folder.
        ("Mupen MPN RomBrowser", "Directory", quoted(&games_folder.display().to_string())),
        ("Mupen MPN RomBrowser", "Recursive", "True".to_string()),
    ] {
        text = set_cfg(&text, section, key, &value);
    }
    fs::write(path, text)
}

/// Options to open Mupen-MPN's window with the player's own settings folder.
/// No game is passed: that would start a game on its own, without netplay.
pub fn mupen_args(user_dir: &Path) -> Vec<OsString> {
    vec!["--user-data-dir".into(), user_dir.into()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn reads_the_host_code_mupen_prints() {
        let line = r#"Browse host code: "0a1B2c3" server endpoint: "203.0.113.5:9150""#;
        assert_eq!(parse_mupen_host_code(line).as_deref(), Some("0A1B2C3"));
        assert_eq!(parse_mupen_host_code("Browse host code: 0A1B2C3 server").as_deref(), Some("0A1B2C3"));
        assert!(parse_mupen_host_code(r#"Browse host code: "XYZ1234""#).is_none());
        assert!(parse_mupen_host_code(r#"Browse host code: "0A1""#).is_none());
        assert!(parse_mupen_host_code("Client connected: 1").is_none());
        assert!(is_mupen_host_code("0A1B2C3"));
        assert!(!is_mupen_host_code("a1B2c3D4"));
    }

    #[test]
    fn edits_settings_without_losing_the_players_own() {
        let text = "[Mupen MPN]\nCheckForUpdates = True\nTheme = \"Dark\"\n\n[Video-General]\nFullscreen = False\n";
        let text = set_cfg(text, "Mupen MPN", "CheckForUpdates", "False");
        let text = set_cfg(&text, "Mupen MPN", "Volume", "50");
        let text = set_cfg(&text, "Mupen MPN Netplay", "Nickname", "\"Adrian\"");
        assert_eq!(
            text,
            "[Mupen MPN]\nCheckForUpdates = False\nTheme = \"Dark\"\nVolume = 50\n\n[Video-General]\nFullscreen = False\n\n[Mupen MPN Netplay]\nNickname = \"Adrian\"\n"
        );
        assert_eq!(set_cfg("", "A", "b", "1"), "[A]\nb = 1\n");
    }

    #[test]
    fn prepares_mupen_for_netplay() {
        let tmp = TempDir::new().unwrap();
        let install = tmp.path().join("install");
        fs::create_dir_all(&install).unwrap();
        let user = tmp.path().join("user");
        prepare_mupen(&install, &user, Path::new("C:\\Games"), "Adrian \"A\"").unwrap();
        assert!(install.join("portable.txt").is_file());
        let cfg = fs::read_to_string(user.join("Config/mupen64plus.cfg")).unwrap();
        assert!(cfg.contains("[Mupen MPN Netplay]\nNickname = \"Adrian A\""), "{cfg}");
        assert!(cfg.contains("ShowInBrowser = False"));
        assert!(cfg.contains("Directory = \"C:\\Games\""));
        assert!(cfg.contains("CheckForUpdates = False"));

        // Running again updates values in place rather than adding copies.
        prepare_mupen(&install, &user, Path::new("D:\\Roms"), "Sam").unwrap();
        let cfg = fs::read_to_string(user.join("Config/mupen64plus.cfg")).unwrap();
        assert_eq!(cfg.matches("Nickname").count(), 1);
        assert!(cfg.contains("Directory = \"D:\\Roms\""));

        let args: Vec<String> = mupen_args(&user).iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["--user-data-dir".to_string(), user.display().to_string()]);
    }
}
