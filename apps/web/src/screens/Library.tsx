import { GAMES } from "@partylink/game-catalog";
import { GameCard } from "../components/GameCard";
import { MyGames } from "../components/MyGames";

export function Library() {
  return (
    <div className="library">
      <header>
        <h1>Your games</h1>
        <p className="muted">
          Games from your own folder, played online with friends through emulators. Everyone needs the same copy of a game,
          and PartyLink checks that before you start.
        </p>
      </header>
      <MyGames />

      <header>
        <h2>PartyLink originals</h2>
        <p className="muted">Party games built into PartyLink, coming later. Nobody needs a copy of anything for these.</p>
      </header>
      <div className="game-grid">
        {GAMES.map((g) => (
          <GameCard key={g.id} game={g} />
        ))}
      </div>

      <p className="muted small credits">
        Game names come from the No-Intro and Redump lists via libretro-database (CC BY-SA 4.0). Box art comes from
        libretro-thumbnails. PartyLink doesn't include or download games.
      </p>
    </div>
  );
}
