/**
 * 年間概要 ―― ソーラーリターンから次のソーラーリターンまでの 1 年を 1 日刻みで走査する。
 *
 * 移植元は astro-viewer の `viewer/calc.js` の calcYearlyRange / formatYearlyRangeText。
 * **日次の状態機械（あのループの意味）はそのまま**で、**天体位置の供給源だけ**を差し替えてある。
 *
 * ⚠ なぜ差し替えるか: 向こうは 1 日ずつ 8 天体を swe_calc_ut する（≒2,900 回）。本物の wasm は
 *    1 回 ≒44µs（速度つき）／17µs（位置のみ）なので合計 ≒126ms ―― **Workers の CPU 上限 10ms を
 *    12 倍超える**。そこで天体ごとに 4〜15 日おきの疎なサンプルを取り、3 次ラグランジュ補間で
 *    日次表を組み立てる（速度は補間の導関数から出すので SEFLG_SPEED を付けずに済む）。
 *    刻み幅は 15 年分（2016〜2030）を本物と突き合わせて天体別に決めた ―― 補間誤差は ≲1e-3°
 *    （Moshier 暦自身の精度と同じ桁）で、紙一重の日に日付が 1 日ずれるのが 15 年で数回。
 *    合計の天体計算は 355 回。同じ日付に当たる天体をまとめて呼ぶ（BASE_STEP の注記）ことで
 *    手元の Node 実測 ≒7〜8ms（Ryzen 9 8945HS）。Workers の実機では `wrangler tail` の cpuTime で要確認。
 *    刻みを変えるなら test/astro-yearly-real.test.ts で検算し直すこと。
 *
 * ここも解釈は持たない ―― 返すのは日付（jd）と角度だけ。文字列化と読み解きは呼び出した側の仕事。
 * chart.ts / returns.ts と同じく wasm には触らない（SwissEph を引数で受け取る）。
 */
import {
  AstroError,
  DEFAULT_ORB,
  SIGNS,
  getAspect,
  getHouse,
  normalizeDegree,
  planetName,
  signIndex,
  type SwissEph,
} from "./chart";

/** 位置だけ取るフラグ: SEFLG_MOSEPH(4)。速度は補間の導関数で出すので SEFLG_SPEED は付けない（付けると 1 回 17µs → 44µs） */
export const POSITION_ONLY_FLAGS = 4;

/**
 * 格子の最小単位（日）。すべての刻み幅はこの倍数にそろえる。
 *
 * ⚠ そろえる理由は CPU: Swiss Ephemeris は同じ jd で続けて呼ぶと地球の位置などを使い回すので、
 *    **同じ日付に当たる天体をまとめて呼ぶ**と 2 天体目以降が半額（実測 37µs → 19µs）になる。
 *    天体ごとにばらばらの日付列を順に呼ぶと、この節約が一切効かない（≒12ms → ≒7ms の差）。
 */
export const BASE_STEP = 4;

/**
 * 追跡する天体と刻み幅（日）。刻みは 15 年分の真値比較で決めた（BASE_STEP の倍数に丸めてある）
 * ――変えるなら test/astro-yearly-real.test.ts で検算し直すこと
 */
export const YEARLY_PLANETS = [
  { id: 2, name: "水星", step: 4, ingress: false, transit: false },
  { id: 3, name: "金星", step: 8, ingress: false, transit: false },
  { id: 4, name: "火星", step: 12, ingress: false, transit: false },
  { id: 5, name: "木星", step: 8, ingress: true, transit: true },
  { id: 6, name: "土星", step: 12, ingress: true, transit: true },
  { id: 7, name: "天王星", step: 12, ingress: true, transit: true },
  { id: 8, name: "海王星", step: 16, ingress: true, transit: true },
  { id: 9, name: "冥王星", step: 16, ingress: true, transit: true },
] as const;

/** ソーラーリターンの間隔は 365.24〜365.26 日。これを大きく外れたら計算を止めて CPU を守る */
const MIN_DAYS = 300;
const MAX_DAYS = 400;

/** 期間の端で切れている印（実際はもっと前から続いていた／もっと後まで続く） */
export type Clip = "start" | "end" | "both";

/** 日次表。添字 d = 0..days（days を含む）で、d 日目は startJd + d */
export interface DailyTable {
  /** 黄経（0〜360 に畳んだもの） */
  lon: number[];
  /** 黄経速度（度/日）。負なら逆行 */
  speed: number[];
  /** この表を作るのに使った天体計算の回数 */
  calls: number;
}

/** 格子の最後の添字 k（k = −1 … lastGridIndex。前後 1 点ずつの袖を含む） */
function lastGridIndex(days: number, step: number): number {
  return Math.ceil(days / step) + 2;
}

/**
 * 全天体ぶんの格子の黄経を、**日付順に**まとめて取る。
 *
 * 返り値は天体ごとの生の黄経列（添字は k + 1、k = −1 … lastGridIndex）。
 * 同じ日付に当たる天体を続けて呼ぶのが肝（BASE_STEP の注記参照）。
 */
export function sampleGrids(
  swe: SwissEph,
  startJd: number,
  days: number,
): { grids: number[][]; calls: number } {
  const grids: number[][] = YEARLY_PLANETS.map(() => []);
  const lastIndex = YEARLY_PLANETS.map((planet) => lastGridIndex(days, planet.step));
  const firstDay = -Math.max(...YEARLY_PLANETS.map((planet) => planet.step));
  const lastDay = Math.max(
    ...YEARLY_PLANETS.map((planet, index) => (lastIndex[index] as number) * planet.step),
  );

  let calls = 0;
  for (let day = firstDay; day <= lastDay; day += BASE_STEP) {
    const jd = startJd + day;
    YEARLY_PLANETS.forEach((planet, index) => {
      if (day % planet.step !== 0) return;
      const k = day / planet.step;
      if (k < -1 || k > (lastIndex[index] as number)) return;
      (grids[index] as number[]).push(
        swe.swe_calc_ut(jd, planet.id, POSITION_ONLY_FLAGS)[0] as number,
      );
      calls++;
    });
  }
  return { grids, calls };
}

/**
 * 疎なサンプル＋3 次ラグランジュ補間で日次表を作る（1 天体ぶんを単独で取る版）。
 *
 * 格子は `t_k = startJd + k * step`（k = −1 … n+2、n = ceil(days / step)）。前後に 1 点ずつ
 * 袖を足すのは、d = 0 と d = days のそばでも 4 点そろえて補間するため。
 * 本番の走査は sampleGrids で全天体をまとめて取ってから tableFromGrid に渡す（CPU の節約）。
 */
export function buildDailyTable(
  swe: SwissEph,
  startJd: number,
  days: number,
  planetId: number,
  step: number,
): DailyTable {
  const grid: number[] = [];
  for (let k = -1; k <= lastGridIndex(days, step); k++) {
    grid.push(swe.swe_calc_ut(startJd + k * step, planetId, POSITION_ONLY_FLAGS)[0] as number);
  }
  return tableFromGrid(grid, days, step);
}

/** 格子の生の黄経列（添字 k + 1）から日次表を組み立てる */
export function tableFromGrid(rawGrid: readonly number[], days: number, step: number): DailyTable {
  // 格子の黄経。0°/360° の継ぎ目で切れないよう、前の点との差で連続に均す
  const grid: number[] = [];
  let previousRaw = 0;
  let turns = 0;
  for (const value of rawGrid) {
    const raw = normalizeDegree(value);
    if (grid.length > 0) {
      const delta = raw - previousRaw;
      if (delta > 180) turns -= 1;
      else if (delta < -180) turns += 1;
    }
    previousRaw = raw;
    grid.push(raw + turns * 360);
  }
  const calls = rawGrid.length;

  const lon: number[] = new Array(days + 1);
  const speed: number[] = new Array(days + 1);
  for (let d = 0; d <= days; d++) {
    const k = Math.floor(d / step);
    const x = (d - k * step) / step;
    // 格子点 k−1, k, k+1, k+2（x = −1, 0, 1, 2）の 4 点
    const y0 = grid[k] as number;
    const y1 = grid[k + 1] as number;
    const y2 = grid[k + 2] as number;
    const y3 = grid[k + 3] as number;

    // ⚠ 4 点をそのまま重み付けせず、**y1 からの差**で計算する。重みの和は数学的には
    //    位置が 1・速度が 0 だが、浮動小数では 1±1e-16 になる。y（数百度）に掛けると
    //    速度に 1e-14°/日 の埃が残り、**止まっている天体が 1 日おきに逆行して見える**。
    //    差で扱えば定数成分がきれいに落ちる（動いていない天体の速度はぴったり 0）。
    const d0 = y0 - y1;
    const d2 = y2 - y1;
    const d3 = y3 - y1;

    const l0 = (-x * (x - 1) * (x - 2)) / 6;
    const l2 = (-(x + 1) * x * (x - 2)) / 2;
    const l3 = ((x + 1) * x * (x - 1)) / 6;
    lon[d] = normalizeDegree(y1 + l0 * d0 + l2 * d2 + l3 * d3);

    // 導関数（度/格子）を step で割って度/日にする
    const g0 = -(3 * x * x - 6 * x + 2) / 6;
    const g2 = -(3 * x * x - 2 * x - 2) / 2;
    const g3 = (3 * x * x - 1) / 6;
    speed[d] = (g0 * d0 + g2 * d2 + g3 * d3) / step;
  }

  return { lon, speed, calls };
}

// ---------------------------------------------------------------------------
// 走査
// ---------------------------------------------------------------------------

export interface YearlyScanInput {
  /** ソーラーリターンの瞬間 */
  startJd: number;
  /** 次のソーラーリターンの瞬間 */
  endJd: number;
  /** ネイタル天体（StoredChart.planets）。id 11（ノード）はアスペクト探索から外す */
  natalPlanets: readonly { id: number; lon: number }[];
  /** ネイタルのカスプ（在ハウス表示用。[0] ダミー＋1..12） */
  cusps: readonly number[];
  angles: { asc: number; mc: number };
  /** 既定は DEFAULT_ORB（1°） */
  orb?: number;
}

/** アスペクトの種類だけ（オーブは窓ごとに別に持つ） */
export interface AspectKind {
  angle: number;
  name: string;
  symbol: string;
}

export interface RetrogradePeriod {
  id: number;
  planet: string;
  startJd: number;
  endJd: number;
  clipped?: Clip;
}

export interface IngressEvent {
  id: number;
  planet: string;
  jd: number;
  signIndex: number;
  sign: string;
  retrograde: boolean;
}

/** アスペクトが成立していた 1 区間 */
interface AspectWindow {
  aspect: AspectKind;
  startJd: number;
  /** 外れた最初の日（期間末まで続いていれば endJd） */
  endJd: number;
  /** 窓の中でオーブが最小だった日 */
  exactJd: number;
  minOrb: number;
  clipped?: Clip;
}

export interface AngleAspectWindow extends AspectWindow {
  transitId: number;
  transit: string;
  angle: "ASC" | "MC";
}

export interface NatalAspectWindow extends AspectWindow {
  transitId: number;
  transit: string;
  natalId: number;
  natal: string;
  house: number;
}

export interface YearlyScan {
  days: number;
  /** 天体計算の合計回数（診断用） */
  ephemerisCalls: number;
  retrogrades: RetrogradePeriod[];
  ingresses: IngressEvent[];
  angleAspects: AngleAspectWindow[];
  natalAspects: NatalAspectWindow[];
}

/** アスペクト探索の相手（ネイタル天体・ASC・MC を同じ形に均す） */
interface AspectTarget {
  lon: number;
}

/**
 * 1 天体 × 1 相手ぶんのアスペクト窓を拾う。
 *
 * calc.js と同じ状態機械 ―― 非 null で入り、null で抜ける。抜けた日（＝外れた最初の日）を
 * end に置き、期間末に未閉じなら endJd で閉じる。
 */
function scanAspectWindows(
  table: DailyTable,
  target: AspectTarget,
  startJd: number,
  endJd: number,
  days: number,
  orb: number,
): AspectWindow[] {
  const windows: AspectWindow[] = [];
  let open: { aspect: AspectKind; startD: number; exactD: number; minOrb: number } | null = null;

  const close = (
    current: { aspect: AspectKind; startD: number; exactD: number; minOrb: number },
    endD: number | null,
  ): void => {
    const window: AspectWindow = {
      aspect: current.aspect,
      startJd: startJd + current.startD,
      endJd: endD === null ? endJd : startJd + endD,
      exactJd: startJd + current.exactD,
      minOrb: Math.round(current.minOrb * 1000) / 1000,
    };
    const clipped = clipOf(current.startD === 0, endD === null);
    if (clipped) window.clipped = clipped;
    windows.push(window);
  };

  for (let d = 0; d <= days; d++) {
    const hit = getAspect(table.lon[d] as number, target.lon, orb);
    if (hit) {
      if (!open) {
        open = {
          aspect: { angle: hit.angle, name: hit.name, symbol: hit.symbol },
          startD: d,
          exactD: d,
          minOrb: hit.orb,
        };
      } else if (hit.orb < open.minOrb) {
        open.minOrb = hit.orb;
        open.exactD = d;
      }
    } else if (open) {
      close(open, d);
      open = null;
    }
  }
  if (open) close(open, null);

  return windows;
}

/** 期間の頭・末での切れ方 */
function clipOf(atStart: boolean, atEnd: boolean): Clip | null {
  if (atStart && atEnd) return "both";
  if (atStart) return "start";
  if (atEnd) return "end";
  return null;
}

/**
 * 1 年ぶんの走査。返すのは jd ベース ―― 日付文字列にするのは呼び出し側（時差を知っているのは向こう）。
 */
export function scanYearlyRange(swe: SwissEph, input: YearlyScanInput): YearlyScan {
  const { startJd, endJd } = input;
  const orb = input.orb ?? DEFAULT_ORB;
  const days = Math.floor(endJd - startJd);

  if (!Number.isFinite(days) || days < MIN_DAYS || days > MAX_DAYS) {
    throw new AstroError(
      `走査する期間が ${Number.isFinite(days) ? days : "不明な"} 日になりました。` +
        `ソーラーリターンの間隔は約365日なので、${MIN_DAYS}〜${MAX_DAYS}日を外れる期間は計算しません` +
        "（年の指定を確かめてください）。",
    );
  }

  // 天体位置の供給源（ここだけが天体計算を呼ぶ。日付順にまとめて取るのは CPU のため）
  const sampled = sampleGrids(swe, startJd, days);
  const ephemerisCalls = sampled.calls;
  const tables = YEARLY_PLANETS.map((planet, index) =>
    tableFromGrid(sampled.grids[index] as number[], days, planet.step),
  );

  const retrogrades: RetrogradePeriod[] = [];
  const ingresses: IngressEvent[] = [];

  YEARLY_PLANETS.forEach((planet, index) => {
    const table = tables[index] as DailyTable;

    // 逆行 ―― speed < 0 で入り、>= 0 で抜ける（calc.js と同じ）
    let start: number | null = null;
    for (let d = 0; d <= days; d++) {
      const retro = (table.speed[d] as number) < 0;
      if (retro && start === null) start = d;
      else if (!retro && start !== null) {
        pushRetrograde(retrogrades, planet.id, planet.name, startJd, endJd, start, d);
        start = null;
      }
    }
    if (start !== null) {
      pushRetrograde(retrogrades, planet.id, planet.name, startJd, endJd, start, null);
    }

    // イングレス ―― 前日と星座が違ったらその日（逆行で前の星座へ戻る場合も数える。calc.js と同じ）
    if (!planet.ingress) return;
    for (let d = 1; d <= days; d++) {
      const sign = signIndex(table.lon[d] as number);
      if (sign === signIndex(table.lon[d - 1] as number)) continue;
      ingresses.push({
        id: planet.id,
        planet: planet.name,
        jd: startJd + d,
        signIndex: sign,
        sign: SIGNS[sign] as string,
        retrograde: (table.speed[d] as number) < 0,
      });
    }
  });

  ingresses.sort((a, b) => a.jd - b.jd || a.id - b.id);

  // アスペクト ―― 木星〜冥王星 ×（ネイタル天体（ノード除く）／ASC／MC）
  const natalTargets = input.natalPlanets.filter((planet) => planet.id !== 11);
  const angleAspects: AngleAspectWindow[] = [];
  const natalAspects: NatalAspectWindow[] = [];

  YEARLY_PLANETS.forEach((planet, index) => {
    if (!planet.transit) return;
    const table = tables[index] as DailyTable;

    for (const natal of natalTargets) {
      for (const window of scanAspectWindows(table, natal, startJd, endJd, days, orb)) {
        natalAspects.push({
          ...window,
          transitId: planet.id,
          transit: planet.name,
          natalId: natal.id,
          natal: planetName(natal.id),
          house: getHouse(natal.lon, input.cusps),
        });
      }
    }

    const angles: { name: "ASC" | "MC"; lon: number }[] = [
      { name: "ASC", lon: input.angles.asc },
      { name: "MC", lon: input.angles.mc },
    ];
    for (const angle of angles) {
      for (const window of scanAspectWindows(table, angle, startJd, endJd, days, orb)) {
        angleAspects.push({
          ...window,
          transitId: planet.id,
          transit: planet.name,
          angle: angle.name,
        });
      }
    }
  });

  // 構造化データの並びは start の時系列。同じ日に始まった窓は天体順→相手の順で落ち着かせる
  angleAspects.sort(
    (a, b) => a.startJd - b.startJd || a.transitId - b.transitId || angleRank(a) - angleRank(b),
  );
  natalAspects.sort(
    (a, b) => a.startJd - b.startJd || a.transitId - b.transitId || a.natalId - b.natalId,
  );

  return { days, ephemerisCalls, retrogrades, ingresses, angleAspects, natalAspects };
}

/** ASC が先、MC が後（ネイタル天体でいう「並び順」の代わり） */
function angleRank(window: AngleAspectWindow): number {
  return window.angle === "ASC" ? 0 : 1;
}

function pushRetrograde(
  into: RetrogradePeriod[],
  id: number,
  planet: string,
  startJd: number,
  endJd: number,
  startD: number,
  endD: number | null,
): void {
  const period: RetrogradePeriod = {
    id,
    planet,
    startJd: startJd + startD,
    endJd: endD === null ? endJd : startJd + endD,
  };
  const clipped = clipOf(startD === 0, endD === null);
  if (clipped) period.clipped = clipped;
  into.push(period);
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** 端で切れている窓の但し書き */
function clipNote(clipped: Clip | undefined): string {
  if (clipped === "both") return "期間を通して継続";
  if (clipped === "start") return "期間頭から継続";
  if (clipped === "end") return "期間末まで継続";
  return "";
}

/** テキストでの並び: 天体順（木星→冥王星）→相手の順→時系列（calc.js と同じ） */
function byPlanetThenStart(a: AngleAspectWindow, b: AngleAspectWindow): number {
  return a.transitId - b.transitId || angleRank(a) - angleRank(b) || a.startJd - b.startJd;
}

function byPlanetThenNatal(a: NatalAspectWindow, b: NatalAspectWindow): number {
  return a.transitId - b.transitId || a.natalId - b.natalId || a.startJd - b.startJd;
}

/**
 * calc.js の formatYearlyRangeText と同じ 4 節。日付だけはフル表記（"YYYY-MM-DD"）にしてある。
 * `dateOf` は呼び出し側が渡す ―― 時差込みの暦を知っているのは向こうなので。
 */
export function formatYearlyText(scan: YearlyScan, dateOf: (jd: number) => string): string[] {
  const lines: string[] = ["■ 逆行期間"];
  for (const planet of YEARLY_PLANETS) {
    const periods = scan.retrogrades.filter((period) => period.id === planet.id);
    if (periods.length === 0) {
      lines.push(`${planet.name}: なし`);
      continue;
    }
    const text = periods
      .map((period) => {
        const note = clipNote(period.clipped);
        return `${dateOf(period.startJd)}〜${dateOf(period.endJd)}${note ? `（${note}）` : ""}`;
      })
      .join(", ");
    lines.push(`${planet.name}: ${text}`);
  }

  lines.push("");
  lines.push("■ 星座イングレス（木星〜冥王星）");
  if (scan.ingresses.length === 0) {
    lines.push("なし");
  } else {
    for (const ingress of scan.ingresses) {
      const back = ingress.retrograde ? "（逆行で戻る）" : "";
      lines.push(`${ingress.planet}: ${dateOf(ingress.jd)} ${ingress.sign}入り${back}`);
    }
  }

  lines.push("");
  lines.push("■ ASC / MC へのトランジット");
  if (scan.angleAspects.length === 0) {
    lines.push("なし");
  } else {
    for (const window of [...scan.angleAspects].sort(byPlanetThenStart)) {
      lines.push(
        `t.${window.transit} ${window.aspect.symbol} n.${window.angle}: ${formatWindow(window, dateOf)}`,
      );
    }
  }

  lines.push("");
  lines.push("■ ネイタル天体へのトランジット");
  if (scan.natalAspects.length === 0) {
    lines.push("なし");
  } else {
    for (const window of [...scan.natalAspects].sort(byPlanetThenNatal)) {
      lines.push(
        `t.${window.transit} ${window.aspect.symbol} n.${window.natal}(${window.house}H): ` +
          formatWindow(window, dateOf),
      );
    }
  }

  return lines;
}

/** 「2026-05-01〜2026-05-20（最接近 2026-05-10、期間末まで継続）」 */
function formatWindow(window: AspectWindow, dateOf: (jd: number) => string): string {
  const note = clipNote(window.clipped);
  const detail = `最接近 ${dateOf(window.exactJd)}${note ? `、${note}` : ""}`;
  return `${dateOf(window.startJd)}〜${dateOf(window.endJd)}（${detail}）`;
}
