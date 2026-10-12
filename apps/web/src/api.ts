import { createRoomResponseSchema, roomInfoResponseSchema, type RoomInfoResponse } from "@partylink/protocol";

export async function createRoom(): Promise<string> {
  const res = await fetch("/api/rooms", { method: "POST" });
  if (!res.ok) throw new Error("Couldn't create a party. Please try again.");
  return createRoomResponseSchema.parse(await res.json()).code;
}

/** Returns the room's info, or null if no such room exists. */
export async function getRoom(code: string): Promise<RoomInfoResponse | null> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Couldn't reach PartyLink. Check your connection.");
  return roomInfoResponseSchema.parse(await res.json());
}

export function roomSocketUrl(code: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/rooms/${code}/ws`;
}

export function inviteLink(code: string): string {
  return `${location.origin}/?room=${code}`;
}
