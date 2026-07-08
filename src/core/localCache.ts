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

/** オフライン時にローカルへ積む未送信イベント。ULID は enqueue 時に確定させる。 */
export interface QueuedMessage {
  requestId: string;
  channelId: Ulid;
  event: ChatEvent;
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
  async enqueue(msg: QueuedMessage): Promise<void> {
    this.data.sendQueue.push(msg);
    await this.persist();
  }
  async removeFromQueue(requestId: string): Promise<void> {
    const before = this.data.sendQueue.length;
    this.data.sendQueue = this.data.sendQueue.filter((m) => m.requestId !== requestId);
    if (this.data.sendQueue.length !== before) await this.persist();
  }
}
