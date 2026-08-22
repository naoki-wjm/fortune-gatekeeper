/**
 * 納甲の「年と月の境」を**本物の Swiss Ephemeris（wasm）**で確かめる。
 *
 * 納甲がエンジンに頼るのは太陽黄経ひとつだけで、そこが月支（節入り）と年の境（立春）を決める。
 * 偽エンジンに好きな黄経を言わせるテスト（test/nakko.test.ts）だけでは、
 * 「本当にその日その時刻の太陽がそこに居るのか」は誰も見ていないので、ここで実物に当てる。
 *
 * 本物の wasm の読み方は test/astro-yearly-real.test.ts と同じ流儀
 * （本番の src/astro/engine.ts は workerd 流の wasm import なので Node では読めない。
 *   glue に wasmBinary を直接渡せば Node でも初期化できる）。
 *
 * ⚠ 立春の時刻そのものは暦を引かずに、**黄経 315° をまたいだかどうか**だけを見る。
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { SwissEph } from "../src/astro/chart";
import { fourPillars, monthBranchOrder, sunLongitude, type NakkoMoment } from "../src/nakko";

let swe: SwissEph;

beforeAll(async () => {
  const wasmBinary = fs.readFileSync(new URL("../src/astro/sweph/swisseph.wasm", import.meta.url));
  const glue = (await import(
    /* @vite-ignore */ new URL("../src/astro/sweph/swisseph.js", import.meta.url).href
  )) as { default: (options: unknown) => Promise<unknown> };
  const wrapper = (await import(
    /* @vite-ignore */ new URL("../src/astro/sweph/sweph-wasm.js", import.meta.url).href
  )) as { default: new (emscripten: unknown) => unknown };

  const emscripten = await glue.default({ wasmBinary });
  swe = new wrapper.default(emscripten) as SwissEph;
});

/** 日本時間の日時（分は 0） */
function jst(year: number, month: number, day: number, hour: number): NakkoMoment {
  return { year, month, day, hour, minute: 0, utcOffset: 9 };
}

describe("納甲（本物の Swiss Ephemeris で検算）", () => {
  it("2026-08-22 12:00 JST の太陽は 149°台（処暑 150° の手前）＝申月", () => {
    const at = jst(2026, 8, 22, 12);
    const lon = sunLongitude(swe, at);
    expect(lon).toBeGreaterThanOrEqual(149);
    expect(lon).toBeLessThan(150);

    // 315°（立春＝寅月）から数えて 7 番目の区切り＝申月
    expect(monthBranchOrder(lon)).toBe(6);
    const pillars = fourPillars(at, lon);
    expect(pillars.month.ganzhi).toBe("丙申");
    expect(pillars.year.ganzhi).toBe("丙午");
    expect(pillars.day.ganzhi).toBe("戊辰");
  });

  it("2026 年の立春をまたぐと年干支が乙巳から丙午へ変わる", () => {
    const before = jst(2026, 2, 3, 12);
    const after = jst(2026, 2, 5, 12);

    const beforeLon = sunLongitude(swe, before);
    const afterLon = sunLongitude(swe, after);
    // 立春（黄経 315°）は 2 月 3〜5 日のどこか。2/3 は手前、2/5 は過ぎている
    expect(beforeLon).toBeLessThan(315);
    expect(beforeLon).toBeGreaterThan(310);
    expect(afterLon).toBeGreaterThan(315);
    expect(afterLon).toBeLessThan(320);

    expect(fourPillars(before, beforeLon).year.ganzhi).toBe("乙巳");
    expect(fourPillars(after, afterLon).year.ganzhi).toBe("丙午");
    // 月も丑月（前年の暮れ）から寅月（新しい年の頭）へ移る
    expect(fourPillars(before, beforeLon).month.branch).toBe("丑");
    expect(fourPillars(after, afterLon).month.branch).toBe("寅");
  });

  it("太陽黄経は 1 年で 12 の区切りをひととおり通る（節入りの並びが月支と合う）", () => {
    // 各月の 20 日ごろは、どの月も節を過ぎたあたり
    const orders = Array.from({ length: 12 }, (_unused, index) => {
      const at = jst(2026, index + 1, 20, 12);
      return fourPillars(at, sunLongitude(swe, at)).month.branch;
    });
    expect(orders).toEqual([
      "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥", "子",
    ]);
  });
});
