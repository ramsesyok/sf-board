// Host ⇔ Webview メッセージプロトコル。DESIGN_EXTENSION.md §5。
// Node/DOM 双方から参照するため純粋な型定義のみ。

import type { RenderedThread } from "../core/reducer";
import type { UserProfile } from "./types";

export type ThreadDisplay = "inline" | "thread";

export interface WebviewConfig {
  attachmentMaxBytes: number;
  /** 返信の表示方式: "inline"(タイムライン内)/ "thread"(右側スレッドペイン)。 */
  threadDisplay: ThreadDisplay;
}

// 既存メッセージの添付を描画するための情報(§5 Phase 3 追補)。
export interface AttachmentInfo {
  ulid: string;
  name: string;
  mime: string;
  size: number;
  uri: string; // Host が asWebviewUri で解決した Webview URI
  isImage: boolean; // 画像 MIME かつ非SVG かつ imageInlinePreview 有効
}

// Host → Webview
export type HostMessage =
  | {
      kind: "init";
      channelId: string;
      channelName: string;
      messages: RenderedThread[]; // リデュース済み全履歴(スレッド構造化済み)
      users: Record<string, UserProfile>;
      attachments: Record<string, AttachmentInfo>; // ulid → 添付情報
      selfUserId: string;
      l10n: Record<string, string>; // Webview 用文言辞書(§9)
      config: WebviewConfig;
    }
  | {
      // 差分ではなくリデュース済み最新状態を全量再送(冪等・単純)。描画のみ差分更新。
      kind: "channelUpdated";
      messages: RenderedThread[];
      channelName: string;
      users: Record<string, UserProfile>;
      attachments: Record<string, AttachmentInfo>;
    }
  | { kind: "sendResult"; requestId: string; ok: boolean; error?: string }
  | {
      kind: "attachmentPicked";
      requestId: string;
      files: { ulid: string; name: string; size: number }[];
    };

// Webview → Host
export type WebviewMessage =
  | { kind: "ready" } // 初期化要求
  | {
      kind: "sendMessage";
      requestId: string;
      body: string;
      threadId?: string;
      attachments?: string[];
    }
  | { kind: "toggleReaction"; targetId: string; emoji: string }
  | { kind: "pickAttachment"; requestId: string }
  | { kind: "openAttachment"; ulid: string }
  | { kind: "openLink"; href: string } // §10 リンク委譲
  | { kind: "renameChannel"; name: string };
