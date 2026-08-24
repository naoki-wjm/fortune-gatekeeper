/**
 * コンポジット（中点図）の ARMC 経路を**本物の Swiss Ephemeris（wasm）**で確かめる。
 *
 * 偽エンジンでは見えないのは 2 つ ―― `swe_calc_ut(SE_ECL_NUT)` が本当に黄道傾斜を返すことと、
 * `mcToArmc` → `swe_houses_armc` の往復が本当に閉じること（＝立て直した MC が中点 MC に戻る）。
 * 配線側はこの往復を毎回検算して外れたら断る作りなので、その「毎回の検算」が
 * 実物では通ることをここで押さえておく。
 *
 * 本物の wasm の読み方は test/shukuyo-real.test.ts と同じ流儀
 * （本番の src/astro/engine.ts は workerd 流の wasm import なので Node では読めない。
 *   glue に wasmBinary を直接渡せば Node でも初期化できる）。
 *
 * ⚠ 期待値は「別のソフトの答えを写した」ものではなく、**この wasm が返した値をそのまま留めた**もの。
 *    見張っているのは往復の精度と規約の一貫性で、暦の正しさそのものは Swiss Ephemeris に委ねている。
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CALC_FLAGS,
  anglesOf,
  computeChart,
  julianDay,
  mcToArmc,
  normalizeDegree,
  type MomentInput,
  type SwissEph,
} from "../src/astro/chart";
import {
  COMPOSITE_PLANET_IDS,
  buildComposite,
  midpointLon,
  type CompositeSide,
} from "../src/astro/composite";

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

/** 架空の出生 2 点（東京と大阪。実在の誰かのものではない） */
const MOMENT_A: MomentInput = { year: 1990, month: 6, day: 15, hour: 12, minute: 0, utcOffset: 9 };
const PLACE_A = { lat: 35.6895, lng: 139.6917, houseSystem: "P" };
const MOMENT_B: MomentInput = { year: 1986, month: 12, day: 29, hour: 3, minute: 0, utcOffset: 9 };
const PLACE_B = { lat: 34.6937, lng: 135.5023, houseSystem: "P" };

function sides(): { a: CompositeSide; b: CompositeSide; jdA: number; jdB: number } {
  const jdA = julianDay(swe, MOMENT_A);
  const jdB = julianDay(swe, MOMENT_B);
  const chartA = computeChart(swe, MOMENT_A, PLACE_A);
  const chartB = computeChart(swe, MOMENT_B, PLACE_B);
  return {
    jdA,
    jdB,
    a: {
      planets: chartA.planets,
      cusps: chartA.cusps,
      ascmc: chartA.ascmc,
      houseSystem: PLACE_A.houseSystem,
      birth: { jd: jdA, lat: PLACE_A.lat },
    },
    b: {
      planets: chartB.planets,
      cusps: chartB.cusps,
      ascmc: chartB.ascmc,
      houseSystem: PLACE_B.houseSystem,
      birth: { jd: jdB, lat: PLACE_B.lat },
    },
  };
}

describe("黄道傾斜（2 人の出生 jd の中間で引く）", () => {
  it("SE_ECL_NUT(-1) の [0] が真黄道傾斜（2 人の中間時点で 23.4433°）", () => {
    const { jdA, jdB } = sides();
    const meanJd = (jdA + jdB) / 2;
    const eps = swe.swe_calc_ut(meanJd, -1, CALC_FLAGS)[0] as number;
    expect(eps).toBeCloseTo(23.443306, 6);
  });

  it("中間時点の値は出生それぞれの値と（わずかに）違う＝規約が効いている", () => {
    const { jdA, jdB } = sides();
    const meanJd = (jdA + jdB) / 2;
    const eps = swe.swe_calc_ut(meanJd, -1, CALC_FLAGS)[0] as number;
    const epsA = swe.swe_calc_ut(jdA, -1, CALC_FLAGS)[0] as number;
    const epsB = swe.swe_calc_ut(jdB, -1, CALC_FLAGS)[0] as number;
    // 章動で 1e-3° ほど動く（歳差だけなら 3.5 年で 5e-4°）。どちらとも一致はしない
    expect(Math.abs(eps - epsA)).toBeGreaterThan(1e-5);
    expect(Math.abs(eps - epsB)).toBeGreaterThan(1e-5);
    // それでも「同じ時代の黄道傾斜」の範囲には収まっている
    expect(Math.abs(eps - epsA)).toBeLessThan(0.01);
  });
});

describe("ARMC → MC の往復（本物の swe_houses_armc）", () => {
  it("立て直した MC が中点 MC に戻る（配線側の検算がこれを毎回見ている）", () => {
    const { a, b } = sides();
    const mcMid = midpointLon(a.ascmc[1] as number, b.ascmc[1] as number);
    const composite = buildComposite(swe, a, b);

    expect(composite.ascMethod).toBe("derived_from_mc_midpoint");
    expect(composite.houseSystem).toBe("P");
    // 配線は「中点 MC そのもの」を返す（往復で戻ってきた値は検算に使うだけ）
    expect(composite.ascmc[1]).toBe(mcMid);
    expect(mcMid).toBeCloseTo(114.007265, 6);
    // プラシーダスの 10 カスプは MC ―― ARMC 経路が正しく効いている証拠
    expect(composite.cusps[10]).toBeCloseTo(mcMid, 9);
  });

  it("往復の誤差は 1e-9° より小さい（実測 1e-13° 台）", () => {
    const { jdA, jdB } = sides();
    const eps = swe.swe_calc_ut((jdA + jdB) / 2, -1, CALC_FLAGS)[0] as number;
    const lat = (PLACE_A.lat + PLACE_B.lat) / 2;

    let worst = 0;
    for (let mc = 0; mc < 360; mc += 5) {
      const houses = swe.swe_houses_armc(mcToArmc(mc, eps), lat, eps, "P");
      let gap = normalizeDegree((houses.ascmc[1] as number) - mc);
      if (gap > 180) gap -= 360;
      worst = Math.max(worst, Math.abs(gap));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("ASC とカスプは 2 人の緯度の平均で立つ（この wasm が返した値を留めておく）", () => {
    const { a, b } = sides();
    const composite = buildComposite(swe, a, b);
    expect(composite.cusps[1]).toBeCloseTo(201.548756, 6);
    expect(anglesOf(composite).asc).toBeCloseTo(201.548756, 6);
    // 12 本そろい、どれも 0-360 に収まっている
    expect(composite.cusps).toHaveLength(13);
    for (let house = 1; house <= 12; house++) {
      const cusp = composite.cusps[house] as number;
      expect(cusp).toBeGreaterThanOrEqual(0);
      expect(cusp).toBeLessThan(360);
    }
  });
});

describe("天体の中点（本物の座標で）", () => {
  it("10 天体とも、2 枚の黄経の短い方の弧の真ん中に乗る", () => {
    const { a, b } = sides();
    const composite = buildComposite(swe, a, b);
    expect(composite.planets).toHaveLength(10);

    for (const [index, id] of COMPOSITE_PLANET_IDS.entries()) {
      const lonA = a.planets.find((planet) => planet.id === id)?.lon as number;
      const lonB = b.planets.find((planet) => planet.id === id)?.lon as number;
      const midpoint = composite.planets[index]?.lon as number;
      expect(midpoint).toBeCloseTo(midpointLon(lonA, lonB), 12);

      // 中点は A からも B からも同じだけ離れている（＝本当に真ん中）
      const toA = Math.min(
        normalizeDegree(midpoint - lonA),
        normalizeDegree(lonA - midpoint),
      );
      const toB = Math.min(
        normalizeDegree(midpoint - lonB),
        normalizeDegree(lonB - midpoint),
      );
      expect(toA).toBeCloseTo(toB, 9);
      // 短い方の弧を採っているので、どちらまでも 90° 以内
      expect(toA).toBeLessThanOrEqual(90 + 1e-9);
    }
  });

  it("0° をまたぐ組もそのまま扱える（この 2 枚では太陽がそれ）", () => {
    const { a, b } = sides();
    const composite = buildComposite(swe, a, b);
    const sunA = a.planets.find((planet) => planet.id === 0)?.lon as number;
    const sunB = b.planets.find((planet) => planet.id === 0)?.lon as number;
    // 双子座の終わり（約 83.8°）と射手座の終わり（約 276.7°）＝短い方の弧は 0° をまたぐ
    expect(sunA).toBeCloseTo(83.771396, 6);
    expect(sunB).toBeCloseTo(276.706451, 6);
    expect(composite.planets[0]?.lon).toBeCloseTo(0.238924, 6);
  });

  it("ノードは中点図に入らない（保存済みの図には居ても）", () => {
    const { a, b } = sides();
    expect(a.planets.some((planet) => planet.id === 11)).toBe(true);
    const composite = buildComposite(swe, a, b);
    expect(composite.planets.some((planet) => planet.id === 11)).toBe(false);
  });
});
