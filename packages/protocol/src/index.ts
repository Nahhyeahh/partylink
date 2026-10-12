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

// Players' own games ----------------------------------------------------------
// PartyLink never ships games. Each player's desktop app scans their own games
// folder and fingerprints each file (SHA-1). Netplay only works when everyone's
// file is identical, so the lobby compares fingerprints before starting.

/** Consoles PartyLink can run through emulators. Matches the desktop scanner's ids. */
export const GAME_SYSTEMS = ["gc", "wii", "n64", "ps1", "snes", "nes", "gba", "md"] as const;
export const gameSystemSchema = z.enum(GAME_SYSTEMS);
export type GameSystem = z.infer<typeof gameSystemSchema>;

export const SYSTEM_NAMES: Record<GameSystem, string> = {
  gc: "GameCube",
  wii: "Wii",
  n64: "Nintendo 64",
  ps1: "PlayStation",
  snes: "Super Nintendo",
  nes: "NES",
  gba: "Game Boy Advance",
  md: "Mega Drive",
};

export const MAX_GAME_TITLE_LENGTH = 120;

const sha1 = z.string().regex(/^[0-9a-f]{40}$/);

/** A game from the host's folder, identified by its file fingerprint. */
export const ownGameSchema = z
  .object({
    system: gameSystemSchema,
    sha1,
    title: z
      .string()
      .max(400)
      .transform((t) => t.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, MAX_GAME_TITLE_LENGTH))
      .pipe(z.string().min(1)),
  })
  .strict();
export type OwnGame = z.infer<typeof ownGameSchema>;

/**
 * Whether a player has the selected game:
 * - checking: their app hasn't answered yet
 * - match: they have an identical file
 * - missing: their games folder has no identical file
 * - no-app: they're in a browser, which can't run emulators
 */
export const GAME_COPY_STATES = ["checking", "match", "missing", "no-app"] as const;
export const gameCopySchema = z.enum(GAME_COPY_STATES);
export type GameCopy = z.infer<typeof gameCopySchema>;

/** An emulator netplay room code, such as Dolphin's 8-character traversal code. */
const roomCode = z.string().regex(/^[A-Za-z0-9]{4,32}$/);

/** A started own game. The host's emulator hosts it; everyone else joins with the room code. */
export const playSessionSchema = z.object({
  /** null until the host's emulator has a room code. */
  roomCode: z.string().nullable(),
  startedAt: z.number(),
});
export type PlaySession = z.infer<typeof playSessionSchema>;

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
  // Host only. A game from the host's own folder; null clears it.
  z.object({ type: z.literal("selectOwnGame"), game: ownGameSchema.nullable() }).strict(),
  // Each player's answer to "do you have this game?" for the selected own game.
  z.object({ type: z.literal("setGameCopy"), sha1, copy: z.enum(["match", "missing", "no-app"]) }).strict(),
  // Host only. Starts the selected own game once everyone has it and is ready.
  z.object({ type: z.literal("startOwnGame") }).strict(),
  // Host only. The emulator's netplay room code, which friends' apps join automatically.
  z.object({ type: z.literal("setRoomCode"), code: roomCode }).strict(),
  // Host only. Everyone goes back to the lobby.
  z.object({ type: z.literal("endOwnGame") }).strict(),
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
  /** Only meaningful while an own game is selected. */
  gameCopy: gameCopySchema,
});
export type LobbyPlayer = z.infer<typeof lobbyPlayerSchema>;

export const lobbyStateSchema = z.object({
  code: z.string(),
  maxPlayers: z.number(),
  selectedGameId: z.string().nullable(),
  /** A game from the host's folder. At most one of this and selectedGameId is set. */
  selectedOwnGame: ownGameSchema.nullable(),
  /** Set while the selected own game is being played. */
  session: playSessionSchema.nullable(),
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
  "cannot_start",
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
