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

const POKEMON_EMERALD: FakeGame = {
  path: "C:\\Games\\GBA\\Pokemon Emerald (USA).gba",
  fileName: "Pokemon Emerald (USA).gba",
  system: "gba",
  size: 16777216,
  sha1: "2222222222222222222222222222222222222222",
};

const MARIO_PARTY_2: FakeGame = {
  path: "C:\\Games\\N64\\Mario Party 2 (USA).z64",
  fileName: "Mario Party 2 (USA).z64",
  system: "n64",
  size: 33554432,
  sha1: "1111111111111111111111111111111111111111",
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

async function fakeDesktop(
  page: Page,
  folder: string | null,
  games: FakeGame[],
  roomCode = "a1B2c3D4",
  { version = "0.3.4", relayFailsFirst = false, ownRelayOn = false } = {},
) {
  await page.addInitScript(
    ({ folder, games, roomCode, version, relayFailsFirst, ownRelayOn }) => {
      let hostLaunches = 0;
      let saved = folder;
      let next = 1;
      let installed = false;
      let clipboard: string | null = "OLDCODE1";
      // RetroArch's lobby list: a room from an earlier game until the host's opens.
      let retroRoom: string | null = "relay.example.org|55435|OldSession==";
      let mupenCode: string | null = null;
      const listeners: Record<string, number[]> = {};
      const w = window as unknown as Record<string, unknown>;
      const calls: { cmd: string; args: unknown }[] = [];
      w.__calls = calls;
      w.__clipboard = () => clipboard;
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
            case "launch_retroarch":
              // The first try can fail to reach the relay server, leaving no relayed room.
              if ((args.launch as { mode: string }).mode === "host" && !(relayFailsFirst && hostLaunches++ === 0)) {
                const own = (args.launch as { relay: string }).relay.startsWith("own:");
                const room = own ? "52.63.252.122|55435|OwnSession==" : "relay.example.org|55435|NewSession==";
                setTimeout(() => (retroRoom = room), 500);
              }
              return null;
            case "relay_reachable":
              return ownRelayOn;
            case "close_emulator":
              return null;
            case "plugin:app|version":
              return version;
            case "find_retroarch_room":
              return retroRoom;
            case "launch_mupen":
              // The host makes a room in Mupen's window; Mupen prints its code.
              setTimeout(() => (mupenCode = "0A1B2C3"), 500);
              return null;
            case "read_mupen_room_code":
              return mupenCode;
            case "copy_mupen_room_code":
              clipboard = args.code as string;
              return null;
            default:
              throw new Error(`unexpected command ${cmd}`);
          }
        },
      };
    },
    { folder, games, roomCode, version, relayFailsFirst, ownRelayOn },
  );
}

const launches = (page: Page, cmd = "launch_dolphin") =>
  page.evaluate(
    (cmd) =>
      (
        (window as unknown as { __calls: { cmd: string; args: { launch: unknown; nickname: string; players?: number } }[] })
          .__calls ?? []
      )
        .filter((c) => c.cmd === cmd)
        .map((c) => ({
          ...(c.args.launch as object),
          nickname: c.args.nickname,
          ...(c.args.players ? { players: c.args.players } : {}),
        })),
    cmd,
  );

async function newPlayer(browser: Browser, timezoneId = "Europe/London"): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId });
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
  await expect(host.getByRole("button", { name: "Start game" })).toBeDisabled();
  await friend.getByRole("button", { name: "I'm ready" }).click();
  await expect(host.getByRole("button", { name: "Start game" })).toBeEnabled();
});

test("starting a GameCube game opens Dolphin for everyone", async ({ browser }) => {
  const MP4_ISO: FakeGame = { ...MARIO_PARTY_4, sha1: "f4b287e3d1a9b05ea6cb5e573414f768370e1ed8", path: "C:\\Games\\mp4.iso" };
  const host = await newPlayer(browser);
  const friend = await newPlayer(browser);
  await fakeDesktop(host, "C:\\Games", [MP4_ISO, POKEMON_EMERALD]);
  await fakeDesktop(friend, "D:\\Roms", [MP4_ISO]);

  await host.goto("/");
  await host.getByLabel("Your name").fill("Adrian");
  await host.getByRole("button", { name: "Create a party" }).click();
  const code = (await host.locator(".room-code").textContent())?.trim() ?? "";
  await friend.goto(`/?room=${code}`);
  await friend.getByLabel("Your name").fill("Sam");
  await friend.getByRole("button", { name: "Join", exact: true }).click();
  await expect(playerRow(host, "Sam")).toBeVisible();

  // GBA games can be picked but not started.
  await host.getByRole("button", { name: "Choose" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Pokemon Emerald/ }).click();
  await expect(host.getByText("Starting Game Boy Advance games arrives in a later update.")).toBeVisible();

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

test("starting a PS1 game opens RetroArch for everyone", async ({ browser }) => {
  const host = await newPlayer(browser);
  const friend = await newPlayer(browser, "America/Chicago");
  await fakeDesktop(host, "C:\\Games", [CRASH_BASH]);
  await fakeDesktop(friend, "D:\\Roms", [{ ...CRASH_BASH, path: "D:\\Roms\\crash.cue" }]);

  await host.goto("/");
  await host.getByLabel("Your name").fill("Adrian");
  await host.getByRole("button", { name: "Create a party" }).click();
  const code = (await host.locator(".room-code").textContent())?.trim() ?? "";
  await friend.goto(`/?room=${code}`);
  await friend.getByLabel("Your name").fill("Sam");
  await friend.getByRole("button", { name: "Join", exact: true }).click();

  await host.getByRole("button", { name: "Choose" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Crash Bash/ }).click();
  await expect(playerRow(host, "Sam")).toContainText("Has the game");
  await host.getByRole("button", { name: "I'm ready" }).click();
  await friend.getByRole("button", { name: "I'm ready" }).click();
  await host.getByRole("button", { name: "Start game" }).click();

  // The host's RetroArch opens and its new relay room (not the old one) reaches the friend.
  await expect(friend.getByText("RetroArch is open and joining Adrian's game.", { exact: false })).toBeVisible();
  await expect(host.getByText("Your friends' RetroArch is joining.", { exact: false })).toBeVisible();
  const [hostLaunch] = await launches(host, "launch_retroarch");
  expect(hostLaunch).toMatchObject({ mode: "host", sha1: CRASH_BASH.sha1, relay: "madrid", nickname: "Adrian", players: 2 });
  const password = (hostLaunch as unknown as { password: string }).password;
  expect(password).toMatch(/^[a-z0-9]{8}$/);
  // RetroArch always asks joining players for the password, so they're shown it.
  await expect(friend.locator("code.password")).toHaveText(password);
  await expect(host.locator("code.password")).toHaveText(password);
  expect(await launches(friend, "launch_retroarch")).toEqual([
    {
      mode: "join",
      sha1: CRASH_BASH.sha1,
      code: `relay.example.org|55435|NewSession==|${password}`,
      nickname: "Sam",
      players: 2,
    },
  ]);
});

test("starting an N64 game opens Mupen and hands friends the room code", async ({ browser }) => {
  const host = await newPlayer(browser);
  const friend = await newPlayer(browser);
  await fakeDesktop(host, "C:\\Games", [MARIO_PARTY_2]);
  await fakeDesktop(friend, "D:\\Roms", [MARIO_PARTY_2]);

  await host.goto("/");
  await host.getByLabel("Your name").fill("Adrian");
  await host.getByRole("button", { name: "Create a party" }).click();
  const code = (await host.locator(".room-code").textContent())?.trim() ?? "";
  await friend.goto(`/?room=${code}`);
  await friend.getByLabel("Your name").fill("Sam");
  await friend.getByRole("button", { name: "Join", exact: true }).click();

  await host.getByRole("button", { name: "Choose" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Mario Party 2/ }).click();
  await expect(playerRow(host, "Sam")).toContainText("Has the game");
  await host.getByRole("button", { name: "I'm ready" }).click();
  await friend.getByRole("button", { name: "I'm ready" }).click();
  await host.getByRole("button", { name: "Start game" }).click();

  // The host's Mupen prints the room code; the friend's app opens Mupen and copies it.
  await expect(host.locator(".steps")).toContainText("Online Play");
  await expect(host.locator(".steps")).toContainText("sent: 0A1B2C3");
  await expect(friend.getByText("Paste the code into Direct connect", { exact: false })).toBeVisible();
  expect(await friend.evaluate(() => (window as unknown as { __clipboard: () => string }).__clipboard())).toBe("0A1B2C3");
  expect(await launches(host, "launch_mupen")).toEqual([{ nickname: "Adrian" }]);
  expect(await launches(friend, "launch_mupen")).toEqual([{ nickname: "Sam" }]);
});

test("the host's RetroArch reopens when the relay server doesn't take its room", async ({ browser }) => {
  test.setTimeout(60000);
  const host = await newPlayer(browser);
  const friend = await newPlayer(browser, "America/Chicago");
  await fakeDesktop(host, "C:\\Games", [CRASH_BASH], undefined, { relayFailsFirst: true });
  await fakeDesktop(friend, "D:\\Roms", [{ ...CRASH_BASH, path: "D:\\Roms\\crash.cue" }]);

  await host.goto("/");
  await host.getByLabel("Your name").fill("Adrian");
  await host.getByRole("button", { name: "Create a party" }).click();
  const code = (await host.locator(".room-code").textContent())?.trim() ?? "";
  await friend.goto(`/?room=${code}`);
  await friend.getByLabel("Your name").fill("Sam");
  await friend.getByRole("button", { name: "Join", exact: true }).click();

  await host.getByRole("button", { name: "Choose" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Crash Bash/ }).click();
  await expect(playerRow(host, "Sam")).toContainText("Has the game");
  await host.getByRole("button", { name: "I'm ready" }).click();
  await friend.getByRole("button", { name: "I'm ready" }).click();
  await host.getByRole("button", { name: "Start game" }).click();

  await expect(friend.getByText("RetroArch is open and joining Adrian's game.", { exact: false })).toBeVisible({
    timeout: 40000,
  });
  expect(await launches(host, "launch_retroarch")).toHaveLength(2);
  expect(await launches(host, "close_emulator")).toHaveLength(1);
  const [join] = await launches(friend, "launch_retroarch");
  expect((join as unknown as { code: string }).code).toMatch(/^relay\.example\.org\|55435\|NewSession==\|/);
});

async function startCrashBashParty(browser: Browser, hostOptions: Parameters<typeof fakeDesktop>[4]) {
  const host = await newPlayer(browser);
  const friend = await newPlayer(browser, "Australia/Sydney");
  await fakeDesktop(host, "C:\\Games", [CRASH_BASH], undefined, hostOptions);
  await fakeDesktop(friend, "D:\\Roms", [{ ...CRASH_BASH, path: "D:\\Roms\\crash.cue" }], undefined, {
    version: "0.3.5",
  });

  await host.goto("/");
  await host.getByLabel("Your name").fill("Adrian");
  await host.getByRole("button", { name: "Create a party" }).click();
  const code = (await host.locator(".room-code").textContent())?.trim() ?? "";
  await friend.goto(`/?room=${code}`);
  await friend.getByLabel("Your name").fill("Sam");
  await friend.getByRole("button", { name: "Join", exact: true }).click();

  await host.getByRole("button", { name: "Choose" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Crash Bash/ }).click();
  await expect(playerRow(host, "Sam")).toContainText("Has the game");
  await host.getByRole("button", { name: "I'm ready" }).click();
  await friend.getByRole("button", { name: "I'm ready" }).click();
  await host.getByRole("button", { name: "Start game" }).click();
  await expect(friend.getByText("RetroArch is open and joining Adrian's game.", { exact: false })).toBeVisible();
  return { host, friend };
}

test("RetroArch games go through the party's own relay when it's on", async ({ browser }) => {
  const { host, friend } = await startCrashBashParty(browser, { version: "0.3.5", ownRelayOn: true });
  const [hostLaunch] = await launches(host, "launch_retroarch");
  expect(hostLaunch).toMatchObject({ mode: "host", relay: "own:52.63.252.122:55435" });
  const [join] = await launches(friend, "launch_retroarch");
  expect(join).toMatchObject({ mode: "join", near: true });
  expect((join as unknown as { code: string }).code).toMatch(/^52\.63\.252\.122\|55435\|OwnSession==\|/);
  await expect(host.getByText("relay server is switched off", { exact: false })).toHaveCount(0);
});

test("RetroArch games use libretro's relay when the party's own is off", async ({ browser }) => {
  const { host, friend } = await startCrashBashParty(browser, { version: "0.3.5", ownRelayOn: false });
  const [hostLaunch] = await launches(host, "launch_retroarch");
  expect(hostLaunch).toMatchObject({ mode: "host", relay: "madrid" });
  await expect(host.getByText("The Sydney relay server is switched off", { exact: false })).toBeVisible();
  const [join] = await launches(friend, "launch_retroarch");
  expect(join).not.toHaveProperty("near");
});
