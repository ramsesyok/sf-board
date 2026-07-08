// 拡張エントリポイント。activate/deactivate、設定読み込み、各コンポーネントの配線。
// DESIGN.md §7 / DESIGN_EXTENSION.md §3・§8。

import * as vscode from "vscode";
import * as os from "os";
import { ChatModel } from "./model/chatModel";
import { ReconcilePoller } from "./core/sync";
import { ChannelTreeProvider } from "./ui/channelTree";
import { PanelManager } from "./ui/panelManager";
import {
  OPEN_CHANNEL_COMMAND,
  CREATE_CHANNEL_COMMAND,
  RENAME_CHANNEL_COMMAND,
  REFRESH_COMMAND,
  SETUP_COMMAND,
  CHANNELS_VIEW_ID,
} from "./ui/commandIds";
import { ChannelItem } from "./ui/channelTree";
import { pickLang, t } from "./shared/strings";

const CONFIG_SECTION = "airgapChat";

interface Runtime {
  model: ChatModel;
  poller: ReconcilePoller;
  tree: ChannelTreeProvider;
  panels: PanelManager;
  disposables: vscode.Disposable[];
}

let runtime: Runtime | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const lang = pickLang(vscode.env.language);

  // コマンドは常時登録する(setup は rootPath 未設定でも使えるように)。
  context.subscriptions.push(
    vscode.commands.registerCommand(SETUP_COMMAND, () => runSetup(lang)),
    vscode.commands.registerCommand(OPEN_CHANNEL_COMMAND, (channelId: string) => {
      void runtime?.panels.open(channelId);
    }),
    vscode.commands.registerCommand(CREATE_CHANNEL_COMMAND, () => runCreateChannel(lang)),
    vscode.commands.registerCommand(RENAME_CHANNEL_COMMAND, (item?: ChannelItem) =>
      runRenameChannel(lang, item),
    ),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      void runtime?.poller.checkNow();
      runtime?.tree.refresh();
    }),
  );

  // 設定変更(rootPath 等)で再初期化する。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        void reinitialize(context, lang);
      }
    }),
  );

  await reinitialize(context, lang);
}

export function deactivate(): void {
  teardown();
}

function teardown(): void {
  if (!runtime) return;
  runtime.poller.stop();
  runtime.panels.dispose();
  for (const d of runtime.disposables) d.dispose();
  runtime = undefined;
}

async function reinitialize(context: vscode.ExtensionContext, lang: ReturnType<typeof pickLang>): Promise<void> {
  teardown();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rootPath = (config.get<string>("rootPath") ?? "").trim();
  if (!rootPath) {
    void vscode.window.showWarningMessage(t(lang, "rootPathNotConfigured"));
    return;
  }

  const selfUserId = resolveUserId(config.get<string>("userId"));
  const displayName = (config.get<string>("displayName") ?? "").trim();
  const reconcileSec = config.get<number>("poll.reconcileSec") ?? 90;

  const model = new ChatModel(rootPath, selfUserId);
  try {
    await model.init(displayName);
  } catch (err) {
    void vscode.window.showErrorMessage(t(lang, "rootPathUnreachable", err instanceof Error ? err.message : String(err)));
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
  const poller = new ReconcilePoller(rootPath, {
    intervalMs: reconcileSec * 1000,
    onChange: () => void model.reconcileAll(),
    onError: (e) => console.error("[airgapChat] reconcile error", e),
  });

  const disposables: vscode.Disposable[] = [];
  disposables.push(vscode.window.registerTreeDataProvider(CHANNELS_VIEW_ID, tree));
  disposables.push(model.onChannelsChanged(() => tree.refresh()));

  poller.start();
  runtime = { model, poller, tree, panels, disposables };
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

async function runSetup(lang: ReturnType<typeof pickLang>): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rootPath = await vscode.window.showInputBox({
    prompt: t(lang, "setupRootPrompt"),
    value: config.get<string>("rootPath") ?? "",
    ignoreFocusOut: true,
  });
  if (rootPath === undefined) return;
  const userId = await vscode.window.showInputBox({
    prompt: t(lang, "setupUserIdPrompt"),
    value: config.get<string>("userId") ?? "",
    ignoreFocusOut: true,
  });
  if (userId === undefined) return;
  const displayName = await vscode.window.showInputBox({
    prompt: t(lang, "setupDisplayNamePrompt"),
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

async function runCreateChannel(lang: ReturnType<typeof pickLang>): Promise<void> {
  if (!runtime) return;
  const name = await vscode.window.showInputBox({
    prompt: t(lang, "createChannelPrompt"),
    placeHolder: t(lang, "createChannelPlaceholder"),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? t(lang, "channelNameEmpty") : undefined),
  });
  if (!name || !name.trim()) return;
  const channelId = await runtime.model.createChannel(name.trim());
  runtime.tree.refresh();
  await runtime.panels.open(channelId);
}

async function runRenameChannel(lang: ReturnType<typeof pickLang>, item?: ChannelItem): Promise<void> {
  if (!runtime || !item) return;
  const name = await vscode.window.showInputBox({
    prompt: t(lang, "renameChannelPrompt"),
    value: typeof item.label === "string" ? item.label : "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? t(lang, "channelNameEmpty") : undefined),
  });
  if (!name || !name.trim()) return;
  await runtime.model.renameChannel(item.channelId, name.trim());
  runtime.tree.refresh();
}
