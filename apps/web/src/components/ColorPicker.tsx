import { AVATAR_COLORS, type AvatarColor } from "@partylink/protocol";
import { COLOR_HEX } from "../colors";

interface Props {
  value: AvatarColor;
  onChange: (color: AvatarColor) => void;
  /** Colours other players already have. */
  taken?: AvatarColor[];
}

export function ColorPicker({ value, onChange, taken = [] }: Props) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Avatar colour">
      {AVATAR_COLORS.map((c) => {
        const unavailable = taken.includes(c) && c !== value;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === value}
            aria-label={c}
            title={unavailable ? `${c} (taken)` : c}
            disabled={unavailable}
            className={`swatch${c === value ? " selected" : ""}`}
            style={{ background: COLOR_HEX[c] }}
            onClick={() => onChange(c)}
          />
        );
      })}
    </div>
  );
}
