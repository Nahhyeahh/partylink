// The player's own games, shared by the Library and the lobby. One store for
// the whole app so the folder is scanned once, not once per screen.
import { useSyncExternalStore } from "react";
import { desktop, isDesktop, type ScanProgress } from "./desktop";
import { type NamedGame, nameGames } from "./gamedb";

export type MyGamesState =
  /** In a browser, which can't read folders. */
  | { status: "browser" }
  /** An older desktop app without folder support. */
  | { status: "outdated" }
  | { status: "loading" }
  | { status: "no-folder" }
  | { status: "scanning"; folder: string; progress: ScanProgress | null; games: NamedGame[] }
  | { status: "ready"; folder: string; games: NamedGame[]; skipped: number }
  | { status: "error"; folder: string | null; message: string };

let state: MyGamesState = isDesktop() ? { status: "loading" } : { status: "browser" };
const listeners = new Set<() => void>();
let started = false;

function setState(next: MyGamesState) {
  state = next;
  for (const listener of listeners) listener();
}

function message(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong.";
}

async function scan(folder: string) {
  const previous = state.status === "ready" || state.status === "scanning" ? state.games : [];
  setState({ status: "scanning", folder, progress: null, games: previous });
  const unlisten = await desktop
    .onScanProgress((progress) => {
      if (state.status === "scanning") setState({ ...state, progress });
    })
    .catch(() => () => {});
  try {
    const result = await desktop.scanGames();
    setState({ status: "ready", folder, games: await nameGames(result.games), skipped: result.skipped.length });
  } catch (error) {
    setState({ status: "error", folder, message: message(error) });
  } finally {
    unlisten();
  }
}

async function start() {
  if (started || state.status === "browser") return;
  started = true;
  let folder: string | null;
  try {
    folder = await desktop.getGamesFolder();
  } catch {
    // Desktop apps before 0.2.0 have no folder commands, and calls fail.
    setState({ status: "outdated" });
    return;
  }
  if (folder) await scan(folder);
  else setState({ status: "no-folder" });
}

export const myGames = {
  async chooseFolder() {
    try {
      const folder = await desktop.chooseGamesFolder();
      if (folder) await scan(folder);
    } catch (error) {
      setState({ status: "error", folder: null, message: message(error) });
    }
  },
  async rescan() {
    if (state.status === "ready" || state.status === "error") {
      if (state.folder) await scan(state.folder);
    }
  },
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  void start();
  return () => listeners.delete(listener);
}

export function useMyGames(): MyGamesState {
  return useSyncExternalStore(subscribe, () => state);
}
