// Messages shared by the PartyLink app, phone pages and the room server.
// Every message that crosses the network is defined and validated here, so
// both ends agree on its shape.
import { z } from "zod";

export const MAX_PLAYERS = 8;
export const MAX_NAME_LENGTH = 20;
export const MAX_MESSAGE_BYTES = 4096;

/** How long a disconnected player's seat is held before it is released. */
export const SEAT_HOLD_MS = 2 * 60 * 1000;
/** How long a room with nobody connected survives before it is deleted. */
export const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

// No vowels or look-alike letters, so codes can't spell words or be misread.
export const ROOM_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const ROOM_CODE_LENGTH = 4;
const roomCodePattern = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidRoomCode(code: string): boolean {
  return roomCodePattern.test(code);
}

/** Trims a display name and strips control characters. Returns null if nothing usable is left. */
export function cleanDisplayName(input: string): string | null {
  const cleaned = input
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

const token = z.string().regex(/^[0-9a-f]{32}$/);

/** Avatar colours a player can pick. Each player in a room has a different one. */
export const AVATAR_COLORS = ["coral", "amber", "lime", "teal", "sky", "violet", "pink", "slate"] as const;
export const avatarColorSchema = z.enum(AVATAR_COLORS);
export type AvatarColor = z.infer<typeof avatarColorSchema>;

const gameId = z.string().regex(/^[a-z0-9-]{1,40}$/);

// Client -> server

export const clientMessageSchema = z.discriminatedUnion("type", [
  // First message on every connection: a new player sends a name, a returning one sends their token.
  z.object({ type: z.literal("join"), name: z.string().max(200), color: avatarColorSchema.optional() }).strict(),
  z.object({ type: z.literal("rejoin"), token }).strict(),
  z.object({ type: z.literal("leave") }).strict(),
  z.object({ type: z.literal("setReady"), ready: z.boolean() }).strict(),
  z.object({ type: z.literal("setColor"), color: avatarColorSchema }).strict(),
  // Host only. null clears the selection.
  z.object({ type: z.literal("selectGame"), gameId: gameId.nullable() }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// Server -> client

export const lobbyPlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: avatarColorSchema,
  isHost: z.boolean(),
  ready: z.boolean(),
  connected: z.boolean(),
});
export type LobbyPlayer = z.infer<typeof lobbyPlayerSchema>;

export const lobbyStateSchema = z.object({
  code: z.string(),
  maxPlayers: z.number(),
  selectedGameId: z.string().nullable(),
  players: z.array(lobbyPlayerSchema),
});
export type LobbyState = z.infer<typeof lobbyStateSchema>;

export const errorCodeSchema = z.enum([
  "room_not_found",
  "room_full",
  "invalid_name",
  "invalid_token",
  "not_joined",
  "already_joined",
  "bad_message",
  "rate_limited",
  "not_host",
  "unknown_game",
  "color_taken",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), playerId: z.string(), token, lobby: lobbyStateSchema }),
  z.object({ type: z.literal("lobby"), lobby: lobbyStateSchema }),
  z.object({ type: z.literal("error"), code: errorCodeSchema, message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Parses a raw WebSocket payload into a client message, or returns null if it is not one. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = clientMessageSchema.safeParse(data);
  return result.success ? result.data : null;
}

/** Parses a raw WebSocket payload into a server message, or returns null if it is not one. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string") return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = serverMessageSchema.safeParse(data);
  return result.success ? result.data : null;
}

// HTTP API

export const createRoomResponseSchema = z.object({ code: z.string() });
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;

export const roomInfoResponseSchema = z.object({
  code: z.string(),
  playerCount: z.number(),
  maxPlayers: z.number(),
});
export type RoomInfoResponse = z.infer<typeof roomInfoResponseSchema>;
