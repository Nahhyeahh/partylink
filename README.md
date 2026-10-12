# PartyLink

Play your own console games online with friends who live in different places. Create a party, share the 4-letter code, pick a game from your games folder, and play together through emulator netplay.

> **Status:** early development. You can create a party, have friends join by code or invite link, and pick avatar colours. In the Windows app you choose your games folder, PartyLink recognises your GameCube, Wii, N64, PlayStation, SNES, NES, Game Boy Advance and Mega Drive games, and the lobby checks that everyone has the same copy of the host's chosen game. GameCube and Wii games start through Dolphin with netplay; other consoles come next.
>
> PartyLink never includes or downloads games. Each player uses their own game files.

**Play in a browser:** https://partylink.adrianpaintaway.workers.dev

**Windows app:** download the latest `PartyLink_..._x64-setup.exe` from [Releases](../../releases). Windows may say "Windows protected your PC" because the installer isn't signed yet; click **More info**, then **Run anyway**.

## How it's built

| Part | Folder | What it is |
| --- | --- | --- |
| Web app | `apps/web` | React + TypeScript. The home screen, game library, lobby, and (later) games and phone controllers. |
| Desktop app | `apps/desktop/src-tauri` | A Tauri 2 window around the hosted web app, built into a Windows installer by GitHub Actions. It adds what a browser can't do, like reading your games folder. |
| Emulators | `apps/desktop/emulators` | Downloads emulators from their own projects' releases (checked against a pinned SHA-256) and builds the options that start netplay. Which release everyone uses is set in `apps/web/src/emulators.ts`. |
| Game scanner | `apps/desktop/scanner` | Rust code that finds game files in a folder, works out each one's console, and fingerprints it (SHA-1) so the lobby can compare copies. |
| Game names | `apps/web/public/gamedb` | Fingerprints of known clean game dumps, used to show proper names. Built by `scripts/build-gamedb.mjs`. |
| Server | `apps/server` | A Cloudflare Worker plus one Durable Object per party, talking to players over WebSockets. It also serves the web app. |
| Protocol | `packages/protocol` | Every message the app and server exchange, with validation, shared by both. |
| Game catalogue | `packages/game-catalog` | The list of games, their player limits, and the rules for when a lobby can start. |

## Running it on your PC (Windows)

1. Install [Node.js 22 or newer](https://nodejs.org/) (the LTS installer is fine).
2. Open a terminal in this folder and enable pnpm, which comes with Node:
   ```
   corepack enable
   ```
3. Install everything:
   ```
   pnpm install
   ```
4. Start the server and web app together:
   ```
   pnpm dev
   ```
5. Open the address Vite prints (usually http://localhost:5173). Open it in a second browser window to join your own party as another player.

## Your games folder

In the Windows app, open **Games** and click **Choose games folder**. PartyLink looks through it and its subfolders for:

| Console | Files |
| --- | --- |
| GameCube, Wii | `.iso`, `.gcm`, `.rvz`, `.wia`, `.wbfs` |
| Nintendo 64 | `.z64`, `.n64`, `.v64` |
| PlayStation | `.cue` with its `.bin` tracks, or a single `.bin` |
| SNES, NES, Game Boy Advance, Mega Drive | `.sfc`, `.smc`, `.nes`, `.gba`, `.md`, `.gen`, `.bin`, or a `.zip` holding one game |

Netplay only works when everyone's file is identical, so when the host picks a game, each player's app checks their own folder for the same fingerprint. Only the fingerprint, console and title are shared, never file paths.

To refresh the list of known games, run `node scripts/build-gamedb.mjs`.

## Playing a game

When everyone has the game and is ready, the host clicks **Start game**:

1. Each player's app downloads the emulator the first time (GameCube and Wii use [Dolphin-MPN](https://github.com/MarioPartyNetplay/Dolphin-MPN), the Mario Party Netplay build of Dolphin, about 150 MB).
2. The host's Dolphin opens with the game, hosting a netplay session. The host clicks **Copy** next to the room code in Dolphin's NetPlay window; PartyLink picks it up and sends it to everyone.
3. Friends' Dolphin opens and joins on its own. When everyone is in Dolphin's player list, the host clicks **Start** there.

Dolphin needs Microsoft's Visual C++ runtime; PartyLink checks for it and links the download if it's missing. An Xbox-style controller works as player 1 out of the box.

### N64 (Mupen-MPN)

N64 games run in [Mupen-MPN](https://github.com/MarioPartyNetplay/Mupen-MPN), the Mario Party Netplay build of Mupen64Plus (about 100 MB). RetroArch can't play N64 games online. Mupen-MPN's netplay is only in its own window, so:

1. PartyLink opens Mupen with the player's nickname and games folder filled in, its update check off, and sessions hidden from its public list.
2. The host clicks **Online Play**, then **Host**, and picks the game. PartyLink reads the room code Mupen prints (or one copied with its **Copy** button) and sends it to the party.
3. Each friend's Mupen opens with the code already copied. They click **Online Play**, then **Join**, paste it into Direct connect and join. The host clicks **Start**.

Mupen's settings and saves live in PartyLink's data folder (`mupen-user`).

### PS1, SNES, NES and Mega Drive (RetroArch)

These run in [RetroArch](https://www.retroarch.com/) 1.22.2 with the PCSX ReARMed, Snes9x, FCEUmm and Genesis Plus GX cores. The "Emulator files" workflow (`.github/workflows/emulator-files.yml`) packs RetroArch and those cores from libretro's stable release into one zip and publishes it as the `retroarch-1.22.2` release here, so every player downloads the same files (about 280 MB, checked against the SHA-256 in `apps/web/src/emulators.ts`).

1. The host's RetroArch opens with the game and hosts through libretro's nearest relay server (picked from the PC's time zone), so nobody opens router ports.
2. RetroArch only shares a relay session through libretro's public lobby list, so the room is listed there with a password PartyLink makes for each game. The host's app reads the room back from the list and sends the room and password to the party.
3. Friends' RetroArch opens their own copy of the game and joins; they drop into the game as they connect. Press F1 for RetroArch's menu.

Every player gets the same core settings: PS1 games use the built-in BIOS, and with 3 or more players a multitap is plugged in so games like Crash Bash take 4 players. RetroArch's settings and saves live in PartyLink's data folder (`retroarch-user`).

## Tests

```
pnpm test               # fast unit tests
cargo test --manifest-path apps/desktop/scanner/Cargo.toml     # the games folder scanner
cargo test --manifest-path apps/desktop/emulators/Cargo.toml   # emulator install and launch options
pnpm build              # builds the web app
pnpm test:integration   # starts the real server locally and connects real WebSocket clients
pnpm test:e2e           # drives real browser windows against the real server (run `pnpm build` first)
pnpm typecheck
```

GitHub Actions runs all of these on every pull request.

## Deploying (free Cloudflare plan)

Merges to `main` deploy automatically once two repository secrets are set under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_ACCOUNT_ID`: shown on your Cloudflare dashboard.
- `CLOUDFLARE_API_TOKEN`: create one under **My Profile → API Tokens** with the **Edit Cloudflare Workers** template.

Until they're set, the deploy step is skipped.

## Releasing the Windows app

On GitHub, open **Actions**, pick **Desktop app**, and click **Run workflow**. It builds the installer and publishes a Release named after the `version` in `apps/desktop/src-tauri/tauri.conf.json`. Pushing a version tag such as `v0.1.0` does the same.

Bump that `version` before publishing a new release. The desktop app loads the hosted web app, so most updates reach everyone without a new installer.

## Credits

Game names come from the No-Intro and Redump lists, via [libretro-database](https://github.com/libretro/libretro-database) (CC BY-SA 4.0); the files in `apps/web/public/gamedb` keep that licence. Box art is loaded from [libretro-thumbnails](https://github.com/libretro-thumbnails).

## License

All rights reserved. No license is granted to use, copy, or distribute this code, except the game name lists credited above.
