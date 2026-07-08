// ChannelTreeProvider: サイドバーのチャンネル一覧。DESIGN_EXTENSION.md §7。
// Phase 2 は一覧表示のみ(未読バッジは Phase 4)。

import * as vscode from "vscode";
import type { ChatModel, ChannelSummary } from "../model/chatModel";
import { OPEN_CHANNEL_COMMAND } from "./commandIds";

export class ChannelItem extends vscode.TreeItem {
  constructor(public readonly channelId: string, name: string, unread: number) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.id = channelId;
    this.contextValue = "channel"; // コンテキストメニュー(リネーム)の絞り込み用。
    this.command = {
      command: OPEN_CHANNEL_COMMAND,
      title: "Open Channel",
      arguments: [channelId],
    };
    // 未読ありは件数バッジ + 強調アイコン(§7)。
    if (unread > 0) {
      this.description = String(unread);
      this.iconPath = new vscode.ThemeIcon("comment-unread", new vscode.ThemeColor("charts.blue"));
    } else {
      this.iconPath = new vscode.ThemeIcon("comment-discussion");
    }
  }
}

export class ChannelTreeProvider implements vscode.TreeDataProvider<ChannelItem> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  constructor(private readonly model: ChatModel) {}

  refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  getTreeItem(element: ChannelItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ChannelItem[]> {
    let channels: ChannelSummary[];
    try {
      channels = await this.model.listChannels();
    } catch {
      return [];
    }
    return channels.map((c) => new ChannelItem(c.id, c.name, c.unread));
  }
}
