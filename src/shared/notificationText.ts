// 非モーダル通知(showInformationMessage 等)に他者由来の文字列を埋め込むための無害化。
//
// VS Code の非モーダル通知は本文中の `[label](https://…)` / `[label](command:…)` / `[label](file:…)` を
// リンクとして描画し、クリックで URL を開いたりコマンドを実行したりする。本文・表示名・チャンネル名は
// 他ユーザーが自由に書けるため、そのまま埋め込むと任意コマンド実行やブラウザ起動(外部接続)の
// 誘導に使える。リンク構文の `](` を分断して、リンクとして解釈されないようにする。

const ZERO_WIDTH_SPACE = "\u200B";

/** 通知メッセージ内でリンク構文として解釈されないよう `](` を分断する。 */
export function neutralizeNotificationLinks(text: string): string {
  return text.replace(/\]\(/g, `]${ZERO_WIDTH_SPACE}(`);
}
