// Who is in a room: seats, host, tokens and connection status.
// Plain data and functions with no Cloudflare dependencies, so it can be unit tested
// and stored as-is in Durable Object storage.
import {
  cleanDisplayName,
  type ErrorCode,
  type LobbyState,
  MAX_PLAYERS,
  SEAT_HOLD_MS,
} from "@partylink/protocol";

export interface Seat {
  id: string;
  name: string;
  token: string;
  joinedAt: number;
  connected: boolean;
  /** When the player last disconnected; null while connected. */
  disconnectedAt: number | null;
}

export interface LobbyData {
  code: string;
  createdAt: number;
  hostId: string | null;
  seats: Seat[];
  /** When the last connected player left; null while anyone is connected. */
  emptySince: number | null;
}

export type JoinResult = { ok: true; seat: Seat } | { ok: false; code: ErrorCode; message: string };

export function createLobby(code: string, now: number): LobbyData {
  return { code, createdAt: now, hostId: null, seats: [], emptySince: now };
}

export function join(lobby: LobbyData, rawName: string, ids: { id: string; token: string }, now: number): JoinResult {
  const name = cleanDisplayName(rawName);
  if (!name) return { ok: false, code: "invalid_name", message: "Please enter a name." };
  if (lobby.seats.length >= MAX_PLAYERS) {
    return { ok: false, code: "room_full", message: `This party is full (${MAX_PLAYERS} players).` };
  }
  const seat: Seat = { id: ids.id, name, token: ids.token, joinedAt: now, connected: true, disconnectedAt: null };
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
  if (lobby.hostId === playerId) lobby.hostId = pickNewHost(lobby);
  if (lobby.seats.every((s) => !s.connected)) lobby.emptySince ??= now;
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
    players: lobby.seats.map((s) => ({ id: s.id, name: s.name, isHost: s.id === lobby.hostId, connected: s.connected })),
  };
}
