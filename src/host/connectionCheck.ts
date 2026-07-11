// 共有フォルダの接続診断ヘルパ。vscode に依存しない(Node の fs のみ)ため単体テスト可能。
// UNC ホストのパースと、存在/読み取り/書き込み/初期化状態の検査を行う。

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

/**
 * UNC パス(`\\host\share\...` または `//host/share/...`)からホスト名を取り出す。
 * UNC でなければ undefined。プラットフォーム判定は呼び出し側で行う。
 */
export function parseUncHost(p: string): string | undefined {
  const m = /^[\\/]{2}([^\\/]+)/.exec(p);
  return m ? m[1] : undefined;
}

export interface ProbeResult {
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  writable: boolean;
  workspaceExists: boolean; // workspace.json の有無(初期化済みか)
  errorCode?: string;
  errorMessage?: string;
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 共有フォルダの状態を検査する。存在・種別・読み取り・書き込み(一時ファイルで実測)・
 * 初期化状態を返す。書き込みプローブの一時ファイルは必ず削除する(残骸を残さない)。
 */
export async function probeSharedFolder(rootPath: string): Promise<ProbeResult> {
  const res: ProbeResult = {
    exists: false,
    isDirectory: false,
    readable: false,
    writable: false,
    workspaceExists: false,
  };

  try {
    const st = await fsp.stat(rootPath);
    res.exists = true;
    res.isDirectory = st.isDirectory();
  } catch (e) {
    res.errorCode = errCode(e);
    res.errorMessage = errMsg(e);
    return res; // 存在しない/到達不能ならここで確定。
  }

  try {
    await fsp.access(rootPath, fs.constants.R_OK);
    res.readable = true;
  } catch {
    /* readable=false */
  }

  // 実際に書き込みできるかをプローブ(ACL/読み取り専用マウントを検出)。
  const probe = path.join(rootPath, `.sfboard-probe.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`);
  try {
    await fsp.writeFile(probe, "probe");
    res.writable = true;
  } catch (e) {
    if (!res.errorCode) {
      res.errorCode = errCode(e);
      res.errorMessage = errMsg(e);
    }
  } finally {
    await fsp.rm(probe, { force: true }).catch(() => undefined); // 後始末(残骸を残さない)。
  }

  try {
    await fsp.access(path.join(rootPath, "workspace.json"), fs.constants.F_OK);
    res.workspaceExists = true;
  } catch {
    /* 未初期化 */
  }

  return res;
}
