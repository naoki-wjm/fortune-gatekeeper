/**
 * ブラウザ用の束ねを作る（divination 向け）。
 *
 *   node scripts/build-browser.mjs   →  dist/browser/fortune-calc.js（＋ .map）
 *
 * 入口は `src/browser/index.ts` の 1 枚だけ。そこから届く純関数と、エンジンを引数で受ける
 * グルーと、貼り付けテキストが 1 本の ESM にまとまります。
 *
 * ⚠ **天体計算（sweph-wasm）は束ねに含めません**。divination 側は Astro Tool（astro-viewer）と
 *    同じ `sweph-wasm.js` を自分で読み、`SwissEPH.init()` で得た `swe` を渡す作りです。
 *    ここで wasm まで抱え込むと、同じ wasm が 2 つ載る（＝メモリも初期化も二重になる）ので、
 *    入口が `src/astro/engine.ts` と `src/astro/sweph/**` を import しないほうで線を引いてあります
 *    （`test/import-boundary.test.ts` が見張っています）。
 *
 * デッキの JSON は esbuild がそのまま埋め込みます（外部ファイルの取得が要らない形）。
 * minify はしません ―― AGPL なので、読める形のまま配るほうが筋が通っているためです。
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = path.join(REPO_ROOT, "src/browser/index.ts");
const OUTFILE = path.join(REPO_ROOT, "dist/browser/fortune-calc.js");

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

/** 頭に付ける札（ライセンスと、いつ・どの版から作ったか） */
const banner =
  `/*! fortune-gatekeeper browser bundle v${pkg.version} ` +
  `(${new Date().toISOString().slice(0, 10)}) — AGPL-3.0-only\n` +
  ` * 計算するのはこの束ね、読むのは貼られた側の LLM。解釈は一切含みません。\n` +
  ` * 天体計算（sweph-wasm）は含みません ―― prepareEngine(swe) に外から渡してください。\n` +
  ` */`;

const result = await build({
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
  sourcemap: true,
  banner: { js: banner },
  legalComments: "inline",
  metafile: true,
});

for (const warning of result.warnings) {
  console.warn(`⚠ ${warning.text}`);
}

const bytes = fs.statSync(OUTFILE).size;
console.log(`dist/browser/fortune-calc.js  ${(bytes / 1024).toFixed(1)} KB`);
