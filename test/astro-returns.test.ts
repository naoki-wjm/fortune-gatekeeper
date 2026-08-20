import { describe, expect, it } from "vitest";
import { AstroError, PROGRESSION_YEAR_DAYS, formatDegree } from "../src/astro/chart";
import {
  computeProgression,
  crossUt,
  crossingsInRange,
  formatAge,
  formatArc,
} from "../src/astro/returns";
import { FAKE_ARMC_ASCMC, FAKE_ARMC_CUSPS, FAKE_EPS, makeFakeEngine } from "./stubs/fake-engine";

/** 偽エンジンと同じ式でユリウス日を作る */
function jdOf(year: number, month: number, day: number, hour = 0): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 2440587.5 + hour / 24;
}

describe("通過（クロス）の一発計算", () => {
  it("開始 jd より後の 1 回を返し、天体とフラグをそのまま渡す", () => {
    const swe = makeFakeEngine();
    swe.moonAnchorJd = jdOf(2026, 8, 21, 3);

    const jd = crossUt(swe, "moon", 345.35, jdOf(2026, 8, 20));
    expect(jd).toBeCloseTo(jdOf(2026, 8, 21, 3), 8);
    expect(swe.crossCalls[0]).toEqual({
      kind: "moon",
      targetLon: 345.35,
      startJd: jdOf(2026, 8, 20),
      flags: 260,
    });

    swe.sunAnchorJd = jdOf(2027, 6, 16);
    expect(crossUt(swe, "sun", 0, jdOf(2027, 1, 1))).toBeCloseTo(jdOf(2027, 6, 16), 8);
    expect(swe.crossCalls[1]?.kind).toBe("sun");
  });

  /**
   * wrapper（sweph-wasm.js）のエラーチェックは返り値ではなく flags を見ていて、
   * flags が正のあいだ絶対に throw しない。だから**呼び出し側で**検算する必要がある。
   */
  it("開始 jd より後を返さなかったら AstroError（壊れた wrapper の穴を塞ぐ）", () => {
    const swe = makeFakeEngine();
    swe.crossFails = true; // 負の値（Swiss Ephemeris のエラー値）を返す
    expect(() => crossUt(swe, "moon", 30, jdOf(2026, 8, 20))).toThrow(AstroError);
    expect(() => crossUt(swe, "moon", 30, jdOf(2026, 8, 20))).toThrow(/計算できませんでした/);

    // 開始 jd ちょうど（進まない）も失敗扱い ―― 無限ループの芽を摘む
    const stuck = makeFakeEngine();
    stuck.swe_mooncross_ut = (_lon: number, startJd: number) => startJd;
    expect(() => crossUt(stuck, "moon", 30, 2_461_000)).toThrow(AstroError);

    const nan = makeFakeEngine();
    nan.swe_solcross_ut = () => Number.NaN;
    expect(() => crossUt(nan, "sun", 0, 2_461_000)).toThrow(AstroError);
  });

  it("期間内のリターンをすべて拾う（1 回・2 回・0 回）", () => {
    const swe = makeFakeEngine();
    const augustStart = jdOf(2026, 8, 1);
    const septemberStart = jdOf(2026, 9, 1);

    // 8/2 起点なら 8/2 と 8/29.32 の 2 回
    swe.moonAnchorJd = jdOf(2026, 8, 2);
    const twice = crossingsInRange(swe, "moon", 30, augustStart, septemberStart);
    expect(twice).toHaveLength(2);
    expect(twice[1]! - twice[0]!).toBeCloseTo(27.32, 8);
    expect(twice[0]).toBeGreaterThanOrEqual(augustStart);
    expect(twice[1]).toBeLessThan(septemberStart);

    // 8/20 起点なら 1 回だけ
    swe.moonAnchorJd = jdOf(2026, 8, 20);
    expect(crossingsInRange(swe, "moon", 30, augustStart, septemberStart)).toHaveLength(1);

    // 周期を伸ばして 8 月を素通りさせると 0 回
    swe.moonPeriod = 35;
    swe.moonAnchorJd = jdOf(2026, 9, 5);
    expect(crossingsInRange(swe, "moon", 30, augustStart, septemberStart)).toEqual([]);
  });

  it("同じ瞬間を二度拾わない（見つけた翌日から探し直す）", () => {
    const swe = makeFakeEngine();
    swe.moonAnchorJd = jdOf(2026, 8, 2);
    crossingsInRange(swe, "moon", 30, jdOf(2026, 8, 1), jdOf(2026, 9, 1));
    // 2 回目の探索は「1 回目 ＋ 1 日」から始まっている
    expect(swe.crossCalls[1]?.startJd).toBeCloseTo(jdOf(2026, 8, 3), 8);
  });
});

describe("二次進行（一日一年法）", () => {
  const natal = { year: 1990, month: 6, day: 15, hour: 12, minute: 0, utcOffset: 0 };
  const place = { lat: 35.6895, lng: 139.6917, houseSystem: "P" };

  it("経過年数ぶんの「日」を出生 jd に足した空を見る", () => {
    const swe = makeFakeEngine();
    const result = computeProgression(swe, {
      natal,
      ...place,
      target: { year: 2026, month: 8, day: 20 },
    });

    const natalJd = jdOf(1990, 6, 15, 12);
    const targetJd = jdOf(2026, 8, 20, 12);
    expect(result.natalJd).toBeCloseTo(natalJd, 8);
    expect(result.targetJd).toBeCloseTo(targetJd, 8);
    expect(result.ageYears).toBeCloseTo((targetJd - natalJd) / PROGRESSION_YEAR_DAYS, 8);
    expect(result.progressedJd).toBeCloseTo(natalJd + result.ageYears, 8);
    // 36 年ぶんの進行は 36 日ぶんの空
    expect(result.progressedJd - natalJd).toBeCloseTo(36.18, 2);
    expect(result.progressedPlanets).toHaveLength(11);
  });

  it("進行 ASC / MC は ARMC 方式（出生地の緯度・真黄道傾斜・出生図のハウス方式）", () => {
    const swe = makeFakeEngine();
    const result = computeProgression(swe, {
      natal,
      ...place,
      target: { year: 2026, month: 8, day: 20 },
    });

    // 偽エンジンは天体を動かさないのでソーラーアークは 0（＝進行 MC は出生 MC のまま）
    expect(result.solarArc).toBeCloseTo(0, 10);
    expect(swe.armcCalls).toHaveLength(1);
    expect(swe.armcCalls[0]?.lat).toBe(35.6895);
    expect(swe.armcCalls[0]?.eps).toBe(FAKE_EPS);
    expect(swe.armcCalls[0]?.hsys).toBe("P");
    // 出生 MC 300° から出した ARMC（黄経ではなく赤経なので値がずれる）
    expect(swe.armcCalls[0]?.armc).toBeCloseTo(302.18, 2);

    expect(result.progressedCusps).toEqual(FAKE_ARMC_CUSPS);
    expect(result.progressedAngles.asc).toBe(FAKE_ARMC_CUSPS[1]);
    expect(result.progressedAngles.mc).toBe(FAKE_ARMC_ASCMC[1]);
    expect(formatDegree(result.progressedAngles.asc)).toBe("蟹座 10°00′");
  });

  it("出生より前の日付は断る", () => {
    const swe = makeFakeEngine();
    expect(() =>
      computeProgression(swe, { natal, ...place, target: { year: 1980, month: 1, day: 1 } }),
    ).toThrow(AstroError);
  });
});

describe("年齢と弧の表記", () => {
  it("経過年数は「◯歳◯ヶ月相当」", () => {
    expect(formatAge(0)).toBe("0歳0ヶ月相当");
    expect(formatAge(36.18)).toBe("36歳2ヶ月相当");
    expect(formatAge(39.999)).toBe("39歳11ヶ月相当");
  });

  it("ソーラーアークは星座を持たない弧のまま", () => {
    expect(formatArc(0)).toBe("0°00′");
    expect(formatArc(35.7)).toBe("35°42′");
    // 359.9° を 360°00′ に見せない
    expect(formatArc(359.9)).toBe("359°54′");
  });
});
