/**
 * Emscripten glue（swisseph.js）の型。
 *
 * ⚠ 実体の swisseph.js は astro-viewer / PoC からの**無改造コピー**。
 *    型が欲しいのはこちら側の都合なので、glue を触らずに .d.ts を隣へ置いて済ませる。
 *    （TypeScript は `import ... from "./swisseph.js"` を `./swisseph.d.ts` で解決する）
 *
 * ここで宣言するのは「本実装が実際に使う口」だけ。glue が持つ他の API は触らない。
 */

/** Emscripten モジュール本体。sweph-wasm.js の wrapper が中身を叩く */
export interface EmscriptenModule {
  [key: string]: unknown;
}

/** Emscripten の instantiateWasm フック（同期 Instance 化を差し込むための口） */
export type InstantiateWasmHook = (
  imports: WebAssembly.Imports,
  successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
) => WebAssembly.Exports | Record<string, never>;

export interface GlueOptions {
  instantiateWasm?: InstantiateWasmHook;
  locateFile?: (path: string, prefix: string) => string;
}

/** MODULARIZE ビルドの工場関数 */
declare function initGlue(options?: GlueOptions): Promise<EmscriptenModule>;

export default initGlue;
