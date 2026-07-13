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
  "thread": "Thread",
  "lastReply": "Last reply {0}",
  "replyInThread": "Reply in thread",
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
  "verifyConnectionButton": "Verify connection",
  "uncNotAllowed": "The shared folder host \"{0}\" is not in VS Code's allowed UNC hosts (security.allowedUNCHosts). Add it and reload the window?",
  "uncAddAndReload": "Add and reload",
  "uncDeclined": "The UNC host was not added, so the shared folder will not be accessible. You can add it later, or run \"SF Board: Verify Shared Folder Connection\".",
  "uncUpdateFailed": "Failed to update security.allowedUNCHosts automatically: {0}. Please add the host manually in Settings.",
  "verifyOk": "Shared folder connection: OK",
  "verifyNg": "Shared folder connection: a problem was detected. See details.",
  // Host 側(本文パスのオープン、§10)
  "pathOpenFolder": "Open folder",
  "pathRevealFile": "Reveal in file manager",
  "pathCopy": "Copy path",
  "pathConfirmOpenFolder": "Open this folder in the file manager?\n{0}",
  "pathConfirmRevealFile": "Show this file in the file manager?\n{0}",
  "pathConfirmOpen": "Open this path?\n{0}",
  "pathNotFound": "Path not found: {0}",
  "pathOpenFailed": "Could not open the path: {0}",
  "pathCopied": "Path copied to the clipboard.",
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
  "thread": "スレッド",
  "lastReply": "最終返信 {0}",
  "replyInThread": "スレッドで返信",
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
  "verifyConnectionButton": "接続確認",
  "uncNotAllowed": "共有フォルダのホスト「{0}」が VS Code の許可リスト(security.allowedUNCHosts)に登録されていません。追加してウィンドウを再読み込みしますか?",
  "uncAddAndReload": "追加して再読み込み",
  "uncDeclined": "UNC ホストを追加しなかったため、共有フォルダにアクセスできません。後から追加するか、「SF Board: 共有フォルダの接続確認」で状態を確認できます。",
  "uncUpdateFailed": "security.allowedUNCHosts の自動更新に失敗しました: {0}。設定で手動追加してください。",
  "verifyOk": "共有フォルダ接続: 正常",
  "verifyNg": "共有フォルダ接続: 問題を検出しました。詳細を確認してください。",
  "pathOpenFolder": "フォルダを開く",
  "pathRevealFile": "ファイルマネージャで表示",
  "pathCopy": "パスをコピー",
  "pathConfirmOpenFolder": "このフォルダをファイルマネージャで開きますか?\n{0}",
  "pathConfirmRevealFile": "このファイルをファイルマネージャで表示しますか?\n{0}",
  "pathConfirmOpen": "このパスを開きますか?\n{0}",
  "pathNotFound": "パスが見つかりません: {0}",
  "pathOpenFailed": "パスを開けませんでした: {0}",
  "pathCopied": "パスをクリップボードにコピーしました。",
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
