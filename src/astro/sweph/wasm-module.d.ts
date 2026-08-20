/**
 * `import wasmModule from "./sweph/swisseph.wasm"` に型を与える宣言。
 *
 * Cloudflare Workers（wrangler / esbuild）は .wasm を ES モジュールとして扱い、
 * default export に **コンパイル済みの WebAssembly.Module** を渡してくる。
 * workerd は `WebAssembly.instantiate(bytes)` 型の動的コンパイルを禁じているので、
 * この「モジュールとして受け取る」経路が唯一の入口になる（PoC で確認済み）。
 */
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
