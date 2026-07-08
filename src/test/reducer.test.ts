import { describe, it, expect } from "vitest";
import { reduceChannel, buildThreads } from "../core/reducer";
import type { ChatEvent } from "../core/events";

// テスト用に昇順の ULID を作る(末尾 2 桁を連番に)。
function uid(n: number): string {
  return "0000000000000000000000" + String(n).padStart(4, "0");
}

const CH = uid(1);

describe("reducer: メッセージ本文の LWW と権限(DESIGN.md §3)", () => {
  it("同一 target への編集は ULID 最大が勝つ", () => {
    const events: ChatEvent[] = [
      { id: uid(10), type: "message_created", ts: "t", author: "alice", body: "v1" },
      { id: uid(30), type: "message_edited", ts: "t", author: "alice", targetId: uid(10), body: "v3" },
      { id: uid(20), type: "message_edited", ts: "t", author: "alice", targetId: uid(10), body: "v2" },
    ];
    const state = reduceChannel(events);
    expect(state.messages[0].body).toBe("v3");
    expect(state.messages[0].edited).toBe(true);
  });

  it("author 不一致の編集・削除は無視する", () => {
    const events: ChatEvent[] = [
      { id: uid(10), type: "message_created", ts: "t", author: "alice", body: "orig" },
      { id: uid(20), type: "message_edited", ts: "t", author: "mallory", targetId: uid(10), body: "hacked" },
      { id: uid(30), type: "message_deleted", ts: "t", author: "mallory", targetId: uid(10) },
    ];
    const state = reduceChannel(events);
    expect(state.messages[0].body).toBe("orig");
    expect(state.messages[0].deleted).toBe(false);
  });

  it("本人の削除は削除状態になり本文は空になる", () => {
    const events: ChatEvent[] = [
      { id: uid(10), type: "message_created", ts: "t", author: "alice", body: "secret" },
      { id: uid(20), type: "message_deleted", ts: "t", author: "alice", targetId: uid(10) },
    ];
    const state = reduceChannel(events);
    expect(state.messages[0].deleted).toBe(true);
    expect(state.messages[0].body).toBe("");
  });

  it("入力順に依らず ULID 昇順で並ぶ", () => {
    const events: ChatEvent[] = [
      { id: uid(30), type: "message_created", ts: "t", author: "a", body: "third" },
      { id: uid(10), type: "message_created", ts: "t", author: "a", body: "first" },
      { id: uid(20), type: "message_created", ts: "t", author: "a", body: "second" },
    ];
    const state = reduceChannel(events);
    expect(state.messages.map((m) => m.body)).toEqual(["first", "second", "third"]);
  });
});

describe("reducer: リアクション LWW と集計(DESIGN.md §3)", () => {
  it("(target,author,emoji) の後勝ちで added/removed が決まる", () => {
    const events: ChatEvent[] = [
      { id: uid(10), type: "message_created", ts: "t", author: "alice", body: "m" },
      { id: uid(20), type: "reaction_added", ts: "t", author: "bob", targetId: uid(10), emoji: "👍" },
      { id: uid(30), type: "reaction_removed", ts: "t", author: "bob", targetId: uid(10), emoji: "👍" },
      { id: uid(40), type: "reaction_added", ts: "t", author: "bob", targetId: uid(10), emoji: "👍" },
    ];
    const state = reduceChannel(events);
    expect(state.messages[0].reactions).toEqual([{ emoji: "👍", users: ["bob"] }]);
  });

  it("removed が最後なら表示されない", () => {
    const events: ChatEvent[] = [
      { id: uid(10), type: "message_created", ts: "t", author: "alice", body: "m" },
      { id: uid(20), type: "reaction_added", ts: "t", author: "bob", targetId: uid(10), emoji: "👍" },
      { id: uid(30), type: "reaction_removed", ts: "t", author: "bob", targetId: uid(10), emoji: "👍" },
    ];
    const state = reduceChannel(events);
    expect(state.messages[0].reactions).toEqual([]);
  });

  it("複数ユーザーを集計する", () => {
    const events: ChatEvent[] = [
      { id: uid(10), type: "message_created", ts: "t", author: "alice", body: "m" },
      { id: uid(20), type: "reaction_added", ts: "t", author: "bob", targetId: uid(10), emoji: "🎉" },
      { id: uid(30), type: "reaction_added", ts: "t", author: "carol", targetId: uid(10), emoji: "🎉" },
    ];
    const state = reduceChannel(events);
    expect(state.messages[0].reactions).toEqual([{ emoji: "🎉", users: ["bob", "carol"] }]);
  });
});

describe("reducer: channel_renamed LWW(DESIGN_EXTENSION.md §2)", () => {
  it("ULID 最大のリネームが現在名になる", () => {
    const events: ChatEvent[] = [
      { id: uid(10), type: "channel_renamed", ts: "t", author: "alice", targetId: CH, name: "旧名" },
      { id: uid(30), type: "channel_renamed", ts: "t", author: "bob", targetId: CH, name: "最新名" },
      { id: uid(20), type: "channel_renamed", ts: "t", author: "carol", targetId: CH, name: "中間名" },
    ];
    const state = reduceChannel(events);
    expect(state.channelName).toBe("最新名");
  });

  it("リネームイベントが無ければ channelName は undefined", () => {
    const state = reduceChannel([
      { id: uid(10), type: "message_created", ts: "t", author: "a", body: "m" },
    ]);
    expect(state.channelName).toBeUndefined();
  });
});

describe("reducer: buildThreads", () => {
  it("親の下に返信をぶら下げる", () => {
    const events: ChatEvent[] = [
      { id: uid(10), type: "message_created", ts: "t", author: "a", body: "parent" },
      { id: uid(20), type: "message_created", ts: "t", author: "b", body: "reply1", threadId: uid(10) },
      { id: uid(30), type: "message_created", ts: "t", author: "c", body: "top2" },
      { id: uid(40), type: "message_created", ts: "t", author: "d", body: "reply2", threadId: uid(10) },
    ];
    const threads = buildThreads(reduceChannel(events).messages);
    expect(threads).toHaveLength(2);
    expect(threads[0].parent.body).toBe("parent");
    expect(threads[0].replies.map((r) => r.body)).toEqual(["reply1", "reply2"]);
    expect(threads[1].parent.body).toBe("top2");
    expect(threads[1].replies).toEqual([]);
  });

  it("親が見つからない返信はトップレベル扱い", () => {
    const threads = buildThreads(
      reduceChannel([
        { id: uid(20), type: "message_created", ts: "t", author: "b", body: "orphan", threadId: uid(99) },
      ]).messages,
    );
    expect(threads).toHaveLength(1);
    expect(threads[0].parent.body).toBe("orphan");
  });
});
