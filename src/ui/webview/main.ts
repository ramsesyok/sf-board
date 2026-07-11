// Webview 本体。DESIGN_EXTENSION.md §5・§6・§10。
// - 正状態は Host。ここは投影(ビュー)であり、リデューサは持たない。
// - Markdown は markdown-it(html:false)+ DOMPurify サニタイズ。外部 URL 画像は描画しない。
// - Ctrl+Enter(Cmd+Enter)で送信、Enter は改行。Ctrl+F で検索。
// - 描画は ULID キーで DOM を突き合わせ、変化した要素のみ再描画する(§6.3)。

import MarkdownIt from "markdown-it";
import DOMPurify, { type Config } from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import katexPlugin from "@vscode/markdown-it-katex";
import mermaid from "mermaid";
import type { HostMessage, WebviewMessage, AttachmentInfo } from "../../shared/protocol";
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

// コードフェンスのシンタックスハイライト(highlight.js common)。§10。
// 出力は <span class="hljs-*"> で、DOMPurify のホワイトリスト(span/class)を通過する。
md.set({
  highlight: (str, lang): string => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const html = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        return `<pre class="hljs"><code>${html}</code></pre>`;
      } catch {
        /* フォールバックへ */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

// 数式($...$ / $$...$$ / ```math)と mermaid(```mermaid)は「プレースホルダ span」に描画し、
// サニタイズ後に KaTeX / mermaid で実描画する(§10)。KaTeX/mermaid の出力は複雑な span/SVG/
// inline style を含み厳格な DOMPurify を通せないが、いずれも自前で安全な HTML を生成する
// (KaTeX は trust:false で XSS 安全、mermaid は securityLevel:strict)ため、サニタイズ後に差し込む。
// プレースホルダは span + class + エスケープ済みテキストのみで、既存の DOMPurify 設定を通過する。
md.use(katexPlugin);
function mathPlaceholder(tex: string, display: boolean): string {
  return `<span class="math-src${display ? " math-display" : ""}">${md.utils.escapeHtml(tex)}</span>`;
}
md.renderer.rules.math_inline = (t, i) => mathPlaceholder(t[i].content, false);
md.renderer.rules.math_block = (t, i) => mathPlaceholder(t[i].content, true);
md.renderer.rules.math_inline_block = (t, i) => mathPlaceholder(t[i].content, true);
md.renderer.rules.math_inline_bare_block = (t, i) => mathPlaceholder(t[i].content, true);

// mermaid と ```math フェンスはプレースホルダに。それ以外は既定(=ハイライト)へ委譲。
const prevFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = (tokens[idx].info || "").trim().split(/\s+/)[0];
  if (info === "mermaid") return `<span class="mermaid-src">${md.utils.escapeHtml(tokens[idx].content)}</span>`;
  if (info === "math") return mathPlaceholder(tokens[idx].content, true);
  return prevFence ? prevFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};

// mermaid 初期化(テーマは VS Code に追従、strict でスクリプト無効)。
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: document.body.classList.contains("vscode-light") ? "default" : "dark",
  fontFamily: "inherit",
});
let mermaidSeq = 0;

// プレースホルダを KaTeX / mermaid で実描画する(サニタイズ後に呼ぶ)。
async function renderMathAndDiagrams(container: HTMLElement): Promise<void> {
  for (const el of container.querySelectorAll<HTMLElement>(".math-src")) {
    const tex = el.textContent ?? "";
    try {
      // KaTeX 出力(trust:false)は安全なため innerHTML に直接差し込む。
      el.innerHTML = katex.renderToString(tex, {
        displayMode: el.classList.contains("math-display"),
        throwOnError: false,
        output: "htmlAndMathml",
      });
    } catch {
      el.textContent = tex;
    }
    el.classList.remove("math-src");
  }
  for (const el of [...container.querySelectorAll<HTMLElement>(".mermaid-src")]) {
    const code = el.textContent ?? "";
    try {
      const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, code);
      el.innerHTML = svg; // mermaid(securityLevel:strict)がサニタイズ済み。
      el.classList.remove("mermaid-src");
      el.classList.add("mermaid-rendered");
    } catch (err) {
      el.classList.add("mermaid-error");
      el.textContent = err instanceof Error ? err.message : String(err);
    }
  }
}

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

// 絵文字ピッカーの定義済みセット(§6.1)。外部ライブラリは使わない。
// ビジネス用途向け: 肯定・否定/反対・確認/注意をバランスよく含める(ファンシー系は除外)。
const EMOJI_SET = [
  "👍", "👎", "✅", "❌", "🙏", "🙌", "👏", "👌",
  "🎉", "🔥", "💯", "👀", "🤔", "😮", "⚠️", "🙅",
  "🚀", "⭐",
];

// ホバーツールバーのクイックリアクション(ワンクリック用)。EMOJI_SET の一部。
const QUICK_REACTIONS = ["👍", "✅", "👀"];

// ---- 状態 ----
let selfUserId = "";
let users: Record<string, UserProfile> = {};
let attachments: Record<string, AttachmentInfo> = {};
let strings: Record<string, string> = {};
let channelId = "";
let channelName = "";
let threadMode = false; // config.threadDisplay === "thread"
let openThreadId: string | undefined; // スレッドペインで開いている親メッセージ ID
let currentThreads: RenderedThread[] = [];
const expandedThreads = new Set<string>(); // 展開中の親メッセージ ID
const replyDrafts = new Map<string, string>(); // 親 ID → 返信ドラフト本文
let pendingAttachments: { ulid: string; name: string; size: number }[] = [];

// 楽観的 UI(§6.4): 送信直後に半透明で即時表示し、正規メッセージ到着で除去する。
interface PendingMsg {
  requestId: string;
  body: string;
  threadId?: string;
  ts: string;
  state: "pending" | "error";
}
let pendingMessages: PendingMsg[] = [];
const claimedRealIds = new Set<string>(); // pending と突合済みの正規メッセージ ID

function tr(key: string): string {
  return strings[key] ?? key;
}
function fmt(key: string, ...args: string[]): string {
  return tr(key).replace(/\{(\d+)\}/g, (_m, i) => args[Number(i)] ?? "");
}

// ---- DOM 参照 ----
const messagesEl = document.getElementById("messages") as HTMLDivElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendEl = document.getElementById("send") as HTMLButtonElement;
const attachEl = document.getElementById("attach") as HTMLButtonElement;
const pendingEl = document.getElementById("pending") as HTMLDivElement;
const searchEl = document.getElementById("search") as HTMLDivElement;
const searchInputEl = document.getElementById("search-input") as HTMLInputElement;
const searchCountEl = document.getElementById("search-count") as HTMLSpanElement;
const threadColEl = document.getElementById("thread-col") as HTMLDivElement;
const threadTitleEl = document.getElementById("thread-title") as HTMLSpanElement;
const threadSubEl = document.getElementById("thread-sub") as HTMLSpanElement;
const threadBodyEl = document.getElementById("thread-body") as HTMLDivElement;
const threadInputEl = document.getElementById("thread-input") as HTMLTextAreaElement;
const threadSendEl = document.getElementById("thread-send") as HTMLButtonElement;
const threadCloseEl = document.getElementById("thread-close") as HTMLButtonElement;

// ULID キーの差分描画用キャッシュ(メッセージ要素のみ)。
const nodeCache = new Map<string, { el: HTMLElement; sig: string }>();

// ---- 受信 ----
window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.kind) {
    case "init":
      selfUserId = msg.selfUserId;
      users = msg.users;
      attachments = msg.attachments;
      strings = msg.l10n;
      channelId = msg.channelId;
      channelName = msg.channelName;
      threadMode = msg.config.threadDisplay === "thread";
      vscode.setState({ channelId });
      applyStrings();
      currentThreads = msg.messages;
      render();
      break;
    case "channelUpdated":
      users = msg.users;
      attachments = msg.attachments;
      channelName = msg.channelName;
      currentThreads = msg.messages;
      claimPending();
      render();
      break;
    case "sendResult":
      if (!msg.ok) {
        const p = pendingMessages.find((x) => x.requestId === msg.requestId);
        if (p) {
          p.state = "error";
          render();
        }
      }
      // ok の場合は次の channelUpdated で正規メッセージと突合して除去する。
      break;
    case "attachmentPicked":
      for (const f of msg.files) pendingAttachments.push(f);
      renderPending();
      break;
  }
});

function applyStrings(): void {
  inputEl.placeholder = tr("messagePlaceholder");
  sendEl.textContent = tr("send");
  attachEl.title = tr("attach");
  searchInputEl.placeholder = tr("searchPlaceholder");
  threadInputEl.placeholder = tr("replyPlaceholder");
  threadSendEl.textContent = tr("send");
  threadCloseEl.title = tr("close");
}

// ---- 描画(§6.3 差分描画: メッセージ要素はキャッシュ再利用) ----
function render(): void {
  const atBottom = isScrolledToBottom();

  if (currentThreads.length === 0 && pendingMessages.length === 0) {
    nodeCache.clear();
    messagesEl.replaceChildren(emptyPlaceholder());
    return;
  }

  const seen = new Set<string>();
  const frag = document.createDocumentFragment();

  for (const thread of currentThreads) {
    frag.appendChild(getMessageEl(thread.parent, false, seen));
    const replyCount = thread.replies.length;

    if (threadMode) {
      // スレッド形式: 返信はタイムラインに出さず、サマリのみ表示(クリックでペイン)。
      if (replyCount > 0) frag.appendChild(replySummary(thread));
    } else {
      // インライン形式: 従来どおり親の下に折りたたみ展開。
      const expanded = expandedThreads.has(thread.parent.id);
      if (replyCount > 0) {
        frag.appendChild(threadToggle(thread.parent.id, replyCount, expanded));
      }
      if (expanded) {
        for (const reply of thread.replies) {
          frag.appendChild(getMessageEl(reply, true, seen));
        }
        for (const p of pendingMessages.filter((x) => x.threadId === thread.parent.id)) {
          frag.appendChild(createPendingEl(p, true));
        }
        frag.appendChild(replyComposer(thread.parent.id));
      }
    }
  }

  // トップレベルの pending は最下部にまとめて表示。
  for (const p of pendingMessages.filter((x) => x.threadId === undefined)) {
    frag.appendChild(createPendingEl(p, false));
  }

  for (const id of [...nodeCache.keys()]) {
    if (!seen.has(id)) nodeCache.delete(id);
  }
  messagesEl.replaceChildren(frag);
  applySearchHighlights();
  if (atBottom) scrollToBottom();

  if (threadMode) renderThreadPanel();
}

// ---- スレッドペイン(スレッド形式) ----
// タイムライン上の返信サマリ(クリックでペインを開く)。
function replySummary(thread: RenderedThread): HTMLElement {
  const el = document.createElement("div");
  el.className = "reply-summary";
  el.addEventListener("click", () => openThread(thread.parent.id));

  const avatarsWrap = document.createElement("span");
  avatarsWrap.className = "avatars";
  const seenAuthors = new Set<string>();
  for (const r of thread.replies) {
    if (seenAuthors.has(r.author)) continue;
    seenAuthors.add(r.author);
    if (seenAuthors.size > 3) break;
    const av = document.createElement("span");
    av.className = "avatar";
    const dn = users[r.author]?.displayName || r.author;
    av.textContent = initialsOf(dn);
    paintAvatar(av, r.author);
    avatarsWrap.appendChild(av);
  }
  el.appendChild(avatarsWrap);

  el.appendChild(span("count", `${thread.replies.length} ${tr("replies")}`));

  const last = thread.replies[thread.replies.length - 1];
  if (last) el.appendChild(span("last", `· ${fmt("lastReply", formatTime(last.ts))}`));
  return el;
}

function openThread(parentId: string): void {
  openThreadId = parentId;
  renderThreadPanel();
  threadInputEl.focus();
}
function closeThread(): void {
  openThreadId = undefined;
  threadColEl.classList.add("hidden");
}

function renderThreadPanel(): void {
  if (!threadMode || !openThreadId) {
    threadColEl.classList.add("hidden");
    return;
  }
  const thread = currentThreads.find((t) => t.parent.id === openThreadId);
  if (!thread) {
    closeThread();
    return;
  }
  threadColEl.classList.remove("hidden");
  threadTitleEl.textContent = tr("thread");
  threadSubEl.textContent = `# ${channelName}`;

  const atBottom = threadBodyEl.scrollHeight - threadBodyEl.scrollTop - threadBodyEl.clientHeight < 40;
  const frag = document.createDocumentFragment();
  frag.appendChild(createMessageEl(thread.parent, false));

  const divider = document.createElement("div");
  divider.className = "thread-divider";
  divider.textContent = `${thread.replies.length} ${tr("replies")}`;
  frag.appendChild(divider);

  for (const reply of thread.replies) frag.appendChild(createMessageEl(reply, true));
  for (const p of pendingMessages.filter((x) => x.threadId === openThreadId)) {
    frag.appendChild(createPendingEl(p, true));
  }
  threadBodyEl.replaceChildren(frag);
  threadInputEl.value = replyDrafts.get(openThreadId) ?? "";
  if (atBottom) threadBodyEl.scrollTop = threadBodyEl.scrollHeight;
}

function submitThreadReply(): void {
  if (!openThreadId) return;
  const body = threadInputEl.value.trim();
  if (!body) return;
  const requestId = newRequestId();
  postMsg({ kind: "sendMessage", requestId, body, threadId: openThreadId });
  pendingMessages.push({ requestId, body, threadId: openThreadId, ts: new Date().toISOString(), state: "pending" });
  replyDrafts.delete(openThreadId);
  threadInputEl.value = "";
  renderThreadPanel();
}

threadSendEl.addEventListener("click", submitThreadReply);
threadCloseEl.addEventListener("click", closeThread);
threadInputEl.addEventListener("input", () => {
  if (openThreadId) replyDrafts.set(openThreadId, threadInputEl.value);
});
threadInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submitThreadReply();
  }
});

// ---- 楽観的 UI ----
function claimPending(): void {
  const remaining: PendingMsg[] = [];
  for (const p of pendingMessages) {
    const match = findSelfUnclaimed(p.body, p.threadId);
    if (match) claimedRealIds.add(match);
    else remaining.push(p);
  }
  pendingMessages = remaining;
}

function findSelfUnclaimed(body: string, threadId: string | undefined): string | undefined {
  for (const thread of currentThreads) {
    const candidates = threadId === undefined ? [thread.parent] : thread.replies;
    for (const m of candidates) {
      if (threadId !== undefined && thread.parent.id !== threadId) continue;
      if (m.author === selfUserId && m.body === body && !m.deleted && !claimedRealIds.has(m.id)) {
        return m.id;
      }
    }
  }
  return undefined;
}

function createPendingEl(p: PendingMsg, isReply: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = isReply ? "msg reply pending own" : "msg pending own";
  const displayName = users[selfUserId]?.displayName || selfUserId;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initialsOf(displayName);
  paintAvatar(avatar, selfUserId);
  row.appendChild(avatar);

  const main = document.createElement("div");
  main.className = "msg-main";
  const head = document.createElement("div");
  head.className = "msg-head";
  head.appendChild(span("msg-author", displayName));
  head.appendChild(span("msg-time", p.state === "error" ? tr("sendFailed") : tr("pending")));
  main.appendChild(head);

  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = renderMarkdown(p.body);
  neutralizeLinks(body);
  decorateMentions(body);
  void renderMathAndDiagrams(body);
  main.appendChild(body);

  if (p.state === "error") {
    const resend = document.createElement("button");
    resend.className = "action-btn";
    resend.textContent = tr("resend");
    resend.addEventListener("click", () => {
      p.state = "pending";
      postMsg({ kind: "sendMessage", requestId: p.requestId, body: p.body, ...(p.threadId ? { threadId: p.threadId } : {}) });
      render();
    });
    main.appendChild(resend);
  }
  row.appendChild(main);
  return row;
}

function getMessageEl(msg: MessageState, isReply: boolean, seen: Set<string>): HTMLElement {
  seen.add(msg.id);
  const sig = signatureOf(msg, isReply);
  let entry = nodeCache.get(msg.id);
  if (!entry || entry.sig !== sig) {
    entry = { el: createMessageEl(msg, isReply), sig };
    nodeCache.set(msg.id, entry);
  }
  return entry.el;
}

function signatureOf(msg: MessageState, isReply: boolean): string {
  const reactions = msg.reactions
    .map((r) => `${r.emoji}:${r.users.length}:${r.users.includes(selfUserId) ? 1 : 0}`)
    .join(",");
  const atts = msg.attachments.map((u) => `${u}:${attachments[u]?.uri ?? ""}`).join(",");
  return JSON.stringify([msg.body, msg.edited, msg.deleted, isReply, reactions, atts]);
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
  paintAvatar(avatar, msg.author);
  row.appendChild(avatar);

  const main = document.createElement("div");
  main.className = "msg-main";

  const head = document.createElement("div");
  head.className = "msg-head";
  head.appendChild(span("msg-author", displayName));
  head.appendChild(span("msg-time", formatTime(msg.ts)));
  if (msg.edited && !msg.deleted) head.appendChild(span("msg-edited", `(${tr("edited")})`));
  main.appendChild(head);

  const body = document.createElement("div");
  body.className = "msg-body";
  if (msg.deleted) {
    body.classList.add("msg-deleted");
    body.textContent = tr("deletedMessage");
  } else {
    body.innerHTML = renderMarkdown(msg.body);
    neutralizeLinks(body);
    decorateMentions(body);
    void renderMathAndDiagrams(body);
  }
  main.appendChild(body);

  if (!msg.deleted && msg.attachments.length > 0) {
    main.appendChild(renderAttachments(msg.attachments));
  }
  if (!msg.deleted) {
    main.appendChild(renderReactions(msg));
    main.appendChild(renderActions(msg, isReply));
  }

  row.appendChild(main);
  return row;
}

function renderAttachments(ulids: string[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "attachments";
  for (const ulid of ulids) {
    const info = attachments[ulid];
    if (!info) continue; // まだ読み込まれていない添付はスキップ。
    if (info.isImage) {
      const img = document.createElement("img");
      img.className = "attachment-image";
      img.src = info.uri;
      img.alt = info.name;
      img.title = info.name;
      // サムネイルクリックでライトボックス表示(拡大)。ダウンロードは拡大画像から行う。
      img.addEventListener("click", () => openLightbox(ulid));
      wrap.appendChild(img);
    } else {
      const card = document.createElement("div");
      card.className = "attachment-card";
      card.appendChild(span("name", info.name));
      card.appendChild(span("size", formatBytes(info.size)));
      card.addEventListener("click", () => postMsg({ kind: "openAttachment", ulid }));
      wrap.appendChild(card);
    }
  }
  return wrap;
}

function renderReactions(msg: MessageState): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "reactions";
  for (const r of msg.reactions) {
    const chip = document.createElement("span");
    chip.className = "reaction";
    if (r.users.includes(selfUserId)) chip.classList.add("mine");
    chip.textContent = `${r.emoji} ${r.users.length}`;
    chip.title = r.users.map((u) => users[u]?.displayName || u).join(", ");
    chip.addEventListener("click", () => postMsg({ kind: "toggleReaction", targetId: msg.id, emoji: r.emoji }));
    wrap.appendChild(chip);
  }
  return wrap;
}

function renderActions(msg: MessageState, isReply: boolean): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  // クイックリアクション(ワンクリックでトグル)。
  for (const emoji of QUICK_REACTIONS) {
    const b = document.createElement("button");
    b.className = "action-btn";
    b.textContent = emoji;
    b.addEventListener("click", () => postMsg({ kind: "toggleReaction", targetId: msg.id, emoji }));
    actions.appendChild(b);
  }

  // 追加リアクション(絵文字ピッカーを開く)。
  const more = document.createElement("button");
  more.className = "action-btn";
  more.textContent = "＋";
  more.title = tr("addReaction");
  more.addEventListener("click", (e) => openEmojiPicker(msg.id, e.currentTarget as HTMLElement));
  actions.appendChild(more);

  // 返信(親メッセージのみ)。
  if (!isReply) {
    const reply = document.createElement("button");
    reply.className = "action-btn";
    reply.textContent = "↩";
    reply.title = threadMode ? tr("replyInThread") : tr("reply");
    reply.addEventListener("click", () => {
      if (threadMode) {
        openThread(msg.id);
      } else {
        expandedThreads.add(msg.id);
        render();
        focusReplyComposer(msg.id);
      }
    });
    actions.appendChild(reply);
  }
  return actions;
}

// ---- スレッド ----
function threadToggle(parentId: string, count: number, expanded: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = "thread-toggle";
  el.textContent = expanded ? `▾ ${tr("hideReplies")}` : `▸ ${count} ${tr("replies")}`;
  el.addEventListener("click", () => {
    if (expanded) expandedThreads.delete(parentId);
    else expandedThreads.add(parentId);
    render();
  });
  return el;
}

function replyComposer(parentId: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "reply-composer";
  const ta = document.createElement("textarea");
  ta.rows = 1;
  ta.placeholder = tr("replyPlaceholder");
  ta.value = replyDrafts.get(parentId) ?? "";
  ta.dataset.parent = parentId;
  ta.addEventListener("input", () => replyDrafts.set(parentId, ta.value));
  const submit = (): void => {
    const body = ta.value.trim();
    if (!body) return;
    const requestId = newRequestId();
    postMsg({ kind: "sendMessage", requestId, body, threadId: parentId });
    pendingMessages.push({ requestId, body, threadId: parentId, ts: new Date().toISOString(), state: "pending" });
    replyDrafts.delete(parentId);
    ta.value = "";
    render();
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  });
  const btn = document.createElement("button");
  btn.className = "action-btn";
  btn.textContent = tr("send");
  btn.addEventListener("click", submit);
  wrap.appendChild(ta);
  wrap.appendChild(btn);
  return wrap;
}

function focusReplyComposer(parentId: string): void {
  const ta = messagesEl.querySelector<HTMLTextAreaElement>(`textarea[data-parent="${parentId}"]`);
  ta?.focus();
}

// ---- 絵文字ピッカー ----
let openPicker: HTMLElement | undefined;
function openEmojiPicker(targetId: string, anchor: HTMLElement): void {
  closeEmojiPicker();
  const picker = document.createElement("div");
  picker.className = "emoji-picker";
  for (const emoji of EMOJI_SET) {
    const b = document.createElement("button");
    b.textContent = emoji;
    b.addEventListener("click", () => {
      postMsg({ kind: "toggleReaction", targetId, emoji });
      closeEmojiPicker();
    });
    picker.appendChild(b);
  }
  document.body.appendChild(picker);
  const rect = anchor.getBoundingClientRect();
  picker.style.left = `${Math.min(rect.left, window.innerWidth - 230)}px`;
  picker.style.top = `${Math.max(4, rect.top - picker.offsetHeight - 4)}px`;
  openPicker = picker;
}
function closeEmojiPicker(): void {
  openPicker?.remove();
  openPicker = undefined;
}
document.addEventListener("click", (e) => {
  if (openPicker && !openPicker.contains(e.target as Node) && !(e.target as HTMLElement).classList.contains("action-btn")) {
    closeEmojiPicker();
  }
});

// ---- 添付(送信前 pending) ----
function renderPending(): void {
  pendingEl.replaceChildren();
  if (pendingAttachments.length === 0) {
    pendingEl.classList.add("hidden");
    return;
  }
  pendingEl.classList.remove("hidden");
  pendingAttachments.forEach((a, idx) => {
    const chip = document.createElement("span");
    chip.className = "pending-chip";
    chip.appendChild(span("", `${a.name} (${formatBytes(a.size)})`));
    const x = document.createElement("button");
    x.textContent = "✕";
    x.addEventListener("click", () => {
      pendingAttachments.splice(idx, 1);
      renderPending();
    });
    chip.appendChild(x);
    pendingEl.appendChild(chip);
  });
}

attachEl.addEventListener("click", () => postMsg({ kind: "pickAttachment", requestId: newRequestId() }));

// ---- 検索(§6.2) ----
interface SearchState { hits: string[]; index: number; }
let search: SearchState = { hits: [], index: 0 };

function openSearch(): void {
  searchEl.classList.remove("hidden");
  searchInputEl.focus();
  searchInputEl.select();
}
function closeSearch(): void {
  searchEl.classList.add("hidden");
  searchInputEl.value = "";
  search = { hits: [], index: 0 };
  searchCountEl.textContent = "";
  applySearchHighlights();
}
function recomputeSearch(): void {
  const q = searchInputEl.value.trim().toLowerCase();
  if (!q) {
    search = { hits: [], index: 0 };
    searchCountEl.textContent = "";
    applySearchHighlights();
    return;
  }
  const hits: string[] = [];
  for (const thread of currentThreads) {
    const all = [thread.parent, ...thread.replies];
    for (const m of all) {
      if (!m.deleted && m.body.toLowerCase().includes(q)) hits.push(m.id);
    }
  }
  search = { hits, index: 0 };
  updateSearchCount();
  jumpToCurrent();
}
function updateSearchCount(): void {
  searchCountEl.textContent = search.hits.length === 0 ? tr("searchNoHits") : fmt("searchCount", String(search.index + 1), String(search.hits.length));
}
function jumpToCurrent(): void {
  if (search.hits.length === 0) {
    applySearchHighlights();
    return;
  }
  const id = search.hits[search.index];
  // 折りたたまれたスレッド内の返信なら親を展開する。
  const parentId = parentOf(id);
  if (parentId && !expandedThreads.has(parentId)) {
    expandedThreads.add(parentId);
    render();
  } else {
    applySearchHighlights();
  }
  const el = messagesEl.querySelector<HTMLElement>(`.msg[data-id="${id}"]`);
  el?.scrollIntoView({ block: "center" });
}
function parentOf(messageId: string): string | undefined {
  for (const thread of currentThreads) {
    if (thread.parent.id === messageId) return undefined; // 親自身
    if (thread.replies.some((r) => r.id === messageId)) return thread.parent.id;
  }
  return undefined;
}
function applySearchHighlights(): void {
  for (const el of messagesEl.querySelectorAll(".msg")) {
    el.classList.remove("search-hit", "search-current");
  }
  search.hits.forEach((id, i) => {
    const el = messagesEl.querySelector<HTMLElement>(`.msg[data-id="${id}"]`);
    if (!el) return;
    el.classList.add(i === search.index ? "search-current" : "search-hit");
  });
}
function nextHit(dir: number): void {
  if (search.hits.length === 0) return;
  search.index = (search.index + dir + search.hits.length) % search.hits.length;
  updateSearchCount();
  jumpToCurrent();
}

searchInputEl.addEventListener("input", recomputeSearch);
searchInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    nextHit(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  }
});
(document.getElementById("search-next") as HTMLButtonElement).addEventListener("click", () => nextHit(1));
(document.getElementById("search-prev") as HTMLButtonElement).addEventListener("click", () => nextHit(-1));
(document.getElementById("search-close") as HTMLButtonElement).addEventListener("click", closeSearch);

// ---- Markdown / ユーティリティ ----
function renderMarkdown(source: string): string {
  const rawHtml = md.render(source);
  return DOMPurify.sanitize(rawHtml, SANITIZE_OPTIONS) as unknown as string;
}

// 本文リンクの href を除去して data-href に退避する。
// VS Code の webview は href 付きリンクのクリックで外部ブラウザを開こうとするため、
// href を消して自動遷移を防ぎ、クリックは委譲ハンドラで処理する(→ Host のコピー用ダイアログ)。
function neutralizeLinks(container: HTMLElement): void {
  for (const a of container.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    a.setAttribute("data-href", href);
    a.removeAttribute("href");
    a.classList.add("ext-link");
    if (!a.getAttribute("title")) a.setAttribute("title", href);
  }
}

// 本文中の @userId を装飾する(§14: ハイライトのみ・通知なし)。
// 既知ユーザー(users に存在)のみ対象。表示は @userId のまま、hover(title)で表示名。
// コード/リンク内は対象外。テキストノードを走査して安全に置換する。
const MENTION_RE = /@([A-Za-z0-9_-]+)/g;
function decorateMentions(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node): number {
      const parent = (node as Text).parentElement;
      if (!parent || parent.closest("code, pre, a, .mention")) return NodeFilter.FILTER_REJECT;
      return /@[A-Za-z0-9_-]+/.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text);
  for (const textNode of targets) replaceMentionsInTextNode(textNode);
}

function replaceMentionsInTextNode(textNode: Text): void {
  const text = textNode.nodeValue ?? "";
  MENTION_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let lastIndex = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const id = m[1];
    const user = users[id];
    if (!user) continue; // 既知ユーザーのみ装飾。未知の @token は素通し。
    matched = true;
    if (m.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
    const span = document.createElement("span");
    span.className = id === selfUserId ? "mention mention-self" : "mention";
    span.textContent = `@${id}`;
    span.title = user.displayName || id;
    frag.appendChild(span);
    lastIndex = m.index + m[0].length;
  }
  if (!matched) return;
  if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
  textNode.parentNode?.replaceChild(frag, textNode);
}

// ---- ライトボックス(画像拡大表示) ----
let lightboxEl: HTMLElement | undefined;
function openLightbox(ulid: string): void {
  const info = attachments[ulid];
  if (!info) return;
  closeLightbox();

  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeLightbox(); // 背景クリックで閉じる
  });

  const toolbar = document.createElement("div");
  toolbar.className = "lightbox-toolbar";
  const dl = document.createElement("button");
  dl.className = "lightbox-btn";
  dl.textContent = tr("download");
  dl.addEventListener("click", () => postMsg({ kind: "openAttachment", ulid }));
  const close = document.createElement("button");
  close.className = "lightbox-btn";
  close.textContent = tr("close");
  close.addEventListener("click", closeLightbox);
  toolbar.appendChild(dl);
  toolbar.appendChild(close);

  const img = document.createElement("img");
  img.className = "lightbox-img";
  img.src = info.uri;
  img.alt = info.name;

  overlay.appendChild(toolbar);
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  lightboxEl = overlay;
}
function closeLightbox(): void {
  lightboxEl?.remove();
  lightboxEl = undefined;
}
function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  if (cls) el.className = cls;
  el.textContent = text;
  return el;
}
function emptyPlaceholder(): HTMLElement {
  const el = document.createElement("div");
  el.className = "empty";
  el.textContent = tr("emptyChannel");
  return el;
}
function initialsOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0].toUpperCase() : "?";
}

// アバターに、userId から決定的に導出したパステル背景色を適用する。
// 同一ユーザーは常に同じ色になり、ユーザー間の判別がつきやすくなる(カスタマイズ不要)。
function paintAvatar(avatar: HTMLElement, userId: string): void {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  avatar.style.backgroundColor = `hsl(${hue}, 70%, 82%)`; // パステル
  avatar.style.color = `hsl(${hue}, 50%, 28%)`; // 同系の濃色で可読性を確保
}
function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function isScrolledToBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
}
function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function postMsg(msg: WebviewMessage): void {
  vscode.postMessage(msg);
}
function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---- メイン送信 ----
function send(): void {
  const body = inputEl.value.trim();
  const atts = pendingAttachments.map((a) => a.ulid);
  if (!body && atts.length === 0) return;
  const requestId = newRequestId();
  postMsg({
    kind: "sendMessage",
    requestId,
    body,
    ...(atts.length > 0 ? { attachments: atts } : {}),
  });
  // 楽観表示は本文のみのメッセージに限定(添付付きは突合が曖昧になるため次回更新で反映)。
  if (body && atts.length === 0) {
    pendingMessages.push({ requestId, body, ts: new Date().toISOString(), state: "pending" });
  }
  inputEl.value = "";
  pendingAttachments = [];
  renderPending();
  render();
  autoResize();
}
sendEl.addEventListener("click", send);
inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
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

// Ctrl+F / Cmd+F で検索バー(§8: Webview 内でキーを奪う)。Esc でライトボックスを閉じる。
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    openSearch();
  } else if (e.key === "Escape" && lightboxEl) {
    e.preventDefault();
    closeLightbox();
  }
});

// 本文内リンクのクリックは Host へ委譲(ブラウザは開かず、コピー用ダイアログを表示)。
// href は neutralizeLinks で data-href に退避済み(自動遷移防止)。
messagesEl.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement).closest("a");
  if (anchor) {
    e.preventDefault();
    const href = anchor.getAttribute("data-href");
    if (href) postMsg({ kind: "openLink", href });
  }
});

// 初期化要求。
postMsg({ kind: "ready" });
