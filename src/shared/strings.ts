// UI 文言(日本語+英語)。DESIGN_EXTENSION.md §9。
// - 文言キーは Host / Webview 単一定義。Host は getStrings() を使い、
//   Webview へは init メッセージで辞書(Record<string,string>)を渡す。
// - Node/DOM 双方から参照するため純粋な定義に保つ。
// - 将来 Phase 4 で Host 側を vscode.l10n.t() へ移行する余地を残す(キーは共通)。

export type Lang = "ja" | "en";

const en = {
  "send": "Send",
  "messagePlaceholder": "Message… (Ctrl+Enter to send)",
  "emptyChannel": "No messages yet",
  "deletedMessage": "This message was deleted",
  "edited": "edited",
  "reply": "Reply",
  "replies": "replies",
  "hideReplies": "Hide replies",
  "replyPlaceholder": "Reply… (Ctrl+Enter to send)",
  "addReaction": "Add reaction",
  "attach": "Attach file",
  "sendFailed": "Failed to send",
  "sendQueued": "Offline: the message was queued and will be sent when the shared folder is reachable.",
  "resend": "Resend",
  "pending": "Sending…",
  "searchPlaceholder": "Search in channel",
  "searchNoHits": "No results",
  "searchCount": "{0}/{1}",
  "download": "Download",
  "close": "Close",
  // Host 側(添付・リンク)ダイアログ
  "attachTooLarge": "\"{0}\" exceeds the size limit ({1} bytes) and was skipped.",
  "attachSaveTitle": "Save attachment",
  "attachVerifyFailed": "Integrity check (SHA-256) failed for \"{0}\". The file may be corrupted.",
  "attachSaved": "Saved: {0}",
  "attachNotFound": "Attachment not found.",
  "linkConfirm": "Copy this link to the clipboard? (For security, links are not opened in a browser.)\n{0}",
  "linkCopy": "Copy link",
  "linkCopied": "Link copied to the clipboard.",
  "cancel": "Cancel",
  // Host 側(コマンド・ダイアログ)
  "createChannelPrompt": "Enter a channel name",
  "createChannelPlaceholder": "e.g. general",
  "renameChannelPrompt": "Enter a new channel name",
  "channelNameEmpty": "Channel name must not be empty",
  "setupRootPrompt": "Path to the shared folder (chat-root)",
  "setupUserIdPrompt": "Your user ID (leave empty to use the OS user name)",
  "setupDisplayNamePrompt": "Your display name",
  "rootPathNotConfigured": "The shared folder path (sfBoard.rootPath) is not configured. Run \"SF Board: Setup\".",
  "rootPathUnreachable": "Cannot reach the shared folder: {0}",
} as const;

type StringKey = keyof typeof en;

const ja: Record<StringKey, string> = {
  "send": "送信",
  "messagePlaceholder": "メッセージ…(Ctrl+Enter で送信)",
  "emptyChannel": "まだメッセージがありません",
  "deletedMessage": "このメッセージは削除されました",
  "edited": "編集済み",
  "reply": "返信",
  "replies": "件の返信",
  "hideReplies": "返信を隠す",
  "replyPlaceholder": "返信…(Ctrl+Enter で送信)",
  "addReaction": "リアクションを追加",
  "attach": "ファイルを添付",
  "sendFailed": "送信に失敗しました",
  "sendQueued": "オフラインのため送信キューに追加しました。共有フォルダに到達できるようになったら送信されます。",
  "resend": "再送",
  "pending": "送信中…",
  "searchPlaceholder": "チャンネル内を検索",
  "searchNoHits": "該当なし",
  "searchCount": "{0}/{1}",
  "download": "ダウンロード",
  "close": "閉じる",
  "attachTooLarge": "「{0}」はサイズ上限({1} バイト)を超えたためスキップしました。",
  "attachSaveTitle": "添付を保存",
  "attachVerifyFailed": "「{0}」の完全性チェック(SHA-256)に失敗しました。ファイルが破損している可能性があります。",
  "attachSaved": "保存しました: {0}",
  "attachNotFound": "添付が見つかりません。",
  "linkConfirm": "このリンクをクリップボードにコピーしますか?(セキュリティのため、リンクはブラウザで開きません)\n{0}",
  "linkCopy": "リンクのコピー",
  "linkCopied": "リンクをクリップボードにコピーしました。",
  "cancel": "キャンセル",
  "createChannelPrompt": "チャンネル名を入力",
  "createChannelPlaceholder": "例: general",
  "renameChannelPrompt": "新しいチャンネル名を入力",
  "channelNameEmpty": "チャンネル名を空にはできません",
  "setupRootPrompt": "共有フォルダ(chat-root)のパス",
  "setupUserIdPrompt": "ユーザーID(空欄なら OS ユーザー名を使用)",
  "setupDisplayNamePrompt": "表示名",
  "rootPathNotConfigured": "共有フォルダのパス(sfBoard.rootPath)が未設定です。「SF Board: 初期設定」を実行してください。",
  "rootPathUnreachable": "共有フォルダに到達できません: {0}",
};

const bundles: Record<Lang, Record<StringKey, string>> = { en, ja };

/** vscode.env.language(例 "ja", "en-US")から言語を決定する。ja* なら日本語。 */
export function pickLang(vscodeLanguage: string | undefined): Lang {
  return vscodeLanguage && vscodeLanguage.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/** 指定言語の文言辞書を返す(Webview へ渡す用)。 */
export function getStrings(lang: Lang): Record<string, string> {
  return { ...bundles[lang] };
}

/** 文言を取得し、{0},{1},… を args で置換する。 */
export function t(lang: Lang, key: StringKey, ...args: string[]): string {
  const template = bundles[lang][key] ?? key;
  return template.replace(/\{(\d+)\}/g, (_m, i) => args[Number(i)] ?? "");
}
