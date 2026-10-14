// Which emulator runs each console, and which release of it the party uses.
// Every player's app installs exactly this release, so everyone in a party is
// on the same version, which netplay needs. Changing it here updates everyone
// the next time they open PartyLink, without a new installer.
import type { GameSystem } from "@partylink/protocol";

export interface EmulatorRelease {
  emulator: "dolphin-mpn" | "retroarch" | "mupen-mpn";
  /** Shown to players. */
  name: string;
  tag: string;
  asset: string;
  sha256: string;
  /** Rough download size for the progress message. */
  megabytes: number;
}

/** The Mario Party Netplay build of Dolphin: https://github.com/MarioPartyNetplay/Dolphin-MPN */
export const DOLPHIN: EmulatorRelease = {
  emulator: "dolphin-mpn",
  name: "Dolphin",
  tag: "e433371",
  asset: "DolphinMPN-windows-x86_64.zip",
  sha256: "4d8b9c3b18f33dff2964dcdfbb9b21cc49908de50970c4c36780a53598945bf0",
  megabytes: 147,
};

/**
 * RetroArch with the PS1, SNES, NES and Mega Drive cores, packed by this
 * repo's "Emulator files" workflow: https://github.com/Nahhyeahh/partylink/releases/tag/retroarch-1.22.2
 */
export const RETROARCH: EmulatorRelease = {
  emulator: "retroarch",
  name: "RetroArch",
  tag: "retroarch-1.22.2",
  asset: "RetroArch-1.22.2-partylink-win64.zip",
  sha256: "48279ba9d403080ea232fe4b3ebf311c799779a1bf9be26f949c909240c754b1",
  megabytes: 278,
};

/** The Mario Party Netplay build of Mupen64Plus, for N64: https://github.com/MarioPartyNetplay/Mupen-MPN */
export const MUPEN: EmulatorRelease = {
  emulator: "mupen-mpn",
  name: "Mupen",
  tag: "476e02b",
  asset: "MupenMPN-windows-x86_64.zip",
  sha256: "54d367e733f2d7b1411b076a7a9e7c99f068b1d517e8969897d371af03efb11d",
  megabytes: 104,
};

/** The emulator for a console, or null if PartyLink can't start its games yet. */
export function emulatorFor(system: GameSystem): EmulatorRelease | null {
  switch (system) {
    case "gc":
    case "wii":
      return DOLPHIN;
    case "n64":
      return MUPEN;
    case "ps1":
    case "snes":
    case "nes":
    case "md":
      return RETROARCH;
    default:
      return null;
  }
}

export type Relay = "nyc" | "madrid" | "saopaulo" | "singapore";

/**
 * The libretro relay server nearest the host, guessed from the PC's time
 * zone. Every player's game traffic goes through it.
 */
export function nearestRelay(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""): Relay {
  const [region, city = ""] = timeZone.split("/");
  if (region === "Europe" || region === "Africa") return "madrid";
  if (region === "Asia" || region === "Australia" || region === "Pacific") return "singapore";
  if (region === "America" && /Sao_Paulo|Argentina|Santiago|Bogota|Lima|Caracas|Montevideo|Asuncion|La_Paz/.test(city))
    return "saopaulo";
  return "nyc";
}

/** A password for the host's RetroArch room, which only the party learns. */
export function roomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

export const VC_RUNTIME_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";
