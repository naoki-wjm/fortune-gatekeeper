import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    /**
     * sweph の複製（minify 済み・ソースマップ無し）は vite に噛ませず Node の素の loader で読む。
     * 噛ませると「swisseph.js.map が無い」という警告が毎回出るだけで、得るものが無いため。
     * 本物の wasm を読むのは test/astro-yearly-real.test.ts だけ。
     */
    server: { deps: { external: [/src[\\/]astro[\\/]sweph[\\/]/] } },
  },
  resolve: {
    /**
     * src/index.ts が読む `./astro/engine`（＝ Swiss Ephemeris の wasm を import する唯一のモジュール）を、
     * テストではスタブに差し替える。Node には workerd の wasm モジュール解決が無いため。
     * 占星術ツールの中身は偽エンジンを注入して試す（test/astro-mcp.test.ts）。
     */
    alias: [
      {
        find: /^\.\/astro\/engine$/,
        replacement: fileURLToPath(new URL("./test/stubs/engine.ts", import.meta.url)),
      },
    ],
  },
});
