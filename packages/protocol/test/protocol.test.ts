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
