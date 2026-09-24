// Host 側 i18n。DESIGN_EXTENSION.md §9(Host は vscode.l10n.t() を使う)。
//
// 文言キーの単一定義は shared/strings.ts に置き、その英語値を vscode.l10n.t の
// メッセージ(=辞書キー)として渡す。日本語訳は l10n/bundle.l10n.ja.json が持つ
// (言語が ja のとき vscode.l10n が自動で差し替える。無ければ英語のまま=安全側)。

import * as vscode from "vscode";
import { getStrings } from "../shared/strings";
import { neutralizeNotificationLinks } from "../shared/notificationText";

const EN = getStrings("en");

/** Host 用文言取得。key は strings.ts のキー。{0},{1}… は args で置換。 */
export function hl(key: string, ...args: string[]): string {
  const message = EN[key] ?? key;
  return vscode.l10n.t(message, ...args);
}

/**
 * 差し込み値を無害化してから文言を組み立てる(show*Message に動的な値を入れるときは必ずこれを使う)。
 * 非モーダル通知は `[x](command:…)` 等をクリック可能なリンクとして描画するため、他ユーザー由来の
 * 本文・パス・添付名などをそのまま入れると任意コマンド実行や外部接続の誘導に使える(§10)。
 */
export function hlSafe(key: string, ...args: string[]): string {
  return hl(key, ...args.map(neutralizeNotificationLinks));
}
