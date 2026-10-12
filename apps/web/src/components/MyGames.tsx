import { GAME_SYSTEMS, type GameSystem, SYSTEM_NAMES } from "@partylink/protocol";
import { useMemo, useState } from "react";
import { DOWNLOAD_URL } from "../desktop";
import type { NamedGame } from "../gamedb";
import { myGames, useMyGames } from "../myGames";
import { OwnGameCard } from "./OwnGameCard";

interface Props {
  /** In the lobby picker, clicking a game picks it. */
  onSelect?: (game: NamedGame) => void;
  selectedSha1?: string;
  compact?: boolean;
}

/** The player's own games: setup steps, scan progress, then a searchable grid. */
export function MyGames({ onSelect, selectedSha1, compact }: Props) {
  const state = useMyGames();
  const [query, setQuery] = useState("");
  const [system, setSystem] = useState<GameSystem | "all">("all");
  const games = state.status === "ready" || state.status === "scanning" ? state.games : [];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return games.filter((g) => (system === "all" || g.system === system) && (!q || g.title.toLowerCase().includes(q)));
  }, [games, query, system]);
  const systems = GAME_SYSTEMS.filter((s) => games.some((g) => g.system === s));

  switch (state.status) {
    case "browser":
      return (
        <div className="card setup-card">
          <h2>Play your own games with the PartyLink app</h2>
          <p className="muted">
            The Windows app finds the games on your PC and starts them with your friends online. A browser can't open your
            games folder, but you can still join parties here.
          </p>
          <a className="button primary" href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
            Download PartyLink for Windows
          </a>
        </div>
      );
    case "outdated":
      return (
        <div className="card setup-card">
          <h2>Update PartyLink to play your own games</h2>
          <p className="muted">This version of the app can't read your games folder yet. Install the latest version, then reopen it.</p>
          <a className="button primary" href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
            Get the latest version
          </a>
        </div>
      );
    case "loading":
      return <p className="muted">Looking for your games…</p>;
    case "no-folder":
      return (
        <div className="card setup-card">
          <h2>Where are your games?</h2>
          <p className="muted">
            Choose the folder with your game files. PartyLink finds GameCube, Wii, N64, PlayStation, SNES, NES, Game Boy
            Advance and Mega Drive games, including in subfolders.
          </p>
          <p className="muted small">
            Your games stay on your PC. Only a fingerprint of the chosen game is shared, to check everyone has the same copy.
          </p>
          <button className="primary" onClick={() => void myGames.chooseFolder()}>
            Choose games folder
          </button>
        </div>
      );
    case "error":
      return (
        <div className="card setup-card">
          <p className="error">{state.message}</p>
          <div className="row">
            <button className="primary" onClick={() => void myGames.chooseFolder()}>
              Choose games folder
            </button>
            {state.folder && <button onClick={() => void myGames.rescan()}>Try again</button>}
          </div>
        </div>
      );
  }

  return (
    <div className="my-games">
      {!compact && (
        <div className="folder-row">
          <span className="muted small grow folder-path" title={state.folder}>
            {state.folder}
          </span>
          <button className="link" onClick={() => void myGames.chooseFolder()} disabled={state.status === "scanning"}>
            Change folder
          </button>
          <button className="link" onClick={() => void myGames.rescan()} disabled={state.status === "scanning"}>
            Rescan
          </button>
        </div>
      )}
      {state.status === "scanning" && (
        <p className="muted small" role="status">
          {state.progress && state.progress.total > 0
            ? `Checking files: ${state.progress.done} of ${state.progress.total}${state.progress.current ? ` (${state.progress.current})` : ""}`
            : "Checking your games folder…"}
        </p>
      )}

      {games.length > 0 && (
        <div className="filters">
          <input
            type="search"
            placeholder="Search your games"
            aria-label="Search your games"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {systems.length > 1 && (
            <div className="chips">
              <button className={`chip-button${system === "all" ? " active" : ""}`} onClick={() => setSystem("all")}>
                All {games.length}
              </button>
              {systems.map((s) => (
                <button key={s} className={`chip-button${system === s ? " active" : ""}`} onClick={() => setSystem(s)}>
                  {SYSTEM_NAMES[s]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {state.status === "ready" && games.length === 0 && (
        <p className="muted">
          No games found in this folder. PartyLink looks for .iso, .rvz, .wbfs, .z64, .n64, .v64, .cue, .bin, .sfc, .smc,
          .nes, .gba, .md, .gen and single-game .zip files.
        </p>
      )}
      {games.length > 0 && shown.length === 0 && <p className="muted">No games match that search.</p>}

      <div className={compact ? "game-picker" : "game-grid"}>
        {shown.map((g) => (
          <OwnGameCard
            key={g.path}
            game={g}
            compact={compact}
            selected={g.sha1 === selectedSha1}
            onSelect={onSelect ? () => onSelect(g) : undefined}
          />
        ))}
      </div>

      {!compact && state.status === "ready" && state.skipped > 0 && (
        <p className="muted small">
          {state.skipped} {state.skipped === 1 ? "file wasn't" : "files weren't"} recognised as a game for a supported console.
        </p>
      )}
    </div>
  );
}
