import type { AvatarColor } from "@partylink/protocol";
import { COLOR_HEX } from "../colors";

export function Avatar({ name, color, size = 40 }: { name: string; color: AvatarColor; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: COLOR_HEX[color] }} aria-hidden>
      {name.slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}
