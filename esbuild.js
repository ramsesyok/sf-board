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

async function main() {
  const active = targets.filter((t) => fs.existsSync(path.resolve(__dirname, t.entry)));
  if (active.length === 0) {
    console.log("[esbuild] ビルド対象のエントリポイントがまだありません(Phase 1)。スキップします。");
    return;
  }
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
