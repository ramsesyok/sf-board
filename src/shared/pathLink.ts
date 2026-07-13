// メッセージ本文中のファイル/フォルダパス検知。DESIGN_EXTENSION.md §10。
// - vscode 非依存の純粋関数(単体テスト可能に保つ)。DOM/Node どちらからも使う。
// - 対象は 3 形式のみ: UNC / Windows ドライブ / POSIX 絶対パス。相対パスは対象外。
// - 誤検出(URL・時刻 12:30・"and/or" 等)を避けるため、直前文字の境界条件で絞る。
//
// 使い分け(§10):
//   - UNC(`\\host\...`)は Markdown が先頭 `\\` を `\` に畳むため、Webview では
//     markdown-it のインラインルールが生ソースに対して matchPathAt を呼んで捕捉する。
//   - Windows ドライブ / POSIX は Markdown を通っても壊れないため、サニタイズ後の
//     DOM テキストに対して findPathMatches で検出する。

// パス本体に含めない「ハード区切り」文字。空白に加え、日本語の句読点・かっこ・引用符は
// パスの一部になり得ず(日本語は語間に空白を置かないため)ここで確実に切る。
// ASCII の丸かっこ等は Windows パス "(x86)" 等で使われ得るので本体に残し、末尾のみ除去する。
const PATH_BODY = "[^\\s、。「」『』【】（）〈〉《》\"]*";

// 末尾に付きやすい句読点・閉じ括弧(和欧)。パス末尾からは除去するが、
// フォルダ区切りの `/` `\` は保持する(末尾スラッシュ=フォルダ指定)。
const TRAILING_PUNCT = /[.,;:!?)\]}>"'」』】）。、]+$/u;

// 引用符で囲まれた「パスのコピー」形式(空白入りパス対応)を拾うための開始判定。
const PATH_PREFIX = /^(?:\\\\[^\s\\/]|[A-Za-z]:[\\/]|\/[^\s/]+\/)/;

// パスの直前に来てよい「開き」境界文字(和欧の引用符・開き括弧)。POSIX 判定に使う。
const OPENING_BOUNDARY = new Set(['"', "'", "(", "[", "{", "<", "「", "『", "【", "（", "《", "〈"]);

const UNC_RE = new RegExp(`^\\\\\\\\[^\\s\\\\/]${PATH_BODY}`);
const DRIVE_RE = new RegExp(`^[A-Za-z]:[\\\\/]${PATH_BODY}`);
const POSIX_RE = new RegExp(`^/[^\\s/]+/${PATH_BODY}`);

function isAsciiAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/** POSIX パスの直前として許容する境界か(行頭・空白・開き括弧/引用符)。 */
function isPosixBoundary(prev: string | undefined): boolean {
  return prev === undefined || /\s/.test(prev) || OPENING_BOUNDARY.has(prev);
}

function trimTrailing(s: string): string {
  return s.replace(TRAILING_PUNCT, "");
}

/**
 * `src` の位置 `pos` から始まるパス(引用符なし)に一致すれば、その値
 * (末尾の句読点・引用符を除去済み)を返す。一致しなければ undefined。
 * アンカー(pos 起点)判定なので markdown-it のインラインルールからも使える。
 */
export function matchPathAt(src: string, pos: number): string | undefined {
  const prev = pos > 0 ? src[pos - 1] : undefined;
  const rest = src.slice(pos);

  // UNC: \\host\share...(先頭 \\ の直後はスラッシュ以外の実体文字)。直前が英数字なら除外。
  let m = UNC_RE.exec(rest);
  if (m && !isAsciiAlnum(prev)) {
    const v = trimTrailing(m[0]);
    if (v.length > 2) return v; // "\\" だけの誤検出を避ける
  }

  // Windows ドライブ: C:\... または C:/...。直前が英数字・スラッシュなら除外
  // (URL スキーム http:// や file://C:/... 内での誤検出防止)。
  m = DRIVE_RE.exec(rest);
  if (m && !isAsciiAlnum(prev) && prev !== "/" && prev !== "\\") return trimTrailing(m[0]);

  // POSIX 絶対: /dir/sub...(2 セグメント以上に限定してノイズを抑制)。先頭 // は対象外。
  // 直前は境界(行頭・空白・開き括弧)に限る("and/or"・"24/7"・"km/h" 等を除外)。
  m = POSIX_RE.exec(rest);
  if (m && isPosixBoundary(prev)) return trimTrailing(m[0]);

  return undefined;
}

export interface PathMatch {
  start: number;
  end: number; // 排他的([start, end))
  value: string;
}

/**
 * `text` を走査し、検出したパスの位置と値を返す(重複なし・出現順)。
 * Webview では DOM テキストノードに適用し、Windows ドライブ / POSIX パスを検出する。
 * `"..."` で囲まれた「パスのコピー」形式は、空白入りでも1つの塊として拾う。
 */
export function findPathMatches(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  let i = 0;
  while (i < text.length) {
    // 引用符で囲まれたパス(空白入り対応)。囲みの内側だけを値とする。
    if (text[i] === '"') {
      const close = text.indexOf('"', i + 1);
      if (close > i + 1) {
        const inner = text.slice(i + 1, close);
        if (PATH_PREFIX.test(inner)) {
          const value = trimTrailing(inner);
          if (value.length > 0) {
            out.push({ start: i + 1, end: i + 1 + value.length, value });
            i = close + 1;
            continue;
          }
        }
      }
    }
    const value = matchPathAt(text, i);
    if (value && value.length > 0) {
      out.push({ start: i, end: i + value.length, value });
      i += value.length;
    } else {
      i += 1;
    }
  }
  return out;
}
