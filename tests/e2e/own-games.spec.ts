import { type Browser, expect, type Page, test } from "@playwright/test";

// These tests stand in for the desktop app: they give the page the same bridge
// Tauri injects, answering the folder commands with a pretend games folder.
// The scanner itself is tested in apps/desktop/scanner.

interface FakeGame {
  path: string;
  fileName: string;
  system: string;
  size: number;
  sha1: string;
  discId?: string;
  discRevision?: number;
}

const CRASH_BASH: FakeGame = {
  path: "C:\\Games\\PS1\\Crash Bash (USA).cue",
  fileName: "Crash Bash (USA).cue",
  system: "ps1",
  size: 178220448,
  sha1: "fce2d66a12d49ec50aa1b93e138da6c6f646eb16",
};

// A compressed GameCube image: its fingerprint isn't in the known list, so it
// is named from the disc id instead.
const MARIO_PARTY_4: FakeGame = {
  path: "C:\\Games\\GC\\mp4.rvz",
  fileName: "mp4.rvz",
  system: "gc",
  size: 900000000,
  sha1: "0123456789abcdef0123456789abcdef01234567",
  discId: "GMPE01",
  discRevision: 1,
};

async function fakeDesktop(page: Page, folder: string | null, games: FakeGame[], roomCode = "a1B2c3D4") {
  await page.addInitScript(
    ({ folder, games, roomCode }) => {
      let saved = folder;
      let next = 1;
      let installed = false;
      let clipboard: string | null = "OLDCODE1";
      const listeners: Record<string, number[]> = {};
      const w = window as unknown as Record<string, unknown>;
      const calls: { cmd: string; args: unknown }[] = [];
      w.__calls = calls;
      const emit = (event: string, payload: unknown) => {
        for (const id of listeners[event] ?? []) {
          (w[`_${id}`] as (e: unknown) => void)?.({ event, id, payload });
        }
      };
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      w.__TAURI_INTERNALS__ = {
        transformCallback(callback: unknown) {
          const id = next++;
          w[`_${id}`] = callback;
          return id;
        },
        unregisterCallback() {},
        async invoke(cmd: string, args: Record<string, unknown>) {
          calls.push({ cmd, args });
          switch (cmd) {
            case "get_games_folder":
              return saved;
            case "choose_games_folder":
              saved = "C:\\Games";
              return saved;
            case "scan_games":
              return { games, skipped: ["C:\\Games\\notes.bin"] };
            case "plugin:event|listen":
              (listeners[args.event as string] ??= []).push(args.handler as number);
              return next++;
            case "plugin:event|unlisten":
              return null;
            case "needs_vc_runtime":
              return false;
            case "emulator_installed":
              return installed;
            case "install_emulator":
              emit("emulator-install-progress", { emulator: "dolphin-mpn", phase: "download", done: 50, total: 100 });
              await new Promise((r) => setTimeout(r, 300));
              installed = true;
              return null;
            case "launch_dolphin":
              // The host's Dolphin opens; a moment later the player clicks Copy.
              if ((args.launch as { mode: string }).mode === "host") setTimeout(() => (clipboard = roomCode), 500);
              return null;
            case "read_dolphin_room_code":
              return clipboard;
            default:
              throw new Error(`unexpected command ${cmd}`);
          }
        },
      };
    },
    { folder, games, roomCode },
  );
}

const launches = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as { __calls: { cmd: string; args: { launch: unknown; nickname: string } }[] }).__calls ?? [])
      .filter((c) => c.cmd === "launch_dolphin")
      .map((c) => ({ ...(c.args.launch as object), nickname: c.args.nickname })),
  );

async function newPlayer(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  return context.newPage();
}

const playerRow = (page: Page, name: string) => page.locator(".players li", { hasText: name });

test("the desktop app finds games in the chosen folder", async ({ browser }) => {
  const page = await newPlayer(browser);
  await fakeDesktop(page, null, [CRASH_BASH, MARIO_PARTY_4]);
  await page.goto("/");
  await page.getByRole("tab", { name: "Games" }).click();

  await page.getByRole("button", { name: "Choose games folder" }).click();
  await expect(page.locator(".folder-path")).toHaveText("C:\\Games");
  await expect(page.locator(".game-card", { hasText: "Crash Bash (USA)" })).toContainText("Matches a known clean copy");
  await expect(page.locator(".game-card", { hasText: "Mario Party 4 (USA) (Rev 1)" })).toContainText("Not in the known-games list");
  await expect(page.getByText("1 file wasn't recognised")).toBeVisible();

  await page.getByRole("button", { name: "GameCube" }).click();
  await expect(page.locator(".my-games .game-card")).toHaveCount(1);
  await page.getByRole("button", { name: /^All/ }).click();
  await page.getByLabel("Search your games").fill("crash");
  await expect(page.locator(".my-games .game-card")).toHaveCount(1);
});

test("a browser explains that your own games need the app", async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.goto("/");
  await page.getByRole("tab", { name: "Games" }).click();
  await expect(page.getByRole("link", { name: "Download PartyLink for Windows" })).toBeVisible();
});

test("the lobby checks everyone has the host's game", async ({ browser }) => {
  const host = await newPlayer(browser);
  const friend = await newPlayer(browser);
  const browserFriend = await newPlayer(browser);
  await fakeDesktop(host, "C:\\Games", [CRASH_BASH, MARIO_PARTY_4]);
  await fakeDesktop(friend, "D:\\Roms", [CRASH_BASH]);

  await host.goto("/");
  await host.getByLabel("Your name").fill("Adrian");
  await host.getByRole("button", { name: "Create a party" }).click();
  const code = (await host.locator(".room-code").textContent())?.trim() ?? "";

  for (const [page, name] of [
    [friend, "Sam"],
    [browserFriend, "Kai"],
  ] as const) {
    await page.goto(`/?room=${code}`);
    await page.getByLabel("Your name").fill(name);
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await expect(playerRow(host, name)).toBeVisible();
  }

  await host.getByRole("button", { name: "Choose" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Mario Party 4/ }).click();
  await expect(friend.locator(".game-card")).toContainText("Mario Party 4");

  await expect(playerRow(host, "Adrian")).toContainText("Has the game");
  await expect(playerRow(host, "Sam")).toContainText("Missing the game");
  await expect(playerRow(host, "Kai")).toContainText("Needs the app");
  await expect(host.getByText("Kai needs the PartyLink app to play Mario Party 4 (USA) (Rev 1).")).toBeVisible();

  // Switching to a game Sam has.
  await host.getByRole("button", { name: "Change" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Crash Bash/ }).click();
  await expect(playerRow(host, "Sam")).toContainText("Has the game");

  await browserFriend.getByRole("button", { name: "Leave party" }).click();
  await host.getByRole("button", { name: "I'm ready" }).click();
  await friend.getByRole("button", { name: "I'm ready" }).click();
  // Everyone has it, but PlayStation games can't be started yet, and the lobby says so.
  await expect(host.getByText("Starting PlayStation games arrives in a later update.")).toBeVisible();
  await expect(host.getByRole("button", { name: "Start game" })).toBeDisabled();
});

test("starting a GameCube game opens Dolphin for everyone", async ({ browser }) => {
  const MP4_ISO: FakeGame = { ...MARIO_PARTY_4, sha1: "f4b287e3d1a9b05ea6cb5e573414f768370e1ed8", path: "C:\\Games\\mp4.iso" };
  const host = await newPlayer(browser);
  const friend = await newPlayer(browser);
  await fakeDesktop(host, "C:\\Games", [MP4_ISO, CRASH_BASH]);
  await fakeDesktop(friend, "D:\\Roms", [MP4_ISO]);

  await host.goto("/");
  await host.getByLabel("Your name").fill("Adrian");
  await host.getByRole("button", { name: "Create a party" }).click();
  const code = (await host.locator(".room-code").textContent())?.trim() ?? "";
  await friend.goto(`/?room=${code}`);
  await friend.getByLabel("Your name").fill("Sam");
  await friend.getByRole("button", { name: "Join", exact: true }).click();
  await expect(playerRow(host, "Sam")).toBeVisible();

  // PlayStation games can be picked but not started yet.
  await host.getByRole("button", { name: "Choose" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Crash Bash/ }).click();
  await expect(host.getByText("Starting PlayStation games arrives in a later update.")).toBeVisible();

  await host.getByRole("button", { name: "Change" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Mario Party 4/ }).click();
  await expect(playerRow(host, "Sam")).toContainText("Has the game");
  await host.getByRole("button", { name: "I'm ready" }).click();
  await friend.getByRole("button", { name: "I'm ready" }).click();
  await host.getByRole("button", { name: "Start game" }).click();

  // Both download Dolphin, the host's opens hosting, and the room code reaches the friend.
  await expect(host.getByRole("heading", { name: /Playing Mario Party 4/ })).toBeVisible();
  await expect(host.locator(".steps")).toContainText("sent: a1B2c3D4");
  await expect(friend.getByText("Dolphin is open and joining Adrian's game.", { exact: false })).toBeVisible();
  expect(await launches(host)).toEqual([{ mode: "host", sha1: MP4_ISO.sha1, nickname: "Adrian" }]);
  expect(await launches(friend)).toEqual([{ mode: "join", code: "a1B2c3D4", nickname: "Sam" }]);

  // Ending the game brings everyone back to the lobby.
  await host.getByRole("button", { name: "End game" }).click();
  await expect(friend.getByRole("heading", { name: /Playing/ })).toHaveCount(0);
  await expect(host.getByRole("button", { name: "Start game" })).toBeDisabled();
});
