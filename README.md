# SF Board

エアギャップ(インターネット非接続)環境向けの **サーバレス・ボード** VSCode 拡張です。
サーバを一切立てず、**共有ネットワークフォルダ(SMB/NFS)のみ**をストレージ兼トランスポートとして動作します。

- チャンネル / スレッド返信 / リアクション / ファイル添付
- Markdown(生テキスト保存・クライアント側レンダリング)
- 準リアルタイム同期(fs.watch 監視 + 照合ポーリングのハイブリッド)
- 日本語 / 英語 UI

設計の詳細は `DESIGN.md` / `DESIGN_EXTENSION.md` を参照してください。

## インストール(オフライン)

```bash
code --install-extension sf-board-0.0.1.vsix
```

VSIX は自己完結(全依存をバンドル済み)で、実行時のネットワークアクセスは
共有フォルダの I/O 以外に一切発生しません。

## 使い方

1. コマンドパレットから **「SF Board: 初期設定」**(`sfBoard.setup`)を実行し、
   共有フォルダ(ルート)のパス・ユーザーID・表示名を入力します。
2. アクティビティバーの SF Board アイコンからチャンネル一覧を開きます。
3. `＋` でチャンネルを作成し、チャンネルをクリックして投稿を開始します。
   - 送信: `Ctrl+Enter`(Enter は改行)
   - 検索: チャンネル内で `Ctrl+F`
   - 添付: 📎 ボタン(既定上限 10MB)

## 主な設定

| キー | 既定 | 説明 |
|---|---|---|
| `sfBoard.rootPath` | (必須) | 共有フォルダのルートパス |
| `sfBoard.userId` | OS ユーザー名 | ユーザーID |
| `sfBoard.displayName` | | 表示名 |
| `sfBoard.poll.reconcileSec` | 90 | 照合ポーリング周期(秒) |
| `sfBoard.poll.fallbackSec` | 4 | フォールバック基本周期(秒) |
| `sfBoard.watch.enabled` | true | fs.watch 監視層の有効化 |
| `sfBoard.attachmentMaxBytes` | 10485760 | 添付上限(バイト) |
| `sfBoard.imageInlinePreview` | true | 画像のインライン表示 |
| `sfBoard.diagnostics.enabled` | false | 同期診断ログの有効化(出力チャネル「SF Board」) |

## エアギャップ運用の推奨(組織 settings.json)

拡張自体は共有フォルダ以外へ通信しませんが、VSCode 本体の接続試行を無くしたい場合は
以下を配布してください:

```jsonc
{
  "telemetry.telemetryLevel": "off",
  "extensions.autoUpdate": false,
  "update.mode": "none"
}
```

## ライセンス

社内利用限定。`LICENSE` を参照。
