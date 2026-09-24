// Notifier: 新着通知(アクティビティバーのバッジ・ステータスバー・ポップアップ)。DESIGN_EXTENSION.md §7.1。
//
// - すべて VS Code 内の表示。OS トースト通知は行わない(§1)。
// - 判定ロジック(基準 ULID・クールダウン・抜粋)は model/newMessageTracker.ts。
// - 未読数は ChatModel の未読判定(§7)をそのまま使う。

import * as vscode from "vscode";
import type { ChatModel } from "../model/chatModel";
import type { MessageState } from "../core/reducer";
import { NewMessageTracker, summarizeBody } from "../model/newMessageTracker";
import type { PanelManager } from "./panelManager";
import type { ChannelItem } from "./channelTree";
import { OPEN_UNREAD_COMMAND } from "./commandIds";
import { hl, hlSafe } from "../host/hostL10n";

export interface NotifyConfig {
  statusBar: boolean;
  popup: "off" | "all";
}

export class Notifier implements vscode.Disposable {
  private readonly tracker = new NewMessageTracker();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    private readonly model: ChatModel,
    private readonly panels: PanelManager,
    private readonly treeView: vscode.TreeView<ChannelItem>,
    private readonly getConfig: () => NotifyConfig,
  ) {
    this.statusBar = vscode.window.createStatusBarItem("sfBoard.unread", vscode.StatusBarAlignment.Left);
    this.statusBar.name = hl("unreadStatusBarName");
    this.statusBar.command = OPEN_UNREAD_COMMAND;
    this.disposables.push(
      this.statusBar,
      this.model.onChannelUpdated((channelId) => this.handleChannelUpdated(channelId)),
      this.model.onChannelsChanged(() => void this.handleChannelsChanged()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("sfBoard.notify")) this.updateCounts();
      }),
    );
  }

  /** ロード済みの全チャンネルの基準を記録し(通知はしない)、未読数を表示する。 */
  prime(): void {
    for (const s of this.model.getLoadedSummaries()) {
      this.tracker.prime(s.id, this.model.getLatestEventId(s.id) ?? "");
    }
    this.updateCounts();
  }

  private handleChannelUpdated(channelId: string): void {
    const latest = this.model.getLatestEventId(channelId);
    if (latest !== undefined) {
      const from = this.tracker.advance(channelId, latest);
      if (from !== undefined) this.maybePopup(channelId, this.model.getIncomingMessagesAfter(channelId, from));
    }
    this.updateCounts();
  }

  /** 新チャンネルの取り込み(listChannels)と基準の記録。既読化・リネームでも呼ばれる。 */
  private async handleChannelsChanged(): Promise<void> {
    try {
      await this.model.listChannels();
    } catch {
      // 到達不能時は既存のロード済み分だけで表示する。
    }
    // 待機中に再初期化で破棄されていたら、新しい Notifier のバッジを上書きしない。
    if (!this.disposed) this.prime();
  }

  private maybePopup(channelId: string, messages: MessageState[]): void {
    const latest = messages[messages.length - 1];
    if (!latest) return;
    if (this.getConfig().popup !== "all") return;
    // 見ている最中のチャンネルは通知しない(ウィンドウ非フォーカス時は通知する)。
    if (this.panels.isActive(channelId) && vscode.window.state.focused) return;
    if (!this.tracker.tryAcquirePopup(channelId)) return;

    // 本文・表示名・チャンネル名は他ユーザー由来。hlSafe で通知内のリンク(command: 等)として解釈させない。
    const channelName = this.model.getChannelView(channelId)?.channelName ?? channelId;
    const author = this.model.getUsers()[latest.author]?.displayName || latest.author;
    const snippet = summarizeBody(latest.body) ?? hl("notifyAttachmentOnly");
    const text =
      messages.length === 1
        ? hlSafe("notifyNewMessage", channelName, author, snippet)
        : hlSafe("notifyNewMessages", String(messages.length), channelName, author, snippet);
    const openLabel = hl("notifyOpen");
    void vscode.window.showInformationMessage(text, openLabel).then((choice) => {
      if (choice === openLabel) void this.panels.open(channelId);
    });
  }

  private updateCounts(): void {
    if (this.disposed) return;
    const unreadChannels = this.model.getLoadedSummaries().filter((s) => s.unread > 0);
    const total = unreadChannels.reduce((sum, s) => sum + s.unread, 0);
    const summary = hl("unreadTotal", String(total));

    this.treeView.badge = total > 0 ? { value: total, tooltip: summary } : undefined;

    if (total > 0 && this.getConfig().statusBar) {
      this.statusBar.text = `$(comment-unread) ${total}`;
      this.statusBar.tooltip = [summary, ...unreadChannels.map((s) => `#${s.name}: ${s.unread}`)].join("\n");
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.treeView.badge = undefined; // TreeView は再初期化をまたいで残るため消しておく。
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
