// 同期診断ロガーの Host 実装。VSCode の LogOutputChannel へ出力する。
// - 出力先は「出力」パネルの Airgap Chat(LogOutputChannel は拡張のログディレクトリへ自動保存)。
// - 診断が無効(airgapChat.diagnostics.enabled=false)のときは何も書かない。
// - 記録するのはメタデータのみ(呼び出し側がメッセージ本文を渡さない前提)。

import * as vscode from "vscode";
import type { DiagLevel, DiagnosticsLogger } from "../core/diagnostics";

export class OutputChannelDiagnosticsLogger implements DiagnosticsLogger {
  constructor(
    private readonly channel: vscode.LogOutputChannel,
    private readonly isEnabled: () => boolean,
  ) {}

  log(level: DiagLevel, name: string, fields?: Record<string, unknown>): void {
    if (!this.isEnabled()) return;
    const msg = fields && Object.keys(fields).length > 0 ? `${name} ${formatFields(fields)}` : name;
    switch (level) {
      case "debug":
        this.channel.debug(msg);
        break;
      case "info":
        this.channel.info(msg);
        break;
      case "warn":
        this.channel.warn(msg);
        break;
      case "error":
        this.channel.error(msg);
        break;
    }
  }
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(" ");
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
