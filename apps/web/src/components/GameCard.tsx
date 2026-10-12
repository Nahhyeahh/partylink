import type { GameInfo, InputMethod } from "@partylink/game-catalog";

const INPUT_LABEL: Record<InputMethod, string> = {
  keyboard: "Keyboard",
  mouse: "Mouse",
  gamepad: "Gamepad",
  phone: "Phone",
};

export function playerRange(game: GameInfo): string {
  return game.minPlayers === game.maxPlayers ? `${game.minPlayers} players` : `${game.minPlayers}–${game.maxPlayers} players`;
}

interface Props {
  game: GameInfo;
  selected?: boolean;
  onSelect?: () => void;
  compact?: boolean;
}

export function GameCard({ game, selected, onSelect, compact }: Props) {
  const body = (
    <>
      <div className="game-art" style={{ background: `linear-gradient(135deg, ${game.art[0]}, ${game.art[1]})` }}>
        <span className="game-art-title">{game.name}</span>
        <span className={`pill ${game.availability === "playable" ? "pill-good" : "pill-soon"}`}>
          {game.availability === "playable" ? "Play now" : `Coming ${game.plannedFor === "Later" ? "later" : "soon"}`}
        </span>
      </div>
      <div className="game-info">
        <div className="game-meta">
          <span>{game.genre}</span>
          <span>{playerRange(game)}</span>
          <span>~{game.minutes} min</span>
        </div>
        {!compact && <p className="game-tagline">{game.tagline}</p>}
        {!compact && (
          <div className="chips">
            <span className="chip chip-mode">{game.mode === "hosted" ? "Built into PartyLink" : "Launches your copy"}</span>
            {game.inputs.map((i) => (
              <span key={i} className="chip">
                {INPUT_LABEL[i]}
              </span>
            ))}
          </div>
        )}
      </div>
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
