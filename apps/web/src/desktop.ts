// Features that only work inside the PartyLink desktop app, which runs this
// same web app in a window and adds commands a browser can't offer, such as
// reading the player's games folder (see apps/desktop/src-tauri).
import type { GameSystem } from "@partylink/protocol";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
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

export interface InstallProgress {
  emulator: string;
  phase: "download" | "unpack";
  done: number;
  total: number | null;
}

interface ReleaseArg {
  emulator: string;
  tag: string;
  asset: string;
  sha256: string;
}

const releaseArg = ({ emulator, tag, asset, sha256 }: ReleaseArg): ReleaseArg => ({ emulator, tag, asset, sha256 });

export type DolphinLaunch = { mode: "host"; sha1: string } | { mode: "join"; code: string };
export type RetroArchLaunch =
  | { mode: "host"; sha1: string; relay: string; password: string }
  | { mode: "join"; sha1: string; code: string };

/** The host's RetroArch room as libretro's lobby lists it. */
export interface LobbyRoom {
  /** `host|port|session`, with an empty session for a direct room. */
  room: string;
  direct: boolean;
  /** Whether the lobby could reach the room. */
  connectable: boolean;
  /** New each time a room opens. */
  id: number;
}

/** True if this desktop app is at least `version` (like "0.3.3"). */
export async function desktopIsAtLeast(version: string): Promise<boolean> {
  const have = (await getVersion().catch(() => "0")).split(".").map(Number);
  const want = version.split(".").map(Number);
  for (let i = 0; i < want.length; i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Desktop apps from this version on can host and join RetroArch games directly. */
export const DIRECT_NETPLAY_VERSION = "0.3.3";

/** Desktop apps from this version on can close an emulator they opened. */
export const CLOSE_EMULATOR_VERSION = "0.3.3";

export const desktop = {
  getGamesFolder: () => invoke<string | null>("get_games_folder"),
  chooseGamesFolder: () => invoke<string | null>("choose_games_folder"),
  scanGames: () => invoke<ScanResult>("scan_games"),
  onScanProgress: (handler: (progress: ScanProgress) => void) =>
    listen<ScanProgress>("games-scan-progress", (event) => handler(event.payload)),

  emulatorInstalled: (release: ReleaseArg) => invoke<boolean>("emulator_installed", { release: releaseArg(release) }),
  installEmulator: (release: ReleaseArg) => invoke<void>("install_emulator", { release: releaseArg(release) }),
  onInstallProgress: (handler: (progress: InstallProgress) => void) =>
    listen<InstallProgress>("emulator-install-progress", (event) => handler(event.payload)),
  needsVcRuntime: () => invoke<boolean>("needs_vc_runtime"),
  launchDolphin: (release: ReleaseArg, launch: DolphinLaunch, nickname: string) =>
    invoke<void>("launch_dolphin", { release: releaseArg(release), launch, nickname }),
  emulatorRunning: (emulator: string) => invoke<boolean>("emulator_running", { emulator }),
  onEmulatorExited: (handler: (emulator: string) => void) =>
    listen<string>("emulator-exited", (event) => handler(event.payload)),
  readDolphinRoomCode: () => invoke<string | null>("read_dolphin_room_code"),
  launchRetroArch: (release: ReleaseArg, launch: RetroArchLaunch, nickname: string, players: number) =>
    invoke<void>("launch_retroarch", { release: releaseArg(release), launch, nickname, players }),
  /** The host's relay room as `relay|port|session`, once RetroArch has announced it. */
  findRetroArchRoom: (nickname: string) => invoke<string | null>("find_retroarch_room", { nickname }),
  /** The host's newest room, direct or relayed (app 0.3.3 and later). */
  findRetroArchLobbyRoom: (nickname: string) =>
    invoke<LobbyRoom | null>("find_retroarch_lobby_room", { nickname }),
  /** Closes an emulator PartyLink opened (app 0.3.3 and later). */
  closeEmulator: (emulator: string) => invoke<void>("close_emulator", { emulator }),
  launchMupen: (release: ReleaseArg, nickname: string) =>
    invoke<void>("launch_mupen", { release: releaseArg(release), nickname }),
  readMupenRoomCode: () => invoke<string | null>("read_mupen_room_code"),
  copyMupenRoomCode: (code: string) => invoke<void>("copy_mupen_room_code", { code }),
};
