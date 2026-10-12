import type { LobbyState, OwnGame, PlaySession } from "@partylink/protocol";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { desktop, type DolphinLaunch, isDesktop } from "../desktop";
import { type EmulatorRelease, emulatorFor, VC_RUNTIME_URL } from "../emulators";
import { type EmulatorSetup, errorText, useEmulatorSetup } from "../emulatorSetup";

type Window = "idle" | "opening" | "open" | "closed";

interface Props {
  lobby: LobbyState;
  game: OwnGame;
  session: PlaySession;
  playerId: string;
  onRoomCode: (code: string) => void;
  onEnd: () => void;
}

/** What each player sees while the party plays one of their own games. */
export function PlayPanel({ lobby, game, session, playerId, onRoomCode, onEnd }: Props) {
  const me = lobby.players.find((p) => p.id === playerId);
  const host = lobby.players.find((p) => p.isHost);
  const isHost = me?.isHost ?? false;
  const release = emulatorFor(game.system);
  const canPlay = isDesktop() && me?.gameCopy === "match" && release !== null;

  return (
    <section className="card play-panel">
      <div className="row">
        <h2>Playing {game.title}</h2>
        {isHost && (
          <button className="link" onClick={onEnd}>
            End game
          </button>
        )}
      </div>
      {canPlay && release ? (
        <EmulatorSteps
          release={release}
          game={game}
          session={session}
          isHost={isHost}
          hostName={host?.name ?? "the host"}
          nickname={me?.name ?? "Player"}
          onRoomCode={onRoomCode}
        />
      ) : (
        <p className="muted">
          {!isDesktop()
            ? "You're in a browser, so you can't join this game. Open the party in the PartyLink app next time."
            : "You don't have the same copy of this game, so you can't join this one."}
        </p>
      )}
    </section>
  );
}

interface StepsProps {
  release: EmulatorRelease;
  game: OwnGame;
  session: PlaySession;
  isHost: boolean;
  hostName: string;
  nickname: string;
  onRoomCode: (code: string) => void;
}

function EmulatorSteps({ release, game, session, isHost, hostName, nickname, onRoomCode }: StepsProps) {
  const { setup, retry } = useEmulatorSetup(release);
  const [windowState, setWindowState] = useState<Window>("idle");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const launched = useRef<string | null>(null);
  // A room code already on the clipboard before Dolphin opened belongs to an
  // older game, so the host's app ignores it.
  const staleCode = useRef<string | null>(null);

  const launch = useCallback(
    async (how: DolphinLaunch) => {
      setLaunchError(null);
      setWindowState("opening");
      try {
        if (how.mode === "host") staleCode.current = await desktop.readDolphinRoomCode().catch(() => null);
        await desktop.launchDolphin(release, how, nickname);
        setWindowState("open");
      } catch (error) {
        setWindowState("closed");
        setLaunchError(errorText(error));
      }
    },
    [release, nickname],
  );

  useEffect(() => {
    let unlisten = () => {};
    let cancelled = false;
    desktop
      .onEmulatorExited((id) => id === release.emulator && setWindowState("closed"))
      .then((fn) => (cancelled ? fn() : (unlisten = fn)))
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten();
    };
  }, [release]);

  // Open the emulator once per game: the host as soon as it's installed,
  // everyone else once the host's room code arrives.
  const joinCode = isHost ? null : session.roomCode;
  useEffect(() => {
    if (setup.status !== "ready") return;
    const key = isHost ? `host:${session.startedAt}` : joinCode ? `join:${session.startedAt}:${joinCode}` : null;
    if (!key || launched.current === key) return;
    launched.current = key;
    void launch(isHost ? { mode: "host", sha1: game.sha1 } : { mode: "join", code: joinCode! });
  }, [setup.status, isHost, joinCode, session.startedAt, game.sha1, launch]);

  // The host clicks Copy in Dolphin; pick the code up and share it.
  const sharedCode = session.roomCode;
  useEffect(() => {
    if (!isHost || windowState !== "open") return;
    const timer = setInterval(async () => {
      const code = await desktop.readDolphinRoomCode().catch(() => null);
      if (code && code !== staleCode.current && code !== sharedCode) onRoomCode(code);
    }, 1000);
    return () => clearInterval(timer);
  }, [isHost, windowState, sharedCode, onRoomCode]);

  if (setup.status !== "ready") return <SetupMessage setup={setup} release={release} onRetry={retry} />;

  const reopen = () => void launch(isHost ? { mode: "host", sha1: game.sha1 } : { mode: "join", code: session.roomCode ?? "" });

  return (
    <div className="play-steps">
      {isHost ? (
        <HostSteps release={release} code={session.roomCode} windowState={windowState} onRoomCode={onRoomCode} />
      ) : (
        <p>
          {!session.roomCode
            ? `Waiting for ${hostName} to open the game in ${release.name}…`
            : windowState === "open"
              ? `${release.name} is open and joining ${hostName}'s game. ${hostName} starts it from ${release.name}.`
              : `Joining ${hostName}'s game…`}
        </p>
      )}

      {launchError && <p className="error">{launchError}</p>}
      {windowState === "closed" && (isHost || session.roomCode) && (
        <button onClick={reopen}>Open {release.name} again</button>
      )}

      <p className="muted small">
        Plug in an Xbox-style controller before {release.name} opens. To change buttons, use Controllers in{" "}
        {release.name}'s menu.
        {game.system === "wii" && " Wii games that use the Wii Remote need it set up there too."}
      </p>
    </div>
  );
}

function HostSteps({
  release,
  code,
  windowState,
  onRoomCode,
}: {
  release: EmulatorRelease;
  code: string | null;
  windowState: Window;
  onRoomCode: (code: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = typed.trim();
    if (/^[A-Za-z0-9]{8}$/.test(value)) {
      onRoomCode(value);
      setTyped("");
    }
  };

  if (windowState === "opening" || windowState === "idle") return <p>Opening {release.name}…</p>;

  return (
    <>
      <ol className="steps">
        <li className={code ? "done" : ""}>
          In {release.name}'s NetPlay window, click <strong>Copy</strong> next to the room code. PartyLink sends it to
          your friends{code ? <> (sent: <code>{code}</code>)</> : null}.
        </li>
        <li>
          When everyone appears in {release.name}'s player list, click <strong>Start</strong> there.
        </li>
      </ol>
      {!code && (
        <form className="join-row" onSubmit={submit}>
          <input
            aria-label="Room code"
            placeholder="Or paste the room code"
            value={typed}
            maxLength={8}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button type="submit">Send</button>
        </form>
      )}
    </>
  );
}

function SetupMessage({ setup, release, onRetry }: { setup: EmulatorSetup; release: EmulatorRelease; onRetry: () => void }) {
  switch (setup.status) {
    case "checking":
      return <p className="muted">Getting {release.name} ready…</p>;
    case "needs-runtime":
      return (
        <div className="play-steps">
          <p>
            {release.name} needs Microsoft's Visual C++ runtime, which isn't on this PC yet. Install it, then click Try
            again.
          </p>
          <div className="row start-row">
            <a className="button primary" href={VC_RUNTIME_URL} target="_blank" rel="noreferrer">
              Download the runtime
            </a>
            <button onClick={onRetry}>Try again</button>
          </div>
        </div>
      );
    case "installing": {
      const p = setup.progress;
      const percent = p?.total ? Math.floor((p.done / p.total) * 100) : null;
      return (
        <div className="play-steps">
          <p>
            {p?.phase === "unpack"
              ? `Unpacking ${release.name}…`
              : `Downloading ${release.name} (about ${release.megabytes} MB, only the first time)${percent !== null ? `: ${percent}%` : "…"}`}
          </p>
          <progress max={100} value={p?.phase === "unpack" ? 100 : (percent ?? undefined)} />
        </div>
      );
    }
    case "error":
      return (
        <div className="play-steps">
          <p className="error">{setup.message}</p>
          <button onClick={onRetry}>Try again</button>
        </div>
      );
    case "ready":
      return null;
  }
}
