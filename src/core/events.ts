// イベント型定義とシリアライズ/パース。DESIGN.md §3 + DESIGN_EXTENSION.md §2。
//
// - イベントログは JSONL(1 行 1 イベント、UTF-8、LF 区切り)。
// - パースは不正行をスキップして継続(例外で全体を止めない)。
// - 未知の type は無視(前方互換)。
// - 外部入力の境界なので unknown → 型ガードで検証する(any 禁止)。

import type { Ulid } from "./ulid";
import { isValidUlid } from "./ulid";

export interface MessageCreatedEvent {
  id: Ulid;
  type: "message_created";
  ts: string; // ISO 8601(表示用途のみ。順序判定に使わない)
  author: string; // userId
  body: string; // Markdown 生テキスト
  threadId?: Ulid; // 親メッセージのイベントID(あればスレッド返信)
  attachments?: Ulid[]; // attachments/ 配下の ULID 参照
}

export interface MessageEditedEvent {
  id: Ulid;
  type: "message_edited";
  ts: string;
  author: string; // 元メッセージの author と一致する場合のみ有効
  targetId: Ulid;
  body: string;
}

export interface MessageDeletedEvent {
  id: Ulid;
  type: "message_deleted";
  ts: string;
  author: string; // 元メッセージの author と一致する場合のみ有効
  targetId: Ulid;
}

export interface ReactionAddedEvent {
  id: Ulid;
  type: "reaction_added";
  ts: string;
  author: string;
  targetId: Ulid;
  emoji: string; // 例 ":+1:" または Unicode 絵文字
}

export interface ReactionRemovedEvent {
  id: Ulid;
  type: "reaction_removed";
  ts: string;
  author: string;
  targetId: Ulid;
  emoji: string;
}

// DESIGN_EXTENSION.md §2: チャンネルリネームイベント。
export interface ChannelRenamedEvent {
  id: Ulid;
  type: "channel_renamed";
  ts: string;
  author: string;
  targetId: Ulid; // channelId
  name: string; // 新チャンネル名
}

export type ChatEvent =
  | MessageCreatedEvent
  | MessageEditedEvent
  | MessageDeletedEvent
  | ReactionAddedEvent
  | ReactionRemovedEvent
  | ChannelRenamedEvent;

export type ChatEventType = ChatEvent["type"];

// ---- パースヘルパ(型ガード) ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUlidArray(value: unknown): value is Ulid[] {
  return Array.isArray(value) && value.every((v) => isValidUlid(v));
}

/** 全イベント共通の必須フィールド(id / ts / author)を検証する。 */
function hasCommonFields(o: Record<string, unknown>): o is Record<string, unknown> & {
  id: Ulid;
  ts: string;
  author: string;
} {
  return isValidUlid(o.id) && typeof o.ts === "string" && isNonEmptyString(o.author);
}

/**
 * パース済み JSON オブジェクトを ChatEvent に検証・変換する。
 * 不正・未知 type の場合は null を返す。
 */
function toChatEvent(o: unknown): ChatEvent | null {
  if (!isRecord(o) || !hasCommonFields(o)) {
    return null;
  }
  const base = { id: o.id, ts: o.ts, author: o.author };

  switch (o.type) {
    case "message_created": {
      if (typeof o.body !== "string") return null;
      if (o.threadId !== undefined && !isValidUlid(o.threadId)) return null;
      if (o.attachments !== undefined && !isUlidArray(o.attachments)) return null;
      const ev: MessageCreatedEvent = { ...base, type: "message_created", body: o.body };
      if (o.threadId !== undefined) ev.threadId = o.threadId;
      if (o.attachments !== undefined) ev.attachments = o.attachments;
      return ev;
    }
    case "message_edited": {
      if (!isValidUlid(o.targetId) || typeof o.body !== "string") return null;
      return { ...base, type: "message_edited", targetId: o.targetId, body: o.body };
    }
    case "message_deleted": {
      if (!isValidUlid(o.targetId)) return null;
      return { ...base, type: "message_deleted", targetId: o.targetId };
    }
    case "reaction_added": {
      if (!isValidUlid(o.targetId) || !isNonEmptyString(o.emoji)) return null;
      return { ...base, type: "reaction_added", targetId: o.targetId, emoji: o.emoji };
    }
    case "reaction_removed": {
      if (!isValidUlid(o.targetId) || !isNonEmptyString(o.emoji)) return null;
      return { ...base, type: "reaction_removed", targetId: o.targetId, emoji: o.emoji };
    }
    case "channel_renamed": {
      if (!isValidUlid(o.targetId) || typeof o.name !== "string") return null;
      return { ...base, type: "channel_renamed", targetId: o.targetId, name: o.name };
    }
    default:
      return null; // 未知 type は無視(前方互換)。
  }
}

/** ChatEvent を JSONL 1 行(末尾 LF なし)にシリアライズする。 */
export function serializeEvent(event: ChatEvent): string {
  return JSON.stringify(event);
}

/**
 * JSONL の 1 行を ChatEvent にパースする。
 * 空行・JSON 不正・スキーマ不正・未知 type の場合は null。
 */
export function parseEventLine(line: string): ChatEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // 破損行はスキップ(DESIGN.md §8)。
  }
  return toChatEvent(parsed);
}

/**
 * 複数行(ファイル全体テキスト等)をパースする。不正行はスキップして継続する。
 * 末尾の不完全行(LF で終わらない最終行)も含め、行単位で処理する。
 * 差分読みでの不完全行の持ち越しが必要な場合は splitCompleteLines を使うこと。
 */
export function parseEventLines(text: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const line of text.split("\n")) {
    const ev = parseEventLine(line);
    if (ev !== null) events.push(ev);
  }
  return events;
}

/**
 * 差分読み用: バッファを「LF で終わる完全な行群」と「持ち越す不完全な残り」に分割する。
 * DESIGN.md §5.3: 読み取った末尾が LF で終わらない場合、その不完全行は捨てて次回に持ち越す
 * (書き込みフラッシュ途中の読み取り対策)。
 */
export function splitCompleteLines(buffer: string): { lines: string[]; remainder: string } {
  const lastLf = buffer.lastIndexOf("\n");
  if (lastLf === -1) {
    return { lines: [], remainder: buffer };
  }
  const complete = buffer.slice(0, lastLf); // 末尾 LF は含めない
  const remainder = buffer.slice(lastLf + 1);
  const lines = complete.length === 0 ? [] : complete.split("\n");
  return { lines, remainder };
}
