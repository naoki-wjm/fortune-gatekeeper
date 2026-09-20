/**
 * vitest.config.ts を型検査に通すための最小限の宣言。
 *
 * tsconfig の `types` は @cloudflare/workers-types だけ（Workers のコードを Node の型で
 * 汚さないため）なので、設定ファイルが使う Node の口だけをここで名乗る。
 * ランタイム依存を増やさない方針は変えていない（@types/node は入れない）。
 */
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  /** 一時フォルダに束ねた JS を `import()` で読むのに要る（test/browser-bundle-real.test.ts） */
  export function pathToFileURL(path: string): URL;
}

/**
 * 本物の wasm を Node で読むテスト（test/astro-yearly-real.test.ts）と、
 * 束ねを一時フォルダに作って読むテスト（test/browser-bundle-real.test.ts）が使う口だけ。
 */
declare module "node:fs" {
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  const fs: {
    readFileSync: typeof readFileSync;
    mkdtempSync: typeof mkdtempSync;
    rmSync: typeof rmSync;
  };
  export default fs;
}

/** 束ねの置き場（一時フォルダ）を決めるのに要る口だけ */
declare module "node:os" {
  export function tmpdir(): string;
  const os: { tmpdir: typeof tmpdir };
  export default os;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  const path: { join: typeof join };
  export default path;
}

interface ImportMeta {
  readonly url: string;
}
