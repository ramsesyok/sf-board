import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { LocalCache, LOCAL_CACHE_SCHEMA, matchesQueueOrigin, queueOrigin } from "../core/localCache";
import { makeTempRoot } from "../core/store";
import type { ChatEvent } from "../core/events";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await makeTempRoot();
  file = path.join(dir, "localCache.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const CH = "0000000000000000000000CHAN";
const evt: ChatEvent = {
  id: "0000000000000000000000Q001",
  type: "message_created",
  ts: "t",
  author: "alice",
  body: "queued",
};

describe("LocalCache: 既読位置", () => {
  it("設定した既読位置が永続化され再読込できる", async () => {
    const c1 = new LocalCache(file);
    await c1.load();
    expect(c1.getReadMarker(CH)).toBeUndefined();
    await c1.setReadMarker(CH, "0000000000000000000000READ");

    const c2 = new LocalCache(file);
    await c2.load();
    expect(c2.getReadMarker(CH)).toBe("0000000000000000000000READ");
  });
});

describe("LocalCache: 送信キュー", () => {
  it("enqueue → 永続化 → removeFromQueue", async () => {
    const c1 = new LocalCache(file);
    await c1.load();
    await c1.enqueue({ requestId: "r1", channelId: CH, event: evt, origin: queueOrigin(dir, "alice") });
    expect(c1.getQueue()).toHaveLength(1);

    const c2 = new LocalCache(file);
    await c2.load();
    expect(c2.getQueue()[0].requestId).toBe("r1");
    expect(matchesQueueOrigin(c2.getQueue()[0].origin, queueOrigin(dir, "alice"))).toBe(true);
    await c2.removeFromQueue("r1");
    expect(c2.getQueue()).toHaveLength(0);
  });

  it("旧形式の未送信イベントは明示的に送信先を紐付けるまで保留する", async () => {
    await fs.writeFile(file, JSON.stringify({
      schemaVersion: LOCAL_CACHE_SCHEMA,
      readMarkers: {},
      sendQueue: [
        { requestId: "old", channelId: CH, event: evt },
        { requestId: "other", channelId: CH, event: { ...evt, id: "0000000000000000000000Q002" } },
      ],
    }));
    const cache = new LocalCache(file);
    await cache.load();
    expect(cache.getLegacyQueueCount()).toBe(2);
    expect(matchesQueueOrigin(cache.getQueue()[0].origin, queueOrigin(dir, "alice"))).toBe(false);

    await cache.claimLegacyQueue(queueOrigin(dir, "alice"), ["old"]);
    const reloaded = new LocalCache(file);
    await reloaded.load();
    expect(reloaded.getLegacyQueueCount()).toBe(1);
    expect(matchesQueueOrigin(reloaded.getQueue()[0].origin, queueOrigin(dir, "alice"))).toBe(true);
    expect(reloaded.getQueue()[1].origin).toBeUndefined();
  });

  it("共有フォルダの表記ゆれを吸収し、ユーザー ID の違いは拒否する", () => {
    const origin = queueOrigin(path.join(dir, "room", "."), "alice");
    expect(matchesQueueOrigin({ rootPath: path.join(dir, "room"), userId: "alice" }, origin)).toBe(true);
    expect(matchesQueueOrigin({ rootPath: path.join(dir, "room"), userId: "bob" }, origin)).toBe(false);
  });
});

describe("LocalCache: 破損・未知スキーマ", () => {
  it("破損ファイルは空で初期化される", async () => {
    await fs.writeFile(file, "{ broken");
    const c = new LocalCache(file);
    await c.load();
    expect(c.getQueue()).toEqual([]);
    expect(c.getReadMarker(CH)).toBeUndefined();
  });

  it("未知スキーマは破棄される", async () => {
    await fs.writeFile(file, JSON.stringify({ schemaVersion: LOCAL_CACHE_SCHEMA + 99, readMarkers: { [CH]: "x" } }));
    const c = new LocalCache(file);
    await c.load();
    expect(c.getReadMarker(CH)).toBeUndefined();
  });
});
