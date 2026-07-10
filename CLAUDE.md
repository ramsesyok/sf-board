# CLAUDE.md

エアギャップ環境向けサーバレス・チャット VSCode 拡張のプロジェクト。共有ネットワークフォルダ(SMB/NFS)のみをストレージ兼トランスポートとして動作する。

## 設計文書(必読・正とする)

実装・修正の前に必ず以下を読むこと:

- `DESIGN.md` — ファイルシステム設計、イベントスキーマ、書き込みプロトコル、同期(監視+照合ポーリング)
- `DESIGN_EXTENSION.md` — 拡張本体設計。確定要件一覧(§1)、Host⇔Webviewプロトコル(§5)、UI仕様、i18n、ビルド・配布

両文書が矛盾する場合: ファイル形式・書き込みプロトコルは `DESIGN.md`、UI・拡張実装は `DESIGN_EXTENSION.md` を正とする。

**設計文書からの逸脱が必要になった場合は、実装せず先に差分を提案して承認を得ること。** 承認後は該当する設計文書も同じコミットで更新する。

## 絶対に守る設計原則(DESIGN.md より)

1. 共有フォルダ上のファイルは追記または新規作成のみ。書き換え・削除は禁止
2. 各ユーザーは自分の userId を含むファイルにのみ書き込む(ロック機構は使わない・作らない)
3. 状態ではなくイベントを保存する。集計値・派生状態を共有フォルダに置かない
4. 新規ファイルは一時名で書き切ってからリネーム。JSONL は 1 イベント = 1 行を単一 write で追記
5. ファイル監視の通知内容を状態管理に使わない。通知はトリガに過ぎず、必ず実ファイルを読み直す
6. 順序・LWW 判定は ULID を正とする。`ts` は表示専用

## 技術的制約

- エアギャップ前提: 実行時のネットワークアクセスは共有フォルダの I/O 以外を一切発生させない。テレメトリ・外部 CDN・fetch・WebSocket 禁止。全依存は VSIX にバンドル
- Web フォント・外部 URL 参照(CSS の `@import`/`url()` 含む)禁止。フォントは `var(--vscode-font-family)` を使う。本文リンクはクリックしてもブラウザを開かず、確認ダイアログで URL をクリップボードにコピーするのみ(拡張自身は通信しない)。リリース時は `DESIGN_EXTENSION.md` §11 の外部接続ゼロ検証チェックリストを必ず実施
- ファイル監視は素の `fs.watch` を使う。chokidar と VSCode の `FileSystemWatcher` はネットワークドライブで信頼できないため使用禁止
- Webview: `enableScripts: true` + 厳格な CSP 必須。Node API へのアクセス禁止。ファイル I/O・パス解決・ダイアログ表示はすべて Extension Host 側で行う
- Markdown: `markdown-it`(`html: false`)+ DOMPurify サニタイズ必須。画像は `attachment://` スキームのみ許可
- 設定キー接頭辞は `sfBoard.`、コマンド ID 接頭辞は `sfBoard.` に統一(拡張名は `sf-board` / 表示名 `SF Board`。旧称 `airgapChat.` / `airgap-chat` から改称)
- UI 文言はハードコード禁止。`strings.ts` にキー定義し、Host は `vscode.l10n.t()`、Webview は init メッセージで受け取った辞書を使う(日英対応)

## ディレクトリ構成

```
src/
├── extension.ts        # activate/deactivate、設定読み込み
├── core/               # ulid / events / reducer / store / sync / localCache
│                       # ※ vscode モジュールに依存させない(単体テスト可能に保つ)
├── ui/                 # channelTree / chatPanel / panelManager
│   └── webview/        # Webview 側 TS/CSS(別バンドル)
├── shared/             # strings.ts、Host⇔Webview メッセージ型定義
└── test/
media/                  # アイコン等
l10n/                   # bundle.l10n.ja.json
```

## コーディング規約

- TypeScript strict モード。`any` 禁止(外部入力のパース境界では unknown → 型ガード)
- イベントのパースは不正行をスキップして継続(例外で全体を止めない)。未知の `type` は無視(前方互換)
- core 層は純粋関数中心に保ち、ファイル I/O は store に隔離する
- コメント・コミットメッセージは日本語で可

## コマンド

```bash
npm run build        # esbuild で Host + Webview の 2 ターゲットをビルド
npm run watch        # 開発用ウォッチビルド
npm test             # ユニット+結合テスト(vitest)
npm run package      # vsce package で VSIX 生成
```

(スクリプト未整備の場合、Phase 1 の最初に上記名で package.json に定義すること)

## テスト方針

- core 層の変更時は必ず対応するユニットテストを追加・更新してから完了とする
- 結合テスト: 一時ディレクトリを共有フォルダに見立て、2 インスタンスの sync/store を並走させて収束を検証する(`DESIGN_EXTENSION.md` §12)
- 共有フォルダを模すテストで実際のネットワークドライブは不要。ただし SMB 特有の注意点(不完全行、ハンドル再オープン)を模擬するテストを含めること

## 実装の進め方

`DESIGN_EXTENSION.md` §13 のフェーズ順に実装する:

1. Phase 1: core 層+ユニットテスト
2. Phase 2: ChatModel / TreeView / Webview 最小チャット(照合ポーリングのみ)
3. Phase 3: スレッド・リアクション・添付・チャンネル作成/リネーム・チャンネル内検索
4. Phase 4: fs.watch 監視層+フォールバック、送信キュー、未読管理、i18n 仕上げ、VSIX

各フェーズ完了時に `npm test` が全件パスすること。フェーズをまたぐ先行実装はしない。

## スコープ外(実装しないこと)

メンション通知 / DM / OS トースト通知 / 全チャンネル横断検索 / アーカイブ / ドラッグ&ドロップ添付。
ただし将来拡張を壊さないための予約(`DESIGN_EXTENSION.md` §14)は遵守する。
