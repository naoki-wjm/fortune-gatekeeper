/**
 * テスト用の偽 SwissEPH。
 *
 * 本物の wasm はテストからは読まない（test/stubs/engine.ts の注記参照）ので、
 * 「決め打ちの座標を返すエンジン」を注入して、その上の層だけを検算する。
 *
 * 天体は id×30° ＋ offset の位置に等間隔で並ぶ。offset を動かせば
 * 「ネイタルとトランジットで少しだけ位置が違う」状況を自由に作れる。
 * jd だけは本物の式（Gregorian → ユリウス日）で作るので、時差の扱いは実物と同じ土俵で検算できる。
 */
import { normalizeDegree, type SwissEph } from "../../src/astro/chart";

/** [0] はダミー。ASC（1H カスプ）= 90°、以降 30° 刻み。10H が 0° をまたぐ形 */
export const FAKE_CUSPS = [0, 90, 120, 150, 180, 210, 240, 270, 300, 330, 0, 30, 60];

/** [0]=ASC, [1]=MC */
export const FAKE_ASCMC = [90, 300, 0, 0, 0, 0, 0, 0];

/** ARMC 方式で立てたときのカスプ（本来の swe_houses とは別物だと分かる形にずらしてある） */
export const FAKE_ARMC_CUSPS = [0, 100, 130, 160, 190, 220, 250, 280, 310, 340, 10, 40, 70];
export const FAKE_ARMC_ASCMC = [100, 310, 0, 0, 0, 0, 0, 0];

/** 偽エンジンが返す黄道傾斜（swe_calc_ut の planetId = -1） */
export const FAKE_EPS = 23.44;

export interface FakeEngine extends SwissEph {
  /** 天体位置のずらし幅（度）。テストから書き換える */
  offset: number;
  /** swe_julday が返した値の記録 */
  juldays: number[];
  /** swe_houses が受け取った引数の記録 */
  houseCalls: { jd: number; lat: number; lng: number; hsys: string }[];
  /** swe_houses_armc が受け取った引数の記録 */
  armcCalls: { armc: number; lat: number; eps: number; hsys: string }[];
  /** swe_mooncross_ut / swe_solcross_ut が受け取った引数の記録 */
  crossCalls: { kind: "moon" | "sun"; targetLon: number; startJd: number; flags: number }[];
  /**
   * 通過の周期（日）。既定は月 27.32 日 / 太陽 365.24 日。
   * 「開始 jd の直後に来る周期の格子点」を返す作りなので、月に 2 回入る月・0 回の月も作れる。
   */
  moonPeriod: number;
  sunPeriod: number;
  /** 周期の位相をずらす（この jd を通過の 1 つとして格子を敷く） */
  moonAnchorJd: number;
  sunAnchorJd: number;
  /** true にすると通過計算がエラー相当（開始 jd 以下）を返す＝壊れた wrapper の再現 */
  crossFails: boolean;
}

export function makeFakeEngine(): FakeEngine {
  const fake: FakeEngine = {
    offset: 0,
    juldays: [],
    houseCalls: [],
    armcCalls: [],
    crossCalls: [],
    moonPeriod: 27.32,
    sunPeriod: 365.24,
    moonAnchorJd: 2_461_000.5,
    sunAnchorJd: 2_461_000.5,
    crossFails: false,

    swe_julday(year: number, month: number, day: number, hour: number, _gregflag: number): number {
      const midnight = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 2440587.5;
      const jd = midnight + hour / 24;
      fake.juldays.push(jd);
      return jd;
    },

    swe_calc_ut(_jd: number, planetId: number, _flags: number): number[] {
      // SE_ECL_NUT（-1）の [0] は真黄道傾斜。天体と同じ式に乗せると意味不明な値になるので分ける
      if (planetId === -1) return [FAKE_EPS, 23.44, 0, 0, 0, 0];
      const lon = normalizeDegree(planetId * 30 + fake.offset);
      // 金星（id 3）だけ逆行させておく
      const speed = planetId === 3 ? -0.5 : 1;
      return [lon, 0, 1, speed, 0, 0];
    },

    swe_houses(jd: number, lat: number, lng: number, hsys: string) {
      fake.houseCalls.push({ jd, lat, lng, hsys });
      return { cusps: [...FAKE_CUSPS], ascmc: [...FAKE_ASCMC] };
    },

    swe_houses_armc(armc: number, lat: number, eps: number, hsys: string) {
      fake.armcCalls.push({ armc, lat, eps, hsys });
      return { cusps: [...FAKE_ARMC_CUSPS], ascmc: [...FAKE_ARMC_ASCMC] };
    },

    swe_mooncross_ut(targetLon: number, startJd: number, flags: number): number {
      fake.crossCalls.push({ kind: "moon", targetLon, startJd, flags });
      return nextCrossing(startJd, fake.moonAnchorJd, fake.moonPeriod);
    },

    swe_solcross_ut(targetLon: number, startJd: number, flags: number): number {
      fake.crossCalls.push({ kind: "sun", targetLon, startJd, flags });
      return nextCrossing(startJd, fake.sunAnchorJd, fake.sunPeriod);
    },
  };

  /** アンカーから period 刻みの格子のうち、startJd の直後のもの */
  function nextCrossing(startJd: number, anchorJd: number, period: number): number {
    // 壊れた wrapper（返り値を見ていない）を通ったときの再現。呼び出し側が弾くはず
    if (fake.crossFails) return -1;
    const steps = Math.floor((startJd - anchorJd) / period) + 1;
    return anchorJd + steps * period;
  }

  return fake;
}
