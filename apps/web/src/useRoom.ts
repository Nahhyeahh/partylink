import { type LobbyState, parseServerMessage } from "@partylink/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { roomSocketUrl } from "./api";
import { seatToken } from "./storage";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "closed";

export interface RoomConnection {
  status: ConnectionStatus;
  lobby: LobbyState | null;
  playerId: string | null;
  /** Set when the room refused us or went away; the lobby can't continue. */
  fatalError: string | null;
  leave: () => void;
}

const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const PING_EVERY_MS = 20_000;

/** Connects to a room, joins (or rejoins with a saved token), and keeps the connection alive. */
export function useRoom(code: string, name: string): RoomConnection {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const stop = (error: string | null) => {
      stoppedRef.current = true;
      setStatus("closed");
      if (error) setFatalError(error);
    };

    const open = () => {
      const ws = new WebSocket(roomSocketUrl(code));
      socketRef.current = ws;

      ws.onopen = () => {
        const token = seatToken.get(code);
        ws.send(JSON.stringify(token ? { type: "rejoin", token } : { type: "join", name }));
        pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), PING_EVERY_MS);
      };

      ws.onmessage = (event) => {
        const msg = parseServerMessage(event.data);
        if (!msg) return;
        if (msg.type === "welcome") {
          attempt = 0;
          seatToken.set(code, msg.token);
          setPlayerId(msg.playerId);
          setLobby(msg.lobby);
          setStatus("connected");
        } else if (msg.type === "lobby") {
          setLobby(msg.lobby);
        } else if (msg.type === "error") {
          if (msg.code === "invalid_token") {
            // Our seat expired; next attempt joins fresh by name.
            seatToken.set(code, null);
          } else if (msg.code === "room_full" || msg.code === "invalid_name" || msg.code === "room_not_found") {
            stop(msg.message);
          } else {
            console.warn("room error", msg);
          }
        }
      };

      ws.onclose = (event) => {
        clearInterval(pingTimer);
        if (socketRef.current === ws) socketRef.current = null;
        if (stoppedRef.current) return;
        if (event.reason === "replaced") return stop("This party is open in another window.");
        if (event.reason === "room_closed" || event.reason === "room_not_found") return stop("This party has ended.");
        if (event.reason === "left") return stop(null);
        setStatus("reconnecting");
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        attempt++;
        retryTimer = setTimeout(open, delay);
      };
    };

    open();
    return () => {
      stoppedRef.current = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      socketRef.current?.close();
    };
  }, [code, name]);

  const leave = useCallback(() => {
    seatToken.set(code, null);
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "leave" }));
    else stoppedRef.current = true;
  }, [code]);

  return { status, lobby, playerId, fatalError, leave };
}
