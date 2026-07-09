import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { SyncEngine } from "../core/sync";
import { ChatModel } from "../model/chatModel";
import { LocalCache } from "../core/localCache";
import { writeCursor, makeTempRoot, initWorkspace } from "../core/store";
import type { DiagLevel, DiagnosticsLogger } from "../core/diagnostics";
import type { ChatEvent } from "../core/events";

interface Entry {
  level: DiagLevel;
  name: string;
  fields?: Record<string, unknown>;
}
class FakeLogger implements DiagnosticsLogger {
  entries: Entry[] = [];
  log(level: DiagLevel, name: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level, name, fields });
  }
  names(): string[] {
    return this.entries.map((e) => e.name);
  }
  find(name: string): Entry | undefined {
    return this.entries.find((e) => e.name === name);
  }
}

let root: string;
beforeEach(async () => {
  root = await makeTempRoot();
  await initWorkspace(root, "ws");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const CH = "0000000000000000000000CHAN";

describe("diagnostics: SyncEngine のログ", () => {
  it("カーソル変化を change.detected として記録する", async () => {
    const fake = new FakeLogger();
    const changes: string[][] = [];
    const engine = new SyncEngine({
      rootPath: root,
      reconcileMs: 999999,
      fallbackMs: 999999,
      watchEnabled: false,
      onChange: (c) => void changes.push(c),
      logger: fake,
    });

    // start() せず checkNow() のみ(タイマー/fs.watch を起動しない)。
    await writeCursor(root, "alice", { lastEventId: "0000000000000000000000EVT1", lastChannelId: CH, updatedAt: "t" });
    await engine.checkNow();

    expect(changes).toEqual([["alice.json"]]);
    const detected = fake.find("change.detected");
    expect(detected).toBeDefined();
    expect(detected?.fields?.count).toBe(1);
    expect(detected?.fields?.source).toBe("manual");
  });
});

describe("diagnostics: ChatModel のログ", () => {
  it("投稿で channel.updated を記録する", async () => {
    const fake = new FakeLogger();
    const model = new ChatModel(root, "alice");
    model.setLogger(fake);
    await model.init("Alice");

    const id = await model.createChannel("general");
    await model.sendMessage(id, "hi");
    expect(fake.names()).toContain("channel.updated");
  });

  it("キューフラッシュで queue.flush(sent 件数)を記録する", async () => {
    const fake = new FakeLogger();
    const model = new ChatModel(root, "alice");
    model.setLogger(fake);
    const cache = new LocalCache(path.join(root, "lc.json"));
    await cache.load();
    model.setLocalCache(cache);
    await model.init("Alice");

    const id = await model.createChannel("general");
    const queued: ChatEvent = {
      id: "0000000000000000000000Q001",
      type: "message_created",
      ts: "t",
      author: "alice",
      body: "x",
    };
    await cache.enqueue({ requestId: queued.id, channelId: id, event: queued });
    await model.flushQueue();

    const flush = fake.find("queue.flush");
    expect(flush).toBeDefined();
    expect(flush?.fields?.sent).toBe(1);
  });

  it("ロガー未設定でも例外なく動作する(既定 no-op)", async () => {
    const model = new ChatModel(root, "alice");
    await model.init("Alice");
    const id = await model.createChannel("general");
    await expect(model.sendMessage(id, "hi")).resolves.toBe("written");
  });
});
