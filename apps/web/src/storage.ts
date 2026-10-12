// Small things remembered on this device. Storage can be unavailable (private
// windows, blocked site data), so every access is guarded.
import { type AvatarColor, avatarColorSchema } from "@partylink/protocol";

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not remembered; the app still works.
  }
}

export const savedName = {
  get: () => get("partylink:name") ?? "",
  set: (name: string) => set("partylink:name", name),
};

export const savedColor = {
  get: (): AvatarColor => {
    const parsed = avatarColorSchema.safeParse(get("partylink:color"));
    return parsed.success ? parsed.data : "violet";
  },
  set: (color: AvatarColor) => set("partylink:color", color),
};

/** The seat token for a room, so a dropped or reopened app gets its seat back. */
export const seatToken = {
  get: (code: string) => get(`partylink:seat:${code}`),
  set: (code: string, token: string | null) => set(`partylink:seat:${code}`, token),
};
