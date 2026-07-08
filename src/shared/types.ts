// 共有フォルダ上のファイルスキーマ型。DESIGN.md §2。
// core(Node)・Webview(DOM)双方から参照するため、vscode/node に依存しない純粋な型定義に保つ。

import type { Ulid } from "../core/ulid";

export interface WorkspaceMeta {
  schemaVersion: number;
  name: string;
}

export interface ChannelMeta {
  id: Ulid; // channelId
  name: string; // 作成時の初期名(不変。現在名はイベントから導出)
  createdBy: string; // userId
  createdAt: string; // ISO 8601
}

export interface UserProfile {
  userId: string;
  displayName: string;
}

export interface Cursor {
  lastEventId: Ulid;
  lastChannelId: Ulid;
  updatedAt: string; // ISO 8601
}
