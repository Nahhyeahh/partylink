import { describe, expect, it } from "vitest";
import { canStart, canStartOwnGame, GAMES, type GameInfo, getGame } from "../src/index";

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

describe("canStartOwnGame", () => {
  const game = { title: "Mario Party 2 (USA)" };
  type Copy = "checking" | "match" | "missing" | "no-app";
  const p = (name: string, gameCopy: Copy, ready = true, connected = true) => ({ name, gameCopy, ready, connected });

  it("starts when everyone has the same copy and is ready", () => {
    expect(canStartOwnGame(game, [p("Adrian", "match"), p("Sam", "match")])).toEqual({ ok: true });
  });

  it("names who is in a browser", () => {
    expect(canStartOwnGame(game, [p("Adrian", "match"), p("Sam", "no-app")])).toEqual({
      ok: false,
      reason: "Sam needs the PartyLink app to play Mario Party 2 (USA).",
    });
  });

  it("names everyone missing the game", () => {
    expect(canStartOwnGame(game, [p("Adrian", "match"), p("Sam", "missing"), p("Kai", "missing"), p("Jo", "missing")])).toEqual({
      ok: false,
      reason: "Sam, Kai and Jo don't have the same copy of Mario Party 2 (USA).",
    });
  });

  it("waits for answers, then for ready", () => {
    expect(canStartOwnGame(game, [p("Adrian", "match"), p("Sam", "checking")])).toMatchObject({ ok: false, reason: "Checking everyone has the game…" });
    expect(canStartOwnGame(game, [p("Adrian", "match"), p("Sam", "match", false)])).toMatchObject({
      ok: false,
      reason: "Waiting for everyone to be ready.",
    });
  });

  it("ignores disconnected players and caps the party at four", () => {
    expect(canStartOwnGame(game, [p("Adrian", "match"), p("Gone", "missing", false, false)])).toEqual({ ok: true });
    const five = ["A", "B", "C", "D", "E"].map((n) => p(n, "match"));
    expect(canStartOwnGame(game, five)).toMatchObject({ ok: false, reason: "Console games allow at most 4 players." });
  });
});
