// クライアントローカル状態(共有フォルダに置かないもの)。DESIGN.md §6 / §8。
//
// 保存先は Extension Host の globalStorageUri 配下(パスは呼び出し側が渡す)。
// - 既読位置: チャンネルごとの最終読了 ULID(未読バッジのローカル計算に使う)。
// - 送信キュー: オフライン時に積む未送信イベント(再起動で消えないよう永続化)。
// - スキーマバージョンを持ち、不整合時は破棄して初期化する(フルスキャンが常に安全な復旧手段)。
// - core 層は vscode に依存しない(Node の fs のみ)。

import * as fsp from "fs/promises";
import * as path from "path";
import type { ChatEvent } from "./events";
import type { Ulid } from "./ulid";

export const LOCAL_CACHE_SCHEMA = 1;

/** 送信待ちイベントを作成したときの送信先。 */
export interface QueueOrigin {
  rootPath: string;
  userId: string;
}

/** 同じ共有フォルダの表記ゆれ(末尾区切り文字・Windows の大文字小文字)を吸収する。 */
export function queueOrigin(rootPath: string, userId: string): QueueOrigin {
  const resolved = path.resolve(rootPath);
  return { rootPath: process.platform === "win32" ? resolved.toLowerCase() : resolved, userId };
}

function isQueueOrigin(value: unknown): value is QueueOrigin {
  return typeof value === "object" && value !== null &&
    "rootPath" in value && typeof value.rootPath === "string" &&
    "userId" in value && typeof value.userId === "string";
}

/** 旧形式や別の共有フォルダのイベントを誤送信しない。 */
export function matchesQueueOrigin(value: unknown, expected: QueueOrigin): boolean {
  if (!isQueueOrigin(value)) return false;
  const normalized = queueOrigin(value.rootPath, value.userId);
  return normalized.rootPath === expected.rootPath && normalized.userId === expected.userId;
}

/** オフライン時にローカルへ積む未送信イベント。ULID は enqueue 時に確定させる。 */
export interface QueuedMessage {
  requestId: string;
  channelId: Ulid;
  event: ChatEvent;
  /** 旧形式のキャッシュには存在しないため、再送前に明示的な紐付けが必要。 */
  origin?: QueueOrigin;
}

interface LocalCacheData {
  schemaVersion: number;
  readMarkers: Record<Ulid, Ulid>; // channelId → 最終読了 ULID
  sendQueue: QueuedMessage[];
}

function emptyData(): LocalCacheData {
  return { schemaVersion: LOCAL_CACHE_SCHEMA, readMarkers: {}, sendQueue: [] };
}

/**
 * ローカルキャッシュ。load() 後にメモリ上で操作し、変更ごとに永続化する。
 * スキーマ不整合や破損時は空データで初期化する(破棄=安全な復旧)。
 */
export class LocalCache {
  private data: LocalCacheData = emptyData();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const text = await fsp.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as Partial<LocalCacheData>;
      if (parsed && parsed.schemaVersion === LOCAL_CACHE_SCHEMA) {
        this.data = {
          schemaVersion: LOCAL_CACHE_SCHEMA,
          readMarkers: parsed.readMarkers ?? {},
          sendQueue: Array.isArray(parsed.sendQueue) ? parsed.sendQueue : [],
        };
      } else {
        this.data = emptyData(); // 未知スキーマは破棄。
      }
    } catch {
      this.data = emptyData(); // 未存在/破損は空で開始。
    }
  }

  private async persist(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await fsp.writeFile(tmp, JSON.stringify(this.data));
    await fsp.rename(tmp, this.filePath);
  }

  // ---- 既読位置 ----
  getReadMarker(channelId: Ulid): Ulid | undefined {
    return this.data.readMarkers[channelId];
  }
  async setReadMarker(channelId: Ulid, lastReadUlid: Ulid): Promise<void> {
    if (this.data.readMarkers[channelId] === lastReadUlid) return;
    this.data.readMarkers[channelId] = lastReadUlid;
    await this.persist();
  }

  // ---- 送信キュー ----
  getQueue(): readonly QueuedMessage[] {
    return this.data.sendQueue;
  }
  getLegacyQueue(): readonly QueuedMessage[] {
    return this.data.sendQueue.filter((item) => !isQueueOrigin(item.origin));
  }
  getLegacyQueueCount(): number {
    return this.getLegacyQueue().length;
  }
  /** 利用者が送信先を確認した旧形式のイベントだけを紐付ける。 */
  async claimLegacyQueue(origin: QueueOrigin, requestIds: readonly string[]): Promise<void> {
    const selected = new Set(requestIds);
    if (selected.size === 0) return;
    let changed = false;
    for (const item of this.data.sendQueue) {
      if (!isQueueOrigin(item.origin) && selected.has(item.requestId)) {
        item.origin = origin;
        changed = true;
      }
    }
    if (changed) await this.persist();
  }
  async enqueue(msg: QueuedMessage & { origin: QueueOrigin }): Promise<void> {
    this.data.sendQueue.push(msg);
    await this.persist();
  }
  async removeFromQueue(requestId: string): Promise<void> {
    const before = this.data.sendQueue.length;
    this.data.sendQueue = this.data.sendQueue.filter((m) => m.requestId !== requestId);
    if (this.data.sendQueue.length !== before) await this.persist();
  }
}
