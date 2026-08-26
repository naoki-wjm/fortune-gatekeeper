/**
 * 月まわりの暦 ―― 朔望・月の星座入り・ボイドタイム・食を、期間まるごと 1 枚に。
 *
 * 位置づけは nakko.ts と同じ「公開層の計算モジュール」。**乱数なし・個人データなし**（誕生日も
 * 場所も受けない＝誰が呼んでも同じ答え）なので、公開の入口 `POST /mcp` に置いてある。
 * 鍵つきの入口 `/astro/mcp` にはカード層まるごとの同居（スーパーセット化）で自動的に載る。
 *
 * ここも解釈は一切持たない ―― 返すのは時刻と星座と名前だけ。「ボイド中は何をすべきか」の
 * たぐいは 1 文字も書かない（読むのは呼び出した側の LLM）。
 *
 * 天体計算の純関数（astro/chart.ts の星座と度数、astro/returns.ts の crossUt、
 * astro/events.ts の 3 次エルミート補間）は借りてよい ―― 公開層が触ってはいけないのは
 * 「KV・身元・出生データを扱う astro モジュール」のほうで、天体計算そのものは納甲（nakko.ts）が
 * すでに同じ経路で使っている。store.ts / context.ts / tools/* / astro-mcp.ts は読まない。
 *
 * 計算の作り:
 *
 *  - **格子＋補間**（events.ts の流儀）。月は 6 時間おき、太陽〜火星は 1 日おき、木星〜冥王星は
 *    4 日おきに位置と速度を取り、あいだは 3 次エルミート補間で埋める。62 日でも天体計算は
 *    650 回ほどで、二分法の途中では wasm を 1 度も呼ばない。
 *  - **朔望**は離角（月の黄経 − 太陽の黄経）が 0 / 90 / 180 / 270 を跨ぐ瞬間。
 *  - **ボイドのアスペクト**は月と相手の黄経差が 0/60/90/120/180（と裏側の 240/270/300）を
 *    跨ぐ瞬間。月は 6 時間で 3.3° しか動かず、隣り合う目標は最短でも 30° 離れているので、
 *    1 区間に跨ぎは高々 1 つ ―― 相手が逆行していても差の符号だけを見るので扱いは同じ。
 *  - **星座入り**だけは補間せず `swe_mooncross_ut` の一発計算（ボイドの終わりの時刻そのものなので、
 *    ここは厳密に）。⚠ wrapper のエラーチェックは壊れているので returns.ts の `crossUt` を通す。
 *  - **食**は `swe_sol_eclipse_when_glob` / `swe_lun_eclipse_when`（global ＝地球上のどこかで
 *    起きるもの。場所を受けないので「どこで見えるか」は返さない）。
 */
import {
  ASPECTS,
  AstroError,
  CALC_FLAGS,
  SIGNS,
  dateFromJulianDay,
  julianDay,
  normalizeDegree,
  planetName,
  signIndex,
  type SwissEph,
} from "./astro/chart";
import { formatPlainMoment, pad, parseStartDate } from "./astro/calendar";
import { positionAt, wrap180, type BodySample } from "./astro/events";
import { crossUt } from "./astro/returns";
import { noReadingNote } from "./phrases";

// ---------------------------------------------------------------------------
// 台帳と定数
// ---------------------------------------------------------------------------

/** days の既定・下限・上限（上限は CPU の目安から。62 日 ≒ 2 朔望月） */
export const MOON_CALENDAR_DEFAULT_DAYS = 14;
export const MOON_CALENDAR_MIN_DAYS = 1;
export const MOON_CALENDAR_MAX_DAYS = 62;

/** utc_offset の既定（cast_hexagram と同じ流儀＝日本時間） */
export const MOON_CALENDAR_DEFAULT_UTC_OFFSET = 9;

/** ボイド判定の相手天体の組（流派で割れるところなので名前で固定する） */
export const VOC_BODY_SETS = ["modern", "traditional"] as const;
export type VocBodySet = (typeof VOC_BODY_SETS)[number];

/**
 * ボイドの相手天体（**月とノードは入れない**）。
 * modern ＝太陽と水星〜冥王星の 9、traditional ＝土星までの 7（近代以降に見つかった 3 つを外す）。
 */
const VOC_BODY_IDS: Record<VocBodySet, readonly number[]> = {
  modern: [0, 2, 3, 4, 5, 6, 7, 8, 9],
  traditional: [0, 2, 3, 4, 5, 6],
};

/** 相手天体の組の呼び名（テキストの規約行で使う） */
const VOC_BODY_SET_LABEL: Record<VocBodySet, string> = {
  modern: "現代式（太陽・水星・金星・火星・木星・土星・天王星・海王星・冥王星の 9 天体）",
  traditional: "伝統式（太陽・水星・金星・火星・木星・土星の 7 天体）",
};

/** 月の id（SE_MOON） */
const MOON_ID = 1;

/** 月の格子の刻み（日）＝6 時間。この刻みが跨ぎ検出と二分法の区間になる */
export const MOON_STEP = 0.25;

/** 相手天体の格子の刻み（日）。events.ts が本物の wasm と突き合わせて決めた値と同じ */
const BODY_STEPS: ReadonlyMap<number, number> = new Map([
  [0, 1],
  [2, 1],
  [3, 1],
  [4, 1],
  [5, 4],
  [6, 4],
  [7, 4],
  [8, 4],
  [9, 4],
]);

/**
 * 期間の前後に伸ばす格子の袖（日）。
 * 月が 1 つの星座に居るのは最長でも約 2.55 日（最も遅いときで 11.8°/日）なので、
 * 3 日あれば「期間の頭より前の直近の星座入り」も「期間の尻の次の星座入り」も必ず捕まる。
 */
const EDGE_MARGIN_DAYS = 3;

/** 二分法の回数。6 時間の区間なら 20 回で 2 秒を切る（分単位には過剰なほど） */
const BISECTION_STEPS = 20;

/** 星座入りの数の上限（62 日なら 30 回ほど。壊れたエンジンで無限に回らないための止め木） */
const MAX_INGRESSES = 64;

/** 期間内の食の数の上限（食は年に 4〜7 回なので 62 日で 2〜3 が上限。同上の止め木） */
const MAX_ECLIPSES = 8;

/**
 * 食の計算に渡すフラグ ＝ SEFLG_MOSEPH のみ（CALC_FLAGS から SEFLG_SPEED を落としたもの）。
 * 天体計算と同じ Moshier モード固定＝天文暦ファイルを読みに行かない。
 */
const ECLIPSE_FLAGS = 4;

/** 朔望の 4 相（離角＝月の黄経 − 太陽の黄経） */
const PHASE_TARGETS = [
  { kind: "new", angle: 0, label: "新月" },
  { kind: "first_quarter", angle: 90, label: "上弦" },
  { kind: "full", angle: 180, label: "満月" },
  { kind: "last_quarter", angle: 270, label: "下弦" },
] as const;

export type MoonPhaseKind = (typeof PHASE_TARGETS)[number]["kind"];

/**
 * 月と相手の黄経差が取りうる「メジャーアスペクトの離角」8 通り。
 * 60/90/120 は前後 2 か所ずつあるので、目標は 8 つ・アスペクトは 5 種になる。
 */
const ASPECT_TARGETS: readonly { target: number; angle: number }[] = [
  { target: 0, angle: 0 },
  { target: 60, angle: 60 },
  { target: 90, angle: 90 },
  { target: 120, angle: 120 },
  { target: 180, angle: 180 },
  { target: 240, angle: 120 },
  { target: 270, angle: 90 },
  { target: 300, angle: 60 },
];

/** 日食の種類（型フラグではなく名前で返す） */
export type SolarEclipseType = "total" | "annular" | "partial" | "hybrid";
/** 月食の種類（半影食も入れる＝type で見分けがつく） */
export type LunarEclipseType = "total" | "partial" | "penumbral";

const SOLAR_ECLIPSE_LABEL: Record<SolarEclipseType, string> = {
  total: "皆既日食",
  annular: "金環日食",
  partial: "部分日食",
  hybrid: "金環皆既日食",
};

const LUNAR_ECLIPSE_LABEL: Record<LunarEclipseType, string> = {
  total: "皆既月食",
  partial: "部分月食",
  penumbral: "半影月食",
};

// ---------------------------------------------------------------------------
// 返り値の形
// ---------------------------------------------------------------------------

export interface MoonPhaseEvent {
  kind: MoonPhaseKind;
  /** 現地時刻（例 "2026-08-26 03:12+09:00"） */
  time: string;
  moon_sign: string;
  /** 星座の中での度数（0〜30・小数 2 桁）。派生値なので出す */
  moon_degree: number;
}

export interface MoonIngressEvent {
  time: string;
  sign: string;
  from_sign: string;
}

export interface LastAspect {
  body: string;
  aspect: string;
  angle: number;
  time: string;
}

export interface VoidOfCourseEvent {
  start: string;
  end: string;
  sign: string;
  /** その星座に居るあいだ 1 つもアスペクトが無ければ null（note が付く） */
  last_aspect: LastAspect | null;
  /** 期間の外にはみ出す端も実時刻のまま返す＝切っていない、の印 */
  clipped: false;
  note?: string;
}

export interface EclipseEvent {
  kind: "solar" | "lunar";
  type: SolarEclipseType | LunarEclipseType;
  /** 食の最大の瞬間 */
  maximum: string;
}

export interface MoonAtStart {
  time: string;
  sign: string;
  degree: number;
  void_of_course: boolean;
}

export interface MoonCalendarConventions {
  void_of_course: "last_exact_major_aspect_to_next_ingress";
  voc_bodies: VocBodySet;
  aspects: number[];
  orb: 0;
  eclipses: "global";
  zodiac: "tropical";
  ephemeris: "moshier";
}

export interface MoonCalendarResult {
  range: { start: string; end: string; days: number; utc_offset: number };
  moon_at_start: MoonAtStart;
  phases: MoonPhaseEvent[];
  ingresses: MoonIngressEvent[];
  void_of_course: VoidOfCourseEvent[];
  eclipses: EclipseEvent[];
  conventions: MoonCalendarConventions;
}

/** 引数を読み取った結果（暦日の start と日数・時差・相手天体の組） */
export interface MoonCalendarRequest {
  start: { year: number; month: number; day: number };
  days: number;
  utcOffset: number;
  vocBodies: VocBodySet;
}

// ---------------------------------------------------------------------------
// 引数の検算
// ---------------------------------------------------------------------------

/** その瞬間を utcOffset の暦で見た日付（moon_calendar は 0 時始まりなので日付だけ要る） */
function localDateOf(now: Date, utcOffset: number): { year: number; month: number; day: number } {
  const shifted = new Date(now.getTime() + utcOffset * 3_600_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * moon_calendar の引数を読み取る。
 * 天体計算より先に全部弾く ―― 断るだけなら wasm に触らずに済む。
 */
export function parseMoonCalendarArguments(raw: unknown, now: Date): MoonCalendarRequest {
  const args = (raw ?? {}) as Record<string, unknown>;

  const rawOffset = args["utc_offset"];
  let utcOffset = MOON_CALENDAR_DEFAULT_UTC_OFFSET;
  if (rawOffset !== undefined && rawOffset !== null) {
    if (typeof rawOffset !== "number" || !Number.isFinite(rawOffset)) {
      throw new AstroError("utc_offset は数値で指定してください（例: 9 / 5.5 / -3）");
    }
    if (rawOffset < -14 || rawOffset > 14) {
      throw new AstroError(`utc_offset は -14 以上 14 以下で指定してください: ${rawOffset}`);
    }
    utcOffset = rawOffset;
  }

  const rawStart = args["start"];
  let start: { year: number; month: number; day: number };
  if (rawStart === undefined || rawStart === null) {
    start = localDateOf(now, utcOffset);
  } else {
    if (typeof rawStart !== "string") {
      throw new AstroError('start は "YYYY-MM-DD" の文字列で指定してください（例: 2026-08-25）');
    }
    // 書式・月日の範囲・実在しない暦日はここで弾く（占星術層の transit_events と同じ検算器）
    start = parseStartDate(rawStart);
  }

  const rawDays = args["days"];
  let days = MOON_CALENDAR_DEFAULT_DAYS;
  if (rawDays !== undefined && rawDays !== null) {
    if (typeof rawDays !== "number" || !Number.isInteger(rawDays)) {
      throw new AstroError("days は整数で指定してください");
    }
    if (rawDays < MOON_CALENDAR_MIN_DAYS || rawDays > MOON_CALENDAR_MAX_DAYS) {
      throw new AstroError(
        `days は ${MOON_CALENDAR_MIN_DAYS} 以上 ${MOON_CALENDAR_MAX_DAYS} 以下で指定してください` +
          `（既定 ${MOON_CALENDAR_DEFAULT_DAYS}・上限は 2 朔望月ぶん）: ${rawDays}`,
      );
    }
    days = rawDays;
  }

  const rawVoc = args["voc_bodies"];
  let vocBodies: VocBodySet = "modern";
  if (rawVoc !== undefined && rawVoc !== null) {
    if (typeof rawVoc !== "string" || !VOC_BODY_SETS.includes(rawVoc as VocBodySet)) {
      throw new AstroError(
        `voc_bodies は ${VOC_BODY_SETS.join(" / ")} のどちらかで指定してください: ${String(rawVoc)}`,
      );
    }
    vocBodies = rawVoc as VocBodySet;
  }

  return { start, days, utcOffset, vocBodies };
}

// ---------------------------------------------------------------------------
// 時刻の整形
// ---------------------------------------------------------------------------

/** 時差 → ISO 8601 の札（"+09:00" / "+05:30" / "-03:00"） */
export function formatOffsetSuffix(utcOffset: number): string {
  const sign = utcOffset < 0 ? "-" : "+";
  const totalMinutes = Math.round(Math.abs(utcOffset) * 60);
  return `${sign}${pad(Math.floor(totalMinutes / 60))}:${pad(totalMinutes % 60)}`;
}

/**
 * ユリウス日（UT）→ 「2026-08-26 03:12+09:00」。
 * 分に**四捨五入**する（切り捨てると 03:11:59.7 が 03:11 に見えてしまう）。
 */
export function formatMoonMoment(jd: number, utcOffset: number): string {
  const exact = dateFromJulianDay(jd);
  const rounded = new Date(Math.round(exact.getTime() / 60_000) * 60_000);
  return `${formatPlainMoment(rounded, utcOffset)}${formatOffsetSuffix(utcOffset)}`;
}

/** 黄経 → 星座の中での度数（0〜30・小数 2 桁） */
export function degreeInSign(lon: number): number {
  const normalized = normalizeDegree(lon);
  return Math.round((normalized - signIndex(normalized) * 30) * 100) / 100;
}

export function signNameOf(index: number): string {
  return SIGNS[((index % 12) + 12) % 12] as string;
}

// ---------------------------------------------------------------------------
// 格子と補間
// ---------------------------------------------------------------------------

interface Grid {
  step: number;
  sample: BodySample;
}

/** 黄経の列を、前の点との差で連続に均す（events.ts の unwrap と同じ要領。あちらは非公開） */
export function unwrapLongitudes(lon: number[]): void {
  let turns = 0;
  let previous = normalizeDegree(lon[0] as number);
  lon[0] = previous;
  for (let index = 1; index < lon.length; index++) {
    const raw = normalizeDegree(lon[index] as number);
    const delta = raw - previous;
    if (delta > 180) turns -= 1;
    else if (delta < -180) turns += 1;
    previous = raw;
    lon[index] = raw + turns * 360;
  }
}

/**
 * 月と相手天体ぶんの格子を、**日付順にまとめて**取る。
 * 同じ jd で続けて呼ぶと 2 天体目以降が半額になる（地球の位置を使い回すため）ので、
 * 外側のループを時刻、内側を天体にしてある。
 */
function sampleGrids(
  swe: SwissEph,
  gridStartJd: number,
  spanDays: number,
  bodyIds: readonly number[],
): { grids: Map<number, Grid>; calls: number } {
  const steps = new Map<number, number>([[MOON_ID, MOON_STEP]]);
  for (const id of bodyIds) steps.set(id, BODY_STEPS.get(id) ?? 1);

  const grids = new Map<number, Grid>();
  const pointCount = new Map<number, number>();
  for (const [id, step] of steps) {
    grids.set(id, { step, sample: { lon: [], speed: [] } });
    // 最後の点が spanDays の先に出るように +2（補間には区間の右端が要る）
    pointCount.set(id, Math.floor(spanDays / step) + 2);
  }

  // 刻みは 6 時間の倍数（0.25 / 1 / 4 日）なので、6 時間を 1 目盛りにすれば整数だけで回せる
  const ticksOf = (step: number): number => Math.round(step * 4);
  const lastTick = Math.max(
    ...[...steps].map(([id, step]) => ((pointCount.get(id) as number) - 1) * ticksOf(step)),
  );

  let calls = 0;
  for (let tick = 0; tick <= lastTick; tick++) {
    const jd = gridStartJd + tick / 4;
    for (const [id, step] of steps) {
      const stride = ticksOf(step);
      if (tick % stride !== 0) continue;
      if (tick / stride >= (pointCount.get(id) as number)) continue;
      const result = swe.swe_calc_ut(jd, id, CALC_FLAGS);
      const grid = grids.get(id) as Grid;
      grid.sample.lon.push(result[0] as number);
      grid.sample.speed.push(result[3] as number);
      calls++;
    }
  }

  for (const grid of grids.values()) unwrapLongitudes(grid.sample.lon);
  return { grids, calls };
}

/** 格子から任意の瞬間の黄経（0〜360） */
function lonAt(grid: Grid, gridStartJd: number, jd: number): number {
  return positionAt(grid.sample, grid.step, jd - gridStartJd).lon;
}

/** f の符号が変わる区間を二分法で詰める（f(lo) ≤ 0 < f(hi) が前提） */
function bisectJd(f: (jd: number) => number, lo: number, hi: number): number {
  let low = lo;
  let high = hi;
  for (let step = 0; step < BISECTION_STEPS; step++) {
    const middle = (low + high) / 2;
    if (f(middle) <= 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/**
 * `value`（0〜360 の角度）が `target` を**下から上へ**跨ぐ瞬間を [fromJd, toJd) で全部拾う。
 *
 * 月がらみの角度は月の動き（13°/日）が支配するので単調に増える ―― 跨ぎは 1 区間に高々 1 つ、
 * 向きも一方向だけ。前後に 1 目盛りずつ袖を足して端の跨ぎを取りこぼさないようにしてある。
 */
export function findCrossings(
  value: (jd: number) => number,
  target: number,
  fromJd: number,
  toJd: number,
): number[] {
  const found: number[] = [];
  const at = (jd: number): number => wrap180(value(jd) - target);
  const lastTick = Math.ceil((toJd - fromJd) / MOON_STEP) + 1;

  let previousJd = fromJd - MOON_STEP;
  let previous = at(previousJd);
  for (let tick = 0; tick <= lastTick; tick++) {
    const jd = fromJd + tick * MOON_STEP;
    const current = at(jd);
    if (previous <= 0 && current > 0) {
      const root = bisectJd(at, previousJd, jd);
      if (root >= fromJd && root < toJd) found.push(root);
    }
    previousJd = jd;
    previous = current;
  }
  return found;
}

// ---------------------------------------------------------------------------
// 星座入り・朔望・アスペクト
// ---------------------------------------------------------------------------

interface Ingress {
  jd: number;
  signIndex: number;
  fromSignIndex: number;
}

/**
 * 期間をまたぐ星座入りの列と、期間の頭の月の黄経。
 *
 * 先頭は**期間の頭より前**（＝いま月が居る星座に入った瞬間）で、末尾は**期間の尻より後**の
 * 最初の 1 つ。こうしておくと「期間の頭でボイド中か」も「期間の尻のボイドがいつ終わるか」も
 * 切らずに言える。
 */
function moonIngresses(
  swe: SwissEph,
  windowStartJd: number,
  windowEndJd: number,
): { list: Ingress[]; startLon: number } {
  const startLon = normalizeDegree(swe.swe_calc_ut(windowStartJd, MOON_ID, CALC_FLAGS)[0] as number);
  let index = signIndex(startLon);
  let jd = crossUt(swe, "moon", index * 30, windowStartJd - EDGE_MARGIN_DAYS);

  const list: Ingress[] = [{ jd, signIndex: index, fromSignIndex: (index + 11) % 12 }];
  while ((list[list.length - 1] as Ingress).jd < windowEndJd && list.length < MAX_INGRESSES) {
    const nextIndex = (index + 1) % 12;
    // 星座に居るのは最短でも約 1.95 日なので、1 日進めてから探せば同じ瞬間は拾い直さない
    const nextJd = crossUt(swe, "moon", nextIndex * 30, jd + 1);
    list.push({ jd: nextJd, signIndex: nextIndex, fromSignIndex: index });
    index = nextIndex;
    jd = nextJd;
  }
  return { list, startLon };
}

interface PhaseHit {
  jd: number;
  kind: MoonPhaseKind;
}

/** 期間内の朔望（離角が 0 / 90 / 180 / 270 を跨ぐ瞬間） */
function moonPhases(
  grids: Map<number, Grid>,
  gridStartJd: number,
  fromJd: number,
  toJd: number,
): PhaseHit[] {
  const moon = grids.get(MOON_ID) as Grid;
  const sun = grids.get(0) as Grid;
  const elongation = (jd: number): number =>
    normalizeDegree(lonAt(moon, gridStartJd, jd) - lonAt(sun, gridStartJd, jd));

  const hits: PhaseHit[] = [];
  for (const phase of PHASE_TARGETS) {
    for (const jd of findCrossings(elongation, phase.angle, fromJd, toJd)) {
      hits.push({ jd, kind: phase.kind });
    }
  }
  hits.sort((left, right) => left.jd - right.jd);
  return hits;
}

interface MoonAspectHit {
  jd: number;
  bodyId: number;
  angle: number;
}

/** 月が相手天体と exact にメジャーアスペクトを作る瞬間（オーブなし） */
function moonAspects(
  grids: Map<number, Grid>,
  gridStartJd: number,
  bodyIds: readonly number[],
  fromJd: number,
  toJd: number,
): MoonAspectHit[] {
  const moon = grids.get(MOON_ID) as Grid;
  const hits: MoonAspectHit[] = [];

  for (const bodyId of bodyIds) {
    const body = grids.get(bodyId) as Grid;
    const separation = (jd: number): number =>
      normalizeDegree(lonAt(moon, gridStartJd, jd) - lonAt(body, gridStartJd, jd));
    for (const { target, angle } of ASPECT_TARGETS) {
      for (const jd of findCrossings(separation, target, fromJd, toJd)) {
        hits.push({ jd, bodyId, angle });
      }
    }
  }
  hits.sort((left, right) => left.jd - right.jd);
  return hits;
}

function aspectNameOf(angle: number): string {
  return ASPECTS.find((aspect) => aspect.angle === angle)?.name ?? `${angle}°`;
}

function aspectSymbolOf(angle: number): string {
  return ASPECTS.find((aspect) => aspect.angle === angle)?.symbol ?? "";
}

// ---------------------------------------------------------------------------
// 食
// ---------------------------------------------------------------------------

/**
 * 日食の種類を決める。
 *
 * ⚠ 種類のビット（SE_ECL_TOTAL など）は C 関数の**戻り値**にあり、wrapper がそれを捨てている
 *    ので使えない。そこで tret と `swe_sol_eclipse_where` から導く:
 *
 *    - tret[4] / tret[5]（皆既・金環の始まりと終わり）が 0 なら中心を持たない＝部分日食
 *    - 中心を持つなら、その始まり・最大・終わりの 3 点で「月と太陽の視直径比」（attr[1]）を見る。
 *      ずっと 1 より大きければ皆既、ずっと小さければ金環、**途中で 1 をまたげば金環皆既**
 *      （ハイブリッド＝経路の端では金環・真ん中では皆既になるもの）。
 *
 *    1990〜2060 年の 156 回を ifltype 付きの検索（SE_ECL_TOTAL などで種類を指定して探し直す方式）
 *    と突き合わせて、6 回のハイブリッドを含め全件一致することを確かめてある。
 *    ifltype 付きの検索は「その種類の次の食」まで何年でも走ってしまう（実測 38ms）ので採らない。
 */
function solarEclipseType(swe: SwissEph, tret: readonly number[]): SolarEclipseType {
  const centralStart = tret[4] ?? 0;
  const centralEnd = tret[5] ?? 0;
  if (centralStart === 0 && centralEnd === 0) return "partial";

  const ratios: number[] = [];
  for (const jd of [centralStart, tret[0] as number, centralEnd]) {
    if (!jd) continue;
    try {
      const ratio = swe.swe_sol_eclipse_where(jd, ECLIPSE_FLAGS).Array[1];
      if (typeof ratio === "number" && Number.isFinite(ratio)) ratios.push(ratio);
    } catch {
      // 地表に落ちない瞬間は wrapper が投げる。残りの点で決める
    }
  }
  if (ratios.length === 0) return "total";

  const lowest = Math.min(...ratios);
  const highest = Math.max(...ratios);
  if (lowest < 1 && highest > 1) return "hybrid";
  return highest >= 1 ? "total" : "annular";
}

/**
 * 月食の種類。日食と違い tret だけで分かる
 * （tret[4] 皆既の始まりがあれば皆既、tret[2] 部分食の始まりがあれば部分、どちらも無ければ半影）。
 */
function lunarEclipseType(tret: readonly number[]): LunarEclipseType {
  if ((tret[4] ?? 0) !== 0 || (tret[5] ?? 0) !== 0) return "total";
  if ((tret[2] ?? 0) !== 0 || (tret[3] ?? 0) !== 0) return "partial";
  return "penumbral";
}

interface EclipseHit {
  jd: number;
  kind: "solar" | "lunar";
  type: SolarEclipseType | LunarEclipseType;
}

/** 期間内の食（global）。前へ 1 つずつ探しては期間を出たら止める */
function eclipsesInRange(swe: SwissEph, windowStartJd: number, windowEndJd: number): EclipseHit[] {
  const hits: EclipseHit[] = [];

  for (const kind of ["solar", "lunar"] as const) {
    let cursor = windowStartJd;
    for (let guard = 0; guard < MAX_ECLIPSES; guard++) {
      const tret =
        kind === "solar"
          ? swe.swe_sol_eclipse_when_glob(cursor, ECLIPSE_FLAGS, 0, false)
          : swe.swe_lun_eclipse_when(cursor, ECLIPSE_FLAGS, 0, false);
      const maximum = tret?.[0];
      // 壊れた答え（探索開始より前・数値でない）が返ったらそこで打ち切る
      if (typeof maximum !== "number" || !Number.isFinite(maximum) || maximum <= cursor) break;
      if (maximum >= windowEndJd) break;
      hits.push({
        jd: maximum,
        kind,
        type: kind === "solar" ? solarEclipseType(swe, tret) : lunarEclipseType(tret),
      });
      cursor = maximum + 1;
    }
  }

  hits.sort((left, right) => left.jd - right.jd);
  return hits;
}

// ---------------------------------------------------------------------------
// 走査
// ---------------------------------------------------------------------------

interface VoidHit {
  startJd: number;
  endJd: number;
  signIndex: number;
  /** ボイドを終わらせる星座入りの行き先（テキストで「→ 蟹座入り」と言うため） */
  nextSignIndex: number;
  aspect: MoonAspectHit | null;
}

export interface MoonCalendarScan {
  windowStartJd: number;
  windowEndJd: number;
  ingresses: Ingress[];
  phases: PhaseHit[];
  voids: VoidHit[];
  eclipses: EclipseHit[];
  moonLonAtStart: number;
  /** 格子で呼んだ `swe_calc_ut` の回数（＋期間の頭の月で 1 回）。CPU の目安を測る覚え書き */
  gridCalls: number;
}

/** 期間 [startJd, startJd + days) を走査する。ここは jd のまま返し、文字列にするのは組み立て側 */
export function scanMoonCalendar(
  swe: SwissEph,
  startJd: number,
  days: number,
  vocBodies: VocBodySet,
): MoonCalendarScan {
  const windowStartJd = startJd;
  const windowEndJd = startJd + days;
  const bodyIds = VOC_BODY_IDS[vocBodies];

  // 星座入りは補間せず一発計算（ボイドの終わりの時刻そのものなので厳密に）
  const { list: ingresses, startLon } = moonIngresses(swe, windowStartJd, windowEndJd);
  const scanFromJd = Math.min((ingresses[0] as Ingress).jd, windowStartJd);
  const scanToJd = Math.max((ingresses[ingresses.length - 1] as Ingress).jd, windowEndJd);

  const gridStartJd = windowStartJd - EDGE_MARGIN_DAYS;
  const { grids, calls } = sampleGrids(swe, gridStartJd, days + EDGE_MARGIN_DAYS * 2, bodyIds);

  const phases = moonPhases(grids, gridStartJd, windowStartJd, windowEndJd);
  const aspects = moonAspects(grids, gridStartJd, bodyIds, scanFromJd, scanToJd);

  // 星座ごとの区間（星座入り → 次の星座入り）で「その星座に入ってからの最後のアスペクト」を拾う
  const voids: VoidHit[] = [];
  for (let index = 0; index + 1 < ingresses.length; index++) {
    const from = ingresses[index] as Ingress;
    const to = ingresses[index + 1] as Ingress;
    let last: MoonAspectHit | null = null;
    for (const hit of aspects) {
      if (hit.jd >= from.jd && hit.jd < to.jd) last = hit;
    }
    const startOfVoid = last ? last.jd : from.jd;
    // 期間に少しでもかかるものだけ載せる（頭のボイドは期間の外から始まっていてよい）
    if (startOfVoid >= windowEndJd) continue;
    if (to.jd <= windowStartJd) continue;
    voids.push({
      startJd: startOfVoid,
      endJd: to.jd,
      signIndex: from.signIndex,
      nextSignIndex: to.signIndex,
      aspect: last,
    });
  }

  return {
    windowStartJd,
    windowEndJd,
    ingresses,
    phases,
    voids,
    eclipses: eclipsesInRange(swe, windowStartJd, windowEndJd),
    moonLonAtStart: startLon,
    gridCalls: calls + 1,
  };
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/** 期間の頭（その土地の 0 時）のユリウス日 */
export function moonCalendarStartJd(swe: SwissEph, request: MoonCalendarRequest): number {
  return julianDay(swe, {
    year: request.start.year,
    month: request.start.month,
    day: request.start.day,
    hour: 0,
    minute: 0,
    utcOffset: request.utcOffset,
  });
}

/** 走査の結果を返り値の形に組み立てる（時刻の文字列化はここで一括） */
export function buildMoonCalendar(
  swe: SwissEph,
  scan: MoonCalendarScan,
  request: MoonCalendarRequest,
): MoonCalendarResult {
  const { utcOffset } = request;
  const when = (jd: number): string => formatMoonMoment(jd, utcOffset);

  const phases: MoonPhaseEvent[] = scan.phases.map((hit) => {
    const lon = normalizeDegree(swe.swe_calc_ut(hit.jd, MOON_ID, CALC_FLAGS)[0] as number);
    return {
      kind: hit.kind,
      time: when(hit.jd),
      moon_sign: signNameOf(signIndex(lon)),
      moon_degree: degreeInSign(lon),
    };
  });

  const ingresses: MoonIngressEvent[] = scan.ingresses
    .filter((entry) => entry.jd >= scan.windowStartJd && entry.jd < scan.windowEndJd)
    .map((entry) => ({
      time: when(entry.jd),
      sign: signNameOf(entry.signIndex),
      from_sign: signNameOf(entry.fromSignIndex),
    }));

  const voidOfCourse: VoidOfCourseEvent[] = scan.voids.map((hit) => {
    const entry: VoidOfCourseEvent = {
      start: when(hit.startJd),
      end: when(hit.endJd),
      sign: signNameOf(hit.signIndex),
      last_aspect: hit.aspect
        ? {
            body: planetName(hit.aspect.bodyId),
            aspect: aspectNameOf(hit.aspect.angle),
            angle: hit.aspect.angle,
            time: when(hit.aspect.jd),
          }
        : null,
      clipped: false,
    };
    if (!hit.aspect) {
      entry.note =
        "この星座に居るあいだ、相手天体とのメジャーアスペクトが 1 つもありませんでした" +
        "（星座に入った瞬間から次の星座入りまで、まるごとボイドとして扱っています）。";
    }
    return entry;
  });

  const voidAtStart = scan.voids.some(
    (hit) => hit.startJd <= scan.windowStartJd && scan.windowStartJd < hit.endJd,
  );

  return {
    range: {
      start: when(scan.windowStartJd),
      end: when(scan.windowEndJd),
      days: request.days,
      utc_offset: utcOffset,
    },
    moon_at_start: {
      time: when(scan.windowStartJd),
      sign: signNameOf(signIndex(scan.moonLonAtStart)),
      degree: degreeInSign(scan.moonLonAtStart),
      void_of_course: voidAtStart,
    },
    phases,
    ingresses,
    void_of_course: voidOfCourse,
    eclipses: scan.eclipses.map((hit) => ({
      kind: hit.kind,
      type: hit.type,
      maximum: when(hit.jd),
    })),
    conventions: {
      void_of_course: "last_exact_major_aspect_to_next_ingress",
      voc_bodies: request.vocBodies,
      aspects: ASPECTS.map((aspect) => aspect.angle),
      orb: 0,
      eclipses: "global",
      zodiac: "tropical",
      ephemeris: "moshier",
    },
  };
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

function eclipseLabel(hit: EclipseHit): string {
  return hit.kind === "solar"
    ? SOLAR_ECLIPSE_LABEL[hit.type as SolarEclipseType]
    : LUNAR_ECLIPSE_LABEL[hit.type as LunarEclipseType];
}

/**
 * 日付順に 1 行 1 イベント。並べ替えは**文字列ではなく jd** で行う（走査の結果を一緒に受け取るのは
 * そのため）。ボイドは**始まりの時刻の行 1 本**にまとめる ―― 終わりはその星座入りの行と
 * 同じ時刻なので、2 本に割ると同じことを 2 度言うことになる。
 */
export function formatMoonCalendarText(scan: MoonCalendarScan, result: MoonCalendarResult): string {
  const lines: { jd: number; text: string }[] = [];
  const when = (jd: number): string => formatMoonMoment(jd, result.range.utc_offset);

  scan.phases.forEach((hit, index) => {
    const phase = result.phases[index] as MoonPhaseEvent;
    const label = PHASE_TARGETS.find((target) => target.kind === hit.kind)?.label ?? hit.kind;
    lines.push({
      jd: hit.jd,
      text: `${phase.time}  ［${label}］${phase.moon_sign} ${phase.moon_degree.toFixed(2)}°`,
    });
  });

  for (const entry of scan.ingresses) {
    if (entry.jd < scan.windowStartJd || entry.jd >= scan.windowEndJd) continue;
    lines.push({
      jd: entry.jd,
      text:
        `${when(entry.jd)}  ［星座入り］月 ` +
        `${signNameOf(entry.fromSignIndex)} → ${signNameOf(entry.signIndex)}`,
    });
  }

  scan.voids.forEach((hit, index) => {
    const entry = result.void_of_course[index] as VoidOfCourseEvent;
    const detail = entry.last_aspect
      ? `最後のアスペクト 月 ${aspectSymbolOf(entry.last_aspect.angle)} ${entry.last_aspect.body}` +
        `（${entry.last_aspect.aspect}・${entry.last_aspect.time}）`
      : "この星座ではアスペクトなし";
    lines.push({
      jd: hit.startJd,
      text:
        `${entry.start}  ［ボイド］${entry.sign}・${detail}` +
        `／終わりは ${entry.end} の${signNameOf(hit.nextSignIndex)}入り`,
    });
  });

  for (const hit of scan.eclipses) {
    lines.push({ jd: hit.jd, text: `${when(hit.jd)}  ［${eclipseLabel(hit)}］食の最大` });
  }

  lines.sort((left, right) => left.jd - right.jd);

  const header = [
    "月まわりの暦（朔望・月の星座入り・ボイド・食）",
    `期間: ${result.range.start} 〜 ${result.range.end}（${result.range.days} 日間）`,
    `開始時点の月: ${result.moon_at_start.sign} ${result.moon_at_start.degree.toFixed(2)}°` +
      `／${result.moon_at_start.void_of_course ? "ボイド中" : "ボイド中ではありません"}`,
  ];

  const body =
    lines.length > 0 ? lines.map((line) => line.text) : ["（この期間にイベントはありません）"];

  const footer = [
    `規約: ボイド＝最後のメジャーアスペクト（${ASPECTS.map((aspect) => aspect.angle).join("/")}・` +
      "オーブなし・exact の瞬間）から次の星座入りまで／相手は" +
      `${VOC_BODY_SET_LABEL[result.conventions.voc_bodies]}` +
      "／食は global（地球上のどこかで起きるもの・場所を受けないので見え方は返しません）" +
      "／トロピカル・Moshier",
    "※ ボイドの定義は流派で割れます（相手天体の範囲・オーブの有無・" +
      "「その星座を出るまで」か「次のアスペクトまで」か）。この鯖は上の 1 通りだけを採ります。",
    noReadingNote("ボイドの吉凶・過ごし方"),
  ];

  return [...header, "", ...body, "", ...footer].join("\n");
}

/** 引数の読み取り済みリクエスト → 返り値とテキスト（配線側はこれだけ呼べばよい） */
export function moonCalendar(
  swe: SwissEph,
  request: MoonCalendarRequest,
): { result: MoonCalendarResult; text: string } {
  const startJd = moonCalendarStartJd(swe, request);
  const scan = scanMoonCalendar(swe, startJd, request.days, request.vocBodies);
  const result = buildMoonCalendar(swe, scan, request);
  return { result, text: formatMoonCalendarText(scan, result) };
}
