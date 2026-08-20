/**
 * vitest.config.ts を型検査に通すための最小限の宣言。
 *
 * tsconfig の `types` は @cloudflare/workers-types だけ（Workers のコードを Node の型で
 * 汚さないため）なので、設定ファイルが使う Node の口だけをここで名乗る。
 * ランタイム依存を増やさない方針は変えていない（@types/node は入れない）。
 */
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

interface ImportMeta {
  readonly url: string;
}
