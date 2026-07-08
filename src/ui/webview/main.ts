// Webview 本体。DESIGN_EXTENSION.md §5・§6・§10。
// - 正状態は Host。ここは投影(ビュー)であり、リデューサは持たない。
// - Markdown は markdown-it(html:false)+ DOMPurify サニタイズ。外部 URL 画像は描画しない。
// - Ctrl+Enter(Cmd+Enter)で送信、Enter は改行。
// - 描画は ULID キーで DOM を突き合わせ、変化した要素のみ再描画する(§6.3)。

import MarkdownIt from "markdown-it";
import DOMPurify, { type Config } from "dompurify";
import type { HostMessage, WebviewMessage } from "../../shared/protocol";
import type { RenderedThread, MessageState } from "../../core/reducer";
import type { UserProfile } from "../../shared/types";

interface VsCodeApi {
  postMessage(msg: WebviewMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// DOMPurify ホワイトリスト(§10 有効記法)。
const SANITIZE_OPTIONS: Config = {
  ALLOWED_TAGS: [
    "p", "br", "strong", "em", "del", "blockquote",
    "ul", "ol", "li", "code", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "a", "hr", "table", "thead", "tbody", "tr", "th", "td", "span",
  ],
  ALLOWED_ATTR: ["href", "title", "class"],
  ALLOW_DATA_ATTR: false,
};

// ---- 状態 ----
let selfUserId = "";
let users: Record<string, UserProfile> = {};
let strings: Record<string, string> = {};
let channelId = "";

function tr(key: string): string {
  return strings[key] ?? key;
}

// ---- DOM 参照 ----
const messagesEl = document.getElementById("messages") as HTMLDivElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendEl = document.getElementById("send") as HTMLButtonElement;

// ULID キーの差分描画用キャッシュ。
const nodeCache = new Map<string, { el: HTMLElement; sig: string }>();

// ---- 受信 ----
window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.kind) {
    case "init":
      selfUserId = msg.selfUserId;
      users = msg.users;
      strings = msg.l10n;
      channelId = msg.channelId;
      vscode.setState({ channelId });
      applyStrings();
      renderThreads(msg.messages);
      break;
    case "channelUpdated":
      users = msg.users;
      renderThreads(msg.messages);
      break;
    case "sendResult":
      // Phase 4 で楽観的 UI(pending/再送)を実装。現状は再読込で反映される。
      break;
    case "attachmentPicked":
      break;
  }
});

function applyStrings(): void {
  inputEl.placeholder = tr("messagePlaceholder");
  sendEl.textContent = tr("send");
}

// ---- 描画(§6.3 差分描画) ----
function renderThreads(threads: RenderedThread[]): void {
  const atBottom = isScrolledToBottom();

  if (threads.length === 0) {
    nodeCache.clear();
    messagesEl.replaceChildren(emptyPlaceholder());
    return;
  }

  // スレッドを描画順(親→返信)に平坦化する。
  const ordered: { msg: MessageState; isReply: boolean }[] = [];
  for (const thread of threads) {
    ordered.push({ msg: thread.parent, isReply: false });
    for (const reply of thread.replies) ordered.push({ msg: reply, isReply: true });
  }

  const seen = new Set<string>();
  const frag = document.createDocumentFragment();
  for (const { msg, isReply } of ordered) {
    seen.add(msg.id);
    const sig = signatureOf(msg, isReply);
    let entry = nodeCache.get(msg.id);
    if (!entry || entry.sig !== sig) {
      const el = createMessageEl(msg, isReply);
      entry = { el, sig };
      nodeCache.set(msg.id, entry);
    }
    frag.appendChild(entry.el);
  }
  // 消えた要素をキャッシュから除去。
  for (const id of [...nodeCache.keys()]) {
    if (!seen.has(id)) nodeCache.delete(id);
  }
  messagesEl.replaceChildren(frag);

  if (atBottom) scrollToBottom();
}

function signatureOf(msg: MessageState, isReply: boolean): string {
  const reactions = msg.reactions.map((r) => `${r.emoji}:${r.users.length}`).join(",");
  return JSON.stringify([msg.body, msg.edited, msg.deleted, isReply, reactions]);
}

function createMessageEl(msg: MessageState, isReply: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = isReply ? "msg reply" : "msg";
  if (msg.author === selfUserId) row.classList.add("own");
  row.dataset.id = msg.id;

  const displayName = users[msg.author]?.displayName || msg.author;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initialsOf(displayName);
  row.appendChild(avatar);

  const main = document.createElement("div");
  main.className = "msg-main";

  const head = document.createElement("div");
  head.className = "msg-head";
  const author = document.createElement("span");
  author.className = "msg-author";
  author.textContent = displayName;
  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime(msg.ts);
  head.appendChild(author);
  head.appendChild(time);
  if (msg.edited && !msg.deleted) {
    const edited = document.createElement("span");
    edited.className = "msg-edited";
    edited.textContent = `(${tr("edited")})`;
    head.appendChild(edited);
  }
  main.appendChild(head);

  const body = document.createElement("div");
  body.className = "msg-body";
  if (msg.deleted) {
    body.classList.add("msg-deleted");
    body.textContent = tr("deletedMessage");
  } else {
    body.innerHTML = renderMarkdown(msg.body);
  }
  main.appendChild(body);

  if (!msg.deleted && msg.reactions.length > 0) {
    const reactions = document.createElement("div");
    reactions.className = "reactions";
    for (const r of msg.reactions) {
      const chip = document.createElement("span");
      chip.className = "reaction";
      chip.textContent = `${r.emoji} ${r.users.length}`;
      reactions.appendChild(chip);
    }
    main.appendChild(reactions);
  }

  row.appendChild(main);
  return row;
}

function renderMarkdown(source: string): string {
  const rawHtml = md.render(source);
  return DOMPurify.sanitize(rawHtml, SANITIZE_OPTIONS) as string;
}

function emptyPlaceholder(): HTMLElement {
  const el = document.createElement("div");
  el.className = "empty";
  el.textContent = tr("emptyChannel");
  return el;
}

function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return [...trimmed][0].toUpperCase();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function isScrolledToBottom(): boolean {
  const threshold = 40;
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
}
function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---- 送信 ----
function send(): void {
  const body = inputEl.value.trim();
  if (!body) return;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const msg: WebviewMessage = { kind: "sendMessage", requestId, body };
  vscode.postMessage(msg);
  inputEl.value = "";
  autoResize();
}

sendEl.addEventListener("click", send);

inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
  // Ctrl+Enter / Cmd+Enter で送信、Enter は改行(§8 キーバインド)。
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener("input", autoResize);

function autoResize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, window.innerHeight * 0.4)}px`;
}

// 本文内リンクのクリックは Phase 2 では抑止する(§10 の openExternal 確認ダイアログは Phase 3)。
messagesEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "A") e.preventDefault();
});

// 初期化要求。
vscode.postMessage({ kind: "ready" } satisfies WebviewMessage);
