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
  selectOwnGame,
  setColor,
  setGameCopy,
  setRoomCode,
  startOwnGame,
  endOwnGame,
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
      { id: expect.any(String), name: "Bo", color: expect.any(String), isHost: true, ready: false, connected: true, gameCopy: "checking" },
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

describe("own games", () => {
  const ok: ActionResult = { ok: true };
  const mp2 = { system: "n64" as const, sha1: "166eda1c05670d337e2c3f15a5db528ae1e5d6e3", title: "Mario Party 2 (USA)" };
  const crash = { system: "ps1" as const, sha1: "fce2d66a12d49ec50aa1b93e138da6c6f646eb16", title: "Crash Bash (USA)" };

  it("lets only the host pick one, and replaces any original game", () => {
    const lobby = lobbyWith("Ada", "Bo");
    const [host, guest] = [lobby.seats[0]!.id, lobby.seats[1]!.id];
    selectGame(lobby, host, "trivia-blitz");
    expect(selectOwnGame(lobby, guest, mp2)).toMatchObject({ ok: false, code: "not_host" });
    expect(selectOwnGame(lobby, host, mp2)).toEqual(ok);
    const state = toLobbyState(lobby);
    expect(state.selectedOwnGame).toEqual(mp2);
    expect(state.selectedGameId).toBeNull();

    selectGame(lobby, host, "doodle-dash");
    expect(lobby.selectedOwnGame).toBeNull();
  });

  it("records who has the game and ignores answers about an old pick", () => {
    const lobby = lobbyWith("Ada", "Bo");
    const [host, guest] = [lobby.seats[0]!.id, lobby.seats[1]!.id];
    selectOwnGame(lobby, host, mp2);
    expect(toLobbyState(lobby).players.map((p) => p.gameCopy)).toEqual(["checking", "checking"]);
    setGameCopy(lobby, host, mp2.sha1, "match");
    setGameCopy(lobby, guest, crash.sha1, "match");
    expect(toLobbyState(lobby).players.map((p) => p.gameCopy)).toEqual(["match", "checking"]);
    setGameCopy(lobby, guest, mp2.sha1, "missing");
    expect(lobby.seats[1]!.gameCopy).toBe("missing");
  });

  it("makes everyone check and ready up again when the game changes", () => {
    const lobby = lobbyWith("Ada", "Bo");
    const [host, guest] = [lobby.seats[0]!.id, lobby.seats[1]!.id];
    selectOwnGame(lobby, host, mp2);
    setGameCopy(lobby, guest, mp2.sha1, "match");
    setReady(lobby, guest, true);
    selectOwnGame(lobby, host, mp2);
    expect(lobby.seats[1]).toMatchObject({ ready: true, gameCopy: "match" });
    selectOwnGame(lobby, host, crash);
    expect(lobby.seats[1]).toMatchObject({ ready: false, gameCopy: "checking" });
  });

  it("starts newcomers as checking, and fills the field in for stored rooms", () => {
    const lobby = lobbyWith("Ada");
    selectOwnGame(lobby, lobby.seats[0]!.id, mp2);
    join(lobby, "Cy", undefined, ids(), 5);
    expect(lobby.seats[1]!.gameCopy).toBe("checking");

    const stored = JSON.parse(JSON.stringify(lobbyWith("Old"))) as LobbyData;
    delete (stored as Partial<LobbyData>).selectedOwnGame;
    delete (stored.seats[0] as Partial<LobbyData["seats"][number]>).gameCopy;
    const upgraded = upgradeLobby(stored);
    expect(upgraded.selectedOwnGame).toBeNull();
    expect(upgraded.seats[0]!.gameCopy).toBe("checking");
  });
});

describe("playing an own game", () => {
  const mp4 = { system: "gc" as const, sha1: "f4b287e3d1a9b05ea6cb5e573414f768370e1ed8", title: "Mario Party 4 (USA) (Rev 1)" };

  function readyLobby() {
    const lobby = lobbyWith("Ada", "Bo");
    const [host, guest] = [lobby.seats[0]!.id, lobby.seats[1]!.id];
    selectOwnGame(lobby, host, mp4);
    for (const id of [host, guest]) {
      setGameCopy(lobby, id, mp4.sha1, "match");
      setReady(lobby, id, true);
    }
    return { lobby, host, guest };
  }

  it("starts only when the start check passes", () => {
    const { lobby, host, guest } = readyLobby();
    setReady(lobby, guest, false);
    expect(startOwnGame(lobby, host, 1)).toMatchObject({ ok: false, code: "cannot_start", message: "Waiting for everyone to be ready." });
    setReady(lobby, guest, true);
    expect(startOwnGame(lobby, guest, 1)).toMatchObject({ ok: false, code: "not_host" });
    expect(startOwnGame(lobby, host, 1)).toEqual({ ok: true });
    expect(toLobbyState(lobby).session).toEqual({ roomCode: null, startedAt: 1 });
  });

  it("refuses to start without an own game", () => {
    const lobby = lobbyWith("Ada");
    expect(startOwnGame(lobby, lobby.seats[0]!.id, 1)).toMatchObject({ ok: false, code: "cannot_start" });
  });

  it("shares the host's room code, then ends back in the lobby", () => {
    const { lobby, host, guest } = readyLobby();
    expect(setRoomCode(lobby, host, "a1B2c3D4")).toMatchObject({ ok: false, code: "cannot_start" });
    startOwnGame(lobby, host, 1);
    expect(setRoomCode(lobby, guest, "a1B2c3D4")).toMatchObject({ ok: false, code: "not_host" });
    expect(setRoomCode(lobby, host, "a1B2c3D4")).toEqual({ ok: true });
    expect(lobby.session?.roomCode).toBe("a1B2c3D4");

    expect(endOwnGame(lobby, guest)).toMatchObject({ ok: false, code: "not_host" });
    expect(endOwnGame(lobby, host)).toEqual({ ok: true });
    expect(lobby.session).toBeNull();
    expect(lobby.seats.map((s) => s.ready)).toEqual([false, false]);
    expect(lobby.selectedOwnGame).toEqual(mp4);
  });

  it("ends the game when the host leaves or picks another game", () => {
    const first = readyLobby();
    startOwnGame(first.lobby, first.host, 1);
    selectGame(first.lobby, first.host, "trivia-blitz");
    expect(first.lobby.session).toBeNull();

    const second = readyLobby();
    startOwnGame(second.lobby, second.host, 1);
    leave(second.lobby, second.guest, 2);
    expect(second.lobby.session).not.toBeNull();
    leave(second.lobby, second.host, 3);
    expect(second.lobby.session).toBeNull();
  });
});
