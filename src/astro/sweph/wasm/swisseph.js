/**
 * ビルドを通すためだけの再エクスポート薄皮（PoC 専用）。
 *
 * 事情: コピーしてきた wrapper（../sweph-wasm.js）の `static async init()` の中に
 *   `await import("./wasm/swisseph.js")`
 * という動的 import が埋まっている。この PoC では init() を**呼ばない**が、
 * esbuild（wrangler のバンドラ）は実行しないコードでも import 先を静的に解決しようとするため、
 * ファイルが無いと「Could not resolve "./wasm/swisseph.js"」でビルドが落ちる。
 *
 * そこで元の astro-viewer と同じ相対配置（wasm/swisseph.js）にこの薄皮を置き、
 * 実体である ../swisseph.js へ横流しする。こうすると **glue と wrapper のコピーを
 * 1バイトも改造せずに済む**（実体は同一モジュールなので二重初期化も起きない）。
 */
export { default } from "../swisseph.js";
