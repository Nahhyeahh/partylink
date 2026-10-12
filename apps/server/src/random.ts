import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@partylink/protocol";

export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomRoomCode(): string {
  // 256 is not a multiple of the alphabet size, so reject the top values to avoid bias.
  const limit = 256 - (256 % ROOM_CODE_ALPHABET.length);
  let code = "";
  while (code.length < ROOM_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(8))) {
      if (b < limit && code.length < ROOM_CODE_LENGTH) code += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
    }
  }
  return code;
}
