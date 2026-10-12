import { GAMES } from "@partylink/game-catalog";
import { type AvatarColor, cleanDisplayName, isValidRoomCode, MAX_NAME_LENGTH, normalizeRoomCode } from "@partylink/protocol";
import { type FormEvent, useState } from "react";
import { createRoom, getRoom } from "../api";
import { Avatar } from "../components/Avatar";
import { ColorPicker } from "../components/ColorPicker";
import { GameCard } from "../components/GameCard";
import { OwnGameCard } from "../components/OwnGameCard";
import { useMyGames } from "../myGames";
import { savedColor, savedName, seatToken } from "../storage";

interface Props {
  initialCode: string;
  onEnter: (code: string, name: string, color: AvatarColor) => void;
  onBrowse: () => void;
}

export function Home({ initialCode, onEnter, onBrowse }: Props) {
  const [name, setName] = useState(savedName.get);
  const [color, setColor] = useState(savedColor.get);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const myGames = useMyGames();
  const mine = myGames.status === "ready" ? myGames.games : [];

  const pickColor = (c: AvatarColor) => {
    setColor(c);
    savedColor.set(c);
  };

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

  const create = () => withName(async (cleanName) => onEnter(await createRoom(), cleanName, color));

  const join = (e: FormEvent) => {
    e.preventDefault();
    withName(async (cleanName) => {
      const normalized = normalizeRoomCode(code);
      if (!isValidRoomCode(normalized)) throw new Error("Room codes are 4 letters, like KQZD.");
      const room = await getRoom(normalized);
      if (!room) throw new Error(`No party found with code ${normalized}.`);
      if (room.playerCount >= room.maxPlayers && !seatToken.get(normalized)) throw new Error("That party is full.");
      onEnter(normalized, cleanName, color);
    });
  };

  return (
    <div className="home">
      <section className="hero">
        <h1>
          Your friends.
          <br />
          <span className="gradient-text">One party.</span>
        </h1>
        <p className="muted">Start a party, send the code, and play together from anywhere.</p>
      </section>

      <section className="card profile-card">
        <div className="profile-row">
          <Avatar name={name || "?"} color={color} size={56} />
          <label className="field grow">
            <span>Your name</span>
            <input
              value={name}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="nickname"
              placeholder="e.g. Sam"
              onChange={(e) => {
                setName(e.target.value);
                savedName.set(e.target.value);
              }}
            />
          </label>
        </div>
        <ColorPicker value={color} onChange={pickColor} />

        <button className="primary big" disabled={busy} onClick={create}>
          Create a party
        </button>

        <div className="divider">
          <span>or join a friend</span>
        </div>

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

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="home-games">
        <div className="row">
          <h2>{mine.length > 0 ? "Your games" : "Games"}</h2>
          <button className="link" onClick={onBrowse}>
            See all {mine.length > 0 ? mine.length : GAMES.length}
          </button>
        </div>
        <div className="game-row">
          {mine.length > 0
            ? mine.slice(0, 3).map((g) => <OwnGameCard key={g.path} game={g} compact />)
            : GAMES.slice(0, 3).map((g) => <GameCard key={g.id} game={g} compact />)}
        </div>
      </section>
    </div>
  );
}
