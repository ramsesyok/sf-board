// 同期診断ログの抽象。DESIGN.md §5(更新検知)の挙動を観測するための任意ログ。
//
// - core 層は vscode に依存しないため、ログ出力先の実装は Host が注入する(このファイルは
//   インターフェースと no-op 実装のみ)。
// - 記録するのは同期のメタデータ(チャンネルID・ULID・件数・所要時間・モード等)のみ。
//   メッセージ本文などの機密情報は渡さない/記録しない方針とする。

export type DiagLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticsLogger {
  /**
   * 診断イベントを記録する。
   * @param level 重要度。debug は既定では出力パネルに表示されない(詳細ログ)。
   * @param name  イベント名(例 "watch.notify", "change.detected", "sync.fallback")。
   * @param fields メタデータ(本文などの機密情報は入れない)。
   */
  log(level: DiagLevel, name: string, fields?: Record<string, unknown>): void;
}

/** 何もしないロガー(診断無効時の既定)。 */
export const noopDiagnosticsLogger: DiagnosticsLogger = {
  log() {
    /* no-op */
  },
};
