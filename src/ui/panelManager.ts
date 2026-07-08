// PanelManager: チャンネルごとの ChatPanel を管理する。DESIGN_EXTENSION.md §4。
// - 1 チャンネル = 最大 1 パネル。既存があれば reveal する。

import * as vscode from "vscode";
import type { ChatModel } from "../model/chatModel";
import { ChatPanel, CHANNEL_VIEW_TYPE, type ChatPanelDeps } from "./chatPanel";

export class PanelManager {
  private readonly panels = new Map<string, ChatPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly model: ChatModel,
    private readonly rootPath: string,
    private readonly getDeps: () => ChatPanelDeps,
  ) {}

  /** チャンネルをタブで開く。既存パネルがあれば reveal する。 */
  async open(channelId: string): Promise<void> {
    const existing = this.panels.get(channelId);
    if (existing) {
      existing.reveal();
      return;
    }
    const loaded = await this.model.loadChannel(channelId);
    if (!loaded) {
      void vscode.window.showErrorMessage(`Channel not found: ${channelId}`);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      CHANNEL_VIEW_TYPE,
      loaded.view.channelName,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const chatPanel = new ChatPanel(
      panel,
      this.extensionUri,
      this.model,
      channelId,
      this.rootPath,
      this.getDeps(),
    );
    this.panels.set(channelId, chatPanel);
    chatPanel.onDidDispose(() => this.panels.delete(channelId));
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
