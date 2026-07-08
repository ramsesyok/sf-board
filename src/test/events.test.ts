import { describe, it, expect } from "vitest";
import {
  serializeEvent,
  parseEventLine,
  parseEventLines,
  splitCompleteLines,
  type ChatEvent,
  type MessageCreatedEvent,
} from "../core/events";

const U1 = "01111111111111111111111111";
const U2 = "02222222222222222222222222";

const created: MessageCreatedEvent = {
  id: U1,
  type: "message_created",
  ts: "2026-07-09T00:00:00.000Z",
  author: "alice",
  body: "こんにちは",
};

describe("events: シリアライズ/パース", () => {
  it("ラウンドトリップで一致する", () => {
    const line = serializeEvent(created);
    expect(line.includes("\n")).toBe(false); // 1 行
    expect(parseEventLine(line)).toEqual(created);
  });

  it("全イベント種別をパースできる", () => {
    const events: ChatEvent[] = [
      created,
      { id: U2, type: "message_edited", ts: "t", author: "alice", targetId: U1, body: "編集後" },
      { id: U2, type: "message_deleted", ts: "t", author: "alice", targetId: U1 },
      { id: U2, type: "reaction_added", ts: "t", author: "bob", targetId: U1, emoji: ":+1:" },
      { id: U2, type: "reaction_removed", ts: "t", author: "bob", targetId: U1, emoji: ":+1:" },
      { id: U2, type: "channel_renamed", ts: "t", author: "alice", targetId: U1, name: "新名" },
    ];
    for (const ev of events) {
      expect(parseEventLine(serializeEvent(ev))).toEqual(ev);
    }
  });

  it("threadId / attachments を保持する", () => {
    const ev: MessageCreatedEvent = {
      ...created,
      id: U2,
      threadId: U1,
      attachments: [U1, U2],
    };
    expect(parseEventLine(serializeEvent(ev))).toEqual(ev);
  });
});

describe("events: 不正入力の扱い(DESIGN.md §8)", () => {
  it("JSON 破損行は null", () => {
    expect(parseEventLine("{ broken")).toBeNull();
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("   ")).toBeNull();
  });

  it("未知 type は null(前方互換)", () => {
    const line = JSON.stringify({ id: U1, type: "channel_archived", ts: "t", author: "a" });
    expect(parseEventLine(line)).toBeNull();
  });

  it("必須フィールド不足・型不正は null", () => {
    expect(parseEventLine(JSON.stringify({ id: "bad", type: "message_created", ts: "t", author: "a", body: "x" }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ id: U1, type: "message_created", ts: "t", author: "a" }))).toBeNull(); // body 無し
    expect(parseEventLine(JSON.stringify({ id: U1, type: "message_edited", ts: "t", author: "a", targetId: "bad", body: "x" }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ id: U1, type: "reaction_added", ts: "t", author: "a", targetId: U2, emoji: "" }))).toBeNull();
  });

  it("parseEventLines は不正行をスキップして継続する", () => {
    const text = [serializeEvent(created), "{ broken", "", JSON.stringify({ type: "unknown" })].join("\n");
    const parsed = parseEventLines(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(created);
  });
});

describe("events: splitCompleteLines(差分読みの不完全行処理 DESIGN.md §5.3)", () => {
  it("LF で終わる完全行と持ち越し残りを分離する", () => {
    const { lines, remainder } = splitCompleteLines("a\nb\nc-incomplete");
    expect(lines).toEqual(["a", "b"]);
    expect(remainder).toBe("c-incomplete");
  });

  it("末尾 LF ありなら残りは空", () => {
    const { lines, remainder } = splitCompleteLines("a\nb\n");
    expect(lines).toEqual(["a", "b"]);
    expect(remainder).toBe("");
  });

  it("LF 無しなら全体を持ち越す", () => {
    const { lines, remainder } = splitCompleteLines("partial");
    expect(lines).toEqual([]);
    expect(remainder).toBe("partial");
  });
});
