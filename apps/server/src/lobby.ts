// Who is in a room: seats, host, tokens and connection status.
// Plain data and functions with no Cloudflare dependencies, so it can be unit tested
// and stored as-is in Durable Object storage.
import { canStartOwnGame, getGame } from "@partylink/game-catalog";
import {
  AVATAR_COLORS,
  type AvatarColor,
  cleanDisplayName,
  type ErrorCode,
  type GameCopy,
  type LobbyState,
  MAX_PLAYERS,
  type OwnGame,
  type PlaySession,
  SEAT_HOLD_MS,
} from "@partylink/protocol";

export interface Seat {
  id: string;
  name: string;
  color: AvatarColor;
  ready: boolean;
  token: string;
  joinedAt: number;
  connected: boolean;
  /** When the player last disconnected; null while connected. */
  disconnectedAt: number | null;
  /** Whether they have the selected own game. */
  gameCopy: GameCopy;
}

export interface LobbyData {
  code: string;
  createdAt: number;
  hostId: string | null;
  selectedGameId: string | null;
  /** A game from the host's folder. At most one of this and selectedGameId is set. */
  selectedOwnGame: OwnGame | null;
  /** Set while the selected own game is being played. */
  session: PlaySession | null;
  seats: Seat[];
  /** When the last connected player left; null while anyone is connected. */
  emptySince: number | null;
}

type Failure = { ok: false; code: ErrorCode; message: string };
export type JoinResult = { ok: true; seat: Seat } | Failure;
export type ActionResult = { ok: true } | Failure;

export function createLobby(code: string, now: number): LobbyData {
  return { code, createdAt: now, hostId: null, selectedGameId: null, selectedOwnGame: null, session: null, seats: [], emptySince: now };
}

/** Fills in fields added after a lobby was stored, so rooms survive a deploy. */
export function upgradeLobby(stored: LobbyData): LobbyData {
  stored.selectedGameId ??= null;
  stored.selectedOwnGame ??= null;
  stored.session ??= null;
  for (const seat of stored.seats) {
    seat.ready ??= false;
    seat.gameCopy ??= "checking";
    if (!seat.color) seat.color = freeColor(stored, undefined);
  }
  return stored;
}

function freeColor(lobby: LobbyData, preferred: AvatarColor | undefined): AvatarColor {
  const taken = new Set(lobby.seats.map((s) => s.color));
  if (preferred && !taken.has(preferred)) return preferred;
  // With at most MAX_PLAYERS seats and as many colours, one is always free.
  return AVATAR_COLORS.find((c) => !taken.has(c)) ?? AVATAR_COLORS[0];
}

export function join(
  lobby: LobbyData,
  rawName: string,
  preferredColor: AvatarColor | undefined,
  ids: { id: string; token: string },
  now: number,
): JoinResult {
  const name = cleanDisplayName(rawName);
  if (!name) return { ok: false, code: "invalid_name", message: "Please enter a name." };
  if (lobby.seats.length >= MAX_PLAYERS) {
    return { ok: false, code: "room_full", message: `This party is full (${MAX_PLAYERS} players).` };
  }
  const seat: Seat = {
    id: ids.id,
    name,
    color: freeColor(lobby, preferredColor),
    ready: false,
    token: ids.token,
    joinedAt: now,
    connected: true,
    disconnectedAt: null,
    gameCopy: "checking",
  };
  lobby.seats.push(seat);
  lobby.hostId ??= seat.id;
  lobby.emptySince = null;
  return { ok: true, seat };
}

export function rejoin(lobby: LobbyData, token: string, now: number): JoinResult {
  const seat = lobby.seats.find((s) => s.token === token);
  if (!seat) return { ok: false, code: "invalid_token", message: "Your seat in this party has expired." };
  markConnected(lobby, seat.id, now);
  return { ok: true, seat };
}

export function markConnected(lobby: LobbyData, playerId: string, _now: number): void {
  const seat = lobby.seats.find((s) => s.id === playerId);
  if (!seat) return;
  seat.connected = true;
  seat.disconnectedAt = null;
  lobby.emptySince = null;
}

export function markDisconnected(lobby: LobbyData, playerId: string, now: number): void {
  const seat = lobby.seats.find((s) => s.id === playerId);
  if (!seat || !seat.connected) return;
  seat.connected = false;
  seat.disconnectedAt = now;
  if (lobby.seats.every((s) => !s.connected)) lobby.emptySince = now;
}

export function leave(lobby: LobbyData, playerId: string, now: number): void {
  lobby.seats = lobby.seats.filter((s) => s.id !== playerId);
  if (lobby.hostId === playerId) {
    lobby.hostId = pickNewHost(lobby);
    // The game ran in the old host's emulator, so it ends with them.
    lobby.session = null;
  }
  if (lobby.seats.every((s) => !s.connected)) lobby.emptySince ??= now;
}

export function setReady(lobby: LobbyData, playerId: string, ready: boolean): ActionResult {
  const seat = lobby.seats.find((s) => s.id === playerId);
  if (!seat) return { ok: false, code: "not_joined", message: "Join the party first." };
  seat.ready = ready;
  return { ok: true };
}

export function setColor(lobby: LobbyData, playerId: string, color: AvatarColor): ActionResult {
  const seat = lobby.seats.find((s) => s.id === playerId);
  if (!seat) return { ok: false, code: "not_joined", message: "Join the party first." };
  if (lobby.seats.some((s) => s.id !== playerId && s.color === color)) {
    return { ok: false, code: "color_taken", message: "Someone else already has that colour." };
  }
  seat.color = color;
  return { ok: true };
}

/** Host only. Changing the game clears everyone's ready state, since they agreed to the old one. */
export function selectGame(lobby: LobbyData, playerId: string, gameId: string | null): ActionResult {
  if (lobby.hostId !== playerId) return { ok: false, code: "not_host", message: "Only the host can pick the game." };
  if (gameId !== null && !getGame(gameId)) return { ok: false, code: "unknown_game", message: "That game doesn't exist." };
  if (lobby.selectedGameId === gameId && lobby.selectedOwnGame === null) return { ok: true };
  lobby.selectedGameId = gameId;
  lobby.selectedOwnGame = null;
  resetChoices(lobby);
  return { ok: true };
}

/**
 * Host only. Picks a game from the host's own folder. Everyone's app then
 * checks their folder for an identical file and answers with setGameCopy.
 */
export function selectOwnGame(lobby: LobbyData, playerId: string, game: OwnGame | null): ActionResult {
  if (lobby.hostId !== playerId) return { ok: false, code: "not_host", message: "Only the host can pick the game." };
  if (game === null && lobby.selectedOwnGame === null) return { ok: true };
  if (game !== null && lobby.selectedOwnGame?.sha1 === game.sha1) return { ok: true };
  lobby.selectedOwnGame = game;
  lobby.selectedGameId = null;
  resetChoices(lobby);
  return { ok: true };
}

/** Records whether a player has the selected own game. Answers about an older selection are ignored. */
export function setGameCopy(lobby: LobbyData, playerId: string, sha1: string, copy: Exclude<GameCopy, "checking">): ActionResult {
  const seat = lobby.seats.find((s) => s.id === playerId);
  if (!seat) return { ok: false, code: "not_joined", message: "Join the party first." };
  if (lobby.selectedOwnGame?.sha1 === sha1) seat.gameCopy = copy;
  return { ok: true };
}

/** Host only. Starts the selected own game if everyone has it and is ready. */
export function startOwnGame(lobby: LobbyData, playerId: string, now: number): ActionResult {
  if (lobby.hostId !== playerId) return { ok: false, code: "not_host", message: "Only the host can start the game." };
  const game = lobby.selectedOwnGame;
  if (!game) return { ok: false, code: "cannot_start", message: "Pick one of your games first." };
  if (lobby.session) return { ok: true };
  const check = canStartOwnGame(game, lobby.seats);
  if (!check.ok) return { ok: false, code: "cannot_start", message: check.reason };
  lobby.session = { roomCode: null, startedAt: now };
  return { ok: true };
}

/** Host only. Shares the emulator's room code so everyone else's app can join. */
export function setRoomCode(lobby: LobbyData, playerId: string, code: string): ActionResult {
  if (lobby.hostId !== playerId) return { ok: false, code: "not_host", message: "Only the host shares the room code." };
  if (!lobby.session) return { ok: false, code: "cannot_start", message: "The game hasn't started." };
  lobby.session.roomCode = code;
  return { ok: true };
}

/** Host only. Ends the game and brings everyone back to the lobby, ready to pick again. */
export function endOwnGame(lobby: LobbyData, playerId: string): ActionResult {
  if (lobby.hostId !== playerId) return { ok: false, code: "not_host", message: "Only the host can end the game." };
  if (!lobby.session) return { ok: true };
  lobby.session = null;
  for (const seat of lobby.seats) seat.ready = false;
  return { ok: true };
}

/** A new game means everyone agrees again and checks their folder again. */
function resetChoices(lobby: LobbyData): void {
  lobby.session = null;
  for (const seat of lobby.seats) {
    seat.ready = false;
    seat.gameCopy = "checking";
  }
}

/** Releases seats whose player has been gone longer than the hold time. Returns true if anything changed. */
export function releaseExpiredSeats(lobby: LobbyData, now: number): boolean {
  const expired = lobby.seats.filter((s) => !s.connected && s.disconnectedAt !== null && now - s.disconnectedAt >= SEAT_HOLD_MS);
  for (const seat of expired) leave(lobby, seat.id, now);
  return expired.length > 0;
}

/** The earliest time a held seat expires, or null if no seat is being held. */
export function nextSeatExpiry(lobby: LobbyData): number | null {
  const times = lobby.seats.flatMap((s) => (s.disconnectedAt === null ? [] : [s.disconnectedAt + SEAT_HOLD_MS]));
  return times.length > 0 ? Math.min(...times) : null;
}

/** The host role goes to whoever has been in the party longest, preferring connected players. */
function pickNewHost(lobby: LobbyData): string | null {
  const byAge = [...lobby.seats].sort((a, b) => a.joinedAt - b.joinedAt);
  return (byAge.find((s) => s.connected) ?? byAge[0])?.id ?? null;
}

/** The lobby as players see it. Tokens never leave the server. */
export function toLobbyState(lobby: LobbyData): LobbyState {
  return {
    code: lobby.code,
    maxPlayers: MAX_PLAYERS,
    selectedGameId: lobby.selectedGameId,
    selectedOwnGame: lobby.selectedOwnGame,
    session: lobby.session,
    players: lobby.seats.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      isHost: s.id === lobby.hostId,
      ready: s.ready,
      connected: s.connected,
      gameCopy: s.gameCopy,
    })),
  };
}
