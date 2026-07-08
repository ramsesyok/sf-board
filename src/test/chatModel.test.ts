import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { ChatModel } from "../model/chatModel";
import { appendEvent, writeCursor, readChannelEvents, makeTempRoot } from "../core/store";
import { LocalCache } from "../core/localCache";
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
    await cache.enqueue({ requestId: queued.id, channelId: id, event: queued });

    await model.flushQueue();

    const events = await readChannelEvents(root, id);
    expect(events.some((e) => e.id === queued.id)).toBe(true);
    expect(cache.getQueue()).toHaveLength(0);
    const bodies = model.getChannelView(id)!.threads.map((t) => t.parent.body);
    expect(bodies).toContain("from queue");
  });
});
