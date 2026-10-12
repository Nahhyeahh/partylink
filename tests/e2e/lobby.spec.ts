import { type Browser, devices, expect, type Page, test } from "@playwright/test";

async function newPlayer(browser: Browser, mobile = false): Promise<Page> {
  const context = await browser.newContext(mobile ? { ...devices["Pixel 7"] } : { viewport: { width: 1280, height: 800 } });
  return context.newPage();
}

const playerRow = (page: Page, name: string) => page.locator(".players li", { hasText: name });

test("two players meet in a lobby, pick a game, and ready up", async ({ browser }) => {
  const host = await newPlayer(browser);
  const guest = await newPlayer(browser, true);

  // The host creates a party.
  await host.goto("/");
  await host.getByLabel("Your name").fill("Adrian");
  await host.getByRole("radio", { name: "teal" }).click();
  await host.getByRole("button", { name: "Create a party" }).click();
  const code = (await host.locator(".room-code").textContent())?.trim() ?? "";
  expect(code).toMatch(/^[A-Z]{4}$/);
  await expect(host.locator(".status")).toHaveText("Connected");

  // A friend opens the invite link on a phone and joins with the same colour preference.
  await guest.goto(`/?room=${code}`);
  await guest.getByLabel("Your name").fill("Sam");
  await guest.getByRole("radio", { name: "teal" }).click();
  await guest.getByRole("button", { name: "Join", exact: true }).click();

  await expect(playerRow(host, "Sam")).toBeVisible();
  await expect(playerRow(guest, "Adrian")).toContainText("Host");

  // Colours are unique: the guest got a different one.
  const hostColor = await playerRow(host, "Adrian").locator(".avatar").evaluate((el) => getComputedStyle(el).backgroundColor);
  const guestColor = await playerRow(host, "Sam").locator(".avatar").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(guestColor).not.toBe(hostColor);

  // Only the host can choose the game; everyone sees the choice.
  await expect(guest.getByRole("button", { name: "Choose" })).toHaveCount(0);
  await host.getByRole("button", { name: "Choose" }).click();
  await host.locator(".game-picker").getByRole("button", { name: /Trivia Blitz/ }).click();
  await expect(guest.locator(".game-card")).toContainText("Trivia Blitz");

  // Ready states sync both ways.
  await guest.getByRole("button", { name: "I'm ready" }).click();
  await expect(playerRow(host, "Sam")).toContainText("Ready");
  await host.getByRole("button", { name: "I'm ready" }).click();
  await expect(playerRow(guest, "Adrian")).toContainText("Ready");

  // No game is playable yet, and the lobby says so instead of pretending.
  await expect(host.getByRole("button", { name: "Start game" })).toBeDisabled();
  await expect(host.getByText("Trivia Blitz isn't playable yet.")).toBeVisible();

  // Refreshing the guest's page keeps their seat and ready state.
  await guest.reload();
  await expect(guest.locator(".status")).toHaveText("Connected");
  await expect(host.locator(".players li")).toHaveCount(2);
  await expect(playerRow(host, "Sam")).toContainText("Ready");

  // When the host leaves, the guest becomes host.
  await host.getByRole("button", { name: "Leave party" }).click();
  await expect(playerRow(guest, "Sam")).toContainText("Host");
  await expect(guest.locator(".players li")).toHaveCount(1);
});

test("joining a party that doesn't exist shows a clear message", async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.goto("/");
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Room code").fill("ZZZZ");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("No party found with code ZZZZ.");
});

test("the game library lists every game with its player count", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Games" }).click();
  await expect(page.getByRole("heading", { name: "Game library" })).toBeVisible();
  await expect(page.locator(".game-grid .game-card")).toHaveCount(6);
  await expect(page.locator(".game-card", { hasText: "Trivia Blitz" })).toContainText("2–8 players");
});
