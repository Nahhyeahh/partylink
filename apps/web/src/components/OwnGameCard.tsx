import { type GameSystem, SYSTEM_NAMES } from "@partylink/protocol";
import { useState } from "react";
import { coverUrl } from "../gamedb";

/** Card colours per console, used behind the box art and when there is none. */
const SYSTEM_ART: Record<GameSystem, [string, string]> = {
  gc: ["#7c5cff", "#38bdf8"],
  wii: ["#94a3b8", "#38bdf8"],
  n64: ["#ff6b6b", "#3ddc97"],
  ps1: ["#64748b", "#7c5cff"],
  snes: ["#a78bfa", "#94a3b8"],
  nes: ["#ff6b6b", "#94a3b8"],
  gba: ["#7c5cff", "#ff5d8f"],
  md: ["#38bdf8", "#1d4ed8"],
};

interface Props {
  game: { system: GameSystem; title: string; verified?: boolean };
  selected?: boolean;
  onSelect?: () => void;
  compact?: boolean;
}

export function OwnGameCard({ game, selected, onSelect, compact }: Props) {
  const [hasCover, setHasCover] = useState(true);
  const [from, to] = SYSTEM_ART[game.system];
  const body = (
    <>
      <div className={`game-art own-art${hasCover ? " has-cover" : ""}`} style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}>
        {hasCover && (
          <img src={coverUrl(game.system, game.title)} alt="" loading="lazy" onError={() => setHasCover(false)} />
        )}
        {!hasCover && <span className="game-art-title">{game.title}</span>}
        <span className="pill pill-soon">{SYSTEM_NAMES[game.system]}</span>
      </div>
      {/* Without box art the title is already on the card art. */}
      {(hasCover || (!compact && game.verified !== undefined)) && (
        <div className="game-info">
          {hasCover && <span className="own-title">{game.title}</span>}
          {!compact && game.verified !== undefined && (
            <div className="chips">
              <span className="chip">{game.verified ? "Matches a known clean copy" : "Not in the known-games list"}</span>
            </div>
          )}
        </div>
      )}
    </>
  );

  return onSelect ? (
    <button type="button" className={`game-card${selected ? " selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
      {body}
    </button>
  ) : (
    <article className="game-card">{body}</article>
  );
}
