// Which emulator runs each console, and which release of it the party uses.
// Every player's app installs exactly this release, so everyone in a party is
// on the same version, which netplay needs. Changing it here updates everyone
// the next time they open PartyLink, without a new installer.
import type { GameSystem } from "@partylink/protocol";

export interface EmulatorRelease {
  emulator: "dolphin-mpn";
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

/** The emulator for a console, or null if PartyLink can't start its games yet. */
export function emulatorFor(system: GameSystem): EmulatorRelease | null {
  return system === "gc" || system === "wii" ? DOLPHIN : null;
}

export const VC_RUNTIME_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";
