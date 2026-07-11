import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { parseUncHost, probeSharedFolder } from "../host/connectionCheck";
import { makeTempRoot, initWorkspace } from "../core/store";

describe("parseUncHost", () => {
  it("UNC パスからホストを取り出す", () => {
    expect(parseUncHost("\\\\server\\share\\dir")).toBe("server");
    expect(parseUncHost("//server/share")).toBe("server");
    expect(parseUncHost("\\\\host")).toBe("host");
  });
  it("UNC でなければ undefined", () => {
    expect(parseUncHost("C:\\local\\path")).toBeUndefined();
    expect(parseUncHost("/home/user")).toBeUndefined();
    expect(parseUncHost("relative/path")).toBeUndefined();
  });
});

describe("probeSharedFolder", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempRoot();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("書き込み可能な既存ディレクトリを正しく検査する", async () => {
    const r = await probeSharedFolder(root);
    expect(r.exists).toBe(true);
    expect(r.isDirectory).toBe(true);
    expect(r.readable).toBe(true);
    expect(r.writable).toBe(true);
    expect(r.workspaceExists).toBe(false);
    expect(r.errorCode).toBeUndefined();
  });

  it("書き込みプローブの一時ファイルを残さない", async () => {
    await probeSharedFolder(root);
    const entries = await fs.readdir(root);
    expect(entries.filter((e) => e.startsWith(".sfboard-probe."))).toEqual([]);
  });

  it("初期化済みなら workspaceExists=true", async () => {
    await initWorkspace(root, "ws");
    const r = await probeSharedFolder(root);
    expect(r.workspaceExists).toBe(true);
  });

  it("存在しないパスは exists=false + エラーコード", async () => {
    const r = await probeSharedFolder(path.join(root, "does-not-exist"));
    expect(r.exists).toBe(false);
    expect(r.errorCode).toBe("ENOENT");
  });
});
