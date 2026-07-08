// ULID 生成(単調性補正付き)。DESIGN.md §3「ULID 生成の単調性補正」。
//
// - 26 文字 Crockford Base32。先頭 10 文字がタイムスタンプ(48bit ミリ秒)、
//   残り 16 文字がランダム(80bit)。
// - 順序・LWW 判定の正は ULID(文字列辞書順が時系列順に一致する)。
// - 時計ズレ対策: 生成値が「最後に観測した ULID」以下になる場合は、
//   観測済み最大値 + 1 に補正して単調性を保つ。
// - core 層は vscode に依存しない(単体テスト可能に保つ)。

export type Ulid = string;

// Crockford Base32(I, L, O, U を除外)。
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10;
const RANDOM_LEN = 16;
export const ULID_LEN = TIME_LEN + RANDOM_LEN; // 26

const ULID_PATTERN = new RegExp(`^[${ENCODING}]{${ULID_LEN}}$`);

/** 文字列が妥当な ULID(26 文字・Crockford Base32)か判定する。 */
export function isValidUlid(value: unknown): value is Ulid {
  return typeof value === "string" && ULID_PATTERN.test(value);
}

function encodeTime(nowMs: number): string {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error(`不正なタイムスタンプ: ${nowMs}`);
  }
  let time = Math.floor(nowMs);
  let out = "";
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = time % ENCODING_LEN;
    out = ENCODING[mod] + out;
    time = (time - mod) / ENCODING_LEN;
  }
  if (time !== 0) {
    throw new Error(`タイムスタンプが ULID の表現範囲を超えています: ${nowMs}`);
  }
  return out;
}

function encodeRandom(random: () => number): string {
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[Math.floor(random() * ENCODING_LEN)];
  }
  return out;
}

/**
 * ULID 文字列を辞書順で 1 だけ加算する(単調性補正用)。
 * 末尾から桁上がりを処理する。全桁が最大値(オーバーフロー)の場合は例外。
 */
export function incrementUlid(ulid: Ulid): Ulid {
  if (!isValidUlid(ulid)) {
    throw new Error(`不正な ULID: ${ulid}`);
  }
  const chars = ulid.split("");
  for (let i = ULID_LEN - 1; i >= 0; i--) {
    const idx = ENCODING.indexOf(chars[i]);
    if (idx < ENCODING_LEN - 1) {
      chars[i] = ENCODING[idx + 1];
      return chars.join("");
    }
    // 桁上がり: この桁を 0 に戻して次の桁へ。
    chars[i] = ENCODING[0];
  }
  throw new Error("ULID がオーバーフローしました");
}

export interface UlidGenerator {
  /** 単調増加を保証した新しい ULID を生成する。 */
  next(nowMs?: number): Ulid;
  /**
   * 外部(他ユーザーのイベント等)で観測した ULID を取り込む。
   * 以後の next() はこの値より必ず大きい ULID を返す。
   */
  observe(ulid: Ulid): void;
  /** 現在までに観測/生成した最大 ULID(未生成なら undefined)。 */
  readonly last: Ulid | undefined;
}

/**
 * 単調性補正付き ULID ジェネレータを生成する。
 * @param random 0<=x<1 の乱数源。テスト時に差し替え可能(既定 Math.random)。
 */
export function monotonicUlidFactory(random: () => number = Math.random): UlidGenerator {
  let lastMax: Ulid | undefined;

  return {
    next(nowMs: number = Date.now()): Ulid {
      let candidate = encodeTime(nowMs) + encodeRandom(random);
      if (lastMax !== undefined && candidate <= lastMax) {
        // 時計が巻き戻った/同一ミリ秒で乱数が小さい等。観測済み最大 +1 に補正。
        candidate = incrementUlid(lastMax);
      }
      lastMax = candidate;
      return candidate;
    },
    observe(ulid: Ulid): void {
      if (!isValidUlid(ulid)) {
        return; // 不正値は無視(前方互換/堅牢性)。
      }
      if (lastMax === undefined || ulid > lastMax) {
        lastMax = ulid;
      }
    },
    get last(): Ulid | undefined {
      return lastMax;
    },
  };
}

// 既定のプロセス共有ジェネレータ。
const defaultGenerator = monotonicUlidFactory();

/** 既定ジェネレータで ULID を生成する。 */
export function ulid(nowMs?: number): Ulid {
  return defaultGenerator.next(nowMs);
}

/** 既定ジェネレータに観測値を取り込む。 */
export function observeUlid(value: Ulid): void {
  defaultGenerator.observe(value);
}
