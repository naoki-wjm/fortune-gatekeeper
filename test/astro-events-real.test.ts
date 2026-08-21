/**
 * 期間内のトランジットイベントを**本物の Swiss Ephemeris（wasm）**で検算する。
 *
 * 読み方は test/astro-yearly-real.test.ts と同じ（glue に wasmBinary を直渡しすれば Node でも動く）。
 *
 * 見たいのは 2 つ:
 *   - 疎サンプル＋3 次エルミート補間が、毎 tick 本物を叩いた総当たりと同じイベントを
 *     同じ時刻（分単位）で出すか
 *   - 走査 1 回の所要と天体計算の回数（Workers 実機は手元 Node の 2〜5 倍遅い）
 *
 * ⚠ 本番の数字はデプロイ後に `wrangler tail` で見る。ここで測るのは Node 上の目安。
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { anglesOf, computeChart, julianDay, type SwissEph } from "../src/astro/chart";
import {
  scanTransitEvents,
  type BodySet,
  type TransitEventScan,
  type TransitEventsInput,
} from "../src/astro/events";
import { bruteScanTransitEvents } from "./stubs/brute-events";

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

/** 1990-06-15 12:00 UTC・東京・プラシーダス */
function natalChart() {
  return computeChart(
    swe,
    { year: 1990, month: 6, day: 15, hour: 12, minute: 0, utcOffset: 0 },
    { lat: 35.6895, lng: 139.6917, houseSystem: "P" },
  );
}

function inputFor(
  start: { year: number; month: number; day: number },
  days: number,
  bodies: BodySet,
): TransitEventsInput {
  const chart = natalChart();
  return {
    startJd: julianDay(swe, { ...start, hour: 0, minute: 0, utcOffset: 0 }),
    days,
    bodies,
    natalPlanets: chart.planets,
    cusps: chart.cusps,
    angles: anglesOf(chart),
  };
}

/** 同じ種類のイベントをまとめる（件数と時刻を突き合わせるための鍵） */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/** 時刻のズレ（分）を控える */
interface Drift {
  worst: number;
  worstLabel: string;
}

function compareMoments(
  label: string,
  sparse: readonly (number | null)[],
  brute: readonly (number | null)[],
  drift: Drift,
): void {
  expect(sparse.length, `${label} の件数`).toBe(brute.length);
  sparse.forEach((jd, index) => {
    const truth = brute[index] as number | null;
    if (jd === null || truth === null) {
      expect(jd, `${label} の ${index} 番目（片方だけ null）`).toBe(truth);
      return;
    }
    const minutes = Math.abs(jd - truth) * 1440;
    if (minutes > drift.worst) {
      drift.worst = minutes;
      drift.worstLabel = label;
    }
    expect(minutes, `${label} の ${index} 番目`).toBeLessThan(2);
  });
}

/** 疎サンプル版と総当たり版を突き合わせる */
function compareScans(sparse: TransitEventScan, brute: TransitEventScan): Drift {
  const drift: Drift = { worst: 0, worstLabel: "" };

  const stationKey = (station: { id: number }) => String(station.id);
  const sparseStations = groupBy(sparse.stations, stationKey);
  const bruteStations = groupBy(brute.stations, stationKey);
  expect([...sparseStations.keys()].sort()).toEqual([...bruteStations.keys()].sort());
  for (const [key, events] of sparseStations) {
    const truth = bruteStations.get(key) as typeof events;
    expect(events.map((event) => event.to), `留の向き（天体 ${key}）`).toEqual(
      truth.map((event) => event.to),
    );
    compareMoments(
      `留 ${events[0]?.name}`,
      events.map((event) => event.jd),
      truth.map((event) => event.jd),
      drift,
    );
  }

  const ingressKey = (ingress: { id: number; signIndex: number }) =>
    `${ingress.id}-${ingress.signIndex}`;
  const sparseIngress = groupBy(sparse.ingresses, ingressKey);
  const bruteIngress = groupBy(brute.ingresses, ingressKey);
  expect([...sparseIngress.keys()].sort()).toEqual([...bruteIngress.keys()].sort());
  for (const [key, events] of sparseIngress) {
    const truth = bruteIngress.get(key) as typeof events;
    compareMoments(
      `イングレス ${key}`,
      events.map((event) => event.jd),
      truth.map((event) => event.jd),
      drift,
    );
  }

  const windowKey = (window: {
    transitId: number;
    target: { name: string };
    aspect: { angle: number };
  }) => `${window.transitId}-${window.target.name}-${window.aspect.angle}`;
  const sparseWindows = groupBy(sparse.windows, windowKey);
  const bruteWindows = groupBy(brute.windows, windowKey);
  expect([...sparseWindows.keys()].sort()).toEqual([...bruteWindows.keys()].sort());
  for (const [key, events] of sparseWindows) {
    const truth = bruteWindows.get(key) as typeof events;
    expect(events.length, `窓の件数（${key}）`).toBe(truth.length);
    compareMoments(
      `${key} の entering`,
      events.map((event) => event.entering),
      truth.map((event) => event.entering),
      drift,
    );
    compareMoments(
      `${key} の leaving`,
      events.map((event) => event.leaving),
      truth.map((event) => event.leaving),
      drift,
    );
    events.forEach((event, index) => {
      compareMoments(`${key} の exact`, event.exact, (truth[index] as typeof event).exact, drift);
    });
    expect(events.map((event) => event.clipped ?? null), `${key} の clipped`).toEqual(
      truth.map((event) => event.clipped ?? null),
    );
    expect(
      events.map((event) => event.applyingAtStart),
      `${key} の applying_at_start`,
    ).toEqual(truth.map((event) => event.applyingAtStart));
  }

  return drift;
}

/**
 * 走査 1 回の所要（ms）。ミニPC で他の仕事が走っているとブレるので、暖機してから最速の回を採る。
 */
function fastestScan(input: TransitEventsInput): number {
  scanTransitEvents(swe, input); // 暖機（wasm も JIT も温めてから測る）
  const times: number[] = [];
  for (let round = 0; round < 3; round++) {
    const started = performance.now();
    scanTransitEvents(swe, input);
    times.push(performance.now() - started);
  }
  return Math.min(...times);
}

describe("期間内のトランジットイベント（本物の Swiss Ephemeris で検算）", () => {
  it("wasm が Node でも初期化できる（glue に wasmBinary を直渡し）", () => {
    expect(typeof swe.swe_calc_ut).toBe("function");
    const jd = swe.swe_julday(2026, 8, 21, 0, 1);
    expect(jd).toBeCloseTo(2461273.5, 6);
  });

  it("2026-08-20 から 14 日（全天体）で総当たりと同じ時刻を出す", () => {
    const input = inputFor({ year: 2026, month: 8, day: 20 }, 14, "all");
    const sparse = scanTransitEvents(swe, input);
    const elapsed = fastestScan(input);
    const brute = bruteScanTransitEvents(swe, input, 10);

    // イベントが一通り出ている期間であることを先に確かめる（空同士の一致では意味がない）
    expect(brute.windows.length).toBeGreaterThan(20);
    expect(brute.ingresses.length).toBeGreaterThan(0);

    const drift = compareScans(sparse, brute);
    console.log(
      `[14 日・all] 天体計算 ${sparse.ephemerisCalls} 回（総当たり ${brute.ephemerisCalls} 回） / ` +
        `窓 ${sparse.windows.length} 本・exact ${sparse.windows.reduce((total, window) => total + window.exact.length, 0)} 個・` +
        `留 ${sparse.stations.length}・イングレス ${sparse.ingresses.length} / ` +
        `最大ズレ ${drift.worst.toFixed(2)} 分（${drift.worstLabel}） / ` +
        `走査 ${elapsed.toFixed(1)}ms（Node 上の目安）`,
    );
    expect(sparse.ephemerisCalls).toBeLessThanOrEqual(300);
    expect(elapsed).toBeLessThan(100);
  });

  it("2026-01-01 から 93 日（月を除く）でも総当たりと同じ時刻を出す", () => {
    const input = inputFor({ year: 2026, month: 1, day: 1 }, 93, "no_moon");
    const sparse = scanTransitEvents(swe, input);
    const elapsed = fastestScan(input);
    // 月が居ないので tick は 30 分で足りる（水星でも 30 分で 0.1° 未満）
    const brute = bruteScanTransitEvents(swe, input, 30);

    expect(brute.windows.length).toBeGreaterThan(20);
    expect(brute.stations.length).toBeGreaterThan(0);

    const drift = compareScans(sparse, brute);
    console.log(
      `[93 日・no_moon] 天体計算 ${sparse.ephemerisCalls} 回（総当たり ${brute.ephemerisCalls} 回） / ` +
        `窓 ${sparse.windows.length} 本・exact ${sparse.windows.reduce((total, window) => total + window.exact.length, 0)} 個・` +
        `留 ${sparse.stations.length}・イングレス ${sparse.ingresses.length} / ` +
        `最大ズレ ${drift.worst.toFixed(2)} 分（${drift.worstLabel}） / ` +
        `走査 ${elapsed.toFixed(1)}ms（Node 上の目安）`,
    );
    // 太陽・水星・金星・火星が 1 日おき（94 点）＋外惑星が 4 日おき（25 点）＝ 501 回
    expect(sparse.ephemerisCalls).toBeLessThanOrEqual(550);
    expect(elapsed).toBeLessThan(300);
  });

  it("いちばん重い組み合わせ（outer で 366 日）でも予算に収まる", () => {
    const input = inputFor({ year: 2026, month: 1, day: 1 }, 366, "outer");
    const scan = scanTransitEvents(swe, input);
    const elapsed = fastestScan(input);
    console.log(
      `[366 日・outer] 天体計算 ${scan.ephemerisCalls} 回 / 窓 ${scan.windows.length} 本・` +
        `留 ${scan.stations.length}・イングレス ${scan.ingresses.length} / ` +
        `走査 ${elapsed.toFixed(1)}ms（Node 上の目安。Workers 実機は 2〜5 倍）`,
    );
    // 外惑星 5 天体 × 4 日おき（93 点）＝ 465 回
    expect(scan.ephemerisCalls).toBeLessThanOrEqual(500);
    expect(elapsed).toBeLessThan(1000);
  });
});
