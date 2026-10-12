import { describe, expect, it } from "vitest";
import { canStart, GAMES, type GameInfo, getGame } from "../src/index";

describe("catalogue", () => {
  it("has unique, URL-safe ids", () => {
    const ids = GAMES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
  });

  it("has sensible player limits", () => {
    for (const g of GAMES) {
      expect(g.minPlayers).toBeGreaterThanOrEqual(1);
      expect(g.maxPlayers).toBeGreaterThanOrEqual(g.minPlayers);
      expect(g.maxPlayers).toBeLessThanOrEqual(8);
    }
  });

  it("looks games up by id", () => {
    expect(getGame("trivia-blitz")?.name).toBe("Trivia Blitz");
    expect(getGame("nope")).toBeUndefined();
  });
});

describe("canStart", () => {
  const playable: GameInfo = { ...GAMES[0]!, availability: "playable", minPlayers: 2, maxPlayers: 3 };
  const p = (ready: boolean, connected = true) => ({ ready, connected });

  it("needs a game", () => {
    expect(canStart(undefined, [p(true), p(true)])).toMatchObject({ ok: false });
  });

  it("refuses games that aren't playable yet", () => {
    expect(canStart({ ...playable, availability: "coming-soon" }, [p(true), p(true)])).toMatchObject({ ok: false });
  });

  it("enforces player limits, counting only connected players", () => {
    expect(canStart(playable, [p(true), p(true, false)])).toMatchObject({ ok: false });
    expect(canStart(playable, [p(true), p(true), p(true), p(true)])).toMatchObject({ ok: false });
  });

  it("waits for everyone to be ready", () => {
    expect(canStart(playable, [p(true), p(false)])).toEqual({ ok: false, reason: "Waiting for everyone to be ready." });
    expect(canStart(playable, [p(true), p(true)])).toEqual({ ok: true });
  });
});
