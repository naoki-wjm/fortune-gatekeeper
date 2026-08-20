/**
 * リターン（ルナリターン・ソーラーリターン）と二次進行（セカンダリー・プログレッション）の計算。
 *
 * chart.ts と同じく **wasm には触らない**（SwissEPH インスタンスを引数で受け取る）ので、
 * テストは偽エンジンを渡すだけで回る。ここも解釈は一切しない ―― 返すのは瞬間と座標だけ。
 *
 * 移植元:
 *   - リターン … Swiss Ephemeris の swe_mooncross_ut / swe_solcross_ut（総当たりではなく一発計算）
 *   - 二次進行 … astro-viewer の `viewer/calc.js` の calculateProgression（一日一年法・ARMC 方式）
 */
import {
  AstroError,
  CALC_FLAGS,
  PROGRESSION_YEAR_DAYS,
  anglesOf,
  computeChart,
  computePlanets,
  julianDay,
  mcToArmc,
  normalizeDegree,
  type ComputedChart,
  type MomentInput,
  type PlanetPosition,
  type SwissEph,
} from "./chart";

/** どちらの天体が帰ってくるか */
export type ReturnKind = "moon" | "sun";

const KIND_LABEL: Record<ReturnKind, string> = { moon: "月", sun: "太陽" };

/** 探索の打ち切り。1 か月にルナリターンは多くて 2 回なので、これで十分すぎる */
const MAX_CROSSINGS = 4;

/**
 * 指定黄経を天体が通過する瞬間（UT のユリウス日）を 1 つ求める。
 *
 * ⚠ **wrapper のエラーチェックは壊れている**。sweph-wasm.js の
 *    `swe_mooncross_ut(x2cross, jd, flags)` は `if (flags < OK) throw` と書かれていて、
 *    見るべき返り値ではなく flags 引数を見ている（flags は常に正なので絶対に throw しない）。
 *    複製ファイルには手を入れない方針なので、**ここで返り値を検算する**。
 *    Swiss Ephemeris は失敗時に負の値を返すので、「開始 jd より後」を満たさなければ失敗とみなす。
 */
export function crossUt(
  swe: SwissEph,
  kind: ReturnKind,
  targetLon: number,
  startJd: number,
): number {
  const jd =
    kind === "moon"
      ? swe.swe_mooncross_ut(targetLon, startJd, CALC_FLAGS)
      : swe.swe_solcross_ut(targetLon, startJd, CALC_FLAGS);

  if (typeof jd !== "number" || !Number.isFinite(jd) || jd <= startJd) {
    throw new AstroError(
      `${KIND_LABEL[kind]}が同じ黄経に戻る瞬間を計算できませんでした` +
        "（天体計算が探索開始より後の答えを返しませんでした）。" +
        "年月の指定を変えて試すか、しばらく置いてからもう一度呼んでください。",
    );
  }
  return jd;
}

/**
 * `startJd` 以後・`endJd` 未満に入るリターンを**すべて**拾う（ルナリターンは月に 2 回あることがある）。
 * 1 つ見つけるたびに **+1 日** から探し直す ―― 同じ瞬間を二度拾わないための最小の刻み。
 */
export function crossingsInRange(
  swe: SwissEph,
  kind: ReturnKind,
  targetLon: number,
  startJd: number,
  endJd: number,
): number[] {
  const found: number[] = [];
  let cursor = startJd;
  while (found.length < MAX_CROSSINGS) {
    const jd = crossUt(swe, kind, targetLon, cursor);
    if (jd >= endJd) break;
    found.push(jd);
    cursor = jd + 1;
  }
  return found;
}

// ---------------------------------------------------------------------------
// 二次進行（一日一年法）
// ---------------------------------------------------------------------------

export interface ProgressionInput {
  /** 出生の瞬間（現地時刻＋時差） */
  natal: MomentInput;
  /** 出生地 */
  lat: number;
  lng: number;
  houseSystem: string;
  /** 見たい日（暦日。時刻は正午 UT に固定する ―― calc.js と同じ） */
  target: { year: number; month: number; day: number };
}

export interface ProgressionResult {
  /** 出生図（原本から毎回引き直す。参考欄に出すぶんだけ） */
  natalChart: ComputedChart;
  natalJd: number;
  /** 対象日（正午 UT）のユリウス日 */
  targetJd: number;
  /** 進行図の実 jd（＝出生 jd ＋ 経過年数） */
  progressedJd: number;
  /** 経過年数（小数。36.5 なら 36 歳半） */
  ageYears: number;
  /** ソーラーアーク（進行太陽 − 出生太陽、度） */
  solarArc: number;
  progressedPlanets: PlanetPosition[];
  /** 進行図のカスプ（[0] ダミー＋1..12） */
  progressedCusps: number[];
  progressedAngles: { asc: number; mc: number };
}

/**
 * 二次進行（セカンダリー・プログレッション）。
 *
 * 一日一年法 ―― 出生の翌日の空が 1 歳、翌々日が 2 歳。
 * 進行 ASC / MC は太陽弧（ソーラーアーク）で MC を動かし、そこから ARMC を出して
 * `swe_houses_armc` でハウスを立てる（calc.js の作法をそのまま踏襲。緯度は出生地のもの）。
 */
export function computeProgression(swe: SwissEph, input: ProgressionInput): ProgressionResult {
  const place = { lat: input.lat, lng: input.lng, houseSystem: input.houseSystem };
  const natalChart = computeChart(swe, input.natal, place);
  const natalJd = julianDay(swe, input.natal);

  // 対象日は正午 UT で見る（1 時間のズレは進行側で約 0.03 秒。日付だけ効けばよい）
  const targetJd = swe.swe_julday(input.target.year, input.target.month, input.target.day, 12, 1);
  const ageYears = (targetJd - natalJd) / PROGRESSION_YEAR_DAYS;
  if (ageYears < 0) {
    throw new AstroError(
      "対象日が出生より前です。二次進行は出生以後の日付でしか意味を持ちません。",
    );
  }
  const progressedJd = natalJd + ageYears; // 「年」をそのまま「日」として足す

  const progressedPlanets = computePlanets(swe, progressedJd);

  const natalSun = natalChart.planets.find((planet) => planet.id === 0);
  const progressedSun = progressedPlanets.find((planet) => planet.id === 0);
  if (!natalSun || !progressedSun) {
    throw new AstroError("進行図の太陽を計算できませんでした");
  }
  const solarArc = normalizeDegree(progressedSun.lon - natalSun.lon);

  const progressedMc = normalizeDegree(anglesOf(natalChart).mc + solarArc);
  // SE_ECL_NUT(-1) の [0] は真黄道傾斜
  const eps = swe.swe_calc_ut(progressedJd, -1, CALC_FLAGS)[0] as number;
  const armc = mcToArmc(progressedMc, eps);
  const houses = swe.swe_houses_armc(armc, input.lat, eps, input.houseSystem);

  return {
    natalChart,
    natalJd,
    targetJd,
    progressedJd,
    ageYears,
    solarArc,
    progressedPlanets,
    progressedCusps: houses.cusps,
    progressedAngles: { asc: houses.cusps[1] as number, mc: houses.ascmc[1] as number },
  };
}

/** 経過年数 → 「36歳4ヶ月相当」。日単位の端数は切り捨て */
export function formatAge(ageYears: number): string {
  const years = Math.floor(ageYears);
  const months = Math.floor((ageYears - years) * 12);
  return `${years}歳${months}ヶ月相当`;
}

/** ソーラーアーク → 「35°42′」（星座を持たない“弧”なので formatDegree とは別物） */
export function formatArc(arc: number): string {
  const total = Math.floor(normalizeDegree(arc) * 60 + 1e-6);
  const degree = Math.floor(total / 60);
  const minute = total % 60;
  return `${degree}°${String(minute).padStart(2, "0")}′`;
}
