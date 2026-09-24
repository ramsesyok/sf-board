import { describe, it, expect } from "vitest";
import {
  monotonicUlidFactory,
  incrementUlid,
  isValidUlid,
  isPlausibleEventUlid,
  MAX_FUTURE_SKEW_MS,
  ULID_LEN,
} from "../core/ulid";

describe("ulid: 妥当性", () => {
  it("生成した ULID は 26 文字の Crockford Base32", () => {
    const gen = monotonicUlidFactory();
    const value = gen.next();
    expect(value).toHaveLength(ULID_LEN);
    expect(isValidUlid(value)).toBe(true);
  });

  it("I/L/O/U や小文字は不正", () => {
    expect(isValidUlid("0".repeat(26))).toBe(true);
    expect(isValidUlid("I".repeat(26))).toBe(false);
    expect(isValidUlid("a".repeat(26))).toBe(false);
    expect(isValidUlid("0".repeat(25))).toBe(false); // 長さ不足
    expect(isValidUlid(123)).toBe(false);
  });
});

describe("ulid: 単調性補正(DESIGN.md §3)", () => {
  it("同一ミリ秒・同一乱数でも厳密に単調増加する", () => {
    const gen = monotonicUlidFactory(() => 0); // 乱数を固定
    const a = gen.next(1000);
    const b = gen.next(1000);
    const c = gen.next(1000);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("時計が巻き戻っても単調増加を保つ", () => {
    const gen = monotonicUlidFactory(() => 0.5);
    const a = gen.next(5000);
    const b = gen.next(1000); // 過去へ巻き戻り
    expect(b > a).toBe(true);
  });

  it("observe した外部 ULID より必ず大きい値を返す", () => {
    const gen = monotonicUlidFactory(() => 0);
    const now = Date.now();
    const external = monotonicUlidFactory(() => 0).next(now + 1000);
    gen.observe(external);
    const next = gen.next(now); // 本来は external より小さい時刻
    expect(next > external).toBe(true);
    expect(gen.last).toBe(next);
  });

  it("observe は不正値を無視する", () => {
    const gen = monotonicUlidFactory(() => 0);
    gen.observe("not-a-ulid");
    expect(gen.last).toBeUndefined();
  });

  it("observe は最大 ULID を無視し、後続の投稿 ID を生成できる", () => {
    const gen = monotonicUlidFactory(() => 0);
    gen.observe("Z".repeat(26));
    expect(gen.last).toBeUndefined();
    expect(() => gen.next()).not.toThrow();
  });
});

describe("ulid: 共有イベントの時刻検証", () => {
  it("時計ずれの猶予を超えた未来時刻を拒否する", () => {
    const now = Date.now();
    const id = (at: number) => monotonicUlidFactory(() => 0).next(at);
    expect(isPlausibleEventUlid(id(now + MAX_FUTURE_SKEW_MS), now)).toBe(true);
    expect(isPlausibleEventUlid(id(now + MAX_FUTURE_SKEW_MS + 1), now)).toBe(false);
    expect(isPlausibleEventUlid("Z".repeat(26), now)).toBe(false);
  });
});

describe("ulid: incrementUlid", () => {
  it("1 加算した値は元より大きく 26 文字", () => {
    const base = "01234567890123456789012345";
    const inc = incrementUlid(base);
    expect(inc).toHaveLength(ULID_LEN);
    expect(inc > base).toBe(true);
  });

  it("末尾の桁上がりを正しく処理する", () => {
    // 末尾が Z(最大値)→ 桁上がりで一つ上の桁が増える。
    const base = "0000000000000000000000000Z";
    expect(incrementUlid(base)).toBe("00000000000000000000000010");
  });

  it("全桁最大値はオーバーフローで例外", () => {
    expect(() => incrementUlid("Z".repeat(26))).toThrow();
  });
});
