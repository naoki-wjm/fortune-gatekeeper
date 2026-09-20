/**
 * 四柱推命の「天体グルー」＝純関数（src/four-pillars.ts）にエンジンの答えを流し込む配線。
 *
 * もとは `src/astro/tools/four-pillars.ts` の中に埋まっていたものを、
 * **鍵つき層の外からも同じ 1 か所を呼べるように**ここへ移しました（2026-09-20）。
 * ブラウザ用の束ね（src/browser/）も MCP の科（tools/four-pillars.ts）も、命式を立てる道は
 * この 1 本だけ ―― 計算の正本を二重に持たない、というのがこのファイルの存在理由です。
 *
 * ここがやるのは 3 つだけ ―― 出生の瞬間の jd を出す / 太陽黄経を引く / 前後の節入りを探す。
 * 表引きと算法は純関数の持ち場で、断り文の着せ替え（出生データの値を隠す言い換え）は
 * 呼び出し側（tools/four-pillars.ts）の持ち場です ―― ここは `FourPillarsError` を
 * **そのまま投げ上げます**（ブラウザ側では値を隠す必要がないため）。
 *
 * ⚠ KV にも身元にも触れません（`SwissEph` を引数で受けるだけ）。
 */
import {
  SOLAR_TERMS,
  calculateDateFortune,
  calculateFourPillars,
  solarTermSpanFromJd,
  type DateFortuneResult,
  type FourPillarsResult,
  type SolarTermSpan,
} from "../four-pillars";
import { monthBranchOrder, sunLongitude, type NakkoMoment } from "../nakko";
import { AstroError, julianDay, type SwissEph } from "./chart";
import { crossUt } from "./returns";

/**
 * 節入り探索の遡り幅（日）。
 *
 * 節の帯（節入りから次の節入り）は太陽が 30° 進む時間＝ 29〜32 日なので、
 * 40 日戻れば「直前の節入り」が必ず 1 本だけ窓に入る（1 年前の同じ節はもっとずっと手前）。
 */
export const TERM_LOOKBACK_DAYS = 40;

/**
 * 節の帯として辻褄が合う長さ（日）。
 *
 * 実際は 29〜32 日（近日点まわりの冬が短く、遠日点まわりの夏が長い。
 * `test/four-pillars-real.test.ts` が本物の wasm で毎回確かめている）。
 * ここは「壊れた答えを弾く網」なので、実測の外側に少し余裕を持たせてある。
 */
export const TERM_SPAN_MIN_DAYS = 28;
export const TERM_SPAN_MAX_DAYS = 33;

/** 浮動小数の埃ぶんだけ「節入りちょうどの生まれ」を許す幅（日）＝ 0.1 秒 */
export const TERM_EPSILON_DAYS = 1e-6;

/**
 * 出生の瞬間を挟む 2 本の節入りから、節の帯の中の位置（＝大運の起運のもと）を出す。
 *
 * 太陽黄経 30° ごとの境をそのまま探すので、暦の節入り表は引かない。
 * ⚠ `swe_solcross_ut` は wrapper のエラーチェックが壊れている（returns.ts の crossUt 参照）。
 *    crossUt が「開始 jd より後か」を見たうえで、ここでも**帯の形**を検算する
 *    ―― 前の節入り ≦ 出生 ＜ 次の節入り、帯の長さが節らしいか、の 2 つ。
 */
export function solarTermSpanAt(
  swe: SwissEph,
  birthJd: number,
  sunLon: number,
): SolarTermSpan {
  const order = monthBranchOrder(sunLon);
  const previousTerm = SOLAR_TERMS[order] as (typeof SOLAR_TERMS)[number];
  const nextTerm = SOLAR_TERMS[(order + 1) % 12] as (typeof SOLAR_TERMS)[number];

  const nextJd = crossUt(swe, "sun", nextTerm.longitude, birthJd);
  const previousJd = crossUt(swe, "sun", previousTerm.longitude, birthJd - TERM_LOOKBACK_DAYS);

  const span = nextJd - previousJd;
  if (
    previousJd > birthJd + TERM_EPSILON_DAYS ||
    nextJd <= birthJd ||
    span < TERM_SPAN_MIN_DAYS ||
    span > TERM_SPAN_MAX_DAYS
  ) {
    // 断り文に jd を出さない（出生の瞬間そのものなので）
    throw new AstroError(
      "節入り（月柱の境）を計算できませんでした" +
        "（天体計算が節の帯として辻褄の合う答えを返しませんでした）。" +
        "しばらく置いてからもう一度呼んでください。",
    );
  }

  const raw = solarTermSpanFromJd(birthJd, previousJd, nextJd);
  // 節入りちょうどの生まれで −1e-12 のような値になるのを均す（純関数は 0 以上しか受けない）
  return {
    days_since_previous: Math.max(0, raw.days_since_previous),
    days_until_next: raw.days_until_next,
  };
}

/**
 * 出生の瞬間から命式を立てる（jd → 太陽黄経 → 節の帯 → 純関数、の 4 行を 1 か所に）。
 *
 * エンジンを叩くのは `swe_calc_ut` 1 回（太陽）と `swe_solcross_ut` 2 回（前後の節入り）だけ。
 * 純関数が投げる `FourPillarsError` はそのまま上がる ―― 出生データを隠す言い換えは
 * 呼び出し側の持ち場です（ブラウザ側は利用者自身の入力なので隠す必要がない）。
 */
export function computeFourPillarsNatal(
  swe: SwissEph,
  moment: NakkoMoment,
): FourPillarsResult {
  const birthJd = julianDay(swe, moment);
  const sunLon = sunLongitude(swe, moment);
  const term = solarTermSpanAt(swe, birthJd, sunLon);
  return calculateFourPillars({ moment, sun_longitude: sunLon, term });
}

/**
 * 指定日の流年・月運・日運（`include_hour` を立てれば時運も）。
 *
 * エンジンを叩くのは `swe_calc_ut` 1 回（対象日の太陽）だけ ―― 節入りは探さない
 * （巡りの側は帯の中の位置を使わないため）。
 */
export function computeDateFortune(
  swe: SwissEph,
  natal: FourPillarsResult,
  targetMoment: NakkoMoment,
  includeHour: boolean,
): DateFortuneResult {
  return calculateDateFortune(natal, {
    moment: targetMoment,
    sun_longitude: sunLongitude(swe, targetMoment),
    include_hour: includeHour,
  });
}
