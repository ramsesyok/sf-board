import { describe, it, expect } from "vitest";
import { NewMessageTracker, summarizeBody } from "../model/newMessageTracker";

describe("NewMessageTracker: 基準 ULID(§7.1)", () => {
  it("初回観測は基準を記録するだけで undefined を返す", () => {
    const t = new NewMessageTracker();
    expect(t.advance("ch", "A")).toBeUndefined();
  });

  it("基準より新しい ID で進めると直前の基準を返し、基準を更新する", () => {
    const t = new NewMessageTracker();
    t.advance("ch", "A");
    expect(t.advance("ch", "C")).toBe("A");
    expect(t.advance("ch", "D")).toBe("C");
  });

  it("基準から進んでいなければ undefined(同一・古い ID)", () => {
    const t = new NewMessageTracker();
    t.advance("ch", "C");
    expect(t.advance("ch", "C")).toBeUndefined();
    expect(t.advance("ch", "B")).toBeUndefined();
    expect(t.advance("ch", "D")).toBe("C"); // 古い ID で基準は後退しない。
  });

  it("prime は未観測時のみ基準を記録し、観測済みなら上書きしない", () => {
    const t = new NewMessageTracker();
    t.prime("ch", "B");
    t.prime("ch", "Z");
    expect(t.advance("ch", "C")).toBe("B");
  });

  it("空チャンネル(基準 \"\")にも新着を検出できる", () => {
    const t = new NewMessageTracker();
    t.prime("ch", "");
    expect(t.advance("ch", "A")).toBe("");
  });

  it("チャンネルごとに独立して管理する", () => {
    const t = new NewMessageTracker();
    t.prime("a", "A");
    t.prime("b", "B");
    expect(t.advance("a", "C")).toBe("A");
    expect(t.advance("b", "C")).toBe("B");
  });
});

describe("NewMessageTracker: ポップアップのクールダウン(§7.1)", () => {
  it("クールダウン内の 2 回目は拒否し、経過後は許可する", () => {
    let now = 1000;
    const t = new NewMessageTracker(30_000, () => now);
    expect(t.tryAcquirePopup("ch")).toBe(true);
    now += 29_999;
    expect(t.tryAcquirePopup("ch")).toBe(false);
    now += 1;
    expect(t.tryAcquirePopup("ch")).toBe(true);
  });

  it("別チャンネルはクールダウンを共有しない", () => {
    const t = new NewMessageTracker(30_000, () => 0);
    expect(t.tryAcquirePopup("a")).toBe(true);
    expect(t.tryAcquirePopup("b")).toBe(true);
  });
});

describe("summarizeBody(§7.1)", () => {
  it("最初の空でない行を返す", () => {
    expect(summarizeBody("\n\n  hello  \nworld")).toBe("hello");
  });

  it("CRLF の本文も行で分割する", () => {
    expect(summarizeBody("first\r\nsecond")).toBe("first");
  });

  it("上限を超えたら切り詰めて … を付ける", () => {
    expect(summarizeBody("abcdef", 3)).toBe("abc…");
    expect(summarizeBody("abc", 3)).toBe("abc");
  });

  it("サロゲートペアを分断しない", () => {
    expect(summarizeBody("😀😀😀", 2)).toBe("😀😀…");
  });

  it("空・空白のみなら undefined", () => {
    expect(summarizeBody("")).toBeUndefined();
    expect(summarizeBody("  \n \n")).toBeUndefined();
  });
});
