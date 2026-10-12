// Names for game files, from the No-Intro and Redump lists of known clean
// dumps (via libretro-database, CC BY-SA 4.0). Built by scripts/build-gamedb.mjs
// into public/gamedb/, one file per console, loaded only when needed.
import type { GameSystem } from "@partylink/protocol";
import type { GameFile } from "./desktop";

interface GameList {
  sha1: Record<string, string>;
  /** GameCube and Wii: 4-character disc id to name, for compressed images. */
  ids?: Record<string, string>;
}

const lists = new Map<GameSystem, Promise<GameList>>();

function loadList(system: GameSystem): Promise<GameList> {
  let list = lists.get(system);
  if (!list) {
    list = fetch(`/gamedb/${system}.json`)
      .then((res) => (res.ok ? (res.json() as Promise<GameList>) : { sha1: {} }))
      .catch(() => ({ sha1: {} }));
    lists.set(system, list);
  }
  return list;
}

export interface NamedGame extends GameFile {
  title: string;
  /** The file exactly matches a known clean dump. */
  verified: boolean;
}

function fallbackTitle(game: GameFile, list: GameList): string {
  if (game.discId) {
    const name = list.ids?.[game.discId.slice(0, 4)];
    if (name) return game.discRevision ? `${name} (Rev ${game.discRevision})` : name;
    if (game.discTitle) return game.discTitle;
  }
  return game.fileName.replace(/\.[^.]+$/, "");
}

export async function nameGames(games: GameFile[]): Promise<NamedGame[]> {
  const systems = [...new Set(games.map((g) => g.system))];
  const loaded = new Map(await Promise.all(systems.map(async (s) => [s, await loadList(s)] as const)));
  return games
    .map((game) => {
      const list = loaded.get(game.system) ?? { sha1: {} };
      const known = list.sha1[game.sha1];
      return { ...game, title: known ?? fallbackTitle(game, list), verified: known !== undefined };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

// Box art from libretro-thumbnails, which names images after the No-Intro and
// Redump titles. Games without a match fall back to a coloured card.
const THUMBNAIL_DIRS: Record<GameSystem, string> = {
  gc: "Nintendo - GameCube",
  wii: "Nintendo - Wii",
  n64: "Nintendo - Nintendo 64",
  ps1: "Sony - PlayStation",
  snes: "Nintendo - Super Nintendo Entertainment System",
  nes: "Nintendo - Nintendo Entertainment System",
  gba: "Nintendo - Game Boy Advance",
  md: "Sega - Mega Drive - Genesis",
};

export function coverUrl(system: GameSystem, title: string): string {
  // libretro-thumbnails replaces characters that aren't allowed in file names.
  const file = title.replace(/[&*/:`<>?\\|"]/g, "_");
  const repo = THUMBNAIL_DIRS[system].replaceAll(" ", "_");
  return `https://raw.githubusercontent.com/libretro-thumbnails/${repo}/master/Named_Boxarts/${encodeURIComponent(file)}.png`;
}
