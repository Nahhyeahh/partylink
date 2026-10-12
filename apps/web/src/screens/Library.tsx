import { GAMES } from "@partylink/game-catalog";
import { GameCard } from "../components/GameCard";

export function Library() {
  return (
    <div className="library">
      <header>
        <h1>Game library</h1>
        <p className="muted">
          Every game here is built into PartyLink, so nobody needs to buy or install anything else. Trivia Blitz is first up.
        </p>
      </header>
      <div className="game-grid">
        {GAMES.map((g) => (
          <GameCard key={g.id} game={g} />
        ))}
      </div>
    </div>
  );
}
