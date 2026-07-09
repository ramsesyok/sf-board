// 更新検知の三層構成。DESIGN.md §5(監視+照合ポーリングのハイブリッド)。
//
// - 監視層: fs.watch("chat-root/cursors", { recursive:false })。300ms デバウンス。
//   通知内容は無視し、必ず cursors を読み直す(§5.2)。素の fs.watch を使う(§5 補足)。
// - 照合層: readdir + mtime/size 比較の定期ポーリング(§5.1)。監視取りこぼしの安全網。
// - フォールバック層: 適応ポーリング(2〜5秒 + ±30% ジッタ)。監視が信頼できない環境用(§5.5)。
// - ヘルスチェック(§5.4): 照合が変化を発見したのに直近に監視通知が無かった回数を数え、
//   閾値超過で監視を諦めフォールバックへ切替。fs.watch error / 復帰時はハンドルを張り直す。
// - core 層は vscode に依存しない(Node の fs のみ)。

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { noopDiagnosticsLogger, type DiagnosticsLogger } from "./diagnostics";

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

/**
 * ヘルスチェック判定(純粋関数・テスト可能)。DESIGN.md §5.4。
 * 照合周期ごとに呼ぶ。照合が変化を発見(reconcileFoundChange)したのに、
 * その周期内に監視通知が無かった(!watchNotifiedThisCycle)場合を「取りこぼし」として数える。
 * 連続 threshold 回で監視を諦める(shouldFallback=true)。監視が機能した周期でリセット。
 */
export function updateHealth(
  consecutiveMissed: number,
  reconcileFoundChange: boolean,
  watchNotifiedThisCycle: boolean,
  threshold = 3,
): { consecutiveMissed: number; shouldFallback: boolean } {
  let missed = consecutiveMissed;
  if (watchNotifiedThisCycle) {
    missed = 0; // 監視は機能している。
  } else if (reconcileFoundChange) {
    missed += 1; // 変化はあったが監視通知が来なかった=取りこぼし。
  }
  return { consecutiveMissed: missed, shouldFallback: missed >= threshold };
}

export type SyncMode = "watch" | "fallback";

export interface SyncEngineOptions {
  rootPath: string;
  /** 照合層の周期(ミリ秒)。DESIGN.md §5.1 では 60〜120 秒。 */
  reconcileMs: number;
  /** フォールバック層の基本周期(ミリ秒)。§5.1 では 2〜5 秒。 */
  fallbackMs: number;
  /** 監視層を有効にするか(設定 sfBoard.watch.enabled)。false なら最初からフォールバック。 */
  watchEnabled: boolean;
  /** 変化検出時のコールバック(変化したカーソルファイル名の配列)。 */
  onChange: (changedCursors: string[]) => void | Promise<void>;
  /** ウィンドウがアクティブか(§5.5: 非アクティブ時はフォールバック周期を延伸)。 */
  isActive?: () => boolean;
  onError?: (err: unknown) => void;
  /** モード切替の通知(ログ/デバッグ用・任意)。 */
  onModeChange?: (mode: SyncMode) => void;
  /** 同期診断ロガー(任意。無効時は noop)。 */
  logger?: DiagnosticsLogger;
}

/**
 * 三層同期エンジン。start() で監視+照合を開始し、checkNow() で即時照合する(手動更新)。
 */
export class SyncEngine {
  private prev: CursorSnapshot = {};
  private mode: SyncMode = "watch";
  private watcher: fs.FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  private watchRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private checking = false;
  private rerunRequested = false;

  // ヘルスチェック用の周期内フラグ/カウンタ。
  private watchNotifiedThisCycle = false;
  private consecutiveMissed = 0;

  private readonly logger: DiagnosticsLogger;

  constructor(private readonly options: SyncEngineOptions) {
    this.logger = options.logger ?? noopDiagnosticsLogger;
  }

  getMode(): SyncMode {
    return this.mode;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.prev = await snapshotCursors(this.options.rootPath);
    this.logger.log("info", "sync.start", {
      watchEnabled: this.options.watchEnabled,
      reconcileMs: this.options.reconcileMs,
      fallbackMs: this.options.fallbackMs,
      cursors: Object.keys(this.prev).length,
    });
    if (this.options.watchEnabled) {
      this.mode = "watch";
      this.startWatch();
    } else {
      this.mode = "fallback";
      this.logger.log("info", "sync.mode", { mode: "fallback", reason: "watchDisabled" });
      this.startFallback();
    }
    this.scheduleReconcile();
  }

  stop(): void {
    this.running = false;
    this.closeWatch();
    for (const timerRef of [this.debounceTimer, this.reconcileTimer, this.fallbackTimer, this.watchRetryTimer]) {
      if (timerRef) clearTimeout(timerRef);
    }
    this.debounceTimer = this.reconcileTimer = this.fallbackTimer = this.watchRetryTimer = undefined;
  }

  /** 即時に 1 回照合する(手動リフレッシュ)。 */
  async checkNow(): Promise<boolean> {
    return this.doCheck("manual");
  }

  // ---- 監視層(§5.1・§5.2) ----
  private startWatch(): void {
    try {
      const dir = path.join(this.options.rootPath, "cursors");
      this.watcher = fs.watch(dir, { recursive: false }, () => this.onWatchEvent());
      this.watcher.on("error", (err) => this.handleWatchError(err));
      this.options.onModeChange?.("watch");
      this.logger.log("info", "watch.start", { dir });
    } catch (err) {
      this.handleWatchError(err);
    }
  }

  private closeWatch(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = undefined;
    }
  }

  private onWatchEvent(): void {
    this.watchNotifiedThisCycle = true;
    this.logger.log("debug", "watch.notify");
    // 300ms デバウンス(§5.2)。通知内容は使わず、後で cursors を読み直す。
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.doCheck("watch");
    }, 300);
  }

  private handleWatchError(err: unknown): void {
    this.options.onError?.(err);
    this.logger.log("warn", "watch.error", { error: errString(err) });
    this.closeWatch();
    if (!this.running || this.mode !== "watch") return;
    // ハンドルを張り直す(§5.4)。失敗が続けば照合層のヘルスチェックでフォールバックへ。
    if (this.watchRetryTimer) clearTimeout(this.watchRetryTimer);
    this.watchRetryTimer = setTimeout(() => {
      if (this.running && this.mode === "watch") {
        this.logger.log("info", "watch.retry");
        this.startWatch();
      }
    }, 5000);
  }

  // ---- 照合層(§5.1)+ ヘルスチェック(§5.4) ----
  private scheduleReconcile(): void {
    if (!this.running) return;
    const jitter = this.options.reconcileMs * 0.1 * (Math.random() * 2 - 1);
    const delay = Math.max(1000, this.options.reconcileMs + jitter);
    this.reconcileTimer = setTimeout(() => {
      void this.reconcileTick().finally(() => this.scheduleReconcile());
    }, delay);
  }

  private async reconcileTick(): Promise<void> {
    const notified = this.watchNotifiedThisCycle;
    const foundChange = await this.doCheck("reconcile");
    if (this.mode === "watch") {
      const health = updateHealth(this.consecutiveMissed, foundChange, notified);
      this.logger.log("debug", "reconcile.tick", {
        foundChange,
        watchNotified: notified,
        missed: health.consecutiveMissed,
      });
      this.consecutiveMissed = health.consecutiveMissed;
      if (health.shouldFallback) this.switchToFallback();
    } else {
      this.logger.log("debug", "reconcile.tick", { foundChange, mode: this.mode });
    }
    this.watchNotifiedThisCycle = false; // 周期リセット。
  }

  private switchToFallback(): void {
    if (this.mode === "fallback") return;
    this.mode = "fallback";
    this.closeWatch();
    if (this.watchRetryTimer) {
      clearTimeout(this.watchRetryTimer);
      this.watchRetryTimer = undefined;
    }
    this.options.onModeChange?.("fallback");
    this.logger.log("warn", "sync.fallback", {
      reason: "watchUnreliable",
      consecutiveMissed: this.consecutiveMissed,
    });
    this.startFallback();
  }

  // ---- フォールバック層(適応ポーリング §5.5) ----
  private startFallback(): void {
    this.scheduleFallback();
  }

  private scheduleFallback(): void {
    if (!this.running || this.mode !== "fallback") return;
    const active = this.options.isActive?.() ?? true;
    // 非アクティブ時は 30〜60 秒へ延伸(§5.5)。
    const base = active ? this.options.fallbackMs : Math.max(this.options.fallbackMs, 30000);
    const jitter = base * 0.3 * (Math.random() * 2 - 1); // ±30% ジッタ。
    const delay = Math.max(1000, base + jitter);
    this.fallbackTimer = setTimeout(() => {
      void this.doCheck("fallback").finally(() => this.scheduleFallback());
    }, delay);
  }

  // ---- 共通: 照合実行(直列化) ----
  private async doCheck(source: string): Promise<boolean> {
    if (this.checking) {
      this.rerunRequested = true;
      return false;
    }
    this.checking = true;
    let changedAny = false;
    try {
      const next = await snapshotCursors(this.options.rootPath);
      const changed = diffCursors(this.prev, next);
      this.prev = next;
      if (changed.length > 0) {
        changedAny = true;
        this.logger.log("info", "change.detected", {
          source,
          count: changed.length,
          cursors: changed.join(","),
        });
        await this.options.onChange(changed);
      }
    } catch (err) {
      this.options.onError?.(err);
      this.logger.log("error", "check.error", { source, error: errString(err) });
    } finally {
      this.checking = false;
    }
    if (this.rerunRequested) {
      this.rerunRequested = false;
      const again = await this.doCheck(source);
      changedAny = changedAny || again;
    }
    return changedAny;
  }
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
