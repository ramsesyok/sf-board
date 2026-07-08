// ChatModel: Extension Host 側の正状態を一元管理するシングルトン。
// DESIGN_EXTENSION.md §3(全体アーキテクチャ)。
//
// - store / reducer を用いてチャンネル状態をオンメモリ保持する。
// - Webview からの操作はすべて Host が受けて共有フォルダへ書き込み、
//   書き込み後に再読込して onChannelUpdated で反映する。
// - vscode には依存しない(node:events を使い、単体テスト可能に保つ)。
//   UI 層(vscode)がイベントを購読する。

import { EventEmitter } from "node:events";
import * as store from "../core/store";
import { reduceChannel, buildThreads, type RenderedThread, type MessageState } from "../core/reducer";
import { serializeEvent, type ChatEvent } from "../core/events";
import { monotonicUlidFactory, type Ulid } from "../core/ulid";
import type { ChannelMeta, UserProfile } from "../shared/types";
import type { StoredAttachment } from "../core/store";
import type { LocalCache } from "../core/localCache";

export interface ChannelSummary {
  id: Ulid;
  name: string; // 現在名(channel_renamed 導出後)
  unread: number; // 未読メッセージ数(自分以外・削除除く)
}

/** 書き込み結果。offline 時はローカル送信キューに積まれる。 */
export type WriteResult = "written" | "queued";

export interface ChannelView {
  channelId: Ulid;
  channelName: string;
  threads: RenderedThread[];
}

interface LoadedChannel {
  meta: ChannelMeta;
  view: ChannelView;
  attachments: Record<Ulid, StoredAttachment>;
  /** このチャンネルで観測した最大イベント ID(未読判定の基準)。 */
  latestEventId: Ulid;
  /** 変化検出用シグネチャ(イベント数 + 最終イベント ID)。 */
  signature: string;
}

export interface Disposable {
  dispose(): void;
}

const EVT_CHANNEL_UPDATED = "channelUpdated";
const EVT_CHANNELS_CHANGED = "channelsChanged";

export class ChatModel {
  private readonly emitter = new EventEmitter();
  private readonly ulidGen = monotonicUlidFactory();
  private readonly loaded = new Map<Ulid, LoadedChannel>();
  private users: Record<string, UserProfile> = {};
  private knownChannelIds = new Set<Ulid>();
  private cache: LocalCache | undefined;

  constructor(
    private readonly rootPath: string,
    private readonly selfUserId: string,
  ) {}

  /** ローカルキャッシュ(未読・送信キュー)を設定する。 */
  setLocalCache(cache: LocalCache): void {
    this.cache = cache;
  }

  // ---- イベント購読 ----

  onChannelUpdated(listener: (channelId: Ulid) => void): Disposable {
    this.emitter.on(EVT_CHANNEL_UPDATED, listener);
    return { dispose: () => this.emitter.off(EVT_CHANNEL_UPDATED, listener) };
  }
  onChannelsChanged(listener: () => void): Disposable {
    this.emitter.on(EVT_CHANNELS_CHANGED, listener);
    return { dispose: () => this.emitter.off(EVT_CHANNELS_CHANGED, listener) };
  }

  getSelfUserId(): string {
    return this.selfUserId;
  }
  getUsers(): Record<string, UserProfile> {
    return this.users;
  }

  // ---- 初期化 ----

  /** users/ を読み込み、workspace が無ければ骨組みを作る。self プロフィールを書き込む。 */
  async init(displayName: string): Promise<void> {
    await store.initWorkspace(this.rootPath, "airgap-chat");
    await store.writeUserProfile(this.rootPath, {
      userId: this.selfUserId,
      displayName: displayName || this.selfUserId,
    });
    this.users = await store.readAllUserProfiles(this.rootPath);
  }

  // ---- チャンネル列挙 ----

  /** チャンネル一覧(現在名・未読数込み)を返す。未ロードのものはここでロードする。 */
  async listChannels(): Promise<ChannelSummary[]> {
    const ids = await store.listChannelIds(this.rootPath);
    this.knownChannelIds = new Set(ids);
    const summaries: ChannelSummary[] = [];
    for (const id of ids) {
      const loaded = this.loaded.get(id) ?? (await this.loadChannel(id));
      if (!loaded) continue;
      await this.ensureReadMarker(id, loaded.latestEventId);
      summaries.push({ id, name: loaded.view.channelName, unread: this.computeUnread(id) });
    }
    summaries.sort((a, b) => a.name.localeCompare(b.name));
    return summaries;
  }

  /** 初回発見時は「現時点まで既読」にして、既存履歴を大量未読として表示しない。 */
  private async ensureReadMarker(channelId: Ulid, latestEventId: Ulid): Promise<void> {
    if (!this.cache) return;
    if (this.cache.getReadMarker(channelId) === undefined) {
      await this.cache.setReadMarker(channelId, latestEventId);
    }
  }

  /** 未読数を計算する(最終読了 ULID より後の、自分以外・非削除メッセージ数)。 */
  private computeUnread(channelId: Ulid): number {
    const loaded = this.loaded.get(channelId);
    if (!loaded || !this.cache) return 0;
    const marker = this.cache.getReadMarker(channelId) ?? "";
    let count = 0;
    for (const thread of loaded.view.threads) {
      for (const m of [thread.parent, ...thread.replies]) {
        if (!m.deleted && m.author !== this.selfUserId && m.id > marker) count++;
      }
    }
    return count;
  }

  getUnreadCount(channelId: Ulid): number {
    return this.computeUnread(channelId);
  }

  /** パネルがアクティブになった時点で読了位置を最新へ進める(§7)。 */
  async markRead(channelId: Ulid): Promise<void> {
    if (!this.cache) return;
    const loaded = this.loaded.get(channelId);
    if (!loaded) return;
    if (this.cache.getReadMarker(channelId) !== loaded.latestEventId) {
      await this.cache.setReadMarker(channelId, loaded.latestEventId);
      this.emitter.emit(EVT_CHANNELS_CHANGED);
    }
  }

  // ---- チャンネル読み込み ----

  /** 指定チャンネルの全履歴を読み込み、キャッシュしてビューを返す。 */
  async loadChannel(channelId: Ulid): Promise<LoadedChannel | undefined> {
    const meta = await store.readChannelMeta(this.rootPath, channelId);
    if (!meta) return undefined;
    const events = await store.readChannelEvents(this.rootPath, channelId);
    for (const ev of events) this.ulidGen.observe(ev.id);
    const attachments = await store.listAttachments(this.rootPath, channelId);
    const loaded = this.buildLoaded(meta, events, attachments);
    this.loaded.set(channelId, loaded);
    this.knownChannelIds.add(channelId);
    return loaded;
  }

  /** キャッシュ済みビューを返す(無ければ undefined)。 */
  getChannelView(channelId: Ulid): ChannelView | undefined {
    return this.loaded.get(channelId)?.view;
  }

  /** キャッシュ済みの添付情報(ulid → 情報)を返す。 */
  getChannelAttachments(channelId: Ulid): Record<Ulid, StoredAttachment> {
    return this.loaded.get(channelId)?.attachments ?? {};
  }

  private buildLoaded(
    meta: ChannelMeta,
    events: ChatEvent[],
    attachments: Record<Ulid, StoredAttachment>,
  ): LoadedChannel {
    const state = reduceChannel(events);
    const view: ChannelView = {
      channelId: meta.id,
      channelName: state.channelName ?? meta.name,
      threads: buildThreads(state.messages),
    };
    const last = events.length > 0 ? events.reduce((m, e) => (e.id > m ? e.id : m), events[0].id) : "";
    return { meta, view, attachments, latestEventId: last, signature: `${events.length}|${last}` };
  }

  /** ビュー内(親・返信)からメッセージ状態を ID で検索する。 */
  private findMessage(channelId: Ulid, messageId: Ulid): MessageState | undefined {
    const view = this.loaded.get(channelId)?.view;
    if (!view) return undefined;
    for (const thread of view.threads) {
      if (thread.parent.id === messageId) return thread.parent;
      const reply = thread.replies.find((r) => r.id === messageId);
      if (reply) return reply;
    }
    return undefined;
  }

  // ---- 書き込み操作(Webview からの委譲) ----

  /** メッセージを投稿する。書き込み後に再読込して onChannelUpdated を発火する。 */
  async sendMessage(channelId: Ulid, body: string, threadId?: Ulid, attachments?: Ulid[]): Promise<WriteResult> {
    const event: ChatEvent = {
      id: this.ulidGen.next(),
      type: "message_created",
      ts: new Date().toISOString(),
      author: this.selfUserId,
      body,
      ...(threadId ? { threadId } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    return this.writeEvent(channelId, event);
  }

  /**
   * リアクションをトグルする。現在 self が当該絵文字を付けていれば removed、
   * そうでなければ added を書き込む。DESIGN.md §3。
   */
  async toggleReaction(channelId: Ulid, targetId: Ulid, emoji: string): Promise<WriteResult> {
    const message = this.findMessage(channelId, targetId);
    const already =
      message?.reactions.some((r) => r.emoji === emoji && r.users.includes(this.selfUserId)) ?? false;
    const event: ChatEvent = {
      id: this.ulidGen.next(),
      type: already ? "reaction_removed" : "reaction_added",
      ts: new Date().toISOString(),
      author: this.selfUserId,
      targetId,
      emoji,
    };
    return this.writeEvent(channelId, event);
  }

  /**
   * 添付を共有フォルダへ書き込み、その ulid を返す(DESIGN.md §4.3 手順1〜3)。
   * message_created への添付付与は呼び出し側が sendMessage の attachments で行う(手順4)。
   */
  async writeAttachment(channelId: Ulid, data: Buffer, name: string, mime: string): Promise<Ulid> {
    const ulid = this.ulidGen.next();
    await store.writeAttachment(this.rootPath, channelId, ulid, data, name, mime);
    return ulid;
  }

  /** チャンネルをリネームする(全ユーザー可)。DESIGN_EXTENSION.md §2。 */
  async renameChannel(channelId: Ulid, name: string): Promise<void> {
    const event: ChatEvent = {
      id: this.ulidGen.next(),
      type: "channel_renamed",
      ts: new Date().toISOString(),
      author: this.selfUserId,
      targetId: channelId,
      name,
    };
    await this.writeEvent(channelId, event);
    this.emitter.emit(EVT_CHANNELS_CHANGED);
  }

  /** 新規チャンネルを作成する。 */
  async createChannel(name: string): Promise<Ulid> {
    const channelId = this.ulidGen.next();
    const meta: ChannelMeta = {
      id: channelId,
      name,
      createdBy: this.selfUserId,
      createdAt: new Date().toISOString(),
    };
    await store.createChannelMeta(this.rootPath, meta);
    await this.loadChannel(channelId);
    this.emitter.emit(EVT_CHANNELS_CHANGED);
    return channelId;
  }

  /**
   * イベント追記 → カーソル更新 → 当該チャンネル再読込 → 通知(共通処理)。
   * 共有フォルダへの書き込みに失敗(オフライン等)した場合はローカル送信キューへ積む(§8)。
   */
  private async writeEvent(channelId: Ulid, event: ChatEvent): Promise<WriteResult> {
    // シリアライズ検証も兼ねる(不正イベントは投げる)。
    void serializeEvent(event);
    try {
      await store.appendEvent(this.rootPath, channelId, this.selfUserId, event);
      await store.writeCursor(this.rootPath, this.selfUserId, {
        lastEventId: event.id,
        lastChannelId: channelId,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (this.cache) {
        await this.cache.enqueue({ requestId: event.id, channelId, event });
        return "queued";
      }
      throw err;
    }
    await this.refreshChannel(channelId, true);
    return "written";
  }

  /**
   * ローカル送信キューを共有フォルダへフラッシュする(復帰後)。
   * 失敗した時点で中断し、順序を保ったまま次回に持ち越す。
   */
  async flushQueue(): Promise<void> {
    if (!this.cache) return;
    const queue = [...this.cache.getQueue()];
    const touched = new Set<Ulid>();
    for (const item of queue) {
      try {
        await store.appendEvent(this.rootPath, item.channelId, this.selfUserId, item.event);
        await store.writeCursor(this.rootPath, this.selfUserId, {
          lastEventId: item.event.id,
          lastChannelId: item.channelId,
          updatedAt: new Date().toISOString(),
        });
        await this.cache.removeFromQueue(item.requestId);
        touched.add(item.channelId);
      } catch {
        break; // まだオフライン。順序維持のため中断。
      }
    }
    for (const id of touched) {
      if (this.loaded.has(id)) await this.refreshChannel(id, true);
    }
  }

  // ---- 照合ポーリングからの再読込 ----

  /**
   * ロード済み(=開いている)全チャンネルを再読込し、変化があれば通知する。
   * 新規チャンネルの出現も検出して onChannelsChanged を発火する。
   * ReconcilePoller の onChange から呼ぶ。
   */
  async reconcileAll(): Promise<void> {
    await this.flushQueue(); // 復帰していれば未送信分を先に送る。
    for (const channelId of [...this.loaded.keys()]) {
      await this.refreshChannel(channelId, false);
    }
    const ids = await store.listChannelIds(this.rootPath);
    const changed =
      ids.length !== this.knownChannelIds.size || ids.some((id) => !this.knownChannelIds.has(id));
    if (changed) {
      this.knownChannelIds = new Set(ids);
      this.emitter.emit(EVT_CHANNELS_CHANGED);
    }
  }

  /**
   * 単一チャンネルを再読込する。シグネチャが変わっていれば(または force 時は必ず)
   * ビューを更新し onChannelUpdated を発火する。
   */
  private async refreshChannel(channelId: Ulid, force: boolean): Promise<void> {
    const meta =
      this.loaded.get(channelId)?.meta ?? (await store.readChannelMeta(this.rootPath, channelId));
    if (!meta) return;
    const events = await store.readChannelEvents(this.rootPath, channelId);
    for (const ev of events) this.ulidGen.observe(ev.id);
    const attachments = await store.listAttachments(this.rootPath, channelId);
    const next = this.buildLoaded(meta, events, attachments);
    const prev = this.loaded.get(channelId);
    this.loaded.set(channelId, next);
    if (force || !prev || prev.signature !== next.signature) {
      // ユーザープロフィールも取り込み直す(表示名の更新反映)。
      this.users = await store.readAllUserProfiles(this.rootPath);
      this.emitter.emit(EVT_CHANNEL_UPDATED, channelId);
    }
  }
}
