// Small things remembered on this device. Storage can be unavailable (private
// windows, blocked site data), so every access is guarded.

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

/** The seat token for a room, so a dropped or reopened app gets its seat back. */
export const seatToken = {
  get: (code: string) => get(`partylink:seat:${code}`),
  set: (code: string, token: string | null) => set(`partylink:seat:${code}`, token),
};
