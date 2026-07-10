// ChatPanel: チャンネル 1 つ分の Webview パネル。DESIGN_EXTENSION.md §4 / §5。
//
// - エディタタブ内 Webview。1 チャンネル = 最大 1 パネル(管理は PanelManager)。
// - 厳格な CSP(default-src 'none'、外部オリジン一切不可)。script は nonce 制限。
// - 正状態は ChatModel。パネルは onChannelUpdated を購読して最新状態を再送するだけ。

import * as vscode from "vscode";
import * as path from "path";
import * as fsp from "fs/promises";
import type { ChatModel } from "../model/chatModel";
import type { HostMessage, WebviewMessage, AttachmentInfo } from "../shared/protocol";
import { getStrings, pickLang } from "../shared/strings";
import { hl } from "../host/hostL10n";
import { mimeFromFilename, isInlineImageMime } from "../shared/mime";
import { verifyAttachment } from "../core/store";

export const CHANNEL_VIEW_TYPE = "sfBoard.channel";

export interface ChatPanelDeps {
  attachmentMaxBytes: number;
  imageInlinePreview: boolean;
}

export class ChatPanel {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly model: ChatModel,
    private readonly channelId: string,
    private readonly rootPath: string,
    private readonly deps: ChatPanelDeps,
  ) {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
        // 添付表示のため chat-root/attachments も許可する(DESIGN_EXTENSION.md §4)。
        vscode.Uri.file(path.join(this.rootPath, "attachments")),
      ],
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

    // パネルがアクティブになったら読了位置を進める(§7)。
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.active) void this.model.markRead(this.channelId);
      },
      undefined,
      this.disposables,
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
          const result = await this.model.sendMessage(this.channelId, msg.body, msg.threadId, msg.attachments);
          this.post({ kind: "sendResult", requestId: msg.requestId, ok: true });
          if (result === "queued") {
            void vscode.window.showInformationMessage(hl("sendQueued"));
          }
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
      case "toggleReaction":
        await this.model.toggleReaction(this.channelId, msg.targetId, msg.emoji);
        break;
      case "pickAttachment":
        await this.handlePickAttachment(msg.requestId);
        break;
      case "openAttachment":
        await this.handleOpenAttachment(msg.ulid);
        break;
      case "openLink":
        await this.handleOpenLink(msg.href);
        break;
    }
  }

  private async handlePickAttachment(requestId: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false });
    const files: { ulid: string; name: string; size: number }[] = [];
    if (picked) {
      for (const uri of picked) {
        const data = await fsp.readFile(uri.fsPath);
        const name = path.basename(uri.fsPath);
        if (data.length > this.deps.attachmentMaxBytes) {
          void vscode.window.showErrorMessage(
            hl("attachTooLarge", name, String(this.deps.attachmentMaxBytes)),
          );
          continue;
        }
        const ulid = await this.model.writeAttachment(this.channelId, data, name, mimeFromFilename(name));
        files.push({ ulid, name, size: data.length });
      }
    }
    // キャンセル時も files:[] で応答して Webview のリクエスト待ちを解消する。
    this.post({ kind: "attachmentPicked", requestId, files });
  }

  private async handleOpenAttachment(ulid: string): Promise<void> {
    const stored = this.model.getChannelAttachments(this.channelId)[ulid];
    if (!stored) {
      void vscode.window.showErrorMessage(hl("attachNotFound"));
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: hl("attachSaveTitle"),
      defaultUri: vscode.Uri.file(stored.meta.name),
    });
    if (!target) return;
    // 保存時に SHA-256 検証する(DESIGN.md §4.3)。
    const ok = await verifyAttachment(stored.blobPath, stored.meta.sha256);
    if (!ok) {
      void vscode.window.showErrorMessage(hl("attachVerifyFailed", stored.meta.name));
      return;
    }
    await fsp.copyFile(stored.blobPath, target.fsPath);
    void vscode.window.showInformationMessage(hl("attachSaved", target.fsPath));
  }

  private async handleOpenLink(href: string): Promise<void> {
    // エアギャップ方針: リンクをクリックしてもブラウザは開かない。
    // http(s) のみ、URL 全文をダイアログで提示し、「リンクのコピー」でクリップボードへコピーする。
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(href, true);
    } catch {
      return;
    }
    if (uri.scheme !== "http" && uri.scheme !== "https") return;
    const copyLabel = hl("linkCopy");
    const choice = await vscode.window.showInformationMessage(hl("linkConfirm", href), { modal: true }, copyLabel);
    if (choice === copyLabel) {
      await vscode.env.clipboard.writeText(href);
      void vscode.window.showInformationMessage(hl("linkCopied"));
    }
  }

  private buildAttachmentInfos(): Record<string, AttachmentInfo> {
    const stored = this.model.getChannelAttachments(this.channelId);
    const out: Record<string, AttachmentInfo> = {};
    for (const [ulid, a] of Object.entries(stored)) {
      const uri = this.panel.webview.asWebviewUri(vscode.Uri.file(a.blobPath)).toString();
      out[ulid] = {
        ulid,
        name: a.meta.name,
        mime: a.meta.mime,
        size: a.meta.size,
        uri,
        isImage: this.deps.imageInlinePreview && isInlineImageMime(a.meta.mime),
      };
    }
    return out;
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
      attachments: this.buildAttachmentInfos(),
      selfUserId: this.model.getSelfUserId(),
      l10n: getStrings(lang),
      config: { attachmentMaxBytes: this.deps.attachmentMaxBytes },
    });
    if (this.panel.active) void this.model.markRead(this.channelId);
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
      attachments: this.buildAttachmentInfos(),
    });
    // アクティブ表示中に届いた分は読了にする。
    if (this.panel.active) void this.model.markRead(this.channelId);
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
<div id="search" class="search hidden">
  <input id="search-input" class="search-input" type="text">
  <span id="search-count" class="search-count"></span>
  <button id="search-prev" class="search-btn" title="prev">&#9650;</button>
  <button id="search-next" class="search-btn" title="next">&#9660;</button>
  <button id="search-close" class="search-btn" title="close">&#10005;</button>
</div>
<div id="messages" class="messages" aria-live="polite"></div>
<div id="pending" class="pending hidden"></div>
<div class="composer">
  <button id="attach" class="composer-attach" title="attach">&#128206;</button>
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
.msg { display: flex; gap: 8px; padding: 4px 0; position: relative; }
.msg.reply { margin-left: 28px; }
.msg.pending { opacity: 0.6; }
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
.reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; align-items: center; }
.reaction {
  display: inline-flex; gap: 4px; align-items: center; cursor: pointer;
  border: 1px solid var(--vscode-panel-border); border-radius: 10px;
  padding: 0 6px; font-size: 0.85em; background: var(--vscode-editorWidget-background);
  user-select: none;
}
.reaction:hover { border-color: var(--vscode-focusBorder); }
.reaction.mine { border-color: var(--vscode-focusBorder); background: var(--vscode-editor-selectionBackground); }
/* ホバー時にメッセージ右上へ浮かぶ操作ツールバー(絶対配置なのでレイアウトを動かさない)。 */
.msg-actions {
  position: absolute; top: -2px; right: 8px; z-index: 5;
  display: none; gap: 1px; align-items: center;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px; padding: 2px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}
.msg:hover .msg-actions { display: flex; }
.action-btn {
  background: none; border: none; border-radius: 4px;
  color: var(--vscode-foreground); cursor: pointer;
  font-size: 1em; line-height: 1; padding: 3px 5px;
}
.action-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.thread-toggle {
  margin: 2px 0 2px 36px; cursor: pointer; color: var(--vscode-textLink-foreground);
  font-size: 0.85em; user-select: none;
}
.thread-toggle:hover { text-decoration: underline; }
.reply-composer { display: flex; gap: 6px; margin: 4px 0 8px 36px; }
.reply-composer textarea {
  flex: 1 1 auto; resize: none; font-family: inherit; font-size: inherit;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px;
  padding: 4px 6px;
}
.attachments { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.attachment-image { max-width: 240px; max-height: 200px; border-radius: 4px; cursor: pointer; }
.ext-link { color: var(--vscode-textLink-foreground); text-decoration: underline; cursor: pointer; }
.lightbox {
  position: fixed; inset: 0; z-index: 100;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  background: rgba(0,0,0,0.8); padding: 24px;
}
.lightbox-toolbar { display: flex; gap: 8px; }
.lightbox-btn {
  color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer;
}
.lightbox-btn:hover { background: var(--vscode-button-hoverBackground); }
.lightbox-img {
  max-width: 92vw; max-height: 82vh; object-fit: contain;
  border-radius: 4px; box-shadow: 0 4px 24px rgba(0,0,0,0.5);
}
.attachment-card {
  display: inline-flex; flex-direction: column; cursor: pointer;
  border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px;
  background: var(--vscode-editorWidget-background); max-width: 260px;
}
.attachment-card .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-card .size { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.emoji-picker {
  position: fixed; z-index: 10; display: flex; flex-wrap: wrap; gap: 2px; max-width: 220px;
  background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
  border-radius: 6px; padding: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.emoji-picker button { background: none; border: none; cursor: pointer; font-size: 1.1em; padding: 2px 4px; border-radius: 4px; }
.emoji-picker button:hover { background: var(--vscode-toolbar-hoverBackground); }
.search { display: flex; gap: 4px; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.search.hidden { display: none; }
.search-input {
  flex: 1 1 auto; font-family: inherit; font-size: inherit;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 3px 6px;
}
.search-count { color: var(--vscode-descriptionForeground); font-size: 0.85em; min-width: 48px; text-align: center; }
.search-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 2px 6px; }
.search-btn:hover { background: var(--vscode-toolbar-hoverBackground); border-radius: 4px; }
.msg.search-hit { background: var(--vscode-editor-findMatchHighlightBackground); }
.msg.search-current { background: var(--vscode-editor-findMatchBackground); }
.pending { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 12px; border-top: 1px solid var(--vscode-panel-border); }
.pending.hidden { display: none; }
.pending-chip {
  display: inline-flex; gap: 6px; align-items: center; font-size: 0.85em;
  border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 2px 6px;
  background: var(--vscode-editorWidget-background);
}
.pending-chip button { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; }
.composer-attach {
  flex: 0 0 auto; align-self: flex-end; background: none; border: none; cursor: pointer;
  font-size: 1.2em; padding: 4px 6px; color: var(--vscode-foreground);
}
.composer-attach:hover { background: var(--vscode-toolbar-hoverBackground); border-radius: 4px; }
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
