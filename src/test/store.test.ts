import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as fssync from "fs";
import * as path from "path";
import {
  appendEvent,
  atomicWriteFile,
  createChannelMeta,
  readChannelMeta,
  readChannelEvents,
  writeCursor,
  readCursor,
  writeUserProfile,
  readAllUserProfiles,
  listChannelIds,
  normalizeUserId,
  monthKey,
  eventFilePath,
  initWorkspace,
  makeTempRoot,
  writeAttachment,
  listAttachments,
  verifyAttachment,
  sha256Hex,
} from "../core/store";
import { reduceChannel } from "../core/reducer";
import type { ChatEvent } from "../core/events";

let root: string;

beforeEach(async () => {
  root = await makeTempRoot();
  await initWorkspace(root, "test-ws");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const CH = "0000000000000000000000CHAN";

describe("store: normalizeUserId", () => {
  it("安全な文字以外を _ に置換する", () => {
    expect(normalizeUserId("do\\main\\user")).toBe("do_main_user");
    expect(normalizeUserId("a.b@c")).toBe("a_b_c");
    expect(normalizeUserId("ok-User_1")).toBe("ok-User_1");
  });
  it("正規化後に空なら例外", () => {
    expect(() => normalizeUserId("...")).not.toThrow(); // "___" になる
    expect(() => normalizeUserId("")).toThrow();
  });
});

describe("store: atomicWriteFile(§4.2 tmp→rename)", () => {
  it("書き込み後に .tmp ファイルが残らない", async () => {
    const target = path.join(root, "sub", "a.json");
    await atomicWriteFile(target, "hello");
    expect(await fs.readFile(target, "utf8")).toBe("hello");
    const entries = await fs.readdir(path.join(root, "sub"));
    expect(entries).toEqual(["a.json"]);
  });

  it("rename 失敗時にも一時ファイルを残さない", async () => {
    // 書き込み先を「空でないディレクトリ」にして rename(file→dir)を失敗させる。
    const target = path.join(root, "sub2", "blocked");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "keep"), "x");
    await expect(atomicWriteFile(target, "data")).rejects.toThrow();
    const entries = await fs.readdir(path.join(root, "sub2"));
    expect(entries.filter((e) => e.includes(".tmp."))).toEqual([]);
  });
});

describe("store: appendEvent(§4.1 単一 write 追記)", () => {
  it("1 イベント = 1 行で追記される", async () => {
    const e1: ChatEvent = { id: "0000000000000000000000AAA1", type: "message_created", ts: "t", author: "alice", body: "one" };
    const e2: ChatEvent = { id: "0000000000000000000000AAA2", type: "message_created", ts: "t", author: "alice", body: "two" };
    const date = new Date(2026, 6, 9); // 2026-07
    await appendEvent(root, CH, "alice", e1, date);
    await appendEvent(root, CH, "alice", e2, date);

    const file = eventFilePath(root, CH, "2026-07", "alice");
    const text = await fs.readFile(file, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("月パーティションで別ファイルに分かれる", async () => {
    const e: ChatEvent = { id: "0000000000000000000000AAA1", type: "message_created", ts: "t", author: "alice", body: "x" };
    await appendEvent(root, CH, "alice", e, new Date(2026, 5, 1)); // 2026-06
    await appendEvent(root, CH, "alice", { ...e, id: "0000000000000000000000AAA2" }, new Date(2026, 6, 1)); // 2026-07
    expect(fssync.existsSync(eventFilePath(root, CH, "2026-06", "alice"))).toBe(true);
    expect(fssync.existsSync(eventFilePath(root, CH, "2026-07", "alice"))).toBe(true);
  });
});

describe("store: channel / cursor / user のラウンドトリップ", () => {
  it("channel.json は作成→読み込みで一致し、二重作成は例外", async () => {
    const meta = { id: CH, name: "general", createdBy: "alice", createdAt: "2026-07-09T00:00:00Z" };
    await createChannelMeta(root, meta);
    expect(await readChannelMeta(root, CH)).toEqual(meta);
    await expect(createChannelMeta(root, meta)).rejects.toThrow();
  });

  it("cursor / user プロフィールのラウンドトリップ", async () => {
    await writeCursor(root, "alice", { lastEventId: "0000000000000000000000AAA1", lastChannelId: CH, updatedAt: "t" });
    expect((await readCursor(root, "alice"))?.lastChannelId).toBe(CH);

    await writeUserProfile(root, { userId: "alice", displayName: "Alice A" });
    await writeUserProfile(root, { userId: "bob", displayName: "Bob B" });
    const all = await readAllUserProfiles(root);
    expect(Object.keys(all).sort()).toEqual(["alice", "bob"]);
    expect(all["alice"].displayName).toBe("Alice A");
  });

  it("listChannelIds はチャンネルディレクトリを列挙する", async () => {
    await createChannelMeta(root, { id: CH, name: "g", createdBy: "a", createdAt: "t" });
    expect(await listChannelIds(root)).toEqual([CH]);
  });
});

describe("store: readChannelEvents", () => {
  it("全月・全ユーザーを読み、不正行はスキップする", async () => {
    const date = new Date(2026, 6, 9);
    await appendEvent(root, CH, "alice", { id: "0000000000000000000000AAA1", type: "message_created", ts: "t", author: "alice", body: "a" }, date);
    await appendEvent(root, CH, "bob", { id: "0000000000000000000000BBB1", type: "message_created", ts: "t", author: "bob", body: "b" }, date);
    // 破損行を直接混入。
    await fs.appendFile(eventFilePath(root, CH, "2026-07", "alice"), "{ broken line\n");

    const events = await readChannelEvents(root, CH);
    expect(events).toHaveLength(2);
    const authors = events.map((e) => e.author).sort();
    expect(authors).toEqual(["alice", "bob"]);
  });

  it("イベントが無いチャンネルは空配列", async () => {
    expect(await readChannelEvents(root, "0000000000000000000000NONE")).toEqual([]);
  });
});

describe("store: 添付ファイル(DESIGN.md §4.3)", () => {
  it("書き込み後 listAttachments で meta と共に取得でき、SHA-256 が一致する", async () => {
    const data = Buffer.from("attachment payload");
    const ulid = "0000000000000000000000ATT1";
    const meta = await writeAttachment(root, CH, ulid, data, "photo.png", "image/png", new Date(2026, 6, 9));
    expect(meta.size).toBe(data.length);
    expect(meta.sha256).toBe(sha256Hex(data));

    const list = await listAttachments(root, CH);
    expect(Object.keys(list)).toEqual([ulid]);
    expect(list[ulid].meta.name).toBe("photo.png");
    expect(list[ulid].month).toBe("2026-07");
    expect(await verifyAttachment(list[ulid].blobPath, meta.sha256)).toBe(true);
  });

  it("blob が改竄されると verifyAttachment が false", async () => {
    const ulid = "0000000000000000000000ATT2";
    const meta = await writeAttachment(root, CH, ulid, Buffer.from("orig"), "a.txt", "text/plain", new Date(2026, 6, 9));
    const list = await listAttachments(root, CH);
    await fs.writeFile(list[ulid].blobPath, "tampered");
    expect(await verifyAttachment(list[ulid].blobPath, meta.sha256)).toBe(false);
  });

  it("添付が無いチャンネルは空", async () => {
    expect(await listAttachments(root, "0000000000000000000000NONE")).toEqual({});
  });
});

describe("monthKey", () => {
  it("YYYY-MM 形式でゼロ埋めする", () => {
    expect(monthKey(new Date(2026, 0, 5))).toBe("2026-01");
    expect(monthKey(new Date(2026, 11, 31))).toBe("2026-12");
  });
});

// DESIGN_EXTENSION.md §12: 2 ユーザーが各自のファイルに書いても、
// 読み手側で同一状態に収束することを検証する(結合テストの核)。
describe("収束: 2 ユーザーの追記が同一状態にマージされる", () => {
  it("相互のイベントが ULID 順にマージされ一致する", async () => {
    const date = new Date(2026, 6, 9);
    // ULID は昇順(create < reaction < edit)になるよう連番の末尾で表現する。
    const msg = "00000000000000000000000010";
    // alice が投稿、bob がリアクション、alice が編集。各自自分のファイルへ追記。
    await appendEvent(root, CH, "alice", { id: msg, type: "message_created", ts: "t", author: "alice", body: "hi" }, date);
    await appendEvent(root, CH, "bob", { id: "00000000000000000000000020", type: "reaction_added", ts: "t", author: "bob", targetId: msg, emoji: "👍" }, date);
    await appendEvent(root, CH, "alice", { id: "00000000000000000000000030", type: "message_edited", ts: "t", author: "alice", targetId: msg, body: "hi (edited)" }, date);

    const state = reduceChannel(await readChannelEvents(root, CH));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].body).toBe("hi (edited)");
    expect(state.messages[0].edited).toBe(true);
    expect(state.messages[0].reactions).toEqual([{ emoji: "👍", users: ["bob"] }]);
  });
});
