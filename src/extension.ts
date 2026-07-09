// 拡張エントリポイント。activate/deactivate、設定読み込み、各コンポーネントの配線。
// DESIGN.md §5〜§8 / DESIGN_EXTENSION.md §3・§4・§8。

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { ChatModel } from "./model/chatModel";
import { SyncEngine } from "./core/sync";
import { LocalCache } from "./core/localCache";
import { ChannelTreeProvider, ChannelItem } from "./ui/channelTree";
import { PanelManager } from "./ui/panelManager";
import { CHANNEL_VIEW_TYPE } from "./ui/chatPanel";
import {
  OPEN_CHANNEL_COMMAND,
  CREATE_CHANNEL_COMMAND,
  RENAME_CHANNEL_COMMAND,
  REFRESH_COMMAND,
  SETUP_COMMAND,
  SHOW_DIAGNOSTICS_COMMAND,
  CHANNELS_VIEW_ID,
} from "./ui/commandIds";
import { hl } from "./host/hostL10n";
import { OutputChannelDiagnosticsLogger } from "./host/diagnosticsLogger";
import type { DiagnosticsLogger } from "./core/diagnostics";

const CONFIG_SECTION = "airgapChat";

/** 同期診断ロガー(activate で 1 度だけ生成。無効時は書き込まない)。 */
let diagnosticsLogger: DiagnosticsLogger | undefined;

interface Runtime {
  model: ChatModel;
  sync: SyncEngine;
  tree: ChannelTreeProvider;
  panels: PanelManager;
  disposables: vscode.Disposable[];
}

let runtime: Runtime | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 同期診断ログの出力チャネル(LogOutputChannel)。診断有効時のみ書き込む。
  const logChannel = vscode.window.createOutputChannel("Airgap Chat", { log: true });
  context.subscriptions.push(logChannel);
  diagnosticsLogger = new OutputChannelDiagnosticsLogger(
    logChannel,
    () => vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("diagnostics.enabled") ?? false,
  );

  // コマンドは常時登録する(setup は rootPath 未設定でも使えるように)。
  context.subscriptions.push(
    vscode.commands.registerCommand(SETUP_COMMAND, () => runSetup()),
    vscode.commands.registerCommand(OPEN_CHANNEL_COMMAND, (channelId: string) => {
      void runtime?.panels.open(channelId);
    }),
    vscode.commands.registerCommand(CREATE_CHANNEL_COMMAND, () => runCreateChannel()),
    vscode.commands.registerCommand(RENAME_CHANNEL_COMMAND, (item?: ChannelItem) => runRenameChannel(item)),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      void runtime?.sync.checkNow();
      runtime?.tree.refresh();
    }),
    vscode.commands.registerCommand(SHOW_DIAGNOSTICS_COMMAND, () => logChannel.show()),
  );

  // パネル復元(VSCode 再起動後にタブを再初期化)。DESIGN_EXTENSION.md §4。
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(CHANNEL_VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        const channelId =
          state && typeof state === "object" && "channelId" in state
            ? String((state as { channelId: unknown }).channelId)
            : undefined;
        if (runtime && channelId) {
          await runtime.panels.adopt(panel, channelId);
        } else {
          panel.dispose();
        }
      },
    }),
  );

  // 設定変更(rootPath 等)で再初期化する。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) void reinitialize(context);
    }),
  );

  await reinitialize(context);
}

export function deactivate(): void {
  teardown();
}

function teardown(): void {
  if (!runtime) return;
  runtime.sync.stop();
  runtime.panels.dispose();
  for (const d of runtime.disposables) d.dispose();
  runtime = undefined;
}

async function reinitialize(context: vscode.ExtensionContext): Promise<void> {
  teardown();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rootPath = (config.get<string>("rootPath") ?? "").trim();
  if (!rootPath) {
    void vscode.window.showWarningMessage(hl("rootPathNotConfigured"));
    return;
  }

  const selfUserId = resolveUserId(config.get<string>("userId"));
  const displayName = (config.get<string>("displayName") ?? "").trim();

  const model = new ChatModel(rootPath, selfUserId);
  if (diagnosticsLogger) model.setLogger(diagnosticsLogger);

  // ローカルキャッシュ(未読・送信キュー)を globalStorage に置く(DESIGN.md §6)。
  const cache = new LocalCache(path.join(context.globalStorageUri.fsPath, "localCache.json"));
  await cache.load();
  model.setLocalCache(cache);

  try {
    await model.init(displayName);
  } catch (err) {
    void vscode.window.showErrorMessage(hl("rootPathUnreachable", err instanceof Error ? err.message : String(err)));
    return;
  }

  const tree = new ChannelTreeProvider(model);
  const panels = new PanelManager(context.extensionUri, model, rootPath, () => {
    const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
      attachmentMaxBytes: c.get<number>("attachmentMaxBytes") ?? 10485760,
      imageInlinePreview: c.get<boolean>("imageInlinePreview") ?? true,
    };
  });

  const sync = new SyncEngine({
    rootPath,
    reconcileMs: (config.get<number>("poll.reconcileSec") ?? 90) * 1000,
    fallbackMs: (config.get<number>("poll.fallbackSec") ?? 4) * 1000,
    watchEnabled: config.get<boolean>("watch.enabled") ?? true,
    onChange: () => void model.reconcileAll(),
    isActive: () => vscode.window.state.focused,
    onError: (e) => console.error("[airgapChat] sync error", e),
    onModeChange: (mode) => console.info(`[airgapChat] sync mode: ${mode}`),
    logger: diagnosticsLogger,
  });

  const disposables: vscode.Disposable[] = [];
  disposables.push(vscode.window.registerTreeDataProvider(CHANNELS_VIEW_ID, tree));
  disposables.push(model.onChannelsChanged(() => tree.refresh()));

  await sync.start();
  runtime = { model, sync, tree, panels, disposables };

  await model.flushQueue(); // 起動時に未送信分があれば送る。
  tree.refresh();
}

function resolveUserId(configured: string | undefined): string {
  const trimmed = (configured ?? "").trim();
  if (trimmed) return trimmed;
  try {
    return os.userInfo().username || "user";
  } catch {
    return "user";
  }
}

async function runSetup(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rootPath = await vscode.window.showInputBox({
    prompt: hl("setupRootPrompt"),
    value: config.get<string>("rootPath") ?? "",
    ignoreFocusOut: true,
  });
  if (rootPath === undefined) return;
  const userId = await vscode.window.showInputBox({
    prompt: hl("setupUserIdPrompt"),
    value: config.get<string>("userId") ?? "",
    ignoreFocusOut: true,
  });
  if (userId === undefined) return;
  const displayName = await vscode.window.showInputBox({
    prompt: hl("setupDisplayNamePrompt"),
    value: config.get<string>("displayName") ?? "",
    ignoreFocusOut: true,
  });
  if (displayName === undefined) return;

  const target = vscode.ConfigurationTarget.Global;
  await config.update("rootPath", rootPath.trim(), target);
  await config.update("userId", userId.trim(), target);
  await config.update("displayName", displayName.trim(), target);
  // 設定変更イベントで reinitialize が走る。
}

async function runCreateChannel(): Promise<void> {
  if (!runtime) return;
  const name = await vscode.window.showInputBox({
    prompt: hl("createChannelPrompt"),
    placeHolder: hl("createChannelPlaceholder"),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? hl("channelNameEmpty") : undefined),
  });
  if (!name || !name.trim()) return;
  const channelId = await runtime.model.createChannel(name.trim());
  runtime.tree.refresh();
  await runtime.panels.open(channelId);
}

async function runRenameChannel(item?: ChannelItem): Promise<void> {
  if (!runtime || !item) return;
  const name = await vscode.window.showInputBox({
    prompt: hl("renameChannelPrompt"),
    value: typeof item.label === "string" ? item.label : "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? hl("channelNameEmpty") : undefined),
  });
  if (!name || !name.trim()) return;
  await runtime.model.renameChannel(item.channelId, name.trim());
  runtime.tree.refresh();
}
