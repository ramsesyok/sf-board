import { describe, it, expect } from "vitest";
import { findPathMatches, matchPathAt } from "../shared/pathLink";

function values(text: string): string[] {
  return findPathMatches(text).map((m) => m.value);
}

describe("findPathMatches", () => {
  it("UNC パスを検出する", () => {
    expect(values("参照: \\\\server\\share\\dir\\file.txt です")).toEqual(["\\\\server\\share\\dir\\file.txt"]);
    expect(values("\\\\srv\\share")).toEqual(["\\\\srv\\share"]);
  });

  it("Windows ドライブパス(バック/スラッシュ両方)を検出する", () => {
    expect(values("C:\\Users\\me\\doc.xlsx を確認")).toEqual(["C:\\Users\\me\\doc.xlsx"]);
    expect(values("画像 C:/Users/me/pic.png")).toEqual(["C:/Users/me/pic.png"]);
    expect(values("C:\\temp をクリック")).toEqual(["C:\\temp"]);
  });

  it("POSIX 絶対パス(2 セグメント以上)を検出する", () => {
    expect(values("設定は /etc/nginx/nginx.conf にある")).toEqual(["/etc/nginx/nginx.conf"]);
    expect(values("/home/user/.bashrc")).toEqual(["/home/user/.bashrc"]);
    // フォルダ(末尾スラッシュ)も保持
    expect(values("ログは /var/log/ 配下")).toEqual(["/var/log/"]);
  });

  it("POSIX の 1 セグメント/裸のスラッシュは誤検出しない", () => {
    expect(values("ルートは / です")).toEqual([]);
    expect(values("/etc だけなら対象外")).toEqual([]);
    expect(values("and/or や 24/7 や km/h")).toEqual([]);
  });

  it("末尾の句読点・閉じ括弧を除去する", () => {
    expect(values("フォルダ \\\\srv\\share\\folder。")).toEqual(["\\\\srv\\share\\folder"]);
    expect(values("(C:\\a\\b)")).toEqual(["C:\\a\\b"]);
    expect(values("パス /opt/app/bin、次へ")).toEqual(["/opt/app/bin"]);
  });

  it("末尾スラッシュ(フォルダ指定)は保持する", () => {
    expect(values("\\\\srv\\share\\dir\\")).toEqual(["\\\\srv\\share\\dir\\"]);
    expect(values("C:\\work\\")).toEqual(["C:\\work\\"]);
  });

  it('「パスのコピー」の二重引用符を除去する(前後の " を含めない)', () => {
    // Windows エクスプローラの「パスのコピー」は "..." で囲む。
    expect(values('"C:\\Users\\me\\Book1.xlsx"')).toEqual(["C:\\Users\\me\\Book1.xlsx"]);
    // 日本語(非空白)を含むパスも1つの塊として拾う。
    expect(values('"C:\\Users\\me\\デスクトップ\\Book1.xlsx"')).toEqual([
      "C:\\Users\\me\\デスクトップ\\Book1.xlsx",
    ]);
  });

  it("複数のパス(異なる形式)を検出する", () => {
    expect(values("A: \\\\a\\b と B: C:\\c\\d と C: /e/f")).toEqual(["\\\\a\\b", "C:\\c\\d", "/e/f"]);
  });

  it("URL(http://)をパスと誤検出しない", () => {
    expect(values("見て http://example.com/path")).toEqual([]);
    expect(values("https://server/share/x")).toEqual([]);
    expect(values("file://C:/tmp を開く")).toEqual([]);
  });

  it("パスでない文字列は検出しない", () => {
    expect(values("時刻 12:30 と比率 a:b")).toEqual([]);
    expect(values("ただのテキスト")).toEqual([]);
  });
});

describe("matchPathAt", () => {
  it("指定位置から始まるパスのみを返す", () => {
    const s = "x \\\\srv\\share y";
    expect(matchPathAt(s, 2)).toBe("\\\\srv\\share"); // '\\' の位置
    expect(matchPathAt(s, 0)).toBeUndefined(); // 'x' の位置
  });
});
