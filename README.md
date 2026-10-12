# PartyLink

Party games for friends who live in different places. Create a party, share the 4-letter code, and play together from your PCs or phones.

> **Status:** early development. You can create a party, have friends join by code or invite link, pick avatar colours, mark yourselves ready, and the host can choose a game. The games themselves come next, starting with Trivia Blitz.

**Play in a browser:** https://partylink.adrianpaintaway.workers.dev

**Windows app:** download the latest `PartyLink_..._x64-setup.exe` from [Releases](../../releases). Windows may say "Windows protected your PC" because the installer isn't signed yet; click **More info**, then **Run anyway**.

## How it's built

| Part | Folder | What it is |
| --- | --- | --- |
| Web app | `apps/web` | React + TypeScript. The home screen, game library, lobby, and (later) games and phone controllers. |
| Desktop app | `apps/desktop` | A Tauri 2 window around the hosted web app, built into a Windows installer by GitHub Actions. |
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

## Tests

```
pnpm test               # fast unit tests
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

Push a version tag and GitHub Actions builds the installer and publishes a Release:

```
git tag v0.1.0
git push origin v0.1.0
```

Bump `version` in `apps/desktop/src-tauri/tauri.conf.json` before tagging a new release. The desktop app loads the hosted web app, so most updates reach everyone without a new installer.

## License

All rights reserved. No license is granted to use, copy, or distribute this code.
