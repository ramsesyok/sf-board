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
| 新着通知 | アクティビティバーのバッジ+ステータスバーの未読数(既定で有効)、VS Code 内ポップアップ(既定で無効)。サイドバー・チャンネルを開いていなくても通知する(§7.1) |
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
│   ├ チャンネル状態とユーザ一覧のオンメモリ保持          │
│   └ EventEmitter: onChannelUpdated / onUsersUpdated     │
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
- Webview オプション: `enableScripts: true`、`localResourceRoots` に **拡張の media ディレクトリと `chat-root/attachments` の両方**を指定する(添付表示のため。`sfBoard.rootPath` 変更時はパネル再作成が必要な点に注意)。
- CSP を必ず設定する: `default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src data:; script-src 'nonce-...';`。外部オリジンは一切許可しない(`font-src data:` は KaTeX の内包フォント用で、data URI のみ=外部接続なし。§10)。

## 5. Host ⇔ Webview メッセージプロトコル

```typescript
// 既存メッセージの添付を描画するための情報。
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
      attachments: Record<string, AttachmentInfo>;  // ulid → 添付情報
      selfUserId: string;
      l10n: Record<string, string>;      // Webview用文言辞書(§9)
      config: { attachmentMaxBytes: number; threadDisplay: "inline" | "thread" } }
  | { kind: "channelUpdated";            // 差分ではなく最新状態を再送(冪等・単純)
      messages: RenderedThread[]; channelName: string;
      users: Record<string, UserProfile>;
      attachments: Record<string, AttachmentInfo> }
  | { kind: "usersUpdated"; users: Record<string, UserProfile> }
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
  | { kind: "openLink"; href: string }                       // §10 リンク委譲
  | { kind: "openPath"; path: string }                       // §10 ファイル/フォルダパスを開く
  | { kind: "renameChannel"; name: string };
```

- `channelUpdated` は差分イベントではなく**リデュース済み最新状態の全量**を送る。50人規模+全履歴読み込み方針なら十分軽く、Webview 側の状態管理バグを構造的に排除できる。描画のみ差分更新する(§6.3)。
- `usersUpdated` は `ChatModel` のプロフィール一覧が変わったときに開いている各 Webview へ送る。メッセージ全履歴は再送せず、候補と既存 DOM の表示名・メンションの表示と hover を更新する。初期一覧は `init` に含める。
- `RenderedThread` は「親メッセージ+返信配列+リアクション集計済み」のビュー用構造体。Markdown→HTML 変換は **Webview 側**で行う(Host は生テキストを渡す)。
- `attachments` は当該チャンネルのメッセージが参照する添付の描画情報。Host が `attachments/{ch}/{YYYY-MM}/{ulid}/meta.json` を読み、`blob` を `asWebviewUri` で解決して渡す。
- `openLink` は本文中リンクのクリックを Host へ委譲する。**リンクをクリックしてもブラウザは開かない**。Host は URL 全文をダイアログで提示し、「リンクのコピー」選択時のみ URL をクリップボードへコピーする(§10)。拡張自身は当該 URL へ通信しない。

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
- スレッド返信の表示方式は設定 `sfBoard.threadDisplay` で切り替える(§6.6)。
  - `inline`(既定): スレッド返信は親の直下にインライン展開(別カラムは作らない)。返信入力欄は展開時に親の下に表示。
  - `thread`: タイムラインには「返信n件・最終返信時刻」のサマリのみ表示し、返信は右側のスレッドペインで開く。
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
- Host 側でサイズ検証(`sfBoard.attachmentMaxBytes`、既定 10MB)。超過時はエラー文言を返す。
- 画像(png/jpg/gif/webp/svg※svgはサニタイズ困難のためサムネイル化せずファイル扱い)はメッセージ内にインラインサムネイル表示(`attachment://` → `asWebviewUri` 解決)。**サムネイルのクリックでライトボックス(全画面オーバーレイの拡大表示)を開き**、そこから「ダウンロード」で `openAttachment` を実行する(背景クリック / Esc / 「閉じる」で閉じる)。画像以外はファイル名+サイズのカードで表示し、クリックで直接 `openAttachment` → Host が保存ダイアログを出す(保存時に SHA-256 検証を実施)。
- Webview へのドラッグ&ドロップ対応は本リリースでは対象外(将来拡張)。

### 6.6 返信の表示方式(inline / thread)

設定 `sfBoard.threadDisplay` により、返信の表示を切り替える(値は Host が `init` の `config.threadDisplay` で Webview へ渡す。§5)。

- `inline`(既定): 従来どおり。親メッセージの直下に「▸ 返信n件」の折りたたみを出し、展開すると返信+返信入力欄がインライン表示される。
- `thread`(Slack 風): Webview を **2 カラム**(左=タイムライン / 右=スレッドペイン)にする。
  - タイムラインには返信を出さず、親の下に「返信サマリ」(返信者アバター+件数+最終返信時刻)を表示。クリック、またはホバーツールバーの返信ボタンでスレッドペインを開く。
  - 右のスレッドペインは、ヘッダ(「スレッド」+ `#チャンネル名` + 閉じる)、親メッセージ、`n件の返信` の区切り、返信一覧、返信入力欄(`Ctrl+Enter` 送信)で構成する。
  - スレッドペインはメインの WebView 内の右カラムであり、別の VSCode エディタタブは開かない。
  - 楽観的 UI(pending)・リアクション・添付表示はペイン内でも同様に機能する。
  - 「チャンネルにも投稿(Also send to channel)」は本リリースでは対象外(将来拡張)。
  - 表示方式はパネル作成時の設定で決まる。設定変更後は、新しく開くパネルから反映する。既存パネルには開き直しが必要。

### 6.7 メンション候補と表示

- メイン入力欄、スレッドペインの入力欄、インライン返信入力欄に共通の候補 UI を設ける。カーソル直前の単語境界にある `@` とその後の文字列を検出する。メールアドレス中の `@` は対象外。入力操作による共有フォルダアクセスは発生させない。
- `@` だけで全候補を開き、その後の入力で `userId` と `displayName` を部分一致検索する。候補には表示名と `userId` の両方を示し、表示名順で最大 10 件を表示する。同名の表示名があっても `userId` で区別する。
- 上下矢印キーで候補を移動し、Enter・Tab・クリックで確定、Esc で閉じる。候補が開いていない場合は従来どおり Enter で改行、Ctrl+Enter で送信する。IME 変換中は候補確定キーを処理しない。カーソル移動、空白、削除、フォーカス喪失で候補を閉じる。
- 候補選択時には入力欄の該当箇所を `@DisplayName` に置き換え、カーソルをその直後へ移す。入力欄ごとに選択した `userId` とトークン位置をローカルで保持する。後続の入力・削除で位置を補正し、トークンの中身が編集されたら紐付けを外す。送信時には有効なトークンを本文の後方から `@userId` に変換し、既存の `message_created.body` に保存する。イベントスキーマは変更しない。
- 本文表示は §10 に従う。表示名の変更や重複があっても保存済みの宛先 ID は不変。コピー・手入力された単なる `@DisplayName` は候補から再選択しない限り自動で ID に変換しない。候補を利用できなくても通常のテキスト入力と送信は可能とする。
- 現行の `@userId` 認識は `[A-Za-z0-9_-]+` に限る。設定値の `userId` は現状この文字集合へ強制されていないため、候補実装時は範囲外 ID を候補で選べないことを明示し、既存 ID を黙って正規化しない。全 ID への対応には本文記法と既存データの互換性を別途設計する。

**実装状況**: チャット本文の `@DisplayName` 表示と自分宛だけの強調は実装済み。候補 UI、入力欄内の表示名と ID の紐付け、`users/` の低頻度照合、`usersUpdated` は未実装であり、本節の実装対象である。

## 7. TreeView(サイドバー)

- ViewContainer `sfBoard` を activitybar に追加。アイコンは同梱 SVG。
- ツリー項目: チャンネル一覧(名前順)。未読ありは太字+未読件数バッジ(`TreeItem.description`)。クリックでパネルを開く/reveal。
- インラインアクション: チャンネル作成(＋)、リフレッシュ。コンテキストメニュー: リネーム。
- 未読判定: ローカルの最終読了 ULID(DESIGN.md §6)と各チャンネル最新イベント ULID の比較。パネルがアクティブになった時点で読了を更新する。
- TreeView は `createTreeView` で activate 時に 1 度だけ生成し、再初期化(§8.2)をまたいで保持する(バッジを載せるため。§7.1)。`sfBoard.rootPath` 未設定時は `viewsWelcome` で「初期設定」ボタンを表示する。

### 7.1 新着通知

サイドバーやチャンネルのタブを開いていなくても、新着メッセージに気づけるようにする。すべて VS Code 内の表示で、OS のトースト通知は行わない(§1)。

**起動時アクティベート**

- `activationEvents` は `onStartupFinished` と `onView:sfBoardChannels`。VS Code の起動後、ビューを開かなくても同期(DESIGN.md §5)が動く。
  - 当初は共有フォルダへのアクセスを減らすためビュー表示時のみ起動としていたが、実運用では常時表示されがちで効果が小さいため方針を変更した。待機中の I/O は fs.watch 監視層ならほぼゼロ。フォールバック中はポーリング負荷がかかる。
- 起動時に `sfBoard.rootPath` が未設定なら、警告を出さずに待機する(設定していない人の起動ごとに警告しないため)。設定変更による再初期化では従来どおり警告する。
- 再初期化の完了時に `ChatModel.listChannels()` で全チャンネルを読み込み、未読数を計算できる状態にする(これまではツリーの表示を契機に読み込んでいた)。

**表示手段**

| 手段 | 実装 | 既定 | 内容 |
|---|---|---|---|
| アクティビティバーのバッジ | `TreeView.badge` | 常に有効 | 全チャンネルの未読数の合計。0 のときは非表示。tooltip は「SF Board: 未読 N 件」 |
| ステータスバー | `window.createStatusBarItem`(左寄せ) | `sfBoard.notify.statusBar` = true | `$(comment-unread) N`。0 のときは非表示。tooltip にチャンネルごとの未読数を表示し、クリックで `sfBoard.openUnread` を実行する |
| ポップアップ | `window.showInformationMessage`(非モーダル) | `sfBoard.notify.popup` = `off` | `all` のとき、他者の新着メッセージで「#channel に新着 — 表示名: 本文の抜粋」と [開く] ボタンを表示する |

- 未読数は §7 の未読判定をそのまま使う(自分の投稿と削除済みは数えない)。
- 既読化は従来どおり、パネルがアクティブになった時点。

**ポップアップの判定**

- チャンネルごとに「通知済みの基準 ULID」をメモリで保持する(永続化しない。共有フォルダにも書かない)。初めて観測したチャンネルは最新イベント ULID を基準にするだけで通知しない。起動直後や新チャンネル発見時に既存の履歴をまとめて通知しないため。
- `onChannelUpdated` のたびに、基準より新しい「自分以外・非削除」のメッセージを集め、基準を最新イベント ULID へ進める。
- 次のときはポップアップを出さない(バッジ・ステータスバーには反映する):
  - 当該チャンネルのパネルがアクティブで、かつ VS Code ウィンドウにフォーカスがある
  - 同じチャンネルで直近 30 秒以内にポップアップを出している(連投で埋め尽くさないため)
- 複数件なら「#channel に新着 N 件 — 最新 表示名: 抜粋」とする。抜粋は本文の最初の空でない行を 80 文字で切ったもの。本文が空(添付のみ)なら「(添付ファイル)」。
- **リンク構文の無害化(必須)**: 本文・表示名・チャンネル名は他ユーザー由来のため、ポップアップの文言は `hlSafe()` で組み立てる(§10)。
- 判定ロジック(基準の管理・クールダウン・抜粋)は vscode 非依存の `model/newMessageTracker.ts` に置き、単体テストする。表示は Host 側の `ui/notifier.ts` が担う。

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
| `sfBoard.verifyConnection` | 共有フォルダの接続確認(存在/読み書き/UNC 許可/実エラーを検査、§8.2) |
| `sfBoard.openUnread` | 未読のあるチャンネルのうち、最新の未読メッセージを持つものを開く(ステータスバーのクリック、§7.1) |

### 設定(contributes.configuration)

| キー | 内容 | 既定値 |
|---|---|---|
| `sfBoard.rootPath` | 共有フォルダの chat-root パス | (必須) |
| `sfBoard.userId` | ユーザーID(未設定時は OS ユーザー名) | "" |
| `sfBoard.displayName` | 表示名 | "" |
| `sfBoard.poll.reconcileSec` | カーソル照合周期(秒) | 90 |
| `sfBoard.poll.fallbackSec` | フォールバック基本周期(秒) | 4 |
| `sfBoard.watch.enabled` | 監視層の有効化 | true |
| `sfBoard.attachmentMaxBytes` | 添付サイズ上限 | 10485760 |
| `sfBoard.imageInlinePreview` | 画像のインライン表示 | true |
| `sfBoard.threadDisplay` | 返信の表示方式 `inline` / `thread`(§6.6) | inline |
| `sfBoard.diagnostics.enabled` | 同期診断ログの有効化(§8.1) | false |
| `sfBoard.confirmOpenPath` | 本文内のパスを開く前に確認する(§10)。有効時は確認に「パスをコピー」も併設 | true |
| `sfBoard.notify.statusBar` | ステータスバーに未読数を表示する(§7.1) | true |
| `sfBoard.notify.popup` | 新着のポップアップ通知 `off` / `all`(§7.1) | off |

設定キーの接頭辞は `sfBoard.` に統一する。

### 8.1 同期診断ログ(任意・既定で無効)

同期(fs.watch 監視 / 照合 / フォールバック、DESIGN.md §5)の挙動を現場で観測するための任意ログ。SMB/NFS 実環境での通知到達・モード切替・取りこぼしの調査に用いる(§12 手動テストの補助)。

- **有効化**: `sfBoard.diagnostics.enabled`(既定 `false`)。**有効時のみ**出力する。
- **出力先**: VSCode の `LogOutputChannel`「SF Board」。`window.createOutputChannel(name, { log:true })` で生成し、VSCode が拡張のログディレクトリへ自動保存する。外部送信・テレメトリは行わない(DESIGN.md 技術的制約の外部接続ゼロを厳守)。共有フォルダには一切書き込まない。
- **記録内容(メタデータのみ)**: 同期イベント名 + メタデータ(`change.detected`(source/件数/カーソル名)、`reconcile.tick`(foundChange/watchNotified/missed)、`sync.fallback`、`watch.notify` / `watch.error` / `watch.retry`、`channel.updated`(channelId/イベント数/最新ULID)、`queue.flush`、`send.queued` 等)。**メッセージ本文・添付内容などの機密情報は記録しない**。
- **実装**: core 層は vscode 非依存の `DiagnosticsLogger` インターフェース(`core/diagnostics.ts`)で抽象化し、SyncEngine / ChatModel を計装する。Host が `LogOutputChannel` 実装(`host/diagnosticsLogger.ts`)を注入する。無効時は no-op ロガーを用い、`isEnabled()` 判定で出力を抑止する。`debug` レベルの高頻度イベント(`watch.notify` / `reconcile.tick` 等)は出力パネルのログレベルを上げたときのみ表示される。

### 8.2 セットアップの堅牢化と共有フォルダ接続診断

- **再初期化のデバウンス+直列化**: 初期設定は `rootPath`/`userId`/`displayName` を連続して `config.update` するため、設定変更を 250ms デバウンスし、`reinitialize` を直列化する(実行中なら 1 回だけ再実行を予約)。再初期化の契機は `rootPath`/`userId`/`displayName`/`poll.*`/`watch.enabled` に限定する。`threadDisplay`/`attachmentMaxBytes`/`imageInlinePreview` は新規パネル作成時に読み、既存パネルへの反映には開き直しが必要。`diagnostics.enabled`/`notify.*` は必要時に読み直す。
- **UNC ホスト許可(Windows)**: VS Code は UNC パス(`\\host\share`)を `security.allowedUNCHosts` で制限する。`reinitialize` は init 前に、Windows かつ UNC かつ未許可(`security.restrictUNCAccess` 有効)を検出したら、確認ダイアログを出し、同意時のみ `security.allowedUNCHosts` にホストを追加してウィンドウを再読み込みする(設定反映に再読み込みが必要なため)。同意が得られない場合は init を中断する(サイレント追加はしない)。
- **接続確認コマンド** `sfBoard.verifyConnection`: 共有フォルダの存在・ディレクトリ種別・読み取り・書き込み(一時ファイルで実測し必ず削除)・`workspace.json` の有無・UNC 許可状態・実エラー(code/path)を検査し、結果をモーダルで表示する。init 失敗時のエラーメッセージにも原因(エラーコード)を含め、「接続確認」ボタンから本コマンドを起動できる。判定ロジックは vscode 非依存の `host/connectionCheck.ts`(`parseUncHost`/`probeSharedFolder`)に置き単体テストする。

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
- ファイル/フォルダパスのリンク化: 本文中の **UNC(`\\host\share\...`)/ Windows ドライブ(`C:\...` / `C:/...`)/ POSIX 絶対(`/dir/sub/...`)** を検出してクリック可能にする。相対パスは対象外。検出ロジックは vscode 非依存の `shared/pathLink.ts`(`matchPathAt` / `findPathMatches`)に置き単体テストする。誤検出対策として、直前が英数字なら URL スキーム(`http://`・`file://C:/...`)を除外し、POSIX は「行頭/空白/開き括弧」の直後かつ **2 セグメント以上**に限定(`and/or`・`24/7`・`12:30` を除外)、末尾の句読点・閉じ括弧を除去(末尾スラッシュは保持)、`"..."`(エクスプローラの「パスのコピー」)は囲みを除いて空白入りでも 1 塊で拾う。
  - レンダリング: **Markdown は先頭 `\\` を `\` に畳む**ため、UNC は `markdown-it` の**インラインルール(`escape` より前)**で生ソースから捕捉しプレースホルダ span(`path-src`)を出力→サニタイズ後に `.path-link` へ変換する。Windows ドライブ / POSIX は Markdown を通っても壊れないため、**サニタイズ後の DOM テキスト走査**で `.path-link` に包む(`code,pre,a,.mention,.path-link,.path-src,.math-src,.mermaid-src` は除外)。生パスは `data-path` に持つ。
  - クリック時: Host が `openPath` を受け、`fs.stat` で種別判定し、設定 `sfBoard.confirmOpenPath`(既定 `true`)が有効なら確認ダイアログ(「開く/表示」+「パスをコピー」)を挟む。**フォルダは OS のファイルマネージャで中を開く**(win32 `explorer.exe` / darwin `open` / linux `xdg-open` へ `child_process.spawn`、引数配列で Unicode 安全)、**ファイルは `vscode.commands.executeCommand('revealFileInOS', Uri.file(path))`**(VS Code 組み込み・全 OS・**関連付け不問・文字化けなし**)でファイルマネージャに選択表示する。UNC は `allowedUNCHosts` 登録前提だが、万一 `fs.stat` が失敗しても中断せず開き(種別不明時は reveal)、ローカルの `ENOENT` のみ「見つかりません」を表示する。開く操作が失敗した場合は「パスをコピー」を提案する(安全弁)。いずれもローカル/共有フォルダの操作のみで**外部通信は行わない**(`child_process` はネットワーク API ではない)。※ ファイルを「既定アプリで開く」方式(`Start-Process`・`openExternal(file:)`)は、関連付けの無い拡張子で無反応・日本語パス破損・OS 差といった不安定さがあるため採用しない。
- 画像記法 `![](...)` は `attachment://` スキームのみ許可。外部URLの画像は描画しない。添付画像のサムネイルはクリックでライトボックス(拡大表示)を開き、そこからダウンロード(保存ダイアログ + SHA-256 検証)できる(§6.5)。
- コードハイライト: `highlight.js/lib/common`(common言語のみ)を Webview バンドルに同梱し、`markdown-it` の `highlight` オプションで適用。出力は `<span class="hljs-*">` で DOMPurify のホワイトリスト(span/class)を通過する。言語未指定/失敗時はプレーン表示。トークン色は VS Code のテーマ(`body.vscode-dark` / `body.vscode-light`)に追従する。
- `@メンション`装飾: サニタイズ後の本文テキストノードを走査し、`@userId` が**既知ユーザー**(`users` に存在)の場合のみ `<span class="mention">` へ変換する。本文の保存値は `@userId` のまま、画面には `@DisplayName` を表示し、hover で userId を確認できるようにする。表示名が重複しても判定は userId で行う。**自分宛のみ** `mention-self` で色を変え、他ユーザー宛は通常の本文色にする。コード(`code`/`pre`)・リンク内は対象外。通知は行わない(§14)。
- 数式(KaTeX): `$...$`(インライン)/ `$$...$$`(ブロック)/ ` ```math ` フェンスに対応。`@vscode/markdown-it-katex` でパースし、レンダラを上書きして**プレースホルダ span**(class + エスケープ済みテキストのみ)を出力→ DOMPurify 通過後に `katex.renderToString`(`trust:false`・`throwOnError:false`)で実描画する。KaTeX の CSS とフォントはビルド時に `dist/katex.css` へ**フォント(woff2)を data URI で内包**して同梱し、Webview は `<link>`(cspSource 経由)で読む。外部フォント参照は持たない。CSP に `font-src data:` を追加(§4)。
- 図(mermaid): ` ```mermaid ` フェンスに対応。同様にプレースホルダ→ `mermaid.render`(`securityLevel:'strict'`・`startOnLoad:false`)で SVG を生成し差し込む。テーマは `body.vscode-dark`/`light` に追従。外部アイコン/CDN は使わない(`loadExternalDiagrams` 等は無効)。
- **Host の通知・ダイアログへの差し込み値の無害化(必須)**: VS Code の非モーダル通知(`show*Message`)は `[label](https:…)` / `(command:…)` / `(file:…)` をリンクとして描画し、クリックで URL を開いたりコマンドを実行したりする。本文中のパス・添付名・表示名・チャンネル名などは他ユーザーが自由に書けるため、そのまま埋め込むと任意コマンドの実行や、ブラウザ起動による外部接続を誘導できる。動的な値を差し込む文言は必ず `hlSafe()`(`host/hostL10n.ts`)で組み立てる。`hlSafe` は差し込み値ごとに `neutralizeNotificationLinks`(`shared/notificationText.ts`)を適用し、`](` にゼロ幅スペースを挟んでリンクとして解釈させない。モーダルダイアログも同じ扱いにする(多層防御)。無害化するのは表示文字列だけで、クリップボードへのコピーやパスを開く処理には元の値を使う。
- KaTeX/mermaid の出力は複雑な span/SVG/inline style を含み厳格な DOMPurify を通せないが、いずれも自前で安全な HTML を生成する(KaTeX は trust:false、mermaid は strict)ため、**サニタイズ後**にプレースホルダへ差し込む方式とする。プレースホルダ自体は既存の DOMPurify ホワイトリスト(span/class/テキスト)を通過する。

## 11. ビルド・配布(VSIX / オフライン)

- バンドラ: `esbuild`。Host 用(`dist/extension.js`, CommonJS, external: vscode)と Webview 用(`dist/webview.js`, IIFE)の2ターゲット。
- **全依存(markdown-it / DOMPurify / highlight.js / ulid実装)をバンドルに内包**する。実行時のネットワークアクセスは共有フォルダ以外に一切発生させない。テレメトリ送信類は入れない。
- `vsce package` で VSIX を生成。インストール手順(ドキュメントに記載): `code --install-extension sf-board-x.y.z.vsix`。
- `engines.vscode` は `^1.85.0` とする。
- 開発環境がエアギャップ外である前提で devDependencies は通常運用とするが、成果物 VSIX が自己完結であることをリリースごとに検証する。

### 外部接続ゼロの検証チェックリスト(リリース時必須)

- [ ] バンドル(`dist/*.js`)に**ネットワーク**呼び出し(`http.request` / `https.request` / `fetch(<引数>)` / `XMLHttpRequest` / `WebSocket(` / `net.connect` / 動的 `import(`)が含まれないこと(grep で機械検証)。
  - 注: KaTeX の**字句解析メソッド `.fetch()`(引数なし)**は多数含まれるが、これはトークン取得用のメソッド名であり通信ではない。ネットワーク検出は「引数付き `fetch(` 」で判定する(例: `grep -oE "fetch\([^)]" dist/webview.js` が 0 件、`window/globalThis/self.fetch` が 0 件)。
- [ ] Webview の HTML/CSS に外部 URL 参照(`https://` を含む `src`/`href`/`@import`/`url(`)が無いこと。UI フォントはシステムフォント(`var(--vscode-font-family)`)のみ。KaTeX の数式フォントは `dist/katex.css` に **data URI で内包**し、`url(fonts/...)` 等の外部参照を残さないこと(`grep url\(fonts/ dist/katex.css` が 0 件)。
- [ ] CSP が `default-src 'none'` 基点で、`img-src`/`style-src` の許可オリジンは `${webview.cspSource}` のみ、`font-src` は `data:` のみ(KaTeX フォント用・外部なし)、`script-src` は nonce のみであること
- [ ] `package.json` に update/telemetry 系の依存が入っていないこと
- [ ] クリーン環境(ネットワーク遮断した VM)で VSIX をインストールし、送受信・添付・検索の主要操作を行ってもネットワークエラーが発生しない(=接続試行が無い)ことを確認

### 運用側への推奨(README に記載)

拡張の外側の話として、VSCode 本体は既定でテレメトリ送信・拡張更新チェック等を行おうとする。エアギャップ環境では到達しないだけなので実害はないが、接続試行自体を無くしたい場合は `telemetry.telemetryLevel: "off"`、`extensions.autoUpdate: false`、`update.mode: "none"` を組織の settings.json で配布することを推奨する。

## 12. テスト方針

- **CI**: GitHub Actions の push・PR・手動実行で、Ubuntu と Windows の両方に `npm ci` で依存関係を入れ、型チェック・テスト・VSIX 作成を実施する。CI は開発時のみ利用し、拡張の実行時通信には含めない。
- **ユニットテスト(必須)**: `core/`(ulid 単調性補正、reducer の LWW/権限チェック/リネーム導出、JSONL差分読みの不完全行処理、store のアトミック書き込み)。vitest または mocha。ファイルI/Oは一時ディレクトリで実施。
- **結合テスト(必須)**: 一時ディレクトリを共有フォルダに見立て、2つの store/sync インスタンスを同時に動かし、相互のイベントが収束することを検証(リアクションのトグル競合、同時投稿の順序)。
- **手動テストチェックリスト**: SMB実環境での fs.watch 通知到達、フォールバック切替、VSCode再起動時のパネル復元、i18n表示、10MB超添付の拒否。
- **メンション候補の確認**: 3 種の入力欄で候補の検索・選択・Enter改行・Ctrl+Enter送信・IME変換を確認する。表示名重複時も選択した userId が本文に保存されること、投稿前の新規ユーザーとプロフィール名の変更が低頻度照合後に反映されること、共有フォルダ一時切断時も既存候補と通常入力が保たれることを確認する。`@` の入力操作では共有フォルダ I/O が増えないことを診断ログ等で確かめる。
- Webview UI の自動テストは本リリースでは対象外(手動確認)。

## 13. 実装フェーズ

1. **Phase 1**: core 層+ユニットテスト(channel_renamed 含む)。
2. **Phase 2**: ChatModel/PanelManager/TreeView + Webview 最小チャット(投稿・全履歴表示・Markdown・Ctrl+Enter)。照合ポーリングのみ。
3. **Phase 3**: スレッド、リアクション、添付(10MB制限・画像インライン)、チャンネル作成/リネーム、チャンネル内検索。
4. **Phase 4**: fs.watch 監視層+フォールバック、送信キュー+楽観的UI、未読管理、i18n 仕上げ、パネル復元(Serializer)、VSIX パッケージング。

## 14. 将来拡張のための予約(実装しないが壊さない)

- メンション通知: 候補選択と本文表示は §6.7 / §10 の仕様とし、メンションに限った通知は引き続き対象外(将来拡張)。`sfBoard.notify.popup` の値に `mentions` を追加すれば対応できる構造にしておく(§7.1)。
- DM: `channel.json` に `members?: string[]` フィールドを予約(現在は未使用・全公開チャンネル)。
- 全チャンネル横断検索: ローカルキャッシュ(DESIGN.md §6)上へのインデックス追加で対応可能な構造を維持する。
- アーカイブ: `channel_archived` イベント追加で対応可能(type 未知イベントは無視される前方互換性で担保済み)。
