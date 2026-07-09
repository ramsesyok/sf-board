// 共有フォルダの読み書き。DESIGN.md §2(ディレクトリ構成)/ §4(書き込みプロトコル)。
//
// 設計原則(厳守):
//  - 追記または新規作成のみ。書き換え・削除はしない。
//  - 各ユーザーは自分の userId を含むファイルにのみ書き込む(ロック機構は作らない)。
//  - 新規ファイルは一時名で書き切ってからリネーム(アトミック)。
//  - JSONL は 1 イベント = 1 行を単一 write で追記し flush する。
//  - core 層は vscode に依存しない(Node の fs のみ)。

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { serializeEvent, parseEventLines, type ChatEvent } from "./events";
import type { Ulid } from "./ulid";
import type { WorkspaceMeta, ChannelMeta, UserProfile, Cursor, AttachmentMeta } from "../shared/types";

// スキーマ型は shared/types に集約(Webview からも参照するため)。ここでは再エクスポートする。
export type { WorkspaceMeta, ChannelMeta, UserProfile, Cursor, AttachmentMeta } from "../shared/types";

export const SCHEMA_VERSION = 1;

// ---- userId 正規化 ----

/** userId をファイル名に安全な文字([a-zA-Z0-9_-])へ正規化する。DESIGN.md §2。 */
export function normalizeUserId(userId: string): string {
  const normalized = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (normalized.length === 0) {
    throw new Error(`userId が正規化後に空になりました: ${JSON.stringify(userId)}`);
  }
  return normalized;
}

/** Date から月パーティションキー(YYYY-MM)を得る。ローカルタイム基準。 */
export function monthKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// ---- パスヘルパ ----

export function channelDir(rootPath: string, channelId: Ulid): string {
  return path.join(rootPath, "channels", channelId);
}
export function channelMetaPath(rootPath: string, channelId: Ulid): string {
  return path.join(channelDir(rootPath, channelId), "channel.json");
}
export function channelEventsDir(rootPath: string, channelId: Ulid): string {
  return path.join(channelDir(rootPath, channelId), "events");
}
export function eventFilePath(
  rootPath: string,
  channelId: Ulid,
  month: string,
  userId: string,
): string {
  return path.join(channelEventsDir(rootPath, channelId), month, `${normalizeUserId(userId)}.jsonl`);
}
export function userProfilePath(rootPath: string, userId: string): string {
  return path.join(rootPath, "users", `${normalizeUserId(userId)}.json`);
}
export function cursorPath(rootPath: string, userId: string): string {
  return path.join(rootPath, "cursors", `${normalizeUserId(userId)}.json`);
}
export function workspacePath(rootPath: string): string {
  return path.join(rootPath, "workspace.json");
}

// ---- アトミック書き込み(§4.2: tmp → rename) ----

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 新規ファイルを一時名で書き切ってから本来名へリネームする(同一ボリューム内でアトミック)。
 * 既存ファイルがあっても rename で置換される点に注意(呼び出し側で不変性を担保すること)。
 */
export async function atomicWriteFile(filePath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `${path.basename(filePath)}.tmp.${randomToken()}`);
  const fh = await fsp.open(tmpPath, "w");
  try {
    await fh.writeFile(data);
    await fh.sync(); // flush してからリネームし、可視化時点で内容が完全であることを保証。
  } finally {
    await fh.close();
  }
  await fsp.rename(tmpPath, filePath);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(value, null, 2) + "\n");
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text) as T;
}

// ---- イベント追記(§4.1) ----

/**
 * イベントを当月・自分のイベントログに単一 write で追記する。
 * @param userId 書き込み主体(= event.author と一致すべき)。
 * @param date 月パーティションの決定に使う日時(既定は現在時刻)。
 */
export async function appendEvent(
  rootPath: string,
  channelId: Ulid,
  userId: string,
  event: ChatEvent,
  date: Date = new Date(),
): Promise<void> {
  const filePath = eventFilePath(rootPath, channelId, monthKey(date), userId);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const line = serializeEvent(event) + "\n";
  // 1 イベント = 1 行を単一 write で追記し fsync する。
  const fh = await fsp.open(filePath, "a");
  try {
    await fh.writeFile(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// ---- workspace / channel / user / cursor ----

export async function writeWorkspace(rootPath: string, meta: WorkspaceMeta): Promise<void> {
  await atomicWriteJson(workspacePath(rootPath), meta);
}
export async function readWorkspace(rootPath: string): Promise<WorkspaceMeta | undefined> {
  return readJsonIfExists<WorkspaceMeta>(workspacePath(rootPath));
}

/** channel.json を新規作成する(既存があれば作らない=不変性を守る)。 */
export async function createChannelMeta(rootPath: string, meta: ChannelMeta): Promise<void> {
  const filePath = channelMetaPath(rootPath, meta.id);
  if (fs.existsSync(filePath)) {
    throw new Error(`channel.json は既に存在します: ${meta.id}`);
  }
  await atomicWriteJson(filePath, meta);
}
export async function readChannelMeta(
  rootPath: string,
  channelId: Ulid,
): Promise<ChannelMeta | undefined> {
  return readJsonIfExists<ChannelMeta>(channelMetaPath(rootPath, channelId));
}

export async function writeUserProfile(rootPath: string, profile: UserProfile): Promise<void> {
  // 本人のみ更新するファイル。プロフィールは追記ではなく丸ごと差し替え(tmp→rename)。
  await atomicWriteJson(userProfilePath(rootPath, profile.userId), profile);
}
export async function readUserProfile(
  rootPath: string,
  userId: string,
): Promise<UserProfile | undefined> {
  return readJsonIfExists<UserProfile>(userProfilePath(rootPath, userId));
}
/** users/ 配下の全プロフィールを読み込む(userId → profile)。 */
export async function readAllUserProfiles(rootPath: string): Promise<Record<string, UserProfile>> {
  const dir = path.join(rootPath, "users");
  const out: Record<string, UserProfile> = {};
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const profile = await readJsonIfExists<UserProfile>(path.join(dir, entry));
    if (profile && typeof profile.userId === "string") {
      out[profile.userId] = profile;
    }
  }
  return out;
}

export async function writeCursor(rootPath: string, userId: string, cursor: Cursor): Promise<void> {
  await atomicWriteJson(cursorPath(rootPath, userId), cursor);
}
export async function readCursor(rootPath: string, userId: string): Promise<Cursor | undefined> {
  return readJsonIfExists<Cursor>(cursorPath(rootPath, userId));
}

// ---- チャンネル列挙・イベント読み込み ----

/** channels/ 配下のチャンネル ID 一覧(ディレクトリ名)を返す。 */
export async function listChannelIds(rootPath: string): Promise<Ulid[]> {
  const dir = path.join(rootPath, "channels");
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * 指定チャンネルの全イベント(全月・全ユーザーの jsonl)を読み込んでパースする。
 * 不正行はスキップ。リデューサへの入力に使う(Phase 1 は全読み。差分読みは Phase 4)。
 */
export async function readChannelEvents(rootPath: string, channelId: Ulid): Promise<ChatEvent[]> {
  const eventsRoot = channelEventsDir(rootPath, channelId);
  const events: ChatEvent[] = [];
  let months: string[];
  try {
    months = await fsp.readdir(eventsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return events;
    throw err;
  }
  for (const month of months.sort()) {
    const monthDir = path.join(eventsRoot, month);
    let files: fs.Dirent[];
    try {
      files = await fsp.readdir(monthDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const text = await fsp.readFile(path.join(monthDir, file.name), "utf8");
      for (const ev of parseEventLines(text)) events.push(ev);
    }
  }
  return events;
}

/** テスト・初回起動用: 一時ディレクトリ配下に chat-root の骨組みを作る。 */
export async function initWorkspace(rootPath: string, name: string): Promise<void> {
  await fsp.mkdir(path.join(rootPath, "users"), { recursive: true });
  await fsp.mkdir(path.join(rootPath, "cursors"), { recursive: true });
  await fsp.mkdir(path.join(rootPath, "channels"), { recursive: true });
  await fsp.mkdir(path.join(rootPath, "attachments"), { recursive: true });
  if (!(await readWorkspace(rootPath))) {
    await writeWorkspace(rootPath, { schemaVersion: SCHEMA_VERSION, name });
  }
}

/** テスト補助: OS の一時ディレクトリに一意な chat-root を作って返す。 */
export async function makeTempRoot(prefix = "sf-board-"): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---- 添付ファイル(DESIGN.md §4.3) ----

export function attachmentsRoot(rootPath: string): string {
  return path.join(rootPath, "attachments");
}
export function channelAttachmentsDir(rootPath: string, channelId: Ulid): string {
  return path.join(attachmentsRoot(rootPath), channelId);
}
export function attachmentDir(rootPath: string, channelId: Ulid, month: string, ulid: Ulid): string {
  return path.join(channelAttachmentsDir(rootPath, channelId), month, ulid);
}
export function attachmentBlobPath(rootPath: string, channelId: Ulid, month: string, ulid: Ulid): string {
  return path.join(attachmentDir(rootPath, channelId, month, ulid), "blob");
}
export function attachmentMetaPath(rootPath: string, channelId: Ulid, month: string, ulid: Ulid): string {
  return path.join(attachmentDir(rootPath, channelId, month, ulid), "meta.json");
}

/** Buffer の SHA-256 を 16 進文字列で返す。 */
export function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * 添付を書き込む。DESIGN.md §4.3 の順序を厳守:
 *   1. ディレクトリ作成 → blob.tmp に書き切り
 *   2. SHA-256 を計算し meta.json を書く(tmp→rename)
 *   3. blob.tmp → blob にリネーム(最後に blob を可視化)
 * 呼び出し側は本メソッド完了後に message_created(attachments)を追記すること(§4.3 手順4)。
 */
export async function writeAttachment(
  rootPath: string,
  channelId: Ulid,
  ulid: Ulid,
  data: Buffer,
  name: string,
  mime: string,
  date: Date = new Date(),
): Promise<AttachmentMeta> {
  const month = monthKey(date);
  const dir = attachmentDir(rootPath, channelId, month, ulid);
  await fsp.mkdir(dir, { recursive: true });

  const tmpBlob = path.join(dir, `blob.tmp.${randomToken()}`);
  const fh = await fsp.open(tmpBlob, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }

  const meta: AttachmentMeta = { name, mime, size: data.length, sha256: sha256Hex(data) };
  await atomicWriteFile(attachmentMetaPath(rootPath, channelId, month, ulid), JSON.stringify(meta, null, 2) + "\n");
  await fsp.rename(tmpBlob, attachmentBlobPath(rootPath, channelId, month, ulid));
  return meta;
}

export interface StoredAttachment {
  ulid: Ulid;
  month: string;
  meta: AttachmentMeta;
  blobPath: string;
}

/**
 * 指定チャンネルの全添付(meta と blob が揃っているもの)を ulid → 情報で返す。
 * 書き込み途中(blob 未可視 / meta 未存在)は除外する。
 */
export async function listAttachments(
  rootPath: string,
  channelId: Ulid,
): Promise<Record<Ulid, StoredAttachment>> {
  const base = channelAttachmentsDir(rootPath, channelId);
  const out: Record<Ulid, StoredAttachment> = {};
  let months: string[];
  try {
    months = await fsp.readdir(base);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const month of months) {
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(path.join(base, month), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const ulid = d.name;
      const meta = await readJsonIfExists<AttachmentMeta>(attachmentMetaPath(rootPath, channelId, month, ulid));
      if (!meta) continue;
      const blobPath = attachmentBlobPath(rootPath, channelId, month, ulid);
      if (!fs.existsSync(blobPath)) continue; // blob 未可視(書き込み途中)は除外。
      out[ulid] = { ulid, month, meta, blobPath };
    }
  }
  return out;
}

/** blob の SHA-256 が期待値と一致するか検証する(保存時に使用)。DESIGN.md §4.3。 */
export async function verifyAttachment(blobPath: string, expectedSha256: string): Promise<boolean> {
  const data = await fsp.readFile(blobPath);
  return sha256Hex(data) === expectedSha256;
}
