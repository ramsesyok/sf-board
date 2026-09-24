import { describe, it, expect } from "vitest";
import { neutralizeNotificationLinks } from "../shared/notificationText";

// VS Code の通知が用いるリンク検出(notifications.ts の LINK_REGEX 相当)。
const VSCODE_NOTIFICATION_LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

describe("neutralizeNotificationLinks", () => {
  it.each([
    "[click](command:workbench.action.terminal.new)",
    "see [docs](https://example.com) now",
    "[x](file:///C:/Windows/System32/calc.exe)",
    "[a](command:x)[b](command:y)",
  ])("リンク構文を無効化する: %s", (input) => {
    const out = neutralizeNotificationLinks(input);
    expect(out.match(VSCODE_NOTIFICATION_LINK)).toBeNull();
    // 見た目の文字は変えない(ゼロ幅スペースの挿入のみ)。
    expect(out.replace(/​/g, "")).toBe(input);
  });

  it("リンク構文を含まない文字列はそのまま", () => {
    expect(neutralizeNotificationLinks("配列 a[0] (注)")).toBe("配列 a[0] (注)");
  });
});
