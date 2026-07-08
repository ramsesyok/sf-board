import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { snapshotCursors, diffCursors, type CursorSnapshot } from "../core/sync";
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
