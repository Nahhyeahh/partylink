// One Room Durable Object per party. It owns the lobby and every player's
// WebSocket. Connections use the hibernation API: the object can be evicted
// from memory between messages without dropping anyone, and idle time is free.
import { DurableObject } from "cloudflare:workers";
import {
  EMPTY_ROOM_TTL_MS,
  type ErrorCode,
  MAX_PLAYERS,
  parseClientMessage,
  type ServerMessage,
} from "@partylink/protocol";
import {
  createLobby,
  join,
  type LobbyData,
  leave,
  markDisconnected,
  nextSeatExpiry,
  rejoin,
  releaseExpiredSeats,
  toLobbyState,
} from "./lobby";
import { randomHex } from "./random";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

/** Kept on each socket so it survives hibernation. */
interface Attachment {
  playerId: string | null;
}

const LOBBY_KEY = "lobby";
/** Sockets allowed per room, joined or not, so one client can't open thousands. */
const MAX_SOCKETS = MAX_PLAYERS * 3;
/** Per-connection rate limit: a burst of 20 messages, refilled at 20 per second. */
const RATE_BURST = 20;
const RATE_PER_MS = 20 / 1000;

export class Room extends DurableObject<Env> {
  private lobby: LobbyData | null = null;
  // Rate-limit buckets live in memory only; losing them on hibernation just resets the limit.
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.lobby = (await ctx.storage.get<LobbyData>(LOBBY_KEY)) ?? null;
    });
    // Answers keep-alive pings without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/init" && request.method === "POST") return this.init(await request.json());
    if (url.pathname === "/info") return this.info();
    if (url.pathname === "/ws") return this.acceptPlayerSocket(request);
    return new Response("Not found", { status: 404 });
  }

  private async init(body: unknown): Promise<Response> {
    const code = (body as { code?: unknown })?.code;
    if (typeof code !== "string") return new Response("Bad request", { status: 400 });
    if (this.lobby) return new Response("Room exists", { status: 409 });
    this.lobby = createLobby(code, Date.now());
    await this.save();
    return new Response(null, { status: 201 });
  }

  private info(): Response {
    if (!this.lobby) return Response.json({ error: "room_not_found" }, { status: 404 });
    return Response.json({ code: this.lobby.code, playerCount: this.lobby.seats.length, maxPlayers: MAX_PLAYERS });
  }

  private acceptPlayerSocket(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    if (!this.lobby) return Response.json({ error: "room_not_found" }, { status: 404 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return Response.json({ error: "room_full" }, { status: 429 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.lobby) {
      ws.close(4004, "room_not_found");
      return;
    }
    if (!this.allow(ws)) {
      this.sendError(ws, "rate_limited", "Slow down a little.");
      return;
    }
    const msg = parseClientMessage(raw);
    if (!msg) {
      console.warn("bad_message", { room: this.lobby.code });
      this.sendError(ws, "bad_message", "That message wasn't understood.");
      return;
    }
    const attachment = ws.deserializeAttachment() as Attachment;
    const now = Date.now();

    if (msg.type === "join" || msg.type === "rejoin") {
      if (attachment.playerId) {
        this.sendError(ws, "already_joined", "You're already in this party.");
        return;
      }
      const result =
        msg.type === "join"
          ? join(this.lobby, msg.name, { id: randomHex(8), token: randomHex(16) }, now)
          : rejoin(this.lobby, msg.token, now);
      if (!result.ok) {
        this.sendError(ws, result.code, result.message);
        ws.close(4000, result.code);
        return;
      }
      // A player is connected from one place at a time; an older connection is replaced.
      for (const other of this.socketsFor(result.seat.id)) other.close(4001, "replaced");
      ws.serializeAttachment({ playerId: result.seat.id } satisfies Attachment);
      await this.save();
      this.send(ws, { type: "welcome", playerId: result.seat.id, token: result.seat.token, lobby: toLobbyState(this.lobby) });
      this.broadcastLobby(ws);
      return;
    }

    if (!attachment.playerId) {
      this.sendError(ws, "not_joined", "Join the party first.");
      return;
    }

    if (msg.type === "leave") {
      leave(this.lobby, attachment.playerId, now);
      ws.serializeAttachment({ playerId: null } satisfies Attachment);
      await this.save();
      ws.close(1000, "left");
      this.broadcastLobby();
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleGone(ws);
  }

  private async handleGone(ws: WebSocket): Promise<void> {
    const { playerId } = ws.deserializeAttachment() as Attachment;
    if (!this.lobby || !playerId) return;
    // Still connected through another socket (for example, it replaced this one).
    if (this.socketsFor(playerId, ws).length > 0) return;
    markDisconnected(this.lobby, playerId, Date.now());
    await this.save();
    this.broadcastLobby();
  }

  async alarm(): Promise<void> {
    if (!this.lobby) return;
    const now = Date.now();
    const anyoneConnected = this.lobby.seats.some((s) => s.connected);
    if (!anyoneConnected && this.lobby.emptySince !== null && now - this.lobby.emptySince >= EMPTY_ROOM_TTL_MS) {
      console.log("room_deleted", { room: this.lobby.code });
      for (const ws of this.ctx.getWebSockets()) ws.close(4004, "room_closed");
      this.lobby = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    if (releaseExpiredSeats(this.lobby, now)) this.broadcastLobby();
    await this.save();
  }

  /** Persists the lobby and schedules the next cleanup check. */
  private async save(): Promise<void> {
    if (!this.lobby) return;
    await this.ctx.storage.put(LOBBY_KEY, this.lobby);
    const times = [nextSeatExpiry(this.lobby), this.lobby.emptySince === null ? null : this.lobby.emptySince + EMPTY_ROOM_TTL_MS];
    const next = times.filter((t): t is number => t !== null);
    if (next.length > 0) await this.ctx.storage.setAlarm(Math.min(...next));
    else await this.ctx.storage.deleteAlarm();
  }

  private socketsFor(playerId: string, except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((s) => {
      if (s === except || s.readyState !== WebSocket.OPEN) return false;
      return (s.deserializeAttachment() as Attachment | null)?.playerId === playerId;
    });
  }

  private broadcastLobby(skip?: WebSocket): void {
    if (!this.lobby) return;
    const message: ServerMessage = { type: "lobby", lobby: toLobbyState(this.lobby) };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip) continue;
      if ((ws.deserializeAttachment() as Attachment | null)?.playerId) this.send(ws, message);
    }
  }

  private allow(ws: WebSocket): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ws) ?? { tokens: RATE_BURST, at: now };
    bucket.tokens = Math.min(RATE_BURST, bucket.tokens + (now - bucket.at) * RATE_PER_MS);
    bucket.at = now;
    this.buckets.set(ws, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The socket closed between the check and the send; its close handler cleans up.
    }
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }
}

