import { cleanDisplayName, isValidRoomCode, MAX_NAME_LENGTH, normalizeRoomCode } from "@partylink/protocol";
import { type FormEvent, useState } from "react";
import { createRoom, getRoom, inviteLink } from "./api";
import { savedName, seatToken } from "./storage";
import { useRoom } from "./useRoom";

type Screen = { kind: "home" } | { kind: "lobby"; code: string; name: string };

function roomFromUrl(): string {
  return normalizeRoomCode(new URLSearchParams(location.search).get("room") ?? "");
}

function setUrlRoom(code: string | null) {
  history.replaceState(null, "", code ? `/?room=${code}` : "/");
}

function initialScreen(): Screen {
  // Reopening the app (or refreshing) with a held seat goes straight back to the party.
  const code = roomFromUrl();
  const name = savedName.get();
  if (isValidRoomCode(code) && name && seatToken.get(code)) return { kind: "lobby", code, name };
  return { kind: "home" };
}

export function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen);

  if (screen.kind === "lobby") {
    return (
      <Lobby
        key={screen.code}
        code={screen.code}
        name={screen.name}
        onExit={() => {
          setUrlRoom(null);
          setScreen({ kind: "home" });
        }}
      />
    );
  }
  return (
    <Home
      onEnter={(code, name) => {
        setUrlRoom(code);
        setScreen({ kind: "lobby", code, name });
      }}
    />
  );
}

function Home({ onEnter }: { onEnter: (code: string, name: string) => void }) {
  const [name, setName] = useState(savedName.get);
  const [code, setCode] = useState(roomFromUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withName = async (action: (cleanName: string) => Promise<void>) => {
    const cleanName = cleanDisplayName(name);
    if (!cleanName) return setError("Pick a name first.");
    savedName.set(cleanName);
    setBusy(true);
    setError(null);
    try {
      await action(cleanName);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    withName(async (cleanName) => {
      onEnter(await createRoom(), cleanName);
    });

  const join = (e: FormEvent) => {
    e.preventDefault();
    withName(async (cleanName) => {
      const normalized = normalizeRoomCode(code);
      if (!isValidRoomCode(normalized)) throw new Error("Room codes are 4 letters, like KQZD.");
      const room = await getRoom(normalized);
      if (!room) throw new Error(`No party found with code ${normalized}.`);
      if (room.playerCount >= room.maxPlayers && !seatToken.get(normalized)) throw new Error("That party is full.");
      onEnter(normalized, cleanName);
    });
  };

  return (
    <main className="page">
      <h1 className="logo">PartyLink</h1>
      <p className="tagline">Grab your friends and play.</p>

      <section className="card">
        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            maxLength={MAX_NAME_LENGTH}
            autoComplete="nickname"
            placeholder="e.g. Sam"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <button className="primary" disabled={busy} onClick={create}>
          Create a party
        </button>

        <div className="divider">or join one</div>

        <form className="join-row" onSubmit={join}>
          <input
            aria-label="Room code"
            className="code-input"
            value={code}
            maxLength={4}
            autoCapitalize="characters"
            placeholder="CODE"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button type="submit" disabled={busy}>
            Join
          </button>
        </form>

        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}

const STATUS_LABEL = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
} as const;

function Lobby({ code, name, onExit }: { code: string; name: string; onExit: () => void }) {
  const { status, lobby, playerId, fatalError, leave } = useRoom(code, name);
  const [copied, setCopied] = useState(false);

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt("Copy this invite link:", inviteLink(code));
    }
  };

  if (fatalError) {
    return (
      <main className="page">
        <section className="card">
          <p className="error">{fatalError}</p>
          <button className="primary" onClick={onExit}>
            Back home
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="lobby-header">
        <div>
          <span className="label">Room code</span>
          <div className="room-code">{code}</div>
        </div>
        <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
      </header>

      <section className="card">
        <div className="row">
          <h2>
            Players {lobby ? `${lobby.players.length}/${lobby.maxPlayers}` : ""}
          </h2>
          <button onClick={copyInvite}>{copied ? "Copied!" : "Copy invite link"}</button>
        </div>
        <ul className="players">
          {lobby?.players.map((p) => (
            <li key={p.id} className={p.connected ? "" : "away"}>
              <span className="avatar">{p.name.slice(0, 1).toUpperCase()}</span>
              <span className="name">
                {p.name}
                {p.id === playerId && <span className="you"> (you)</span>}
              </span>
              {p.isHost && <span className="badge">Host</span>}
              {!p.connected && <span className="badge muted">Reconnecting</span>}
            </li>
          ))}
        </ul>
        {!lobby && <p className="muted">Joining…</p>}
      </section>

      <button
        className="ghost"
        onClick={() => {
          leave();
          onExit();
        }}
      >
        Leave party
      </button>
    </main>
  );
}
