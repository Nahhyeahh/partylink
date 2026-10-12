// The games PartyLink knows about. The library, the lobby, and the server all
// read this list, so a game's player limits are enforced in one place.

export type GameMode =
  /** PartyLink runs the game itself. */
  | "hosted"
  /** PartyLink launches a game the players own and helps them coordinate. */
  | "launch";

export type InputMethod = "keyboard" | "mouse" | "gamepad" | "phone";

export type Availability =
  /** Can be started from a lobby. */
  | "playable"
  /** Listed so players can see what's coming, but can't be started yet. */
  | "coming-soon";

export interface GameInfo {
  id: string;
  name: string;
  tagline: string;
  genre: string;
  minPlayers: number;
  maxPlayers: number;
  /** Typical length of one game, in minutes. */
  minutes: number;
  inputs: InputMethod[];
  mode: GameMode;
  availability: Availability;
  /** Shown on the card so players know when to expect it. */
  plannedFor?: string;
  /** Two colours for the card art, as CSS colour values. */
  art: [string, string];
}

export const GAMES: readonly GameInfo[] = [
  {
    id: "trivia-blitz",
    name: "Trivia Blitz",
    tagline: "Race the clock through rapid-fire questions. Streaks score big.",
    genre: "Trivia",
    minPlayers: 2,
    maxPlayers: 8,
    minutes: 10,
    inputs: ["keyboard", "mouse", "phone"],
    mode: "hosted",
    availability: "coming-soon",
    plannedFor: "Milestone 5",
    art: ["#ff5d8f", "#ffb347"],
  },
  {
    id: "doodle-dash",
    name: "Doodle Dash",
    tagline: "One player draws, everyone else guesses before time runs out.",
    genre: "Drawing",
    minPlayers: 3,
    maxPlayers: 8,
    minutes: 15,
    inputs: ["mouse", "phone"],
    mode: "hosted",
    availability: "coming-soon",
    plannedFor: "Milestone 6",
    art: ["#3ddc97", "#38bdf8"],
  },
  {
    id: "impostor-party",
    name: "Impostor Party",
    tagline: "Finish your tasks, find the impostor, and vote wisely.",
    genre: "Social deduction",
    minPlayers: 4,
    maxPlayers: 8,
    minutes: 20,
    inputs: ["keyboard", "mouse", "phone"],
    mode: "hosted",
    availability: "coming-soon",
    plannedFor: "Milestone 7",
    art: ["#7c5cff", "#ff6b6b"],
  },
  {
    id: "chaos-kitchen",
    name: "Chaos Kitchen",
    tagline: "Cook, chop, and plate orders together before the rush buries you.",
    genre: "Co-op",
    minPlayers: 2,
    maxPlayers: 4,
    minutes: 10,
    inputs: ["keyboard", "gamepad"],
    mode: "hosted",
    availability: "coming-soon",
    plannedFor: "Later",
    art: ["#ffc857", "#ff7a45"],
  },
  {
    id: "wobbly-arena",
    name: "Wobbly Arena",
    tagline: "A floppy brawler where the last one standing wins.",
    genre: "Physics brawler",
    minPlayers: 2,
    maxPlayers: 8,
    minutes: 10,
    inputs: ["keyboard", "gamepad"],
    mode: "hosted",
    availability: "coming-soon",
    plannedFor: "Later",
    art: ["#38bdf8", "#7c5cff"],
  },
  {
    id: "mini-game-mayhem",
    name: "Mini-Game Mayhem",
    tagline: "Short rounds, rotating rules, one overall winner.",
    genre: "Mini-games",
    minPlayers: 2,
    maxPlayers: 8,
    minutes: 15,
    inputs: ["keyboard", "mouse", "phone"],
    mode: "hosted",
    availability: "coming-soon",
    plannedFor: "Later",
    art: ["#ff5d8f", "#7c5cff"],
  },
];

export function getGame(id: string): GameInfo | undefined {
  return GAMES.find((g) => g.id === id);
}

export type StartCheck = { ok: true } | { ok: false; reason: string };

/** Whether a lobby could start this game now. Shared by the lobby screen and the server. */
export function canStart(game: GameInfo | undefined, players: { connected: boolean; ready: boolean }[]): StartCheck {
  if (!game) return { ok: false, reason: "Pick a game first." };
  if (game.availability !== "playable") return { ok: false, reason: `${game.name} isn't playable yet.` };
  const present = players.filter((p) => p.connected);
  if (present.length < game.minPlayers) return { ok: false, reason: `${game.name} needs at least ${game.minPlayers} players.` };
  if (present.length > game.maxPlayers) return { ok: false, reason: `${game.name} allows at most ${game.maxPlayers} players.` };
  if (present.some((p) => !p.ready)) return { ok: false, reason: "Waiting for everyone to be ready." };
  return { ok: true };
}
