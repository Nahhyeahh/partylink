// Starts the real Worker and Room Durable Object locally with `wrangler dev`,
// then connects real WebSocket clients to it. Nothing here is simulated.
import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseServerMessage, type ServerMessage } from "@partylink/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let wrangler: ChildProcess;

beforeAll(async () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  wrangler = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", ".wrangler/test-state"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  let output = "";
  wrangler.stdout?.on("data", (d) => (output += d));
  wrangler.stderr?.on("data", (d) => (output += d));
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/rooms/BBBB`);
      if (res.status === 404) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`wrangler dev did not start:\n${output}`);
}, 90_000);

afterAll(() => {
  wrangler?.kill();
});

/** A real WebSocket client that records every message the server sends it. */
class Client {
  messages: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private ws: WebSocket;
  private opened: Promise<void>;

  constructor(code: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/rooms/${code}/ws`);
    this.ws.addEventListener("message", (e) => {
      const msg = parseServerMessage(e.data);
      if (msg) this.messages.push(msg);
    });
    this.ws.addEventListener("close", (e) => (this.closed = { code: e.code, reason: e.reason }));
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
    });
  }

  async send(data: unknown) {
    await this.opened;
    this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }

  close() {
    this.ws.close();
  }

  /** Waits for the next message matching the predicate, counting from `from`. */
  async waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, from?: number): Promise<T>;
  async waitFor(pred: (m: ServerMessage) => boolean, from?: number): Promise<ServerMessage>;
  async waitFor(pred: (m: ServerMessage) => boolean, from = 0): Promise<ServerMessage> {
    for (let i = 0; i < 100; i++) {
      const found = this.messages.slice(from).find(pred);
      if (found) return found;
      await sleep(50);
    }
    throw new Error(`timed out; got ${JSON.stringify(this.messages)}`);
  }

  async waitForClose() {
    for (let i = 0; i < 100 && !this.closed; i++) await sleep(50);
    return this.closed;
  }
}

const isWelcome = (m: ServerMessage): m is Extract<ServerMessage, { type: "welcome" }> => m.type === "welcome";
const lobbyNames = (m: ServerMessage) =>
  m.type === "lobby" || m.type === "welcome" ? m.lobby.players.map((p) => `${p.name}${p.isHost ? "*" : ""}${p.connected ? "" : "?"}`) : [];

async function createRoom(): Promise<string> {
  const res = await fetch(`${BASE}/api/rooms`, { method: "POST" });
  expect(res.status).toBe(201);
  const { code } = (await res.json()) as { code: string };
  expect(code).toMatch(/^[A-Z]{4}$/);
  return code;
}

describe("rooms over real WebSockets", () => {
  it("creates a room and reports its info", async () => {
    const code = await createRoom();
    const info = await fetch(`${BASE}/api/rooms/${code.toLowerCase()}`);
    expect(await info.json()).toEqual({ code, playerCount: 0, maxPlayers: 8 });
  });

  it("returns 404 for rooms that don't exist", async () => {
    expect((await fetch(`${BASE}/api/rooms/ZZZZ`)).status).toBe(404);
    expect((await fetch(`${BASE}/api/rooms/NOPE!`)).status).toBe(404);
  });

  it("lets two players join and see each other live", async () => {
    const code = await createRoom();
    const ada = new Client(code);
    await ada.send({ type: "join", name: "Ada" });
    const adaWelcome = await ada.waitFor(isWelcome);
    expect(lobbyNames(adaWelcome)).toEqual(["Ada*"]);

    const bo = new Client(code);
    await bo.send({ type: "join", name: "Bo" });
    expect(lobbyNames(await bo.waitFor(isWelcome))).toEqual(["Ada*", "Bo"]);
    await ada.waitFor((m) => lobbyNames(m).join() === "Ada*,Bo");

    const info = await (await fetch(`${BASE}/api/rooms/${code}`)).json();
    expect(info).toMatchObject({ playerCount: 2 });
    ada.close();
    bo.close();
  });

  it("holds a dropped player's seat and restores it with their token", async () => {
    const code = await createRoom();
    const ada = new Client(code);
    await ada.send({ type: "join", name: "Ada" });
    await ada.waitFor(isWelcome);
    const bo = new Client(code);
    await bo.send({ type: "join", name: "Bo" });
    const { token, playerId } = await bo.waitFor(isWelcome);

    bo.close();
    await ada.waitFor((m) => lobbyNames(m).join() === "Ada*,Bo?");

    const boAgain = new Client(code);
    await boAgain.send({ type: "rejoin", token });
    const welcome = await boAgain.waitFor(isWelcome);
    expect(welcome.playerId).toBe(playerId);
    await ada.waitFor((m) => lobbyNames(m).join() === "Ada*,Bo");
    ada.close();
    boAgain.close();
  });

  it("replaces an older connection when the same player connects twice", async () => {
    const code = await createRoom();
    const first = new Client(code);
    await first.send({ type: "join", name: "Ada" });
    const { token } = await first.waitFor(isWelcome);

    const second = new Client(code);
    await second.send({ type: "rejoin", token });
    await second.waitFor(isWelcome);
    expect(await first.waitForClose()).toMatchObject({ code: 4001 });

    // The replaced socket closing must not mark the player as disconnected.
    await sleep(300);
    const watcher = new Client(code);
    await watcher.send({ type: "join", name: "Cy" });
    expect(lobbyNames(await watcher.waitFor(isWelcome))).toEqual(["Ada*", "Cy"]);
    second.close();
    watcher.close();
  });

  it("passes the host on when the host leaves", async () => {
    const code = await createRoom();
    const ada = new Client(code);
    await ada.send({ type: "join", name: "Ada" });
    await ada.waitFor(isWelcome);
    const bo = new Client(code);
    await bo.send({ type: "join", name: "Bo" });
    await bo.waitFor(isWelcome);

    await ada.send({ type: "leave" });
    expect(await ada.waitForClose()).toMatchObject({ code: 1000 });
    await bo.waitFor((m) => lobbyNames(m).join() === "Bo*");
    bo.close();
  });

  it("rejects a forged token", async () => {
    const code = await createRoom();
    const eve = new Client(code);
    await eve.send({ type: "rejoin", token: "0".repeat(32) });
    await eve.waitFor((m) => m.type === "error" && m.code === "invalid_token");
    expect(await eve.waitForClose()).toMatchObject({ code: 4000 });
  });

  it("refuses actions before joining and malformed messages", async () => {
    const code = await createRoom();
    const c = new Client(code);
    await c.send({ type: "leave" });
    await c.waitFor((m) => m.type === "error" && m.code === "not_joined");
    await c.send("{not json");
    await c.waitFor((m) => m.type === "error" && m.code === "bad_message");
    await c.send({ type: "join", name: "Ada", isHost: true });
    await c.waitFor((m) => m.type === "error" && m.code === "bad_message");
    c.close();
  });

  it("refuses a ninth player", async () => {
    const code = await createRoom();
    const players: Client[] = [];
    for (let i = 0; i < 8; i++) {
      const c = new Client(code);
      await c.send({ type: "join", name: `P${i}` });
      await c.waitFor(isWelcome);
      players.push(c);
    }
    const extra = new Client(code);
    await extra.send({ type: "join", name: "Extra" });
    await extra.waitFor((m) => m.type === "error" && m.code === "room_full");
    for (const c of players) c.close();
  });

  it("rate limits a flood of messages", async () => {
    const code = await createRoom();
    const c = new Client(code);
    await c.send({ type: "join", name: "Ada" });
    await c.waitFor(isWelcome);
    for (let i = 0; i < 60; i++) await c.send("{}");
    await c.waitFor((m) => m.type === "error" && m.code === "rate_limited");
    c.close();
  });

  it("syncs ready states, colours, and the host's game pick to everyone", async () => {
    const code = await createRoom();
    const ada = new Client(code);
    await ada.send({ type: "join", name: "Ada", color: "teal" });
    await ada.waitFor(isWelcome);
    const bo = new Client(code);
    await bo.send({ type: "join", name: "Bo", color: "teal" });
    const boWelcome = await bo.waitFor(isWelcome);
    expect(boWelcome.lobby.players.map((p) => p.color)).toEqual(["teal", "coral"]);

    await bo.send({ type: "selectGame", gameId: "trivia-blitz" });
    await bo.waitFor((m) => m.type === "error" && m.code === "not_host");

    await ada.send({ type: "selectGame", gameId: "trivia-blitz" });
    await bo.send({ type: "setReady", ready: true });
    await bo.send({ type: "setColor", color: "pink" });
    await ada.waitFor(
      (m) => m.type === "lobby" && m.lobby.selectedGameId === "trivia-blitz" && m.lobby.players[1]?.ready === true && m.lobby.players[1]?.color === "pink",
    );

    await bo.send({ type: "setColor", color: "teal" });
    await bo.waitFor((m) => m.type === "error" && m.code === "color_taken");
    ada.close();
    bo.close();
  });

  it("checks everyone has the host's own game", async () => {
    const code = await createRoom();
    const ada = new Client(code);
    await ada.send({ type: "join", name: "Ada" });
    await ada.waitFor(isWelcome);
    const bo = new Client(code);
    await bo.send({ type: "join", name: "Bo" });
    await bo.waitFor(isWelcome);

    const sha1 = "fce2d66a12d49ec50aa1b93e138da6c6f646eb16";
    await ada.send({ type: "selectOwnGame", game: { system: "ps1", sha1, title: "Crash Bash (USA)" } });
    await bo.waitFor((m) => m.type === "lobby" && m.lobby.selectedOwnGame?.title === "Crash Bash (USA)");

    await ada.send({ type: "setGameCopy", sha1, copy: "match" });
    await bo.send({ type: "setGameCopy", sha1, copy: "missing" });
    await ada.waitFor(
      (m) => m.type === "lobby" && m.lobby.players.map((p) => p.gameCopy).join() === "match,missing",
    );

    // Paths or other extra fields are refused, so nothing private leaves a player's PC.
    await ada.send({ type: "selectOwnGame", game: { system: "ps1", sha1, title: "x", path: "C:/Games" } });
    await ada.waitFor((m) => m.type === "error" && m.code === "bad_message");
    ada.close();
    bo.close();
  });

  it("starts an own game and shares the host's room code", async () => {
    const code = await createRoom();
    const ada = new Client(code);
    await ada.send({ type: "join", name: "Ada" });
    await ada.waitFor(isWelcome);
    const bo = new Client(code);
    await bo.send({ type: "join", name: "Bo" });
    await bo.waitFor(isWelcome);

    const sha1 = "f4b287e3d1a9b05ea6cb5e573414f768370e1ed8";
    await ada.send({ type: "selectOwnGame", game: { system: "gc", sha1, title: "Mario Party 4 (USA) (Rev 1)" } });
    await ada.send({ type: "startOwnGame" });
    await ada.waitFor((m) => m.type === "error" && m.code === "cannot_start");

    for (const c of [ada, bo]) {
      await c.send({ type: "setGameCopy", sha1, copy: "match" });
      await c.send({ type: "setReady", ready: true });
    }
    await ada.waitFor((m) => m.type === "lobby" && m.lobby.players.every((p) => p.ready && p.gameCopy === "match"));
    await ada.send({ type: "startOwnGame" });
    await bo.waitFor((m) => m.type === "lobby" && m.lobby.session !== null && m.lobby.session.roomCode === null);

    await bo.send({ type: "setRoomCode", code: "a1B2c3D4" });
    await bo.waitFor((m) => m.type === "error" && m.code === "not_host");
    await ada.send({ type: "setRoomCode", code: "a1B2c3D4" });
    await bo.waitFor((m) => m.type === "lobby" && m.lobby.session?.roomCode === "a1B2c3D4");

    await ada.send({ type: "endOwnGame" });
    await bo.waitFor((m) => m.type === "lobby" && m.lobby.session === null);
    ada.close();
    bo.close();
  });
});
