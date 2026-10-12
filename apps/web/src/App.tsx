import { type AvatarColor, isValidRoomCode, normalizeRoomCode } from "@partylink/protocol";
import { useState } from "react";
import { Home } from "./screens/Home";
import { Library } from "./screens/Library";
import { Lobby } from "./screens/Lobby";
import { savedColor, savedName, seatToken } from "./storage";

type Screen = { kind: "home" } | { kind: "library" } | { kind: "lobby"; code: string; name: string; color: AvatarColor };

function roomFromUrl(): string {
  return normalizeRoomCode(new URLSearchParams(location.search).get("room") ?? "");
}

function setUrlRoom(code: string | null) {
  history.replaceState(null, "", code ? `/?room=${code}` : "/");
}

function initialScreen(): Screen {
  // Reopening the app (or refreshing) with a held seat goes straight back to the party.
  const code = roomFromUrl();
  const name = savedName.get();
  if (isValidRoomCode(code) && name && seatToken.get(code)) return { kind: "lobby", code, name, color: savedColor.get() };
  return { kind: "home" };
}

export function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const inLobby = screen.kind === "lobby";

  return (
    <div className="app">
      <nav className="topbar">
        <span className="logo">PartyLink</span>
        {!inLobby && (
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={screen.kind === "home"} onClick={() => setScreen({ kind: "home" })}>
              Home
            </button>
            <button role="tab" aria-selected={screen.kind === "library"} onClick={() => setScreen({ kind: "library" })}>
              Games
            </button>
          </div>
        )}
      </nav>

      <main className="content">
        {screen.kind === "lobby" && (
          <Lobby
            key={screen.code}
            code={screen.code}
            name={screen.name}
            color={screen.color}
            onExit={() => {
              setUrlRoom(null);
              setScreen({ kind: "home" });
            }}
          />
        )}
        {screen.kind === "library" && <Library />}
        {screen.kind === "home" && (
          <Home
            initialCode={roomFromUrl()}
            onBrowse={() => setScreen({ kind: "library" })}
            onEnter={(code, name, color) => {
              setUrlRoom(code);
              setScreen({ kind: "lobby", code, name, color });
            }}
          />
        )}
      </main>
    </div>
  );
}
