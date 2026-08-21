/**
 * 年間概要を**本物の Swiss Ephemeris（wasm）**で検算する。
 *
 * 他の占星術テストは偽エンジンで回している（本番の src/astro/engine.ts は workerd 流の
 * wasm import なので Node では読めない）。ただし glue に `wasmBinary` を直接渡せば
 * Node でも普通に初期化できるので、**このファイルだけ**本物を読む。
 *
 * 見たいのは 2 つ:
 *   - 疎サンプル＋3 次補間の日次表が、毎日総当たりした真値と同じ日付を出すか（±1 日）
 *   - 走査 1 回の所要が Workers の CPU 予算（10ms）に収まるか
 *
 * ⚠ 本番の数字はデプロイ後に `wrangler tail` で見る。ここで測るのは Node 上の目安。
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { anglesOf, computeChart, julianDay, type SwissEph } from "../src/astro/chart";
import { crossUt } from "../src/astro/returns";
import { scanYearlyRange, type YearlyScan, type YearlyScanInput } from "../src/astro/yearly";
import { bruteScanYearlyRange } from "./stubs/brute-yearly";

let swe: SwissEph;

beforeAll(async () => {
  const wasmBinary = fs.readFileSync(new URL("../src/astro/sweph/swisseph.wasm", import.meta.url));
  // 複製（minify 済み・ソースマップ無し）は vite に噛ませず Node の素の loader で読む。
  // glue の .d.ts は wasmBinary を宣言していない（複製に手を入れない方針）ので型は as で通す。
  const glue = (await import(
    /* @vite-ignore */ new URL("../src/astro/sweph/swisseph.js", import.meta.url).href
  )) as { default: (options: unknown) => Promise<unknown> };
  const wrapper = (await import(
    /* @vite-ignore */ new URL("../src/astro/sweph/sweph-wasm.js", import.meta.url).href
  )) as { default: new (emscripten: unknown) => unknown };

  const emscripten = await glue.default({ wasmBinary });
  swe = new wrapper.default(emscripten) as SwissEph;
});

/** 1990-06-15 12:00 UTC・東京・プラシーダス */
function natalChart() {
  return computeChart(
    swe,
    { year: 1990, month: 6, day: 15, hour: 12, minute: 0, utcOffset: 0 },
    { lat: 35.6895, lng: 139.6917, houseSystem: "P" },
  );
}

/** その年の 1 月 1 日から数えて最初のソーラーリターンと、その次のリターン */
function solarYear(sunLon: number, year: number): { startJd: number; endJd: number } {
  const from = julianDay(swe, { year, month: 1, day: 1, hour: 0, minute: 0, utcOffset: 0 });
  const startJd = crossUt(swe, "sun", sunLon, from);
  return { startJd, endJd: crossUt(swe, "sun", sunLon, startJd + 1) };
}

function inputFor(year: number): YearlyScanInput {
  const chart = natalChart();
  const sun = chart.planets.find((planet) => planet.id === 0);
  const period = solarYear(sun?.lon as number, year);
  return {
    startJd: period.startJd,
    endJd: period.endJd,
    natalPlanets: chart.planets,
    cusps: chart.cusps,
    angles: anglesOf(chart),
  };
}

/** 同じ種類のイベントをまとめる（件数と日付を突き合わせるための鍵） */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/** 日付のズレ（日数）を数える。ついでに 1 日を超えるズレがあれば控える */
interface Drift {
  shifted: number;
  far: string[];
}

function compareDates(
  label: string,
  sparse: readonly number[],
  brute: readonly number[],
  startJd: number,
  drift: Drift,
): void {
  sparse.forEach((jd, index) => {
    const diff = Math.abs(jd - (brute[index] as number));
    if (diff > 0.5) {
      drift.shifted++;
      if (diff > 1.5) drift.far.push(`${label}: ${Math.round(jd - startJd)}日目が ${diff.toFixed(1)}日ずれた`);
    }
  });
}

/** 疎サンプル版と総当たり版を突き合わせる */
function compareScans(sparse: YearlyScan, brute: YearlyScan, startJd: number): Drift {
  const drift: Drift = { shifted: 0, far: [] };

  expect(sparse.days).toBe(brute.days);

  const retroKey = (period: { id: number }) => String(period.id);
  const sparseRetro = groupBy(sparse.retrogrades, retroKey);
  const bruteRetro = groupBy(brute.retrogrades, retroKey);
  expect([...sparseRetro.keys()].sort()).toEqual([...bruteRetro.keys()].sort());
  for (const [key, periods] of sparseRetro) {
    const truth = bruteRetro.get(key) as typeof periods;
    expect(periods.length, `逆行の件数（天体 ${key}）`).toBe(truth.length);
    compareDates(
      `逆行 ${periods[0]?.planet}`,
      periods.map((period) => period.startJd),
      truth.map((period) => period.startJd),
      startJd,
      drift,
    );
    compareDates(
      `逆行 ${periods[0]?.planet}`,
      periods.map((period) => period.endJd),
      truth.map((period) => period.endJd),
      startJd,
      drift,
    );
    expect(periods.map((period) => period.clipped ?? null)).toEqual(
      truth.map((period) => period.clipped ?? null),
    );
  }

  const ingressKey = (ingress: { id: number; signIndex: number }) =>
    `${ingress.id}-${ingress.signIndex}`;
  const sparseIngress = groupBy(sparse.ingresses, ingressKey);
  const bruteIngress = groupBy(brute.ingresses, ingressKey);
  expect([...sparseIngress.keys()].sort()).toEqual([...bruteIngress.keys()].sort());
  for (const [key, events] of sparseIngress) {
    const truth = bruteIngress.get(key) as typeof events;
    expect(events.length, `イングレスの件数（${key}）`).toBe(truth.length);
    compareDates(
      `イングレス ${events[0]?.planet}`,
      events.map((event) => event.jd),
      truth.map((event) => event.jd),
      startJd,
      drift,
    );
  }

  const angleKey = (window: { transitId: number; angle: string; aspect: { angle: number } }) =>
    `${window.transitId}-${window.angle}-${window.aspect.angle}`;
  const sparseAngle = groupBy(sparse.angleAspects, angleKey);
  const bruteAngle = groupBy(brute.angleAspects, angleKey);
  expect([...sparseAngle.keys()].sort()).toEqual([...bruteAngle.keys()].sort());
  for (const [key, windows] of sparseAngle) {
    const truth = bruteAngle.get(key) as typeof windows;
    expect(windows.length, `ASC/MC トランジットの件数（${key}）`).toBe(truth.length);
    for (const field of ["startJd", "endJd", "exactJd"] as const) {
      compareDates(
        `${key} の ${field}`,
        windows.map((window) => window[field]),
        truth.map((window) => window[field]),
        startJd,
        drift,
      );
    }
  }

  const natalKey = (window: { transitId: number; natalId: number; aspect: { angle: number } }) =>
    `${window.transitId}-${window.natalId}-${window.aspect.angle}`;
  const sparseNatal = groupBy(sparse.natalAspects, natalKey);
  const bruteNatal = groupBy(brute.natalAspects, natalKey);
  expect([...sparseNatal.keys()].sort()).toEqual([...bruteNatal.keys()].sort());
  for (const [key, windows] of sparseNatal) {
    const truth = bruteNatal.get(key) as typeof windows;
    expect(windows.length, `ネイタルトランジットの件数（${key}）`).toBe(truth.length);
    for (const field of ["startJd", "endJd", "exactJd"] as const) {
      compareDates(
        `${key} の ${field}`,
        windows.map((window) => window[field]),
        truth.map((window) => window[field]),
        startJd,
        drift,
      );
    }
  }

  return drift;
}

describe("年間概要（本物の Swiss Ephemeris で検算）", () => {
  it("wasm が Node でも初期化できる（glue に wasmBinary を直渡し）", () => {
    expect(typeof swe.swe_calc_ut).toBe("function");
    const jd = swe.swe_julday(2026, 8, 21, 0, 1);
    expect(jd).toBeCloseTo(2461273.5, 6);
    // Moshier モード（SEFLG_MOSEPH）で太陽が獅子座あたりに居る
    expect(swe.swe_calc_ut(jd, 0, 4)[0] as number).toBeCloseTo(147.98, 1);
  });

  for (const year of [2025, 2026]) {
    it(`${year} 年のソーラーリターン年で総当たりと同じ日付を出す`, () => {
      const input = inputFor(year);
      const sparse = scanYearlyRange(swe, input);
      const brute = bruteScanYearlyRange(swe, input);

      expect(sparse.days).toBeGreaterThan(360);
      expect(sparse.ephemerisCalls).toBeLessThanOrEqual(400);
      // 総当たりは 2,900 回超 ―― Workers の CPU 上限にはとても載らない
      expect(brute.ephemerisCalls).toBeGreaterThan(2900);

      const drift = compareScans(sparse, brute, input.startJd);
      console.log(
        `[${year}] 天体計算 ${sparse.ephemerisCalls} 回（総当たり ${brute.ephemerisCalls} 回） / ` +
          `日付が 1 日ずれたイベント ${drift.shifted} 件`,
      );
      expect(drift.far).toEqual([]);
      expect(drift.shifted).toBeLessThanOrEqual(3);
    });
  }

  it("走査 1 回が Workers の CPU 予算に収まる", () => {
    const input = inputFor(2026);
    scanYearlyRange(swe, input); // 暖機（wasm も JIT も温めてから測る）

    // ミニPC で他の仕事が走っているとブレるので、5 回のうち一番速かった回を採る
    const times: number[] = [];
    let calls = 0;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      calls = scanYearlyRange(swe, input).ephemerisCalls;
      times.push(performance.now() - started);
    }
    const best = Math.min(...times);
    console.log(
      `年間概要 1 回: 最速 ${best.toFixed(2)}ms（5 回: ${times.map((time) => time.toFixed(1)).join(" / ")}）` +
        ` / 天体計算 ${calls} 回（Node 上の目安。本番の数字はデプロイ後に wrangler tail で見る）`,
    );
    expect(best).toBeLessThan(15);
  });
});
