// ChatPanel: チャンネル 1 つ分の Webview パネル。DESIGN_EXTENSION.md §4 / §5。
//
// - エディタタブ内 Webview。1 チャンネル = 最大 1 パネル(管理は PanelManager)。
// - 厳格な CSP(default-src 'none'、外部オリジン一切不可)。script は nonce 制限。
// - 正状態は ChatModel。パネルは onChannelUpdated を購読して最新状態を再送するだけ。

import * as vscode from "vscode";
import type { ChatModel } from "../model/chatModel";
import type { HostMessage, WebviewMessage } from "../shared/protocol";
import { getStrings, pickLang } from "../shared/strings";

export const CHANNEL_VIEW_TYPE = "airgapChat.channel";

export class ChatPanel {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly model: ChatModel,
    private readonly channelId: string,
    private readonly attachmentMaxBytes: number,
  ) {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => void this.handleMessage(msg),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // 自チャンネルの更新のみ Webview へ反映する。
    this.disposables.push(
      this.model.onChannelUpdated((updatedId) => {
        if (updatedId === this.channelId) this.postChannelUpdated();
      }),
    );
  }

  reveal(column?: vscode.ViewColumn): void {
    this.panel.reveal(column);
  }

  onDidDispose(listener: () => void): void {
    this.panel.onDidDispose(listener, undefined, this.disposables);
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.kind) {
      case "ready":
        this.postInit();
        break;
      case "sendMessage": {
        try {
          await this.model.sendMessage(this.channelId, msg.body, msg.threadId);
          this.post({ kind: "sendResult", requestId: msg.requestId, ok: true });
        } catch (err) {
          this.post({
            kind: "sendResult",
            requestId: msg.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case "renameChannel":
        await this.model.renameChannel(this.channelId, msg.name);
        break;
      // Phase 3: toggleReaction / pickAttachment / openAttachment を実装する。
      case "toggleReaction":
      case "pickAttachment":
      case "openAttachment":
        break;
    }
  }

  private postInit(): void {
    const view = this.model.getChannelView(this.channelId);
    if (!view) return;
    const lang = pickLang(vscode.env.language);
    this.panel.title = view.channelName;
    this.post({
      kind: "init",
      channelId: this.channelId,
      channelName: view.channelName,
      messages: view.threads,
      users: this.model.getUsers(),
      selfUserId: this.model.getSelfUserId(),
      l10n: getStrings(lang),
      config: { attachmentMaxBytes: this.attachmentMaxBytes },
    });
  }

  private postChannelUpdated(): void {
    const view = this.model.getChannelView(this.channelId);
    if (!view) return;
    this.panel.title = view.channelName;
    this.post({
      kind: "channelUpdated",
      messages: view.threads,
      channelName: view.channelName,
      users: this.model.getUsers(),
    });
  }

  private buildHtml(): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const cspSource = webview.cspSource;
    // CSP: 外部オリジンは一切許可しない(DESIGN_EXTENSION.md §4)。
    // 画像は Phase 3 で attachment:// を asWebviewUri(= cspSource)へ解決して表示する。
    const csp = [
      "default-src 'none'",
      `img-src ${cspSource}`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${WEBVIEW_CSS}</style>
</head>
<body>
<div id="messages" class="messages" aria-live="polite"></div>
<div class="composer">
  <textarea id="input" rows="1" class="composer-input"></textarea>
  <button id="send" class="composer-send"></button>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// フォントは var(--vscode-font-family) のみ。外部フォント・外部 URL は使わない(§11)。
const WEBVIEW_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  display: flex; flex-direction: column; height: 100vh;
}
.messages { flex: 1 1 auto; overflow-y: auto; padding: 12px 16px; }
.empty { color: var(--vscode-descriptionForeground); text-align: center; margin-top: 24px; }
.msg { display: flex; gap: 8px; padding: 4px 0; }
.msg.reply { margin-left: 28px; }
.avatar {
  flex: 0 0 auto; width: 28px; height: 28px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}
.msg-main { flex: 1 1 auto; min-width: 0; }
.msg-head { display: flex; align-items: baseline; gap: 8px; }
.msg-author { font-weight: 600; }
.msg-time { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.msg-edited { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.msg-body { word-wrap: break-word; overflow-wrap: anywhere; }
.msg-body p { margin: 2px 0; }
.msg-body pre {
  background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px;
  overflow-x: auto;
}
.msg-body code {
  background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px;
  font-family: var(--vscode-editor-font-family, monospace);
}
.msg-body pre code { background: none; padding: 0; }
.msg-body blockquote {
  margin: 2px 0; padding-left: 8px; border-left: 3px solid var(--vscode-textBlockQuote-border);
  color: var(--vscode-textBlockQuote-foreground);
}
.msg-body table { border-collapse: collapse; }
.msg-body th, .msg-body td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; }
.msg-body a { color: var(--vscode-textLink-foreground); }
.msg-deleted { color: var(--vscode-descriptionForeground); font-style: italic; }
.reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.reaction {
  display: inline-flex; gap: 4px; align-items: center;
  border: 1px solid var(--vscode-panel-border); border-radius: 10px;
  padding: 0 6px; font-size: 0.85em; background: var(--vscode-editorWidget-background);
}
.composer {
  flex: 0 0 auto; display: flex; gap: 8px; padding: 8px 12px;
  border-top: 1px solid var(--vscode-panel-border);
}
.composer-input {
  flex: 1 1 auto; resize: none; max-height: 40vh;
  font-family: inherit; font-size: inherit;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px;
  padding: 6px 8px;
}
.composer-input:focus { outline: 1px solid var(--vscode-focusBorder); }
.composer-send {
  flex: 0 0 auto; align-self: flex-end;
  color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer;
}
.composer-send:hover { background: var(--vscode-button-hoverBackground); }
`;
