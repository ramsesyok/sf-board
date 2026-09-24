// NewMessageTracker: 新着ポップアップ通知の判定ロジック。DESIGN_EXTENSION.md §7.1。
//
// - チャンネルごとに「通知済みの基準 ULID」をメモリで保持する(永続化しない・共有フォルダに書かない)。
// - 初めて観測したチャンネルは基準を記録するだけで通知しない(起動直後・新チャンネル発見時に
//   既存履歴をまとめて通知しないため)。
// - 同一チャンネルのポップアップはクールダウン期間内に 1 回まで。
// - vscode には依存しない(表示は ui/notifier.ts)。

import type { Ulid } from "../core/ulid";

/** 同一チャンネルでポップアップを出す最短間隔(§7.1)。 */
export const POPUP_COOLDOWN_MS = 30_000;

/** 抜粋の最大文字数(§7.1)。 */
export const SNIPPET_MAX_CHARS = 80;

export class NewMessageTracker {
  private readonly baselines = new Map<Ulid, Ulid>();
  private readonly lastPopupAt = new Map<Ulid, number>();

  constructor(
    private readonly cooldownMs: number = POPUP_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** 未観測のチャンネルなら基準を latestId に記録する(観測済みなら何もしない)。 */
  prime(channelId: Ulid, latestId: Ulid): void {
    if (!this.baselines.has(channelId)) this.baselines.set(channelId, latestId);
  }

  /**
   * 基準を latestId へ進め、進める前の基準を返す。
   * 初回観測、または基準から進んでいない場合は undefined(=通知対象なし)。
   */
  advance(channelId: Ulid, latestId: Ulid): Ulid | undefined {
    const prev = this.baselines.get(channelId);
    if (prev === undefined) {
      this.baselines.set(channelId, latestId);
      return undefined;
    }
    if (latestId <= prev) return undefined;
    this.baselines.set(channelId, latestId);
    return prev;
  }

  /** クールダウン外ならポップアップ時刻を記録して true を返す。 */
  tryAcquirePopup(channelId: Ulid): boolean {
    const t = this.now();
    const last = this.lastPopupAt.get(channelId);
    if (last !== undefined && t - last < this.cooldownMs) return false;
    this.lastPopupAt.set(channelId, t);
    return true;
  }
}

/** 本文の最初の空でない行を max 文字で切った抜粋。空なら undefined(添付のみ等)。 */
export function summarizeBody(body: string, max: number = SNIPPET_MAX_CHARS): string | undefined {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  const chars = Array.from(line); // サロゲートペアを分断しない。
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : line;
}
