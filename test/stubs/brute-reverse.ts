/**
 * 総当たり版の逆引きホロスコープ ―― astro-viewer の `reverse/reverse.js` の判定を素直に写したもの。
 *
 * 6 時間刻み（0.25 日）で走り、その瞬間に全部の条件が成り立っていれば「その瞬間の暦日」を候補にする。
 * 1 年ぶんで `swe_calc_ut` を 1,460 回 × 条件の天体ぶん叩くので**本番では使えない**が、
 * reverse-horoscope.ts の「窓を求めて交差させる」やり方が同じ答えを出すかを測る物差しとして要る。
 *
 * ⚠ 6 時間刻みなので、**6 時間より短い当たり**は原理的に取りこぼす。
 *   突き合わせ側（test/reverse-horoscope-real.test.ts）はそれを踏まえて
 *   「総当たりが拾った日 ⊆ 新実装の日」＋「新実装だけが拾った日は短い当たりの日」の 2 段で見る。
 */
import { CALC_FLAGS, signIndex, type SwissEph } from "../../src/astro/chart";
import {
  localDayNumber,
  type ReverseHoroscopeRequest,
} from "../../src/reverse-horoscope";

/** reverse.js と同じ走査の刻み（6 時間） */
export const BRUTE_STEP = 0.25;

const BODY_IDS: Record<string, number> = {
  sun: 0,
  moon: 1,
  mercury: 2,
  venus: 3,
  mars: 4,
  jupiter: 5,
  saturn: 6,
  uranus: 7,
  neptune: 8,
  pluto: 9,
};

/**
 * 6 時間刻みの総当たりで、required が全部そろう瞬間を含む暦日（現地）の集合を返す。
 * 走査は範囲の頭から尻まで（尻ちょうどは含めない＝新実装の区間と同じ切り方）。
 */
export function bruteCandidateDays(
  swe: SwissEph,
  request: ReverseHoroscopeRequest,
  rangeStartJd: number,
  rangeEndJd: number,
): Set<number> {
  const required = request.conditions
    .filter((condition) => condition.priority === "required")
    .map((condition) => ({
      id: BODY_IDS[condition.body] as number,
      signIndex: condition.signIndex,
    }));

  const days = new Set<number>();
  for (let jd = rangeStartJd; jd < rangeEndJd; jd += BRUTE_STEP) {
    let met = true;
    for (const condition of required) {
      const lon = swe.swe_calc_ut(jd, condition.id, CALC_FLAGS)[0] as number;
      if (signIndex(lon) !== condition.signIndex) {
        met = false;
        break;
      }
    }
    if (met) days.add(localDayNumber(jd, request.utcOffset));
  }
  return days;
}
