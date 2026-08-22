/**
 * 宿曜のサイデリアル計算を**本物の Swiss Ephemeris（wasm）**で確かめる。
 *
 * 宿曜が新しく頼るのは 2 本だけ ―― `swe_set_sid_mode`（基準点を Lahiri に決める）と
 * `swe_get_ayanamsa_ut`（その瞬間のアヤナムシャ）。どちらも `sweph/sweph-wasm.d.ts` に
 * 宣言が無く、実体にだけ生えているメソッドなので、「本当に呼べて、本当に Lahiri の値が返るか」は
 * 偽エンジンでは誰も見ていない。ここで実物に当てる。
 *
 * 本物の wasm の読み方は test/nakko-real.test.ts と同じ流儀
 * （本番の src/astro/engine.ts は workerd 流の wasm import なので Node では読めない。
 *   glue に wasmBinary を直接渡せば Node でも初期化できる）。
 *
 * ⚠ 期待値は「別のソフトの答えを写した」ものではなく、**この wasm が返した値をそのまま留めた**もの。
 *    見張っているのは「基準点が Lahiri のままか」「境界探索が本当に境界へ着くか」で、
 *    暦の正しさそのものは Swiss Ephemeris に委ねている。
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { CALC_FLAGS, SIDEREAL_MODE_LAHIRI, type SwissEph } from "../src/astro/chart";
import { SHUKU_SPAN, shukuOf, toSidereal } from "../src/shukuyo";

let swe: SwissEph;

/** ユリウス日（UT）= Unix 元期のときの値。chart.ts と同じ */
const UNIX_EPOCH_JD = 2440587.5;

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
  // 本番（src/astro/engine.ts）が初期化直後に一度だけ呼ぶのと同じ設定
  swe.swe_set_sid_mode(SIDEREAL_MODE_LAHIRI, 0, 0);
});

/** J2000.0（2000-01-01 12:00 TT） */
const J2000 = 2451545.0;
/** 2026-08-22 00:00 UT */
const JD_20260822 = 2461274.5;

describe("アヤナムシャ（Lahiri）", () => {
  it("2000 年ごろの Lahiri はおよそ 23.85°", () => {
    const ayanamsa = swe.swe_get_ayanamsa_ut(J2000);
    expect(ayanamsa).toBeGreaterThan(23.8);
    expect(ayanamsa).toBeLessThan(23.9);
    expect(ayanamsa).toBeCloseTo(23.8571, 3);
  });

  it("歳差ぶんだけ年 50″ ほどで増えていく（1900 → 2000 → 2026）", () => {
    const y1900 = swe.swe_get_ayanamsa_ut(2415020.5); // 1900-01-01
    const y2026 = swe.swe_get_ayanamsa_ut(JD_20260822);
    expect(y1900).toBeCloseTo(22.4605, 3);
    expect(y2026).toBeCloseTo(24.2292, 3);

    // 100 年で 50.3″ × 100 ＝ 約 1.4°
    const perCentury = ((swe.swe_get_ayanamsa_ut(J2000) - y1900) / 100) * 3600;
    expect(perCentury).toBeGreaterThan(49);
    expect(perCentury).toBeLessThan(51);
  });

  it("swe_set_sid_mode を呼ばないと別の基準点（既定の Fagan-Bradley）になる", () => {
    // 既定のまま（sid_mode 0）だと J2000 で 24.74° ＝ Lahiri より 0.88° ほど大きい。
    // engine.ts が初期化直後に一度だけ設定しているのは、この差を踏まないため。
    swe.swe_set_sid_mode(0, 0, 0);
    const fagan = swe.swe_get_ayanamsa_ut(J2000);
    swe.swe_set_sid_mode(SIDEREAL_MODE_LAHIRI, 0, 0);
    const lahiri = swe.swe_get_ayanamsa_ut(J2000);

    expect(fagan).toBeCloseTo(24.7403, 3);
    expect(fagan - lahiri).toBeGreaterThan(0.8);
    // 差は 1 宿（13°20′）の 7% ほど＝宿が 1 つずれることもある大きさ
    expect((fagan - lahiri) / SHUKU_SPAN).toBeGreaterThan(0.06);
  });

  it("トロピカル計算は sid_mode に左右されない（CALC_FLAGS に SEFLG_SIDEREAL が無いため）", () => {
    const lahiriSun = swe.swe_calc_ut(JD_20260822, 0, CALC_FLAGS)[0] as number;
    swe.swe_set_sid_mode(0, 0, 0);
    const faganSun = swe.swe_calc_ut(JD_20260822, 0, CALC_FLAGS)[0] as number;
    swe.swe_set_sid_mode(SIDEREAL_MODE_LAHIRI, 0, 0);

    expect(faganSun).toBe(lahiriSun);
    // ついでに実際の値も（2026-08-22 の太陽は獅子座の末＝黄経 148°台）
    expect(lahiriSun).toBeCloseTo(148.9439, 3);
  });
});

describe("月の宿（サイデリアル）", () => {
  it("2026-08-22 00:00 UT の月は心宿（Jyeshtha・18）", () => {
    const tropical = swe.swe_calc_ut(JD_20260822, 1, CALC_FLAGS)[0] as number;
    const ayanamsa = swe.swe_get_ayanamsa_ut(JD_20260822);
    const sidereal = toSidereal(tropical, ayanamsa);

    expect(tropical).toBeCloseTo(259.6207, 3);
    expect(sidereal).toBeCloseTo(235.3914, 3);

    const position = shukuOf(sidereal);
    // 心宿は 18 番目＝始まりは 17 × 13°20′ = 226°40′。235°23′ − 226°40′ = 8°43′
    expect(position.shuku.number).toBe(18);
    expect(position.shuku.name).toBe("心宿");
    expect(position.shuku.sanskrit).toBe("Jyeshtha");
    expect(position.position).toBe("8°43′");
    expect(position.prev.name).toBe("房宿");
    expect(position.next.name).toBe("尾宿");
  });

  it("月は 1 日でほぼ 1 宿ぶん動く（だから時刻不明では引かない）", () => {
    const speed = swe.swe_calc_ut(JD_20260822, 1, CALC_FLAGS)[3] as number;
    // 月足は 11〜15°/日。1 宿 13°20′ とほぼ同じ幅
    expect(speed).toBeGreaterThan(11);
    expect(speed).toBeLessThan(15.5);
    expect(speed / SHUKU_SPAN).toBeGreaterThan(0.8);
  });
});

describe("宿の切り替わり時刻（swe_mooncross_ut）", () => {
  /**
   * 境界探索の要は「サイデリアルの境界にアヤナムシャを足し戻してトロピカルの目標にする」ところ。
   * 探索が本当にその境界へ着いたかは、**着いた瞬間の月をもう一度サイデリアルに直して**確かめる。
   */
  it("次の境界（240°＝尾宿の頭）へ分どころか秒の精度で着く", () => {
    const ayanamsa = swe.swe_get_ayanamsa_ut(JD_20260822);
    const boundary = 18 * SHUKU_SPAN; // 尾宿（19 番目）の始まり＝240°
    expect(boundary).toBeCloseTo(240, 10);

    const target = (((boundary + ayanamsa) % 360) + 360) % 360;
    const crossJd = swe.swe_mooncross_ut(target, JD_20260822, CALC_FLAGS);

    // 壊れた wrapper のエラーチェックの代わり（returns.ts の crossUt と同じ検算）
    expect(crossJd).toBeGreaterThan(JD_20260822);
    // 月は 1 宿に 21〜27 時間いるので、次の境界は 1 日以内
    expect(crossJd - JD_20260822).toBeLessThan(1);

    // 着いた瞬間にサイデリアルで測り直すと、確かに境界に乗っている
    const at = swe.swe_calc_ut(crossJd, 1, CALC_FLAGS)[0] as number;
    const sidereal = toSidereal(at, swe.swe_get_ayanamsa_ut(crossJd));
    expect(sidereal).toBeCloseTo(boundary, 3);

    // アヤナムシャを「窓の頭の値で使い回す」ことによるずれは 1 秒未満
    // （50″/年 ＝ 1 日で 4e-5°、月足 13°/日 で割ると 0.3 秒）
    const errorSeconds = (Math.abs(sidereal - boundary) / 13.2) * 86400;
    expect(errorSeconds).toBeLessThan(1);

    // 2026-08-22 09:19 UTC（＝日本時間 18:19）ごろ
    const utc = new Date(Math.round((crossJd - UNIX_EPOCH_JD) * 86_400) * 1000);
    expect(utc.toISOString().slice(0, 16)).toBe("2026-08-22T09:19");
  });

  it("境界を越えた直後の月は次の宿（尾宿）に居る", () => {
    const ayanamsa = swe.swe_get_ayanamsa_ut(JD_20260822);
    const target = (((18 * SHUKU_SPAN + ayanamsa) % 360) + 360) % 360;
    const crossJd = swe.swe_mooncross_ut(target, JD_20260822, CALC_FLAGS);

    const before = crossJd - 1 / 24; // 1 時間前
    const after = crossJd + 1 / 24; // 1 時間後
    const shukuAtJd = (jd: number) =>
      shukuOf(
        toSidereal(swe.swe_calc_ut(jd, 1, CALC_FLAGS)[0] as number, swe.swe_get_ayanamsa_ut(jd)),
      ).shuku.name;

    expect(shukuAtJd(before)).toBe("心宿");
    expect(shukuAtJd(after)).toBe("尾宿");
  });
});
