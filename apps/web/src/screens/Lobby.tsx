import { canStart, canStartOwnGame, GAMES, getGame } from "@partylink/game-catalog";
import { type AvatarColor, type GameCopy, SYSTEM_NAMES } from "@partylink/protocol";
import { useEffect, useState } from "react";
import { inviteLink } from "../api";
import { Avatar } from "../components/Avatar";
import { ColorPicker } from "../components/ColorPicker";
import { GameCard } from "../components/GameCard";
import { MyGames } from "../components/MyGames";
import { OwnGameCard } from "../components/OwnGameCard";
import { PlayPanel } from "../components/PlayPanel";
import { emulatorFor } from "../emulators";
import { type MyGamesState, useMyGames } from "../myGames";
import { isDesktop } from "../desktop";
import { savedColor } from "../storage";
import { useRoom } from "../useRoom";

const STATUS_LABEL = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
} as const;

const COPY_LABEL: Record<GameCopy, string> = {
  checking: "Checking game…",
  match: "Has the game",
  missing: "Missing the game",
  "no-app": "Needs the app",
};

/** What this player's app should tell the room about the selected game, or null to wait. */
function myCopy(games: MyGamesState, sha1: string): "match" | "missing" | "no-app" | null {
  switch (games.status) {
    case "browser":
    case "outdated":
      return "no-app";
    case "no-folder":
    case "error":
      return "missing";
    case "ready":
      return games.games.some((g) => g.sha1 === sha1) ? "match" : "missing";
    default:
      return null;
  }
}

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
  const [pickerTab, setPickerTab] = useState<"mine" | "originals">(isDesktop() ? "mine" : "originals");
  const games = useMyGames();

  const me = lobby?.players.find((p) => p.id === playerId);
  const isHost = me?.isHost ?? false;
  const game = lobby?.selectedGameId ? getGame(lobby.selectedGameId) : undefined;
  const ownGame = lobby?.selectedOwnGame ?? null;
  const session = lobby?.session ?? null;
  const startCheck = ownGame
    ? emulatorFor(ownGame.system)
      ? canStartOwnGame(ownGame, lobby?.players ?? [])
      : { ok: false as const, reason: `Starting ${SYSTEM_NAMES[ownGame.system]} games arrives in a later update.` }
    : canStart(game, lobby?.players ?? []);

  // Tell the room whether we have the host's chosen game. Answers again after
  // the folder is rescanned or changed, since the answer may change.
  const answer = ownGame ? myCopy(games, ownGame.sha1) : null;
  const myAnswer = me?.gameCopy;
  const ownSha1 = ownGame?.sha1;
  const { setGameCopy } = room;
  useEffect(() => {
    if (ownSha1 && answer && answer !== myAnswer) setGameCopy(ownSha1, answer);
  }, [ownSha1, answer, myAnswer, setGameCopy]);

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

      {lobby && ownGame && session && playerId && (
        <PlayPanel
          lobby={lobby}
          game={ownGame}
          session={session}
          playerId={playerId}
          onRoomCode={room.setRoomCode}
          onEnd={room.endOwnGame}
        />
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
                {ownGame && p.connected && (
                  <span className={`copy-state copy-${p.gameCopy}`}>{COPY_LABEL[p.gameCopy]}</span>
                )}
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
                {choosing ? "Done" : game || ownGame ? "Change" : "Choose"}
              </button>
            )}
          </div>

          {choosing && isHost ? (
            <>
              <div className="tabs picker-tabs" role="tablist">
                <button role="tab" aria-selected={pickerTab === "mine"} onClick={() => setPickerTab("mine")}>
                  Your games
                </button>
                <button role="tab" aria-selected={pickerTab === "originals"} onClick={() => setPickerTab("originals")}>
                  PartyLink originals
                </button>
              </div>
              {pickerTab === "mine" ? (
                <MyGames
                  compact
                  selectedSha1={ownGame?.sha1}
                  onSelect={(g) => {
                    room.selectOwnGame({ system: g.system, sha1: g.sha1, title: g.title });
                    setChoosing(false);
                  }}
                />
              ) : (
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
              )}
            </>
          ) : ownGame ? (
            <>
              <OwnGameCard game={ownGame} />
              <p className="muted small">
                Everyone needs the same copy of this game in their games folder. PartyLink checks that for you.
              </p>
            </>
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
              <button
                className="primary big"
                disabled={!startCheck.ok || session !== null}
                onClick={() => ownGame && room.startOwnGame()}
              >
                {session ? "Playing" : "Start game"}
              </button>
              {!startCheck.ok && !session && <p className="muted small center">{startCheck.reason}</p>}
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
