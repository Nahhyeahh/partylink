// Features that only work inside the PartyLink desktop app, which runs this
// same web app in a window and adds commands a browser can't offer, such as
// reading the player's games folder (see apps/desktop/src-tauri).
import type { GameSystem } from "@partylink/protocol";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const DOWNLOAD_URL = "https://github.com/Nahhyeahh/partylink/releases/latest";

/** True inside the desktop app, false in a browser or on a phone. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** A game file found by the desktop app's scanner (apps/desktop/scanner). */
export interface GameFile {
  path: string;
  fileName: string;
  system: GameSystem;
  size: number;
  sha1: string;
  discId?: string;
  discRevision?: number;
  discTitle?: string;
}

export interface ScanResult {
  games: GameFile[];
  skipped: string[];
}

export interface ScanProgress {
  done: number;
  total: number;
  current: string;
}

export const desktop = {
  getGamesFolder: () => invoke<string | null>("get_games_folder"),
  chooseGamesFolder: () => invoke<string | null>("choose_games_folder"),
  scanGames: () => invoke<ScanResult>("scan_games"),
  onScanProgress: (handler: (progress: ScanProgress) => void) =>
    listen<ScanProgress>("games-scan-progress", (event) => handler(event.payload)),
};
