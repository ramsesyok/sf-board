import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { snapshotCursors, diffCursors, updateHealth, type CursorSnapshot } from "../core/sync";
import { writeCursor, makeTempRoot, initWorkspace } from "../core/store";

let root: string;
beforeEach(async () => {
  root = await makeTempRoot();
  await initWorkspace(root, "ws");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const CH = "0000000000000000000000CHAN";

describe("sync: snapshotCursors / diffCursors(照合層 DESIGN.md §5.1)", () => {
  it("cursors ディレクトリが空なら空スナップショット", async () => {
    expect(await snapshotCursors(root)).toEqual({});
  });

  it("追加されたカーソルを差分として検出する", async () => {
    const prev = await snapshotCursors(root);
    await writeCursor(root, "alice", { lastEventId: "0000000000000000000000EVT1", lastChannelId: CH, updatedAt: "t" });
    const next = await snapshotCursors(root);
    expect(diffCursors(prev, next)).toEqual(["alice.json"]);
  });

  it("size 変化を差分として検出する", () => {
    const prev: CursorSnapshot = { "a.json": { mtimeMs: 100, size: 10 } };
    const next: CursorSnapshot = { "a.json": { mtimeMs: 100, size: 20 } };
    expect(diffCursors(prev, next)).toEqual(["a.json"]);
  });

  it("mtime 変化を差分として検出する", () => {
    const prev: CursorSnapshot = { "a.json": { mtimeMs: 100, size: 10 } };
    const next: CursorSnapshot = { "a.json": { mtimeMs: 200, size: 10 } };
    expect(diffCursors(prev, next)).toEqual(["a.json"]);
  });

  it("変化が無ければ空配列", () => {
    const snap: CursorSnapshot = { "a.json": { mtimeMs: 100, size: 10 } };
    expect(diffCursors(snap, snap)).toEqual([]);
  });
});

describe("sync: updateHealth(ヘルスチェック DESIGN.md §5.4)", () => {
  it("監視通知があればカウンタをリセットする", () => {
    const r = updateHealth(2, true, true);
    expect(r.consecutiveMissed).toBe(0);
    expect(r.shouldFallback).toBe(false);
  });

  it("変化ありだが監視通知なしで取りこぼしをカウントする", () => {
    let missed = 0;
    let last = updateHealth(missed, true, false);
    expect(last.consecutiveMissed).toBe(1);
    last = updateHealth(last.consecutiveMissed, true, false);
    last = updateHealth(last.consecutiveMissed, true, false);
    expect(last.consecutiveMissed).toBe(3);
    expect(last.shouldFallback).toBe(true);
  });

  it("変化も通知も無ければカウンタは変わらない", () => {
    const r = updateHealth(1, false, false);
    expect(r.consecutiveMissed).toBe(1);
    expect(r.shouldFallback).toBe(false);
  });
});
