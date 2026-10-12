// Builds the game name lists the Library uses to recognise game files.
//
// The lists come from libretro-database (https://github.com/libretro/libretro-database),
// which collects No-Intro and Redump checksums of clean game dumps. They contain
// names and checksums only, never games. The data is licensed CC BY-SA 4.0, so
// the generated files keep that licence and credit their source.
//
// Run with `node scripts/build-gamedb.mjs` to refresh apps/web/public/gamedb/.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat";

// Keys match the `GameSystem` ids in packages/protocol.
const SYSTEMS = {
  gc: "redump/Nintendo - GameCube",
  wii: "redump/Nintendo - Wii",
  n64: "no-intro/Nintendo - Nintendo 64",
  ps1: "redump/Sony - PlayStation",
  snes: "no-intro/Nintendo - Super Nintendo Entertainment System",
  nes: "no-intro/Nintendo - Nintendo Entertainment System",
  gba: "no-intro/Nintendo - Game Boy Advance",
  md: "no-intro/Sega - Mega Drive - Genesis",
};

const outDir = join(dirname(fileURLToPath(import.meta.url)), "../apps/web/public/gamedb");

/** Parses the clrmamepro .dat format into { version, games: [{ name, roms: [{ sha1, serial }] }] }. */
export function parseDat(text) {
  const version = /^\s*version "([^"]*)"/m.exec(text)?.[1] ?? "unknown";
  const games = [];
  const gameRe = /^game \(\n([\s\S]*?)^\)/gm;
  for (const match of text.matchAll(gameRe)) {
    const body = match[1];
    const name = /^\s*name "((?:[^"\\]|\\.)*)"/m.exec(body)?.[1];
    if (!name) continue;
    const gameSerial = /^\s*serial "([^"]*)"/m.exec(body)?.[1];
    const roms = [];
    for (const rom of body.matchAll(/^\s*rom \((.*)\)\s*$/gm)) {
      const line = rom[1];
      const sha1 = /\bsha1 ([0-9A-Fa-f]{40})\b/.exec(line)?.[1];
      if (!sha1) continue;
      roms.push({ sha1: sha1.toLowerCase(), serial: /\bserial "([^"]*)"/.exec(line)?.[1] ?? gameSerial });
    }
    games.push({ name, roms });
  }
  return { version, games };
}

/**
 * GameCube and Wii serials look like "DL-DOL-GMPE-USA". The 4-letter game id in
 * the middle is also stored inside compressed disc images (.rvz), so the
 * Library can name those without hashing them.
 */
function discId(serial) {
  const parts = serial.split(/[-,\s]+/);
  return parts.find((part) => /^[A-Z0-9]{4}$/.test(part) && part !== "USA");
}

export function buildList(system, dat) {
  const sha1 = {};
  const ids = {};
  for (const game of dat.games) {
    for (const rom of game.roms) {
      sha1[rom.sha1] ??= game.name;
      if ((system === "gc" || system === "wii") && rom.serial) {
        const id = discId(rom.serial);
        // Some ids are shared by several releases; prefer the USA name, then the first listed.
        const name = game.name.replace(/ \(Rev \d+\)/, "");
        if (id && (!ids[id] || (!ids[id].includes("(USA") && name.includes("(USA")))) ids[id] = name;
      }
    }
  }
  return {
    source: `libretro-database ${dat.version}, CC BY-SA 4.0`,
    sha1,
    ...(Object.keys(ids).length > 0 ? { ids } : {}),
  };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const [system, path] of Object.entries(SYSTEMS)) {
    const url = `${SOURCE}/${path.split("/").map(encodeURIComponent).join("/")}.dat`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const list = buildList(system, parseDat(await res.text()));
    const json = JSON.stringify(list);
    await writeFile(join(outDir, `${system}.json`), json);
    console.log(`${system}: ${Object.keys(list.sha1).length} files, ${(json.length / 1024).toFixed(0)} KB`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
