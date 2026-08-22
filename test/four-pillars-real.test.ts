/**
 * 四柱推命の「節入りを挟む」ところを**本物の Swiss Ephemeris（wasm）**で確かめる。
 *
 * 純関数（src/four-pillars.ts）は節入りの前後の日数を**引数で受け取る**ので、
 * その日数を作るのは配線（src/astro/astro-mcp.ts の solarTermSpanAt）の仕事になる ――
 * 太陽黄経から今の節を決め、`swe_solcross_ut` で前後 2 本の節入りを探す、という手順。
 * 偽エンジンのテストでは「探しに行った引数」しか見ていないので、
 * **本当に出生の瞬間を挟むのか・帯の長さは節らしいか**をここで実物に当てる。
 *
 * ⚠ wrapper の `swe_solcross_ut` はエラーチェックが壊れている（返り値ではなく flags を見ている）ので、
 *    探索は returns.ts の `crossUt`（返り値を検算する側）を通す ―― 配線と同じ道具立て。
 *
 * 本物の wasm の読み方は test/nakko-real.test.ts / test/shukuyo-real.test.ts と同じ流儀
 * （本番の src/astro/engine.ts は workerd 流の wasm import なので Node では読めない。
 *   glue に wasmBinary を直接渡せば Node でも初期化できる）。
 *
 * ⚠ 出生の実例は**架空の日付**を使う（テストの中にも本物の出生データを置かない）。
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { CALC_FLAGS, julianDay, normalizeDegree, type SwissEph } from "../src/astro/chart";
import { crossUt } from "../src/astro/returns";
import { SOLAR_TERMS, solarTermSpanFromJd } from "../src/four-pillars";
import { monthBranchOrder, sunLongitude, type NakkoMoment } from "../src/nakko";

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

/** 配線（astro-mcp.ts の solarTermSpanAt）と同じ遡り幅 */
const LOOKBACK_DAYS = 40;

/** 日時（時差は既定で日本時間） */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  utcOffset = 9,
): NakkoMoment {
  return { year, month, day, hour, minute, utcOffset };
}

/** 配線と同じ手順で、出生の瞬間を挟む 2 本の節入りを出す */
function termsAround(moment: NakkoMoment): {
  birthJd: number;
  sunLon: number;
  order: number;
  previousJd: number;
  nextJd: number;
} {
  const birthJd = julianDay(swe, moment);
  const sunLon = sunLongitude(swe, moment);
  const order = monthBranchOrder(sunLon);
  const nextJd = crossUt(swe, "sun", (SOLAR_TERMS[(order + 1) % 12] as { longitude: number }).longitude, birthJd);
  const previousJd = crossUt(
    swe,
    "sun",
    (SOLAR_TERMS[order] as { longitude: number }).longitude,
    birthJd - LOOKBACK_DAYS,
  );
  return { birthJd, sunLon, order, previousJd, nextJd };
}

/**
 * 見本の日時。
 *
 * **人の誕生日と紛れないものだけ**を並べてあります ―― 公開された日付
 * （ChatGPT / Claude の公開日。時刻の 10 時は架空、時差は米国太平洋時間）か、未来の日付か、
 * 節の境そのもの。本物の出生データはテストにも置きません。
 * 季節も散らしてある ―― 節入り直後・直前・うるう日・大晦日・
 * 夏（節の帯がいちばん長くなるころ）・冬（いちばん短くなるころ）。
 */
const SAMPLES: readonly { label: string; moment: NakkoMoment }[] = [
  // ChatGPT 公開日（PST）・Claude 公開日（PDT。2023 年は 3/12 から夏時間）
  { label: "ChatGPT 公開日", moment: at(2022, 11, 30, 10, 0, -8) },
  { label: "Claude 公開日", moment: at(2023, 3, 14, 10, 0, -7) },
  { label: "真夏（帯が長い）", moment: at(2027, 7, 20, 12, 0) },
  { label: "真冬（帯が短い）", moment: at(2027, 1, 5, 12, 0) },
  { label: "立春の直後", moment: at(2026, 2, 5, 3, 30) },
  { label: "立春の直前", moment: at(2026, 2, 3, 1, 5) },
  { label: "うるう日", moment: at(2028, 2, 29, 18, 40) },
  { label: "大晦日", moment: at(2029, 12, 31, 23, 59) },
  { label: "未来", moment: at(2087, 9, 9, 9, 9) },
];

describe("節入りの前後（本物の Swiss Ephemeris で検算）", () => {
  it.each(SAMPLES)("$label: 前の節入り ≦ 出生 ＜ 次の節入り", ({ moment }) => {
    const { birthJd, previousJd, nextJd } = termsAround(moment);

    expect(previousJd).toBeLessThanOrEqual(birthJd);
    expect(nextJd).toBeGreaterThan(birthJd);
  });

  it.each(SAMPLES)("$label: 節の帯は 29〜32 日", ({ moment }) => {
    const { previousJd, nextJd } = termsAround(moment);
    const span = nextJd - previousJd;

    // 太陽が黄経 30° 進む時間。近日点まわり（冬）が短く、遠日点まわり（夏）が長い
    expect(span).toBeGreaterThan(29);
    expect(span).toBeLessThan(32);
  });

  it.each(SAMPLES)("$label: 探索は本当にその節の黄経へ着く", ({ moment }) => {
    const { order, previousJd, nextJd } = termsAround(moment);
    const previousTerm = SOLAR_TERMS[order] as { name: string; longitude: number };
    const nextTerm = SOLAR_TERMS[(order + 1) % 12] as { name: string; longitude: number };

    const atPrevious = normalizeDegree(swe.swe_calc_ut(previousJd, 0, CALC_FLAGS)[0] as number);
    const atNext = normalizeDegree(swe.swe_calc_ut(nextJd, 0, CALC_FLAGS)[0] as number);

    // 着いた瞬間の太陽は、その節の黄経に乗っている（0.001° ＝ 太陽足で 1.5 分ぶん）
    expect(Math.abs(normalizeDegree(atPrevious - previousTerm.longitude + 180) - 180)).toBeLessThan(
      0.001,
    );
    expect(Math.abs(normalizeDegree(atNext - nextTerm.longitude + 180) - 180)).toBeLessThan(0.001);
  });

  it("節入りをまたいだ前後で月支が 1 つ進む", () => {
    // 2026 年の立春（黄経 315°）をまたぐ 2 点。またぐ前は丑月、あとは寅月
    const { previousJd, order } = termsAround(at(2026, 2, 5, 3, 30));
    expect((SOLAR_TERMS[order] as { name: string }).name).toBe("立春");

    const beforeLon = normalizeDegree(
      swe.swe_calc_ut(previousJd - 1 / 24, 0, CALC_FLAGS)[0] as number,
    );
    const afterLon = normalizeDegree(
      swe.swe_calc_ut(previousJd + 1 / 24, 0, CALC_FLAGS)[0] as number,
    );

    // 立春の 1 時間前はまだ丑月（order 11）、1 時間後は寅月（order 0）
    expect(monthBranchOrder(beforeLon)).toBe(11);
    expect(monthBranchOrder(afterLon)).toBe(0);
    expect((SOLAR_TERMS[11] as { branch: string }).branch).toBe("丑");
    expect((SOLAR_TERMS[0] as { branch: string }).branch).toBe("寅");
  });

  it("節入りちょうどに生まれても、前の節入りは出生を追い越さない", () => {
    // 2026 年の立春の瞬間を出して、その 1 分後を「出生」にする
    const { previousJd: risshunJd } = termsAround(at(2026, 2, 5, 3, 30));
    const birthJd = risshunJd + 1 / 1440;

    const sunLon = normalizeDegree(swe.swe_calc_ut(birthJd, 0, CALC_FLAGS)[0] as number);
    const order = monthBranchOrder(sunLon);
    expect(order).toBe(0); // 立春を過ぎているので寅月

    const previousJd = crossUt(swe, "sun", 315, birthJd - LOOKBACK_DAYS);
    const nextJd = crossUt(swe, "sun", 345, birthJd);

    expect(previousJd).toBeLessThanOrEqual(birthJd);
    const span = solarTermSpanFromJd(birthJd, previousJd, nextJd);
    // 節入りの直後なので「前の節入りから」はほぼ 0、「次まで」はほぼ帯まるごと
    expect(span.days_since_previous).toBeGreaterThanOrEqual(0);
    expect(span.days_since_previous).toBeLessThan(0.01);
    expect(span.days_until_next).toBeGreaterThan(29);
  });

  it("1 年ぶん 12 本の節をたどると帯の合計が回帰年になる", () => {
    // 2026 年の立春から順に 12 本
    const start = crossUt(swe, "sun", 315, julianDay(swe, at(2026, 1, 1, 0)));
    let cursor = start;
    const spans: number[] = [];

    for (let index = 1; index <= 12; index++) {
      const term = SOLAR_TERMS[index % 12] as { longitude: number };
      const next = crossUt(swe, "sun", term.longitude, cursor);
      spans.push(next - cursor);
      cursor = next;
    }

    for (const span of spans) {
      expect(span).toBeGreaterThan(29);
      expect(span).toBeLessThan(32);
    }
    // 12 本の合計＝太陽が黄経 360° 進む時間＝回帰年（365.2422 日）
    const total = spans.reduce((sum, span) => sum + span, 0);
    expect(total).toBeCloseTo(365.2422, 2);

    // いちばん短い帯は冬（小寒〜立春のあたり）、いちばん長いのは夏（小暑〜立秋のあたり）
    expect(Math.min(...spans)).toBeLessThan(30);
    expect(Math.max(...spans)).toBeGreaterThan(31);
  });
});
