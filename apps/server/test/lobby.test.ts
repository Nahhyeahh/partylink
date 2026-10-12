import { MAX_PLAYERS, SEAT_HOLD_MS } from "@partylink/protocol";
import { describe, expect, it } from "vitest";
import {
  type ActionResult,
  createLobby,
  join,
  type LobbyData,
  leave,
  markDisconnected,
  nextSeatExpiry,
  rejoin,
  releaseExpiredSeats,
  selectGame,
  setColor,
  setReady,
  toLobbyState,
  upgradeLobby,
} from "../src/lobby";

let n = 0;
const ids = () => {
  n++;
  return { id: `p${n}`, token: n.toString(16).padStart(32, "0") };
};

function lobbyWith(...names: string[]): LobbyData {
  const lobby = createLobby("KQZD", 0);
  names.forEach((name, i) => join(lobby, name, undefined, ids(), i));
  return lobby;
}

describe("joining", () => {
  it("makes the first player host", () => {
    const lobby = lobbyWith("Ada", "Bo");
    const state = toLobbyState(lobby);
    expect(state.players.map((p) => [p.name, p.isHost])).toEqual([
      ["Ada", true],
      ["Bo", false],
    ]);
  });

  it("cleans names and refuses empty ones", () => {
    const lobby = createLobby("KQZD", 0);
    expect(join(lobby, "  Ada  ", undefined, ids(), 0)).toMatchObject({ ok: true, seat: { name: "Ada" } });
    expect(join(lobby, "   ", undefined, ids(), 0)).toMatchObject({ ok: false, code: "invalid_name" });
  });

  it("refuses players beyond the limit", () => {
    const lobby = lobbyWith(...Array.from({ length: MAX_PLAYERS }, (_, i) => `P${i}`));
    expect(join(lobby, "Extra", undefined, ids(), 99)).toMatchObject({ ok: false, code: "room_full" });
    expect(lobby.seats).toHaveLength(MAX_PLAYERS);
  });

  it("never exposes tokens in the lobby state", () => {
    const lobby = lobbyWith("Ada");
    expect(JSON.stringify(toLobbyState(lobby))).not.toContain(lobby.seats[0]!.token);
  });
});

describe("disconnects and rejoining", () => {
  it("holds a seat and restores it with the token", () => {
    const lobby = lobbyWith("Ada", "Bo");
    const bo = lobby.seats[1]!;
    markDisconnected(lobby, bo.id, 1000);
    expect(toLobbyState(lobby).players[1]).toMatchObject({ name: "Bo", connected: false });

    expect(rejoin(lobby, bo.token, 2000)).toMatchObject({ ok: true, seat: { id: bo.id } });
    expect(toLobbyState(lobby).players[1]).toMatchObject({ connected: true });
  });

  it("rejects unknown tokens", () => {
    const lobby = lobbyWith("Ada");
    expect(rejoin(lobby, "f".repeat(32), 0)).toMatchObject({ ok: false, code: "invalid_token" });
  });

  it("releases a seat after the hold time, and only then", () => {
    const lobby = lobbyWith("Ada", "Bo");
    const bo = lobby.seats[1]!;
    markDisconnected(lobby, bo.id, 1000);
    expect(nextSeatExpiry(lobby)).toBe(1000 + SEAT_HOLD_MS);

    expect(releaseExpiredSeats(lobby, 1000 + SEAT_HOLD_MS - 1)).toBe(false);
    expect(lobby.seats).toHaveLength(2);

    expect(releaseExpiredSeats(lobby, 1000 + SEAT_HOLD_MS)).toBe(true);
    expect(lobby.seats.map((s) => s.name)).toEqual(["Ada"]);
    expect(rejoin(lobby, bo.token, 1000 + SEAT_HOLD_MS)).toMatchObject({ ok: false, code: "invalid_token" });
  });

  it("tracks when the room became empty", () => {
    const lobby = lobbyWith("Ada", "Bo");
    markDisconnected(lobby, lobby.seats[0]!.id, 10);
    expect(lobby.emptySince).toBeNull();
    markDisconnected(lobby, lobby.seats[1]!.id, 20);
    expect(lobby.emptySince).toBe(20);
    rejoin(lobby, lobby.seats[0]!.token, 30);
    expect(lobby.emptySince).toBeNull();
  });
});

describe("host handover", () => {
  it("passes the host to the longest-standing player when the host leaves", () => {
    const lobby = lobbyWith("Ada", "Bo", "Cy");
    leave(lobby, lobby.seats[0]!.id, 100);
    expect(toLobbyState(lobby).players.find((p) => p.isHost)?.name).toBe("Bo");
  });

  it("prefers a connected player as the new host", () => {
    const lobby = lobbyWith("Ada", "Bo", "Cy");
    markDisconnected(lobby, lobby.seats[1]!.id, 50);
    leave(lobby, lobby.seats[0]!.id, 100);
    expect(toLobbyState(lobby).players.find((p) => p.isHost)?.name).toBe("Cy");
  });

  it("passes the host on when the host's held seat expires", () => {
    const lobby = lobbyWith("Ada", "Bo");
    markDisconnected(lobby, lobby.seats[0]!.id, 0);
    releaseExpiredSeats(lobby, SEAT_HOLD_MS);
    expect(toLobbyState(lobby).players).toEqual([
      { id: expect.any(String), name: "Bo", color: expect.any(String), isHost: true, ready: false, connected: true },
    ]);
  });

  it("leaves no host when the last player leaves", () => {
    const lobby = lobbyWith("Ada");
    leave(lobby, lobby.seats[0]!.id, 5);
    expect(lobby.hostId).toBeNull();
    expect(lobby.emptySince).toBe(5);
  });
});

describe("avatar colours", () => {
  it("gives the preferred colour when it's free, and a different free one when it isn't", () => {
    const lobby = createLobby("KQZD", 0);
    const a = join(lobby, "Ada", "teal", ids(), 0);
    const b = join(lobby, "Bo", "teal", ids(), 1);
    expect(a).toMatchObject({ ok: true, seat: { color: "teal" } });
    expect(b.ok && b.seat.color).not.toBe("teal");
  });

  it("gives every player in a full room a different colour", () => {
    const lobby = createLobby("KQZD", 0);
    for (let i = 0; i < MAX_PLAYERS; i++) join(lobby, `P${i}`, "coral", ids(), i);
    expect(new Set(lobby.seats.map((s) => s.color)).size).toBe(MAX_PLAYERS);
  });

  it("refuses a colour someone else has", () => {
    const lobby = lobbyWith("Ada", "Bo");
    const [ada, bo] = lobby.seats as [(typeof lobby.seats)[0], (typeof lobby.seats)[0]];
    expect(setColor(lobby, bo.id, ada.color)).toMatchObject({ ok: false, code: "color_taken" });
    expect(setColor(lobby, bo.id, bo.color)).toEqual({ ok: true });
  });
});

describe("ready and game selection", () => {
  const ok: ActionResult = { ok: true };

  it("lets players mark themselves ready", () => {
    const lobby = lobbyWith("Ada", "Bo");
    expect(setReady(lobby, lobby.seats[1]!.id, true)).toEqual(ok);
    expect(toLobbyState(lobby).players.map((p) => p.ready)).toEqual([false, true]);
  });

  it("only lets the host pick the game", () => {
    const lobby = lobbyWith("Ada", "Bo");
    expect(selectGame(lobby, lobby.seats[1]!.id, "trivia-blitz")).toMatchObject({ ok: false, code: "not_host" });
    expect(selectGame(lobby, lobby.seats[0]!.id, "trivia-blitz")).toEqual(ok);
    expect(toLobbyState(lobby).selectedGameId).toBe("trivia-blitz");
  });

  it("refuses unknown games", () => {
    const lobby = lobbyWith("Ada");
    expect(selectGame(lobby, lobby.seats[0]!.id, "nope")).toMatchObject({ ok: false, code: "unknown_game" });
  });

  it("clears everyone's ready state when the game changes, but not when it stays the same", () => {
    const lobby = lobbyWith("Ada", "Bo");
    const host = lobby.seats[0]!.id;
    selectGame(lobby, host, "trivia-blitz");
    for (const s of lobby.seats) setReady(lobby, s.id, true);
    selectGame(lobby, host, "trivia-blitz");
    expect(lobby.seats.every((s) => s.ready)).toBe(true);
    selectGame(lobby, host, "doodle-dash");
    expect(lobby.seats.some((s) => s.ready)).toBe(false);
  });
});

describe("stored rooms from before this version", () => {
  it("are upgraded with defaults", () => {
    const old = { code: "KQZD", createdAt: 0, hostId: "p1", seats: [{ id: "p1", name: "Ada", token: "t", joinedAt: 0, connected: true, disconnectedAt: null }], emptySince: null };
    const lobby = upgradeLobby(old as unknown as Parameters<typeof upgradeLobby>[0]);
    expect(toLobbyState(lobby)).toMatchObject({ selectedGameId: null, players: [{ name: "Ada", ready: false, color: "coral" }] });
  });
});
