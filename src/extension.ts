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
  VERIFY_CONNECTION_COMMAND,
  CHANNELS_VIEW_ID,
} from "./ui/commandIds";
import { hl } from "./host/hostL10n";
import { OutputChannelDiagnosticsLogger } from "./host/diagnosticsLogger";
import type { DiagnosticsLogger } from "./core/diagnostics";
import { parseUncHost, probeSharedFolder } from "./host/connectionCheck";

const CONFIG_SECTION = "sfBoard";

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
  const logChannel = vscode.window.createOutputChannel("SF Board", { log: true });
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
    vscode.commands.registerCommand(VERIFY_CONNECTION_COMMAND, () => runVerifyConnection()),
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

  // 設定変更で再初期化する。ただし再初期化が必要なキーに限定し(表示系設定はパネル再作成不要)、
  // 変更を 250ms デバウンス+直列化する。初期設定は rootPath/userId/displayName を連続更新するため、
  // これを行わないと reinitialize が多重に走って共有フォルダ上で競合し、初回セットアップで
  // 一時的なエラーが出る(その後は正常)問題が起きる。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (REINIT_KEYS.some((k) => e.affectsConfiguration(k))) scheduleReinitialize(context);
    }),
  );

  await reinitialize(context);
}

// 再初期化が必要な設定キー(表示系: threadDisplay / attachmentMaxBytes /
// imageInlinePreview / diagnostics.enabled は都度参照なので除外)。
const REINIT_KEYS = [
  "sfBoard.rootPath",
  "sfBoard.userId",
  "sfBoard.displayName",
  "sfBoard.poll.reconcileSec",
  "sfBoard.poll.fallbackSec",
  "sfBoard.watch.enabled",
];

// ---- 再初期化のデバウンス+直列化 ----
let reinitTimer: ReturnType<typeof setTimeout> | undefined;
let reinitRunning = false;
let reinitPending = false;

function scheduleReinitialize(context: vscode.ExtensionContext): void {
  if (reinitTimer) clearTimeout(reinitTimer);
  reinitTimer = setTimeout(() => {
    reinitTimer = undefined;
    void runReinitializeSerialized(context);
  }, 250);
}

async function runReinitializeSerialized(context: vscode.ExtensionContext): Promise<void> {
  if (reinitRunning) {
    reinitPending = true; // 実行中の再初期化と重ねない。終わったら 1 回だけ再実行。
    return;
  }
  reinitRunning = true;
  try {
    await reinitialize(context);
  } finally {
    reinitRunning = false;
    if (reinitPending) {
      reinitPending = false;
      void runReinitializeSerialized(context);
    }
  }
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

  // Windows + UNC パスでホストが security.allowedUNCHosts に無い場合は、
  // 初期化(fs アクセス)を試みる前に許可の同意を取る(取れなければ中断)。
  if (await handleUncPermissionIfNeeded(rootPath)) return;

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
    const detail = err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? ""} ${err.message}`.trim() : String(err);
    void vscode.window
      .showErrorMessage(hl("rootPathUnreachable", detail), hl("verifyConnectionButton"))
      .then((choice) => {
        if (choice === hl("verifyConnectionButton")) void runVerifyConnection();
      });
    return;
  }

  const tree = new ChannelTreeProvider(model);
  const panels = new PanelManager(context.extensionUri, model, rootPath, () => {
    const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
      attachmentMaxBytes: c.get<number>("attachmentMaxBytes") ?? 10485760,
      imageInlinePreview: c.get<boolean>("imageInlinePreview") ?? true,
      threadDisplay: c.get<"inline" | "thread">("threadDisplay") ?? "inline",
    };
  });

  const sync = new SyncEngine({
    rootPath,
    reconcileMs: (config.get<number>("poll.reconcileSec") ?? 90) * 1000,
    fallbackMs: (config.get<number>("poll.fallbackSec") ?? 4) * 1000,
    watchEnabled: config.get<boolean>("watch.enabled") ?? true,
    onChange: () => void model.reconcileAll(),
    isActive: () => vscode.window.state.focused,
    onError: (e) => console.error("[sfBoard] sync error", e),
    onModeChange: (mode) => console.info(`[sfBoard] sync mode: ${mode}`),
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

/** rootPath が UNC で、ホストが security.allowedUNCHosts に許可されているか。 */
function isUncHostAllowed(rootPath: string): { isUnc: boolean; host?: string; allowed: boolean; restrictActive: boolean } {
  const host = process.platform === "win32" ? parseUncHost(rootPath) : undefined;
  if (!host) return { isUnc: false, allowed: true, restrictActive: false };
  const sec = vscode.workspace.getConfiguration("security");
  const restrictActive = sec.get<boolean>("restrictUNCAccess", true);
  const allowedHosts = sec.get<string[]>("allowedUNCHosts", []) ?? [];
  const allowed = !restrictActive || allowedHosts.some((h) => h.toLowerCase() === host.toLowerCase());
  return { isUnc: true, host, allowed, restrictActive };
}

/**
 * Windows で UNC ホストが未許可なら、確認の上 security.allowedUNCHosts に追加してウィンドウを
 * 再読み込みする(設定の反映に再読み込みが必要なため)。処理した(=init を中断すべき)場合 true。
 */
async function handleUncPermissionIfNeeded(rootPath: string): Promise<boolean> {
  const status = isUncHostAllowed(rootPath);
  if (!status.isUnc || status.allowed || !status.host) return false;

  const addLabel = hl("uncAddAndReload");
  const choice = await vscode.window.showWarningMessage(hl("uncNotAllowed", status.host), { modal: true }, addLabel);
  if (choice !== addLabel) {
    void vscode.window.showWarningMessage(hl("uncDeclined"));
    return true; // 未許可のまま init に進んでも失敗するので中断。
  }
  try {
    const sec = vscode.workspace.getConfiguration("security");
    const current = sec.get<string[]>("allowedUNCHosts", []) ?? [];
    if (!current.some((h) => h.toLowerCase() === status.host!.toLowerCase())) {
      await sec.update("allowedUNCHosts", [...current, status.host], vscode.ConfigurationTarget.Global);
    }
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  } catch (err) {
    void vscode.window.showErrorMessage(hl("uncUpdateFailed", err instanceof Error ? err.message : String(err)));
  }
  return true;
}

/** 共有フォルダの接続状態を検査して結果を表示する(初期セットアップ不調時の診断)。 */
async function runVerifyConnection(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rootPath = (config.get<string>("rootPath") ?? "").trim();
  if (!rootPath) {
    void vscode.window.showWarningMessage(hl("rootPathNotConfigured"));
    return;
  }

  const lines: string[] = [`Path: ${rootPath}`, `Platform: ${process.platform}`];
  const unc = isUncHostAllowed(rootPath);
  if (unc.isUnc) {
    lines.push(
      `UNC host: ${unc.host} — allowedUNCHosts: ${unc.allowed ? "OK" : "NG (not registered)"}` +
        (unc.restrictActive ? "" : " (restrictUNCAccess disabled)"),
    );
  }

  const probe = await probeSharedFolder(rootPath);
  lines.push(`Exists: ${probe.exists ? "OK" : "NG"}${probe.exists && !probe.isDirectory ? " (not a directory)" : ""}`);
  lines.push(`Readable: ${probe.readable ? "OK" : "NG"}`);
  lines.push(`Writable: ${probe.writable ? "OK" : "NG"}`);
  lines.push(`workspace.json: ${probe.workspaceExists ? "exists (initialized)" : "absent (not initialized)"}`);
  if (probe.errorCode || probe.errorMessage) {
    lines.push(`Error: ${(probe.errorCode ?? "").trim()} ${(probe.errorMessage ?? "").trim()}`.trim());
  }

  const ok = probe.exists && probe.isDirectory && probe.readable && probe.writable && unc.allowed;
  await vscode.window.showInformationMessage(hl(ok ? "verifyOk" : "verifyNg"), { modal: true, detail: lines.join("\n") });
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
