// The Worker is the front door: it creates rooms and routes each request to
// the right Room. Everything outside /api/ is the web app, served as static files.
import { isValidRoomCode, normalizeRoomCode } from "@partylink/protocol";
import { randomRoomCode } from "./random";
import type { Env } from "./room";

export { Room } from "./room";

const CREATE_ATTEMPTS = 8;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "rooms", code?, "ws"?]

    if (parts[0] !== "api") return env.ASSETS.fetch(request);

    if (parts[1] === "rooms" && parts.length === 2 && request.method === "POST") {
      return createRoom(env);
    }

    if (parts[1] === "rooms" && parts.length >= 3) {
      const code = normalizeRoomCode(parts[2] ?? "");
      if (!isValidRoomCode(code)) return Response.json({ error: "room_not_found" }, { status: 404 });
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      if (parts.length === 3 && request.method === "GET") return room.fetch("https://room/info");
      if (parts.length === 4 && parts[3] === "ws") return room.fetch(new Request("https://room/ws", request));
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function createRoom(env: Env): Promise<Response> {
  // Codes are random; on the rare clash with a live room, try another.
  for (let i = 0; i < CREATE_ATTEMPTS; i++) {
    const code = randomRoomCode();
    const room = env.ROOMS.get(env.ROOMS.idFromName(code));
    const res = await room.fetch("https://room/init", { method: "POST", body: JSON.stringify({ code }) });
    if (res.status === 201) {
      console.log("room_created", { room: code });
      return Response.json({ code }, { status: 201 });
    }
  }
  console.error("room_create_failed");
  return Response.json({ error: "try_again" }, { status: 503 });
}
