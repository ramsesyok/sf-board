// 更新検知の照合層(reconcile polling)。DESIGN.md §5.1「照合層」/ §5.2。
//
// Phase 2 では照合ポーリングのみを実装する(fs.watch 監視層・適応フォールバックは Phase 4)。
// - 監視対象は cursors/ ディレクトリ 1 つだけ(§5 冒頭)。
// - readdir + 各カーソルの mtime/size 比較で変化を検出する。通知内容は状態管理に使わない。
// - 変化を検出したら onChange を呼ぶ(呼び出し側が実ファイルを読み直す)。
// - core 層は vscode に依存しない(Node の fs のみ)。

import * as fsp from "fs/promises";
import * as path from "path";

export interface CursorStat {
  mtimeMs: number;
  size: number;
}
export type CursorSnapshot = Record<string, CursorStat>;

/** cursors/ 配下の各ファイルの mtime/size を取得する。 */
export async function snapshotCursors(rootPath: string): Promise<CursorSnapshot> {
  const dir = path.join(rootPath, "cursors");
  const snapshot: CursorSnapshot = {};
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return snapshot;
    throw err;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      snapshot[name] = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      // stat 失敗(削除レース等)は無視。
    }
  }
  return snapshot;
}

/** 2 つのスナップショット差分から、追加・変化したカーソルファイル名を返す。 */
export function diffCursors(prev: CursorSnapshot, next: CursorSnapshot): string[] {
  const changed: string[] = [];
  for (const [name, stat] of Object.entries(next)) {
    const before = prev[name];
    if (!before || before.mtimeMs !== stat.mtimeMs || before.size !== stat.size) {
      changed.push(name);
    }
  }
  return changed;
}

export interface ReconcilePollerOptions {
  /** 基本周期(ミリ秒)。DESIGN.md §5.1 では 60〜120 秒。 */
  intervalMs: number;
  /** ±ジッタ比率(0〜1)。機械的周期性を崩す。既定 0.2。 */
  jitterRatio?: number;
  /** 変化検出時のコールバック。変化したカーソルファイル名の配列を渡す。 */
  onChange: (changedCursors: string[]) => void | Promise<void>;
  /** エラー時のコールバック(任意)。 */
  onError?: (err: unknown) => void;
}

/**
 * 照合ポーリング本体。start() で周期実行を開始し、checkNow() で即時照合する
 * (手動リフレッシュ用)。fs.watch は使わない(Phase 4)。
 */
export class ReconcilePoller {
  private prev: CursorSnapshot = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private checking = false;

  constructor(
    private readonly rootPath: string,
    private readonly options: ReconcilePollerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** 即時に 1 回照合する(前回スナップショットと比較)。手動リフレッシュから呼ぶ。 */
  async checkNow(): Promise<void> {
    if (this.checking) return; // 多重実行防止。
    this.checking = true;
    try {
      const next = await snapshotCursors(this.rootPath);
      const changed = diffCursors(this.prev, next);
      this.prev = next;
      if (changed.length > 0) {
        await this.options.onChange(changed);
      }
    } catch (err) {
      this.options.onError?.(err);
    } finally {
      this.checking = false;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const { intervalMs, jitterRatio = 0.2 } = this.options;
    const jitter = intervalMs * jitterRatio * (Math.random() * 2 - 1);
    const delay = Math.max(1000, intervalMs + jitter);
    this.timer = setTimeout(() => {
      void this.checkNow().finally(() => this.scheduleNext());
    }, delay);
  }
}
