import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { ChatModel } from "../model/chatModel";
import { appendEvent, writeCursor, readChannelEvents, makeTempRoot } from "../core/store";
import { LocalCache, matchesQueueOrigin, queueOrigin, LOCAL_CACHE_SCHEMA } from "../core/localCache";
import type { ChatEvent } from "../core/events";

let root: string;
let model: ChatModel;

beforeEach(async () => {
  root = await makeTempRoot();
  model = new ChatModel(root, "alice");
  await model.init("Alice");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("ChatModel: チャンネル作成・投稿", () => {
  it("作成したチャンネルが一覧に出る", async () => {
    const id = await model.createChannel("general");
    const channels = await model.listChannels();
    expect(channels).toEqual([{ id, name: "general", unread: 0 }]);
  });

  it("投稿すると view に反映され onChannelUpdated が発火する", async () => {
    const id = await model.createChannel("general");
    const updated: string[] = [];
    model.onChannelUpdated((cid) => updated.push(cid));

    await model.sendMessage(id, "hello");
    const view = model.getChannelView(id);
    expect(view?.threads).toHaveLength(1);
    expect(view?.threads[0].parent.body).toBe("hello");
    expect(view?.threads[0].parent.author).toBe("alice");
    expect(updated).toContain(id);

    // 実ファイルにも 1 イベント追記されている。
    const events = await readChannelEvents(root, id);
    expect(events).toHaveLength(1);
  });

  it("スレッド返信は親の下にぶら下がる", async () => {
    const id = await model.createChannel("general");
    await model.sendMessage(id, "parent");
    const parentId = model.getChannelView(id)!.threads[0].parent.id;
    await model.sendMessage(id, "reply", parentId);

    const threads = model.getChannelView(id)!.threads;
    expect(threads).toHaveLength(1);
    expect(threads[0].replies.map((r) => r.body)).toEqual(["reply"]);
  });

  it("リネームで channelName が更新される", async () => {
    const id = await model.createChannel("old");
    await model.renameChannel(id, "new");
    expect(model.getChannelView(id)?.channelName).toBe("new");
    const channels = await model.listChannels();
    expect(channels[0].name).toBe("new");
  });
});

describe("ChatModel: リアクション", () => {
  it("toggleReaction で追加→削除がトグルする", async () => {
    const id = await model.createChannel("general");
    await model.sendMessage(id, "m");
    const msgId = model.getChannelView(id)!.threads[0].parent.id;

    await model.toggleReaction(id, msgId, "👍");
    let reactions = model.getChannelView(id)!.threads[0].parent.reactions;
    expect(reactions).toEqual([{ emoji: "👍", users: ["alice"] }]);

    await model.toggleReaction(id, msgId, "👍");
    reactions = model.getChannelView(id)!.threads[0].parent.reactions;
    expect(reactions).toEqual([]);
  });
});

describe("ChatModel: 添付", () => {
  it("writeAttachment → sendMessage(attachments) で添付が紐づく", async () => {
    const id = await model.createChannel("general");
    const ulid = await model.writeAttachment(id, Buffer.from("hello png"), "pic.png", "image/png");
    await model.sendMessage(id, "見て", undefined, [ulid]);

    const parent = model.getChannelView(id)!.threads[0].parent;
    expect(parent.attachments).toEqual([ulid]);
    const atts = model.getChannelAttachments(id);
    expect(atts[ulid].meta.name).toBe("pic.png");
  });
});

describe("ChatModel: 照合ポーリングによる他ユーザー投稿の取り込み", () => {
  it("reconcileAll で他ユーザーの追記を反映し通知する", async () => {
    const id = await model.createChannel("general");
    await model.loadChannel(id); // 開いた状態にする。
    const updated: string[] = [];
    model.onChannelUpdated((cid) => updated.push(cid));

    // 別ユーザー bob が自分のファイルへ直接追記(共有フォルダ経由を模擬)。
    await appendEvent(root, id, "bob", {
      id: "0000000000000000000000BAB1",
      type: "message_created",
      ts: "t",
      author: "bob",
      body: "hi from bob",
    });
    await writeCursor(root, "bob", { lastEventId: "0000000000000000000000BAB1", lastChannelId: id, updatedAt: "t" });

    await model.reconcileAll();

    const bodies = model.getChannelView(id)!.threads.map((t) => t.parent.body);
    expect(bodies).toContain("hi from bob");
    expect(updated).toContain(id);
  });

  it("変化が無ければ onChannelUpdated は発火しない", async () => {
    const id = await model.createChannel("general");
    await model.loadChannel(id);
    const updated: string[] = [];
    model.onChannelUpdated((cid) => updated.push(cid));

    await model.reconcileAll(); // 変化なし
    expect(updated).toEqual([]);
  });
});

describe("ChatModel: 未読管理(§7)", () => {
  it("他ユーザー投稿で未読が増え、markRead で 0 になる", async () => {
    const cache = new LocalCache(path.join(root, "lc.json"));
    await cache.load();
    model.setLocalCache(cache);

    const id = await model.createChannel("general");
    await model.listChannels(); // 既読マーカーを初期化(現時点まで既読)。
    expect(model.getUnreadCount(id)).toBe(0);

    await appendEvent(root, id, "bob", {
      id: "0000000000000000000000BAB1",
      type: "message_created",
      ts: "t",
      author: "bob",
      body: "hi",
    });
    await writeCursor(root, "bob", { lastEventId: "0000000000000000000000BAB1", lastChannelId: id, updatedAt: "t" });
    await model.reconcileAll();
    expect(model.getUnreadCount(id)).toBe(1);

    await model.markRead(id);
    expect(model.getUnreadCount(id)).toBe(0);
  });
});

describe("ChatModel: 新着通知用の照会(§7.1)", () => {
  async function postAs(channelId: string, author: string, id: string, body: string): Promise<void> {
    await appendEvent(root, channelId, author, { id, type: "message_created", ts: "t", author, body });
    await writeCursor(root, author, { lastEventId: id, lastChannelId: channelId, updatedAt: "t" });
  }

  it("getIncomingMessagesAfter は自分以外・基準より新しいものを昇順で返す", async () => {
    const id = await model.createChannel("general");
    await postAs(id, "bob", "0000000000000000000000B0B1", "b1");
    await postAs(id, "carol", "0000000000000000000000CA01", "c1");
    await postAs(id, "bob", "0000000000000000000000B0B2", "b2");
    await model.reconcileAll();
    await model.sendMessage(id, "mine"); // 自分の投稿は含めない。

    const all = model.getIncomingMessagesAfter(id, "");
    expect(all.map((m) => m.body)).toEqual(["b1", "b2", "c1"]);
    const after = model.getIncomingMessagesAfter(id, "0000000000000000000000B0B1");
    expect(after.map((m) => m.body)).toEqual(["b2", "c1"]);
    expect(model.getLatestEventId(id)).toBe(
      model.getChannelView(id)!.threads.at(-1)!.parent.id, // 自分の投稿(最新 ULID)。
    );
  });

  it("getLoadedSummaries と findChannelWithLatestUnread が未読を反映する", async () => {
    const cache = new LocalCache(path.join(root, "lc.json"));
    await cache.load();
    model.setLocalCache(cache);

    const a = await model.createChannel("alpha");
    const b = await model.createChannel("beta");
    await model.listChannels(); // 既読マーカーを初期化。
    expect(model.findChannelWithLatestUnread()).toBeUndefined();

    await postAs(a, "bob", "0000000000000000000000AAA2", "later");
    await postAs(b, "bob", "0000000000000000000000AAA1", "earlier");
    await model.reconcileAll();

    expect(model.getLoadedSummaries()).toEqual([
      { id: a, name: "alpha", unread: 1 },
      { id: b, name: "beta", unread: 1 },
    ]);
    expect(model.findChannelWithLatestUnread()).toBe(a);

    await model.markRead(a);
    expect(model.findChannelWithLatestUnread()).toBe(b);
  });
});

describe("ChatModel: 送信キューのフラッシュ(§8)", () => {
  it("キュー済みイベントを共有フォルダへ書き出し、キューが空になる", async () => {
    const cache = new LocalCache(path.join(root, "lc.json"));
    await cache.load();
    model.setLocalCache(cache);

    const id = await model.createChannel("general");
    const queued: ChatEvent = {
      id: "0000000000000000000000Q001",
      type: "message_created",
      ts: "t",
      author: "alice",
      body: "from queue",
    };
    await cache.enqueue({ requestId: queued.id, channelId: id, event: queued, origin: queueOrigin(root, "alice") });

    await model.flushQueue();

    const events = await readChannelEvents(root, id);
    expect(events.some((e) => e.id === queued.id)).toBe(true);
    expect(cache.getQueue()).toHaveLength(0);
    const bodies = model.getChannelView(id)!.threads.map((t) => t.parent.body);
    expect(bodies).toContain("from queue");
  });

  it("元の共有フォルダへ戻るまで保留し、現在の共有フォルダの分だけ再送する", async () => {
    const cacheFile = path.join(root, "lc.json");
    const cache = new LocalCache(cacheFile);
    await cache.load();
    model.setLocalCache(cache);
    const channelA = await model.createChannel("A");
    const rootB = await makeTempRoot();
    try {
      const modelB = new ChatModel(rootB, "alice");
      await modelB.init("Alice");
      const channelB = await modelB.createChannel("B");
      const eventA: ChatEvent = {
        id: "0000000000000000000000Q001", type: "message_created", ts: "t", author: "alice", body: "private A",
      };
      const eventB: ChatEvent = {
        id: "0000000000000000000000Q002", type: "message_created", ts: "t", author: "alice", body: "for B",
      };
      await cache.enqueue({ requestId: eventA.id, channelId: channelA, event: eventA, origin: queueOrigin(root, "alice") });
      await cache.enqueue({ requestId: eventB.id, channelId: channelB, event: eventB, origin: queueOrigin(rootB, "alice") });

      const cacheB = new LocalCache(cacheFile); // 設定変更による再初期化を模擬。
      await cacheB.load();
      modelB.setLocalCache(cacheB);
      await modelB.flushQueue();
      expect(await readChannelEvents(rootB, channelA)).toEqual([]);
      expect((await readChannelEvents(rootB, channelB)).map((e) => e.id)).toContain(eventB.id);
      expect(cacheB.getQueue().map((item) => item.requestId)).toEqual([eventA.id]);

      const cacheAgain = new LocalCache(cacheFile);
      await cacheAgain.load();
      model.setLocalCache(cacheAgain);
      await model.flushQueue();
      expect((await readChannelEvents(root, channelA)).map((e) => e.id)).toContain(eventA.id);
      expect(cacheAgain.getQueue()).toHaveLength(0);
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it("旧形式のキューは確認して紐付けるまで再送しない", async () => {
    const channelId = await model.createChannel("general");
    const queued: ChatEvent = {
      id: "0000000000000000000000Q003", type: "message_created", ts: "t", author: "alice", body: "legacy",
    };
    const cacheFile = path.join(root, "legacy-cache.json");
    await fs.writeFile(cacheFile, JSON.stringify({
      schemaVersion: LOCAL_CACHE_SCHEMA,
      readMarkers: {},
      sendQueue: [{ requestId: queued.id, channelId, event: queued }],
    }));
    const cache = new LocalCache(cacheFile);
    await cache.load();
    model.setLocalCache(cache);

    await model.flushQueue();
    expect(await readChannelEvents(root, channelId)).toEqual([]);
    expect(cache.getQueue()).toHaveLength(1);

    await cache.claimLegacyQueue(queueOrigin(root, "alice"), [queued.id]);
    await model.flushQueue();
    expect((await readChannelEvents(root, channelId)).map((e) => e.id)).toContain(queued.id);
    expect(cache.getQueue()).toHaveLength(0);
  });

  it("送信失敗時に元の共有フォルダとユーザー ID をキューへ保存する", async () => {
    const blockedPath = path.join(root, "not-a-directory");
    await fs.writeFile(blockedPath, "block");
    const cache = new LocalCache(path.join(root, "blocked-cache.json"));
    await cache.load();
    const blockedModel = new ChatModel(blockedPath, "alice");
    blockedModel.setLocalCache(cache);

    expect(await blockedModel.sendMessage("0000000000000000000000CHAN", "queued")).toBe("queued");
    expect(cache.getQueue()).toHaveLength(1);
    expect(matchesQueueOrigin(cache.getQueue()[0].origin, queueOrigin(blockedPath, "alice"))).toBe(true);
  });
});
