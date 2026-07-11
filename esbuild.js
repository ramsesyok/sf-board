// esbuild ビルドスクリプト。
// Host 用(dist/extension.js, CommonJS, external: vscode)と
// Webview 用(dist/webview.js, IIFE)の 2 ターゲットをビルドする(DESIGN_EXTENSION.md §11)。
//
// Phase 1 時点ではエントリポイント(src/extension.ts / src/ui/webview/*)が
// まだ存在しないため、存在するターゲットのみをビルドする。
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    name: "extension (host)",
    entry: "src/extension.ts",
    options: {
      entryPoints: ["src/extension.ts"],
      outfile: "dist/extension.js",
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      external: ["vscode"],
      sourcemap: true,
      minify: !watch,
    },
  },
  {
    name: "webview",
    entry: "src/ui/webview/main.ts",
    options: {
      entryPoints: ["src/ui/webview/main.ts"],
      outfile: "dist/webview.js",
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2021",
      sourcemap: true,
      minify: !watch,
    },
  },
];

// KaTeX の CSS を、フォント(woff2)を data URI で内包した dist/katex.css として生成する。
// エアギャップ方針: 外部フォント参照を持たせない。Webview は <link> で dist/katex.css を読む
// (cspSource 経由)。フォントは data: なので CSP に font-src data: を追加する(§4)。
function generateKatexCss() {
  const katexDir = path.resolve(__dirname, "node_modules/katex/dist");
  const cssPath = path.join(katexDir, "katex.min.css");
  if (!fs.existsSync(cssPath)) {
    console.log("[esbuild] katex が見つからないため katex.css 生成をスキップ。");
    return;
  }
  let css = fs.readFileSync(cssPath, "utf8");
  // woff2 を data URI に置換。
  css = css.replace(/url\(fonts\/(KaTeX_[A-Za-z0-9_-]+\.woff2)\)/g, (_m, file) => {
    const b64 = fs.readFileSync(path.join(katexDir, "fonts", file)).toString("base64");
    return `url(data:font/woff2;base64,${b64})`;
  });
  // 残りの woff / ttf 参照(外部)は削除して woff2 のみにする。
  css = css.replace(/,\s*url\(fonts\/KaTeX_[A-Za-z0-9_-]+\.woff\)\s*format\("woff"\)/g, "");
  css = css.replace(/,\s*url\(fonts\/KaTeX_[A-Za-z0-9_-]+\.ttf\)\s*format\("truetype"\)/g, "");
  fs.mkdirSync(path.resolve(__dirname, "dist"), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, "dist/katex.css"), css);
  console.log(`[esbuild] generated dist/katex.css (${(css.length / 1024).toFixed(0)} KB, fonts inlined)`);
}

async function main() {
  const active = targets.filter((t) => fs.existsSync(path.resolve(__dirname, t.entry)));
  if (active.length === 0) {
    console.log("[esbuild] ビルド対象のエントリポイントがまだありません(Phase 1)。スキップします。");
    return;
  }
  generateKatexCss();
  for (const t of active) {
    if (watch) {
      const ctx = await esbuild.context(t.options);
      await ctx.watch();
      console.log(`[esbuild] watching ${t.name}`);
    } else {
      await esbuild.build(t.options);
      console.log(`[esbuild] built ${t.name}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
