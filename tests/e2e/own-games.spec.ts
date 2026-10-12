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

async function fakeDesktop(page: Page, folder: string | null, games: FakeGame[]) {
  await page.addInitScript(
    ({ folder, games }) => {
      let saved = folder;
      let next = 1;
      const w = window as unknown as Record<string, unknown>;
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      w.__TAURI_INTERNALS__ = {
        transformCallback(callback: unknown) {
          const id = next++;
          w[`_${id}`] = callback;
          return id;
        },
        unregisterCallback() {},
        async invoke(cmd: string) {
          switch (cmd) {
            case "get_games_folder":
              return saved;
            case "choose_games_folder":
              saved = "C:\\Games";
              return saved;
            case "scan_games":
              return { games, skipped: ["C:\\Games\\notes.bin"] };
            case "plugin:event|listen":
              return next++;
            default:
              throw new Error(`unexpected command ${cmd}`);
          }
        },
      };
    },
    { folder, games },
  );
}

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
  await host.locator(".game-picker").getByRole("button", { name: /Crash Bash/ }).click();
  await expect(friend.locator(".game-card")).toContainText("Crash Bash (USA)");

  await expect(playerRow(host, "Adrian")).toContainText("Has the game");
  await expect(playerRow(host, "Sam")).toContainText("Has the game");
  await expect(playerRow(host, "Kai")).toContainText("Needs the app");
  await expect(host.getByText("Kai needs the PartyLink app to play Crash Bash (USA).")).toBeVisible();

  // Switching to a game Sam doesn't have.
  await host.getByRole("button", { name: "Change" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Mario Party 4/ }).click();
  await expect(playerRow(host, "Sam")).toContainText("Missing the game");

  await host.getByRole("button", { name: "Change" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Crash Bash/ }).click();
  await browserFriend.getByRole("button", { name: "Leave party" }).click();
  await expect(host.getByText("Waiting for everyone to be ready.")).toBeVisible();

  await host.getByRole("button", { name: "I'm ready" }).click();
  await friend.getByRole("button", { name: "I'm ready" }).click();
  await expect(host.getByText("Everyone's set.", { exact: false })).toBeVisible();
  await expect(host.getByRole("button", { name: "Start game" })).toBeDisabled();
});
