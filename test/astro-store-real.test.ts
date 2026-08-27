/**
 * 台帳の読み出しの検算を、**本物の Swiss Ephemeris（wasm）が返す値**で確かめる
 * （2026-08-27 査読 I-2）。
 *
 * `parseStoredChart` は「天体は PLANETS の 11 個ちょうど」「カスプは 13 個・ascmc は 8 個」
 * 「黄経は 0 以上 360 未満」を固定した。この線引きは**偽エンジンの決め打ちに合わせて**
 * 引いたのではなく、本物が返す形に合わせて引いた ―― という当たり前を、ここで実物に確かめる。
 * 弾いてはいけないのは本番の台帳に入っている図で、それは save_chart ＝ computeChart が
 * 書いた形そのものだから。
 *
 * 本物の wasm の読み方は test/astro-composite-real.test.ts と同じ流儀。
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  HOUSE_SYSTEM_CODES,
  PLANETS,
  computeChart,
  type MomentInput,
  type SwissEph,
} from "../src/astro/chart";
import { parseStoredChart, type StoredChart } from "../src/astro/store";

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

/** 架空の出生（実在の誰かのものではない）。年代と土地を散らしてある */
const MOMENTS: { moment: MomentInput; lat: number; lng: number }[] = [
  { moment: { year: 1935, month: 1, day: 3, hour: 5, minute: 12, utcOffset: 9 }, lat: 43.06, lng: 141.35 },
  { moment: { year: 1968, month: 7, day: 20, hour: 23, minute: 59, utcOffset: -5 }, lat: 40.71, lng: -74.01 },
  { moment: { year: 1990, month: 6, day: 15, hour: 12, minute: 0, utcOffset: 9 }, lat: 35.6895, lng: 139.6917 },
  { moment: { year: 2004, month: 12, day: 31, hour: 0, minute: 30, utcOffset: 5.75 }, lat: -33.87, lng: 151.21 },
  { moment: { year: 2026, month: 8, day: 27, hour: 18, minute: 45, utcOffset: 0 }, lat: 64.15, lng: -21.94 },
];

/** save_chart が組み立てるのと同じ形（birth も預かる側にそろえる） */
function storedChartOf(
  entry: (typeof MOMENTS)[number],
  houseSystem: string,
): Record<string, unknown> {
  const computed = computeChart(swe, entry.moment, {
    lat: entry.lat,
    lng: entry.lng,
    houseSystem,
  });
  const stored: StoredChart = {
    label: "実物",
    house_system: houseSystem,
    planets: computed.planets,
    cusps: computed.cusps,
    ascmc: computed.ascmc,
    birth: {
      year: entry.moment.year,
      month: entry.moment.month,
      day: entry.moment.day,
      hour: entry.moment.hour,
      minute: entry.moment.minute,
      utc_offset: entry.moment.utcOffset,
      lat: entry.lat,
      lng: entry.lng,
    },
    created: new Date("2026-08-27T00:00:00.000Z").toISOString(),
  };
  // 本物の KV は文字列しか持てないので、JSON を通した形で見る
  return JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
}

describe("本物の wasm が返す図は台帳の検算を通る", () => {
  it("4 つのハウス方式 × 5 つの出生で、どれも壊れ扱いにならない", () => {
    for (const houseSystem of HOUSE_SYSTEM_CODES) {
      for (const entry of MOMENTS) {
        const record = storedChartOf(entry, houseSystem);
        const parsed = parseStoredChart(record);
        expect(parsed, `${houseSystem} / ${entry.moment.year}`).not.toBeNull();
        // 写し直したものが元と 1 バイトも変わらない＝落とすべき余りものが無い
        expect(parsed).toEqual(record);
      }
    }
  });

  it("配列の長さと角度の範囲は、検算が決め打ちしている値と実物で一致する", () => {
    for (const houseSystem of HOUSE_SYSTEM_CODES) {
      for (const entry of MOMENTS) {
        const computed = computeChart(swe, entry.moment, {
          lat: entry.lat,
          lng: entry.lng,
          houseSystem,
        });
        const where = `${houseSystem} / ${entry.moment.year}`;

        expect(computed.cusps, where).toHaveLength(13);
        expect(computed.ascmc, where).toHaveLength(8);
        for (const value of [...computed.cusps, ...computed.ascmc]) {
          expect(Number.isFinite(value), `${where}: ${value}`).toBe(true);
          expect(value >= 0 && value < 360, `${where}: ${value}`).toBe(true);
        }

        // 天体は PLANETS と同じ 11 個・同じ ID・黄経は 0 以上 360 未満
        expect(computed.planets.map((planet) => planet.id)).toEqual(
          PLANETS.map((planet) => planet.id),
        );
        for (const planet of computed.planets) {
          expect(planet.lon >= 0 && planet.lon < 360, `${where}: ${planet.lon}`).toBe(true);
          expect(Number.isFinite(planet.speed), where).toBe(true);
        }
      }
    }
  });
});
