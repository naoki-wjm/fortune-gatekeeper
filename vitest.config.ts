import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
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
