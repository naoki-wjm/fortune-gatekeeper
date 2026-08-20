/**
 * vitest 用の engine スタブ。
 *
 * 本番の `src/astro/engine.ts` は Swiss Ephemeris の wasm を import し、**モジュール評価の時点で**
 * 初期化を始める（isolate 起動の予算に載せるため）。これは workerd の作法なので、Node で走る
 * vitest からは読めない。そこで `vitest.config.ts` の alias で、`src/index.ts` が読む
 * `./astro/engine` だけをこのファイルに差し替えている。
 *
 * ＝ **テストは wasm を一切読まない**。占星術ツールの中身を試すテストは、
 *    `handleAstroMcpRequest` に偽エンジンを注入して回す（test/astro-mcp.test.ts）。
 */
import type { SwissEph } from "../../src/astro/chart";

export const bootDiagnostics: { syncInstanceError: string | null } = { syncInstanceError: null };

export function getEngine(): Promise<SwissEph> {
  return Promise.reject(
    new Error("テスト環境では wasm を読み込みません（偽エンジンを注入してください）"),
  );
}
