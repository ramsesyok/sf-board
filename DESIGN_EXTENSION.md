# サーバレス・チャット VSCode拡張 詳細設計(拡張本体編)

本書は `DESIGN.md`(ファイルシステム・同期層設計)を補完する、VSCode拡張本体の詳細設計である。実装時は両文書を併読すること。両文書が矛盾する場合、ファイル形式・書き込みプロトコルは `DESIGN.md` を、UI・拡張実装は本書を正とする。

## 1. 確定済み要件

| 項目 | 決定内容 |
|---|---|
| UI形態 | エディタタブ内 Webview。複数チャンネルを同時に別タブで表示可能 |
| メッセージ検索 | 開いているチャンネル内のみ。メモリ上の簡易検索(インデックス構築なし) |
| 履歴読み込み | 起動時(パネル初期化時)に当該チャンネルの全履歴を読み込む。シンプル優先 |
| チャンネル管理 | 作成+リネーム(削除・アーカイブは対象外) |
| 送信キー | Ctrl+Enter で送信、Enter は改行 |
| 添付サイズ上限 | 既定 10MB(設定で変更可) |
| 表示言語 | 日本語+英語(i18n対応) |
| 追加機能の対象外 | メンション通知、DM、OSトースト通知(将来拡張として設計だけ壊さない) |
| 配布 | VSIX手動配布(エアギャップ環境でのオフラインインストール) |

## 2. DESIGN.md への追補: チャンネルリネームイベント

チャンネルリネームに対応するため、イベントスキーマに以下を追加する。`channel.json` は作成時の初期値として不変とし、現在のチャンネル名はイベントから導出する。

```typescript
| {
    id: Ulid;
    type: "channel_renamed";
    ts: string;
    author: string;
    targetId: Ulid;        // channelId
    name: string;          // 新チャンネル名
  }
```

- 書き込み先: 当該チャンネルの自分のイベントログ(`channels/{ch}/events/{YYYY-MM}/{me}.jsonl`)。
- 導出ルール: 同一 `targetId` への `channel_renamed` のうち **ULID 最大が勝ち**(LWW)。イベントが存在しない場合は `channel.json` の `name` を使用。
- 権限: 全ユーザーがリネーム可能(制限しない)。

## 3. 全体アーキテクチャ

```
┌─ Extension Host (Node.js) ─────────────────────────────┐
│  ChatModel(シングルトン)                                │
│   ├ store / sync / reducer / localCache (DESIGN.md §7) │
│   ├ チャンネル状態のオンメモリ保持(全チャンネル)          │
│   └ EventEmitter: onChannelUpdated(channelId)          │
│                                                        │
│  ChannelTreeProvider ── TreeView(サイドバー)            │
│  PanelManager ── ChatPanel × N(チャンネルごと)          │
└───────┬────────────────────────────────────────────────┘
        │ postMessage(§5 プロトコル)
┌───────┴────────────────────────────────────────────────┐
│  Webview(チャンネルごとに1つ)                           │
│   ├ 状態: メッセージ配列(リデュース済み)、検索状態        │
│   ├ レンダラ: markdown-it + DOMPurify、差分描画          │
│   └ 入力欄、リアクションUI、添付UI、検索バー              │
└────────────────────────────────────────────────────────┘
```

設計原則:

- **正となる状態は Extension Host 側の ChatModel に一元化**する。Webview はその投影(ビュー)であり、リデューサを Webview 側に持たない。
- Webview からの操作(送信・リアクション等)はすべて Host へ委譲し、Host が共有フォルダへ書き込む。書き込み成功後、通常の同期経路(自イベントの再読込)で Webview へ反映する(楽観的UI更新は §6.4 参照)。
- ファイルI/O・`fs.watch`・パス解決は Host 専任。Webview は Node API に触れない。

## 4. パネル管理(エディタタブ内 Webview)

- `vscode.window.createWebviewPanel(viewType: "sfBoard.channel", ...)` でチャンネルごとにパネルを作成。
- **1チャンネル=最大1パネル**。TreeView から同じチャンネルを開いた場合は既存パネルを `reveal()` する。PanelManager が `Map<channelId, ChatPanel>` を保持。
- `retainContextWhenHidden: true` とする。50人規模・テキスト中心なのでメモリより実装単純性を優先する。
- `WebviewPanelSerializer` を登録し、VSCode再起動後にタブが復元されたら `state.channelId` から再初期化する(Webview 側で `vscode.setState({channelId})` を保持)。
- パネルタイトルは現在のチャンネル名。`channel_renamed` 反映時にタイトルも更新する。
- Webview オプション: `enableScripts: true`、`localResourceRoots` に **拡張の media ディレクトリと `chat-root/attachments` の両方**を指定する(添付表示のため。`chat.rootPath` 変更時はパネル再作成が必要な点に注意)。
- CSP を必ず設定する: `default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-...';`。外部オリジンは一切許可しない。

## 5. Host ⇔ Webview メッセージプロトコル

```typescript
// 既存メッセージの添付を描画するための情報(Phase 3 追補)。
// uri は Host が asWebviewUri で解決した Webview 用 URI。
// isImage は §6.5 の判定(画像 MIME かつ非SVG かつ imageInlinePreview 有効)。
interface AttachmentInfo {
  ulid: string; name: string; mime: string; size: number; uri: string; isImage: boolean;
}

// Host → Webview
type HostMessage =
  | { kind: "init"; channelId: string; channelName: string;
      messages: RenderedThread[];        // リデュース済み全履歴(スレッド構造化済み)
      users: Record<string, UserProfile>;
      attachments: Record<string, AttachmentInfo>;  // ulid → 添付情報(Phase 3 追補)
      selfUserId: string;
      l10n: Record<string, string>;      // Webview用文言辞書(§9)
      config: { attachmentMaxBytes: number } }
  | { kind: "channelUpdated";            // 差分ではなく最新状態を再送(冪等・単純)
      messages: RenderedThread[]; channelName: string;
      users: Record<string, UserProfile>;
      attachments: Record<string, AttachmentInfo> }        // Phase 3 追補
  | { kind: "sendResult"; requestId: string; ok: boolean; error?: string }
  | { kind: "attachmentPicked"; requestId: string;
      files: { ulid: string; name: string; size: number }[] };

// Webview → Host
type WebviewMessage =
  | { kind: "ready" }                                        // 初期化要求
  | { kind: "sendMessage"; requestId: string; body: string;
      threadId?: string; attachments?: string[] }
  | { kind: "toggleReaction"; targetId: string; emoji: string }
  | { kind: "pickAttachment"; requestId: string }            // Host側でファイルダイアログ
  | { kind: "openAttachment"; ulid: string }                 // 既定アプリ/保存ダイアログ
  | { kind: "openLink"; href: string }                       // §10 リンク委譲(Phase 3 追補)
  | { kind: "renameChannel"; name: string };
```

- `channelUpdated` は差分イベントではなく**リデュース済み最新状態の全量**を送る。50人規模+全履歴読み込み方針なら十分軽く、Webview 側の状態管理バグを構造的に排除できる。描画のみ差分更新する(§6.3)。
- `RenderedThread` は「親メッセージ+返信配列+リアクション集計済み」のビュー用構造体。Markdown→HTML 変換は **Webview 側**で行う(Host は生テキストを渡す)。
- `attachments` は当該チャンネルのメッセージが参照する添付の描画情報。Host が `attachments/{ch}/{YYYY-MM}/{ulid}/meta.json` を読み、`blob` を `asWebviewUri` で解決して渡す(Phase 3 追補)。
- `openLink` は本文中リンクのクリックを Host へ委譲する。**リンクをクリックしてもブラウザは開かない**。Host は URL 全文をダイアログで提示し、「リンクのコピー」選択時のみ URL をクリップボードへコピーする(§10)。拡張自身は当該 URL へ通信しない(Phase 3 追補 / v0.0.3 で挙動変更)。

## 6. Webview UI 詳細

### 6.1 レイアウト

```
┌──────────────────────────────────────┐
│ [チャンネル名]              [🔍検索]  │  ← ヘッダ(リネームはタイトルクリックで)
├──────────────────────────────────────┤
│ メッセージリスト(時系列昇順・最下部が最新)│
│   ├ 通常メッセージ                     │
│   └ スレッド親 ▸ 返信n件(折りたたみ)    │
├──────────────────────────────────────┤
│ [📎] [テキストエリア(自動高さ)] [送信]  │  ← Ctrl+Enter送信 / Enter改行
└──────────────────────────────────────┘
```

- メッセージ要素: アバター(イニシャル自動生成)、表示名、時刻(ローカルTZ)、本文HTML、リアクションチップ列(クリックでトグル)、`+絵文字` ボタン、`返信` ボタン。
- 絵文字ピッカーは**定義済みセット(20個程度: 👍 ✅ 🙏 😄 🎉 👀 ❤️ 等)**のシンプルなポップオーバー。外部絵文字ライブラリは使わない。
- スレッド返信は親の直下にインライン展開(別カラムは作らない)。返信入力欄は展開時に親の下に表示。
- 新規メッセージ到着時、ユーザーが最下部にいる場合のみ自動スクロール。上方閲覧中はスクロール位置を保持し「新着 ↓」バッジを表示。

### 6.2 チャンネル内検索

- ヘッダの検索アイコンまたは `Ctrl+F`(Webview 内でキーを奪う)で検索バーを表示。
- **メモリ上の messages 配列に対する部分一致(大文字小文字無視)**。Markdown 記号を含む生テキスト(`body`)を対象とする。
- ヒット件数表示、`Enter`/`Shift+Enter` で次/前ヒットへジャンプ+ハイライト。`Esc` で解除。
- インデックスは持たない。全チャンネル横断検索は将来拡張とし、本リリースでは実装しない。

### 6.3 描画戦略

- 起動(パネル初期化)時に全履歴を一括受領し、一括レンダリングする。
- `channelUpdated` 受領時は、メッセージ ULID をキーに DOM を突き合わせ、**追加・変更(編集/リアクション差分)のあった要素のみ再描画**する(全再構築しない)。
- 目安として 5,000 メッセージ超で初期描画が重くなった場合に仮想スクロール導入を検討する、と TODO コメントを残す(本リリースでは実装しない)。

### 6.4 送信フロー(楽観的UI)

1. Webview: 送信内容を `pending` 状態(半透明)で即時リストに追加し、`sendMessage` を Host へ送る。
2. Host: DESIGN.md §4 のプロトコルで書き込み → `sendResult(ok)` を返す。
3. Webview: 次の `channelUpdated` で正規メッセージが届いたら pending 表示を除去(ULID一致で突合)。失敗時は pending をエラー表示に変え、再送ボタンを出す。オフライン時は Host の送信キュー(DESIGN.md §8)に積まれる旨を表示する。

### 6.5 添付ファイル

- `📎` ボタン → Host が `vscode.window.showOpenDialog` を表示(Webview からの `<input type=file>` は使わない。実パスが取れず共有フォルダへのコピーができないため)。
- Host 側でサイズ検証(`chat.attachmentMaxBytes`、既定 10MB)。超過時はエラー文言を返す。
- 画像(png/jpg/gif/webp/svg※svgはサニタイズ困難のためサムネイル化せずファイル扱い)はメッセージ内にインラインサムネイル表示(`attachment://` → `asWebviewUri` 解決)。**サムネイルのクリックでライトボックス(全画面オーバーレイの拡大表示)を開き**、そこから「ダウンロード」で `openAttachment` を実行する(背景クリック / Esc / 「閉じる」で閉じる)。画像以外はファイル名+サイズのカードで表示し、クリックで直接 `openAttachment` → Host が保存ダイアログを出す(保存時に SHA-256 検証を実施)。
- Webview へのドラッグ&ドロップ対応は本リリースでは対象外(将来拡張)。

## 7. TreeView(サイドバー)

- ViewContainer `sfBoard` を activitybar に追加。アイコンは同梱 SVG。
- ツリー項目: チャンネル一覧(名前順)。未読ありは太字+未読件数バッジ(`TreeItem.description`)。クリックでパネルを開く/reveal。
- インラインアクション: チャンネル作成(＋)、リフレッシュ。コンテキストメニュー: リネーム。
- 未読判定: ローカルの最終読了 ULID(DESIGN.md §6)と各チャンネル最新イベント ULID の比較。パネルがアクティブになった時点で読了を更新する。

## 8. コマンド・設定・キーバインド

### コマンド(contributes.commands)

| コマンドID | 内容 |
|---|---|
| `sfBoard.openChannel` | チャンネルをタブで開く(TreeViewクリックから) |
| `sfBoard.createChannel` | チャンネル作成(InputBoxで名前入力) |
| `sfBoard.renameChannel` | チャンネルリネーム |
| `sfBoard.refresh` | 手動同期(照合ポーリングを即時実行) |
| `sfBoard.setup` | 初期設定ウィザード(rootPath/userId/displayName を順に入力) |
| `sfBoard.showDiagnostics` | 同期診断ログの出力チャネルを表示(§8.1) |

### 設定(DESIGN.md §7 の表に追加)

| キー | 内容 | 既定値 |
|---|---|---|
| `sfBoard.attachmentMaxBytes` | 添付サイズ上限 | 10485760 |
| `sfBoard.imageInlinePreview` | 画像のインライン表示 | true |
| `sfBoard.diagnostics.enabled` | 同期診断ログの有効化(§8.1) | false |

設定キーの接頭辞は `sfBoard.` に統一する(DESIGN.md 記載の `chat.` は本書で上書き)。

### 8.1 同期診断ログ(任意・既定で無効)

同期(fs.watch 監視 / 照合 / フォールバック、DESIGN.md §5)の挙動を現場で観測するための任意ログ。SMB/NFS 実環境での通知到達・モード切替・取りこぼしの調査に用いる(§12 手動テストの補助)。

- **有効化**: `sfBoard.diagnostics.enabled`(既定 `false`)。**有効時のみ**出力する。
- **出力先**: VSCode の `LogOutputChannel`「SF Board」。`window.createOutputChannel(name, { log:true })` で生成し、VSCode が拡張のログディレクトリへ自動保存する。外部送信・テレメトリは行わない(DESIGN.md 技術的制約の外部接続ゼロを厳守)。共有フォルダには一切書き込まない。
- **記録内容(メタデータのみ)**: 同期イベント名 + メタデータ(`change.detected`(source/件数/カーソル名)、`reconcile.tick`(foundChange/watchNotified/missed)、`sync.fallback`、`watch.notify` / `watch.error` / `watch.retry`、`channel.updated`(channelId/イベント数/最新ULID)、`queue.flush`、`send.queued` 等)。**メッセージ本文・添付内容などの機密情報は記録しない**。
- **実装**: core 層は vscode 非依存の `DiagnosticsLogger` インターフェース(`core/diagnostics.ts`)で抽象化し、SyncEngine / ChatModel を計装する。Host が `LogOutputChannel` 実装(`host/diagnosticsLogger.ts`)を注入する。無効時は no-op ロガーを用い、`isEnabled()` 判定で出力を抑止する。`debug` レベルの高頻度イベント(`watch.notify` / `reconcile.tick` 等)は出力パネルのログレベルを上げたときのみ表示される。

### キーバインド

- 送信は Webview 内の keydown ハンドラで実装(`Ctrl+Enter` 送信、`Enter` 改行、`Ctrl+F` 検索、`Esc` 検索解除)。macOS では `Cmd+Enter` も送信として扱う。
- contributes.keybindings への登録は行わない(Webview フォーカス時のみの操作のため)。

## 9. i18n(日本語+英語)

- **拡張マニフェスト側**: `package.nls.json`(英語・既定)と `package.nls.ja.json` を用意し、コマンド名・設定説明を `%key%` 参照にする。
- **Extension Host 側**: `vscode.l10n.t()` を使用。`l10n/bundle.l10n.ja.json` を同梱。
- **Webview 側**: `vscode.l10n` は Webview で直接使えないため、Host が `init` メッセージで文言辞書(`l10n: Record<string,string>`)を渡す。Webview は `t(key)` ヘルパで参照。文言キーは Host/Webview で単一の `strings.ts` に定義し、ビルド時に両バンドルへ含める。
- 言語判定は `vscode.env.language` に従う(`ja*` なら日本語、それ以外は英語)。

## 10. Markdown レンダリング(確定仕様)

- `markdown-it` を Webview バンドルに含める。設定: `{ html: false, linkify: true, breaks: true }`(Slack風に単一改行を `<br>` にする)。
- 有効記法: 見出し、強調、リスト、引用、コードブロック(フェンス)、インラインコード、テーブル、リンク、水平線。
- 出力を `DOMPurify.sanitize()` に通す。許可タグ・属性はホワイトリスト方式。
- リンク: `http(s)://` は表示するが、**クリックしてもブラウザは開かない**(エアギャップ方針。VS Code webview の自動遷移も防ぐため、レンダリング後に `href` を除去して `data-href` に退避する)。クリック時は Host が URL 全文をダイアログ(`vscode.window.showInformationMessage`、モーダル)で提示し、「リンクのコピー」選択時のみ `vscode.env.clipboard.writeText` でクリップボードへコピーする。`file://` 等その他プロトコルは対象外。
- 画像記法 `![](...)` は `attachment://` スキームのみ許可。外部URLの画像は描画しない。添付画像のサムネイルはクリックでライトボックス(拡大表示)を開き、そこからダウンロード(保存ダイアログ + SHA-256 検証)できる(§6.5)。
- コードハイライト: `highlight.js`(common言語のみのビルド)を同梱。失敗時はプレーン表示。

## 11. ビルド・配布(VSIX / オフライン)

- バンドラ: `esbuild`。Host 用(`dist/extension.js`, CommonJS, external: vscode)と Webview 用(`dist/webview.js`, IIFE)の2ターゲット。
- **全依存(markdown-it / DOMPurify / highlight.js / ulid実装)をバンドルに内包**する。実行時のネットワークアクセスは共有フォルダ以外に一切発生させない。テレメトリ送信類は入れない。
- `vsce package` で VSIX を生成。インストール手順(ドキュメントに記載): `code --install-extension sf-board-x.y.z.vsix`。
- `engines.vscode` は `^1.85.0` とする。
- 開発環境がエアギャップ外である前提で devDependencies は通常運用とするが、成果物 VSIX が自己完結であることをリリースごとに検証する。

### 外部接続ゼロの検証チェックリスト(リリース時必須)

- [ ] バンドル(`dist/*.js`)に `http.request` / `https.request` / `fetch(` / `XMLHttpRequest` / `WebSocket(` / `net.connect` の呼び出しが含まれないこと(grep で機械検証)
- [ ] Webview の HTML/CSS に外部 URL 参照(`https://` を含む `src`/`href`/`@import`/`url(`)が無いこと。フォントはシステムフォント(`var(--vscode-font-family)`)のみ使用し、Web フォントを同梱・参照しないこと
- [ ] CSP が `default-src 'none'` 基点で、許可オリジンが `${webview.cspSource}` のみであること
- [ ] `package.json` に update/telemetry 系の依存が入っていないこと
- [ ] クリーン環境(ネットワーク遮断した VM)で VSIX をインストールし、送受信・添付・検索の主要操作を行ってもネットワークエラーが発生しない(=接続試行が無い)ことを確認

### 運用側への推奨(README に記載)

拡張の外側の話として、VSCode 本体は既定でテレメトリ送信・拡張更新チェック等を行おうとする。エアギャップ環境では到達しないだけなので実害はないが、接続試行自体を無くしたい場合は `telemetry.telemetryLevel: "off"`、`extensions.autoUpdate: false`、`update.mode: "none"` を組織の settings.json で配布することを推奨する。

## 12. テスト方針

- **ユニットテスト(必須)**: `core/`(ulid 単調性補正、reducer の LWW/権限チェック/リネーム導出、JSONL差分読みの不完全行処理、store のアトミック書き込み)。vitest または mocha。ファイルI/Oは一時ディレクトリで実施。
- **結合テスト(必須)**: 一時ディレクトリを共有フォルダに見立て、2つの store/sync インスタンスを同時に動かし、相互のイベントが収束することを検証(リアクションのトグル競合、同時投稿の順序)。
- **手動テストチェックリスト**: SMB実環境での fs.watch 通知到達、フォールバック切替、VSCode再起動時のパネル復元、i18n表示、10MB超添付の拒否。
- Webview UI の自動テストは本リリースでは対象外(手動確認)。

## 13. 実装フェーズ(DESIGN.md §9 を更新)

1. **Phase 1**: core 層+ユニットテスト(channel_renamed 含む)。
2. **Phase 2**: ChatModel/PanelManager/TreeView + Webview 最小チャット(投稿・全履歴表示・Markdown・Ctrl+Enter)。照合ポーリングのみ。
3. **Phase 3**: スレッド、リアクション、添付(10MB制限・画像インライン)、チャンネル作成/リネーム、チャンネル内検索。
4. **Phase 4**: fs.watch 監視層+フォールバック、送信キュー+楽観的UI、未読管理、i18n 仕上げ、パネル復元(Serializer)、VSIX パッケージング。

## 14. 将来拡張のための予約(実装しないが壊さない)

- メンション: `body` 内の `@userId` は現時点でプレーンテキスト扱い。将来ハイライト+通知に拡張。
- DM: `channel.json` に `members?: string[]` フィールドを予約(現在は未使用・全公開チャンネル)。
- 全チャンネル横断検索: ローカルキャッシュ(DESIGN.md §6)上へのインデックス追加で対応可能な構造を維持する。
- アーカイブ: `channel_archived` イベント追加で対応可能(type 未知イベントは無視される前方互換性で担保済み)。
