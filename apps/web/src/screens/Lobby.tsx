import { canStart, GAMES, getGame } from "@partylink/game-catalog";
import type { AvatarColor } from "@partylink/protocol";
import { useState } from "react";
import { inviteLink } from "../api";
import { Avatar } from "../components/Avatar";
import { ColorPicker } from "../components/ColorPicker";
import { GameCard } from "../components/GameCard";
import { savedColor } from "../storage";
import { useRoom } from "../useRoom";

const STATUS_LABEL = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
} as const;

interface Props {
  code: string;
  name: string;
  color: AvatarColor;
  onExit: () => void;
}

export function Lobby({ code, name, color, onExit }: Props) {
  const room = useRoom(code, name, color);
  const { status, lobby, playerId, fatalError, notice } = room;
  const [copied, setCopied] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const me = lobby?.players.find((p) => p.id === playerId);
  const isHost = me?.isHost ?? false;
  const game = lobby?.selectedGameId ? getGame(lobby.selectedGameId) : undefined;
  const startCheck = canStart(game, lobby?.players ?? []);

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
      <div className="center-card">
        <section className="card">
          <p className="error">{fatalError}</p>
          <button className="primary" onClick={onExit}>
            Back home
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="lobby">
      <header className="lobby-header">
        <div>
          <span className="label">Room code</span>
          <div className="room-code">{code}</div>
        </div>
        <div className="lobby-header-actions">
          <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
          <button onClick={copyInvite}>{copied ? "Copied!" : "Copy invite link"}</button>
        </div>
      </header>

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="lobby-grid">
        <section className="card">
          <div className="row">
            <h2>Players {lobby ? `${lobby.players.length}/${lobby.maxPlayers}` : ""}</h2>
          </div>
          <ul className="players">
            {lobby?.players.map((p) => (
              <li key={p.id} className={p.connected ? "" : "away"}>
                <Avatar name={p.name} color={p.color} />
                <span className="name">
                  {p.name}
                  {p.id === playerId && <span className="muted"> (you)</span>}
                </span>
                {p.isHost && <span className="badge">Host</span>}
                {!p.connected ? (
                  <span className="badge muted-badge">Reconnecting</span>
                ) : (
                  <span className={`ready-dot${p.ready ? " is-ready" : ""}`}>{p.ready ? "Ready" : "Not ready"}</span>
                )}
              </li>
            ))}
          </ul>
          {!lobby && <p className="muted">Joining…</p>}

          {me && (
            <div className="me-controls">
              <ColorPicker
                value={me.color}
                taken={lobby?.players.map((p) => p.color)}
                onChange={(c) => {
                  savedColor.set(c);
                  room.setColor(c);
                }}
              />
              <button className={me.ready ? "ready-button is-ready" : "ready-button"} onClick={() => room.setReady(!me.ready)}>
                {me.ready ? "Ready!" : "I'm ready"}
              </button>
            </div>
          )}
        </section>

        <section className="card">
          <div className="row">
            <h2>Game</h2>
            {isHost && (
              <button className="link" onClick={() => setChoosing(!choosing)}>
                {choosing ? "Done" : game ? "Change" : "Choose"}
              </button>
            )}
          </div>

          {choosing && isHost ? (
            <div className="game-picker">
              {GAMES.map((g) => (
                <GameCard
                  key={g.id}
                  game={g}
                  compact
                  selected={g.id === lobby?.selectedGameId}
                  onSelect={() => {
                    room.selectGame(g.id);
                    setChoosing(false);
                  }}
                />
              ))}
            </div>
          ) : game ? (
            <>
              <GameCard game={game} />
              <p className="muted small">
                Everyone plays on their own PC. Phones can join as controllers once games arrive.
              </p>
            </>
          ) : (
            <p className="muted">{isHost ? "Choose what to play." : "Waiting for the host to choose a game."}</p>
          )}

          {isHost ? (
            <>
              <button className="primary big" disabled={!startCheck.ok}>
                Start game
              </button>
              {!startCheck.ok && <p className="muted small center">{startCheck.reason}</p>}
            </>
          ) : (
            <p className="muted small center">The host starts the game when everyone is ready.</p>
          )}
        </section>
      </div>

      <button
        className="ghost"
        onClick={() => {
          room.leave();
          onExit();
        }}
      >
        Leave party
      </button>
    </div>
  );
}
