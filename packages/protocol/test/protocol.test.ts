import { describe, expect, it } from "vitest";
import {
  cleanDisplayName,
  isValidRoomCode,
  MAX_MESSAGE_BYTES,
  MAX_NAME_LENGTH,
  normalizeRoomCode,
  parseClientMessage,
} from "../src/index";

describe("room codes", () => {
  it("accepts four letters from the alphabet", () => {
    expect(isValidRoomCode("KQZD")).toBe(true);
  });

  it("rejects vowels, digits, and wrong lengths", () => {
    for (const code of ["KAZD", "KQZ1", "KQZ", "KQZDX", "", "kqzd"]) {
      expect(isValidRoomCode(code)).toBe(false);
    }
  });

  it("normalizes typed codes", () => {
    expect(normalizeRoomCode("  kqzd ")).toBe("KQZD");
  });
});

describe("display names", () => {
  it("trims and collapses whitespace", () => {
    expect(cleanDisplayName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
  });

  it("strips control and invisible characters", () => {
    expect(cleanDisplayName("Ad\u0000a​")).toBe("Ada");
  });

  it("caps the length", () => {
    expect(cleanDisplayName("x".repeat(50))).toHaveLength(MAX_NAME_LENGTH);
  });

  it("rejects names with nothing left", () => {
    expect(cleanDisplayName("   ")).toBeNull();
    expect(cleanDisplayName("\u0007")).toBeNull();
  });
});

describe("client message parsing", () => {
  it("parses a join", () => {
    expect(parseClientMessage('{"type":"join","name":"Ada"}')).toEqual({ type: "join", name: "Ada" });
  });

  it("parses a rejoin with a well-formed token", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(parseClientMessage(JSON.stringify({ type: "rejoin", token }))).toEqual({ type: "rejoin", token });
  });

  it("parses lobby actions", () => {
    expect(parseClientMessage('{"type":"setReady","ready":true}')).toEqual({ type: "setReady", ready: true });
    expect(parseClientMessage('{"type":"setColor","color":"teal"}')).toEqual({ type: "setColor", color: "teal" });
    expect(parseClientMessage('{"type":"selectGame","gameId":"trivia-blitz"}')).toEqual({ type: "selectGame", gameId: "trivia-blitz" });
    expect(parseClientMessage('{"type":"selectGame","gameId":null}')).toEqual({ type: "selectGame", gameId: null });
    expect(parseClientMessage('{"type":"join","name":"Ada","color":"pink"}')).toEqual({ type: "join", name: "Ada", color: "pink" });
  });

  it("accepts Dolphin and RetroArch room codes", () => {
    for (const code of ["a1B2c3D4", "relay.example.org|55435|aBc+/9==|abcd1234"]) {
      expect(parseClientMessage(JSON.stringify({ type: "setRoomCode", code }))).toEqual({ type: "setRoomCode", code });
    }
    for (const code of ["abc", "has space1", "x".repeat(201), "<script>1"]) {
      expect(parseClientMessage(JSON.stringify({ type: "setRoomCode", code }))).toBeNull();
    }
  });

  it("rejects malformed input", () => {
    const bad = [
      "not json",
      "42",
      '{"type":"nope"}',
      '{"type":"join"}',
      '{"type":"join","name":"Ada","extra":1}',
      '{"type":"rejoin","token":"short"}',
      '{"type":"setReady","ready":"yes"}',
      '{"type":"setColor","color":"chartreuse"}',
      '{"type":"selectGame","gameId":"../etc"}',
      JSON.stringify({ type: "join", name: "x".repeat(MAX_MESSAGE_BYTES) }),
    ];
    for (const raw of bad) expect(parseClientMessage(raw)).toBeNull();
    expect(parseClientMessage(new ArrayBuffer(4))).toBeNull();
  });
});

describe("own game messages", () => {
  const sha1 = "166eda1c05670d337e2c3f15a5db528ae1e5d6e3";

  it("accepts a game pick and cleans its title", () => {
    const msg = parseClientMessage(
      JSON.stringify({ type: "selectOwnGame", game: { system: "n64", sha1, title: "  Mario Party 2\u0000 (USA) " } }),
    );
    expect(msg).toEqual({ type: "selectOwnGame", game: { system: "n64", sha1, title: "Mario Party 2 (USA)" } });
    expect(parseClientMessage(JSON.stringify({ type: "selectOwnGame", game: null }))).toEqual({ type: "selectOwnGame", game: null });
  });

  it("rejects unknown consoles, bad fingerprints and empty titles", () => {
    const pick = (game: object) => parseClientMessage(JSON.stringify({ type: "selectOwnGame", game }));
    expect(pick({ system: "ps2", sha1, title: "x" })).toBeNull();
    expect(pick({ system: "n64", sha1: sha1.toUpperCase(), title: "x" })).toBeNull();
    expect(pick({ system: "n64", sha1, title: " \u0000 " })).toBeNull();
    expect(pick({ system: "n64", sha1, title: "x", path: "C:/secret" })).toBeNull();
  });

  it("accepts copy answers but not 'checking'", () => {
    expect(parseClientMessage(JSON.stringify({ type: "setGameCopy", sha1, copy: "match" }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "setGameCopy", sha1, copy: "checking" }))).toBeNull();
  });
});
