import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import {
  ensureDir,
  initWorkspace,
  isWorkspaceInitialized,
  readWorkspace,
  makeTempRoot,
} from "../core/store";
import { ChatModel } from "../model/chatModel";

let root: string;
beforeEach(async () => {
  root = await makeTempRoot();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("ensureDir", () => {
  it("既存ディレクトリでも例外を投げない", async () => {
    const dir = path.join(root, "a", "b");
    await ensureDir(dir);
    await expect(ensureDir(dir)).resolves.toBeUndefined(); // 2 回目も OK
  });

  it("ネストしたディレクトリを作成する", async () => {
    const dir = path.join(root, "x", "y", "z");
    await ensureDir(dir);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });
});

describe("initWorkspace: 冪等性(初期化済みフォルダを開いてもエラーにならない)", () => {
  it("1 回目で作成、2 回目以降は何もしない(例外なし)", async () => {
    await initWorkspace(root, "sf-board");
    expect(await isWorkspaceInitialized(root)).toBe(true);
    const first = await readWorkspace(root);

    // 2 人目以降の初回利用を模擬。例外を投げず、workspace.json も変わらない。
    await expect(initWorkspace(root, "sf-board")).resolves.toBeUndefined();
    await expect(initWorkspace(root, "別の名前")).resolves.toBeUndefined();
    expect(await readWorkspace(root)).toEqual(first); // 上書きされない
  });

  it("未初期化なら isWorkspaceInitialized は false", async () => {
    expect(await isWorkspaceInitialized(root)).toBe(false);
  });
});

describe("2 人目以降のユーザーが初期化済みフォルダを開く", () => {
  it("エラーなく初期化でき、既存チャンネル・プロフィールが見える", async () => {
    // 1 人目 alice がセットアップし、チャンネルを作成。
    const alice = new ChatModel(root, "alice");
    await alice.init("Alice");
    const channelId = await alice.createChannel("general");

    // 2 人目 bob が同じ共有フォルダで初回利用(初期化)。例外が出ないこと。
    const bob = new ChatModel(root, "bob");
    await expect(bob.init("Bob")).resolves.toBeUndefined();

    // bob から既存チャンネルが見え、両者のプロフィールが揃っている。
    const channels = await bob.listChannels();
    expect(channels.map((c) => c.id)).toContain(channelId);
    expect(Object.keys(bob.getUsers()).sort()).toEqual(["alice", "bob"]);

    // bob が投稿でき、alice 側から再読込で見える。
    await bob.sendMessage(channelId, "hello from bob");
    await alice.reconcileAll();
    const bodies = alice.getChannelView(channelId)!.threads.map((t) => t.parent.body);
    expect(bodies).toContain("hello from bob");
  });
});
