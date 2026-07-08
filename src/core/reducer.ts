// リデューサ: イベント列 → チャンネル状態。DESIGN.md §3 導出ルール + DESIGN_EXTENSION.md §2。
//
// - 全イベントを ULID 昇順にマージソートして再生する。ULID 順が LWW/時系列の正。
// - 昇順処理により「後勝ち(last-write-wins)」が自然に成立する。
// - 編集/削除は author が元メッセージの author と一致するイベントのみ有効。
// - リアクションの同一性は (targetId, author, emoji) の 3 つ組。
// - channel_renamed は同一 targetId で ULID 最大が勝ち。
// - core 層は vscode に依存しない。

import type { ChatEvent } from "./events";
import type { Ulid } from "./ulid";

/** メッセージに付いたリアクション 1 種の集計結果。 */
export interface ReactionState {
  emoji: string;
  /** リアクションしたユーザー ID(最初に付けた順)。 */
  users: string[];
}

/** リデュース済みの 1 メッセージ状態。 */
export interface MessageState {
  id: Ulid;
  author: string;
  ts: string;
  body: string;
  threadId?: Ulid;
  attachments: Ulid[];
  edited: boolean;
  deleted: boolean;
  reactions: ReactionState[];
}

/** リデュース済みのチャンネル状態。 */
export interface ChannelState {
  /** channel_renamed から導出した現在名。イベントが無ければ undefined(呼び出し側が channel.json を使う)。 */
  channelName?: string;
  /** ULID 昇順のメッセージ一覧。 */
  messages: MessageState[];
}

// 内部作業用のミュータブルなメッセージ表現。
interface MutableMessage {
  id: Ulid;
  author: string;
  ts: string;
  body: string;
  threadId?: Ulid;
  attachments: Ulid[];
  edited: boolean;
  deleted: boolean;
  // emoji -> (author -> added?) 挿入順を保持する Map。
  reactions: Map<string, Map<string, boolean>>;
}

/**
 * イベント列をリデュースしてチャンネル状態を得る。
 * 入力は単一チャンネルの全イベント(複数ユーザー・複数月分を連結したもの)を想定する。
 */
export function reduceChannel(events: readonly ChatEvent[]): ChannelState {
  // ULID 昇順にソート(元配列は破壊しない)。
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const messages = new Map<Ulid, MutableMessage>(); // 挿入順 = 作成 ULID 昇順
  let channelName: string | undefined;

  for (const ev of sorted) {
    switch (ev.type) {
      case "message_created": {
        // 同一 id の重複作成は最初のものを採用(以降は無視)。
        if (!messages.has(ev.id)) {
          messages.set(ev.id, {
            id: ev.id,
            author: ev.author,
            ts: ev.ts,
            body: ev.body,
            threadId: ev.threadId,
            attachments: ev.attachments ? [...ev.attachments] : [],
            edited: false,
            deleted: false,
            reactions: new Map(),
          });
        }
        break;
      }
      case "message_edited": {
        const target = messages.get(ev.targetId);
        // 権限チェック: 元メッセージの author と一致する場合のみ有効。
        if (target && target.author === ev.author) {
          target.body = ev.body; // 昇順処理なので後勝ち。
          target.edited = true;
        }
        break;
      }
      case "message_deleted": {
        const target = messages.get(ev.targetId);
        if (target && target.author === ev.author) {
          target.deleted = true;
        }
        break;
      }
      case "reaction_added":
      case "reaction_removed": {
        const target = messages.get(ev.targetId);
        if (!target) break; // 対象不明のリアクションは無視。
        let byEmoji = target.reactions.get(ev.emoji);
        if (!byEmoji) {
          byEmoji = new Map<string, boolean>();
          target.reactions.set(ev.emoji, byEmoji);
        }
        // 昇順処理により (targetId, author, emoji) の後勝ちが成立する。
        byEmoji.set(ev.author, ev.type === "reaction_added");
        break;
      }
      case "channel_renamed": {
        channelName = ev.name; // 昇順処理なので ULID 最大が最後に残る。
        break;
      }
    }
  }

  const result: ChannelState = {
    messages: [...messages.values()].map(finalizeMessage),
  };
  if (channelName !== undefined) {
    result.channelName = channelName;
  }
  return result;
}

function finalizeMessage(m: MutableMessage): MessageState {
  const reactions: ReactionState[] = [];
  for (const [emoji, byAuthor] of m.reactions) {
    const users: string[] = [];
    for (const [author, added] of byAuthor) {
      if (added) users.push(author);
    }
    if (users.length > 0) {
      reactions.push({ emoji, users });
    }
  }
  const out: MessageState = {
    id: m.id,
    author: m.author,
    ts: m.ts,
    body: m.deleted ? "" : m.body,
    attachments: m.deleted ? [] : m.attachments,
    edited: m.edited,
    deleted: m.deleted,
    reactions: m.deleted ? [] : reactions,
  };
  if (m.threadId !== undefined) out.threadId = m.threadId;
  return out;
}

/** ビュー用のスレッド構造体(DESIGN_EXTENSION.md §5 RenderedThread)。 */
export interface RenderedThread {
  parent: MessageState;
  replies: MessageState[];
}

/**
 * リデュース済みメッセージ列をスレッド構造(親 + 返信配列)に組み立てる。
 * threadId の無いメッセージ、および親が見つからない返信をトップレベル扱いにする。
 * 返信は ULID 昇順、トップレベルも ULID 昇順で返す(messages は既に昇順)。
 */
export function buildThreads(messages: readonly MessageState[]): RenderedThread[] {
  const byId = new Map<Ulid, MessageState>();
  for (const m of messages) byId.set(m.id, m);

  const threads: RenderedThread[] = [];
  const threadIndex = new Map<Ulid, RenderedThread>();

  for (const m of messages) {
    const isReply = m.threadId !== undefined && byId.has(m.threadId);
    if (!isReply) {
      const thread: RenderedThread = { parent: m, replies: [] };
      threads.push(thread);
      threadIndex.set(m.id, thread);
    }
  }
  for (const m of messages) {
    if (m.threadId !== undefined) {
      const thread = threadIndex.get(m.threadId);
      if (thread) {
        thread.replies.push(m);
      }
    }
  }
  return threads;
}
