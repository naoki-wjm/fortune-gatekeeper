/**
 * 期間内のトランジットイベント ―― 数日〜1 か月を**時刻単位**で拡大する。
 *
 * yearly.ts が「1 年を日単位で俯瞰する」道具なのに対し、こちらは「今週 exact になるのはどれか」
 * 「明日いちばんタイトな時間帯はいつか」に答える道具。**年間 → 今週 → 明日 → この時刻**と
 * ズームがそろう（一点を見る顕微鏡は transit のまま）。
 *
 * 天体位置の供給源は yearly.ts と同系の**疎サンプル＋補間**。ただしこちらは**速度つき
 * （CALC_FLAGS＝Moshier＋SPEED）で取って 3 次エルミート補間**する ―― 区間の両端の位置と速度だけで
 * 決まるので袖が要らず、格子も短くて済む。本物の wasm と 4 時間刻みの真値で突き合わせた結果、
 * 月・太陽・水星・金星・火星は **1 日おき**、木星〜冥王星は **4 日おき**で位置誤差 ≤ 1.6e-4°
 * （時刻にして 1 分未満）。31 日・全天体でも天体計算は約 205 回で済む。
 *
 * CPU は Workers Paid（wrangler.jsonc の limits.cpu_ms）なので 10ms の壁は無いが、
 * **1 リクエストの天体計算は数百回まで**という枠は守る ―― そのための期間上限が MAX_DAYS。
 *
 * ここも解釈は持たない ―― 返すのは jd と角度だけで、文字列化は呼び出し側（時差を知っているのは向こう）。
 * chart.ts / yearly.ts と同じく wasm には触らない（SwissEph を引数で受け取る）。
 */
import {
  ASPECTS,
  AstroError,
  CALC_FLAGS,
  DEFAULT_ORB,
  SIGNS,
  getHouse,
  normalizeDegree,
  planetName,
  signIndex,
  type SwissEph,
} from "./chart";

/**
 * 動く側の天体と格子の刻み（日）。
 *
 * ⚠ **ノース ノード（id 11）は入れない**（動く側にも相手側にも）。計算が重いうえ、真ノードは
 *    日々揺れるので「留」が騒がしくなるだけで読み物にならない ―― 年間概要と同じ扱い。
 */
export const EVENT_BODIES = [
  { id: 0, name: "太陽", step: 1 },
  { id: 1, name: "月", step: 1 },
  { id: 2, name: "水星", step: 1 },
  { id: 3, name: "金星", step: 1 },
  { id: 4, name: "火星", step: 1 },
  { id: 5, name: "木星", step: 4 },
  { id: 6, name: "土星", step: 4 },
  { id: 7, name: "天王星", step: 4 },
  { id: 8, name: "海王星", step: 4 },
  { id: 9, name: "冥王星", step: 4 },
] as const;

export type EventBody = (typeof EVENT_BODIES)[number];

/** 動く側の天体の組 */
export type BodySet = "all" | "no_moon" | "outer";

/** 組ごとの期間上限（日）。月は 1 か月で 60 本ほどアスペクトを作るので、それ以上は読み物にならない */
export const MAX_DAYS: Record<BodySet, number> = { all: 31, no_moon: 93, outer: 366 };

/** 見出しに出す組の呼び名 */
export const BODY_SET_LABEL: Record<BodySet, string> = {
  all: "太陽〜冥王星（10 天体）",
  no_moon: "月を除く 9 天体",
  outer: "木星〜冥王星",
};

/** all＝全 10 天体 / no_moon＝月を除く 9 天体 / outer＝木星〜冥王星の 5 天体 */
export function bodiesOf(set: BodySet): readonly EventBody[] {
  if (set === "outer") return EVENT_BODIES.filter((body) => body.id >= 5);
  if (set === "no_moon") return EVENT_BODIES.filter((body) => body.id !== 1);
  return EVENT_BODIES;
}

/** 細かい格子の刻み（分）。この刻みで入り／外れ／留／イングレスを見つけ、境界は二分法で詰める */
export const TICK_MINUTES = 10;

/** 1 日あたりの tick 数 */
const TICKS_PER_DAY = 1440 / TICK_MINUTES;

/** 二分法の回数。10 分の区間を 10 回割れば 1 秒以下（1 分より十分細かい） */
const BISECTION_STEPS = 10;

/** 期間の端で切れている印（実際はもっと前から続いていた／もっと後まで続く）。yearly.ts と同じ 3 値 */
export type Clip = "start" | "end" | "both";

/**
 * 期間の長さを検める。**天体計算より先に呼ぶこと**（弾くだけなら CPU を使わない）。
 */
export function assertDaysInRange(days: number, set: BodySet): void {
  if (!Number.isFinite(days) || days < 1) {
    throw new AstroError(
      `days は 1 以上で指定してください（省略すると 7 日）: ${Number.isFinite(days) ? days : "不明な値"}`,
    );
  }
  const max = MAX_DAYS[set];
  if (days > max) {
    throw new AstroError(
      `bodies=${set} で見られるのは最長 ${max} 日です（指定: ${days} 日）。` +
        `月を外すなら no_moon で最長 ${MAX_DAYS.no_moon} 日、` +
        `外惑星だけなら outer で最長 ${MAX_DAYS.outer} 日まで見られます。` +
        "1 年をまるごと俯瞰するなら yearly_overview のほうが向いています。",
    );
  }
}

// ---------------------------------------------------------------------------
// サンプリングと補間
// ---------------------------------------------------------------------------

/** 1 天体ぶんの格子（添字 k = 0 … ceil(days / step)）。lon は 0°/360° の継ぎ目で切れないよう連続に均してある */
export interface BodySample {
  lon: number[];
  speed: number[];
}

/** 黄経の列を、前の点との差で連続に均す（補間のため。yearly.ts の tableFromGrid と同じ要領） */
function unwrap(lon: number[]): void {
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
 * 全天体ぶんの格子を、**日付順にまとめて**取る。
 *
 * ⚠ 日付順に呼ぶのが肝 ―― Swiss Ephemeris は同じ jd で続けて呼ぶと地球の位置などを使い回すので、
 *    2 天体目以降が半額になる（yearly.ts の BASE_STEP の注記と同じ理屈）。
 */
export function sampleBodies(
  swe: SwissEph,
  startJd: number,
  days: number,
  bodies: readonly EventBody[],
): { samples: Map<number, BodySample>; calls: number } {
  const samples = new Map<number, BodySample>();
  const lastIndex = new Map<number, number>();
  for (const body of bodies) {
    samples.set(body.id, { lon: [], speed: [] });
    lastIndex.set(body.id, Math.ceil(days / body.step));
  }
  const lastDay = Math.max(...bodies.map((body) => (lastIndex.get(body.id) as number) * body.step));

  let calls = 0;
  for (let day = 0; day <= lastDay; day++) {
    const jd = startJd + day;
    for (const body of bodies) {
      if (day % body.step !== 0) continue;
      if (day / body.step > (lastIndex.get(body.id) as number)) continue;
      const result = swe.swe_calc_ut(jd, body.id, CALC_FLAGS);
      const sample = samples.get(body.id) as BodySample;
      sample.lon.push(result[0] as number);
      sample.speed.push(result[3] as number);
      calls++;
    }
  }

  for (const sample of samples.values()) unwrap(sample.lon);
  return { samples, calls };
}

/**
 * 3 次エルミート補間。t は開始からの日数。
 *
 * 区間 k の両端の位置（p0, p1）と速度（m0, m1 ＝ 度/日 × step）だけで決まる。
 *
 * ⚠ 位置は **p1 − p0 の差**で計算する。重みの和は数学的に 1 だが浮動小数では 1±1e-16 になり、
 *    数百度の黄経に掛けると速度に埃が残る（止まっている天体が刻みごとに逆行して見える）。
 *    差で扱えば定数成分がきれいに落ちる ―― yearly.ts の tableFromGrid と同じ用心。
 */
export function positionAt(
  sample: BodySample,
  step: number,
  t: number,
): { lon: number; speed: number } {
  const lastInterval = sample.lon.length - 2;
  let k = Math.floor(t / step);
  if (k > lastInterval) k = lastInterval; // t = days ちょうどは最後の区間の u = 1 として扱う
  if (k < 0) k = 0;
  const u = t / step - k;

  const p0 = sample.lon[k] as number;
  const delta = (sample.lon[k + 1] as number) - p0;
  const m0 = (sample.speed[k] as number) * step;
  const m1 = (sample.speed[k + 1] as number) * step;

  // p(u) = p0 + (−2u³+3u²)(p1−p0) + (u³−2u²+u)m0 + (u³−u²)m1
  const lon = p0 + u * u * (3 - 2 * u) * delta + u * (u - 1) * (u - 1) * m0 + u * u * (u - 1) * m1;
  // p′(u) を step で割って度/日に
  const speed =
    (6 * u * (1 - u) * delta + (3 * u * u - 4 * u + 1) * m0 + (3 * u * u - 2 * u) * m1) / step;

  return { lon: normalizeDegree(lon), speed };
}

/** 角度を (−180, 180] に畳む */
export function wrap180(deg: number): number {
  const wrapped = normalizeDegree(deg);
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** f の符号が変わる区間 [lo, hi] を二分法で詰める（10 分の区間なら 10 回で 1 秒以下） */
function bisect(f: (t: number) => number, lo: number, hi: number): number {
  let low = lo;
  let high = hi;
  const sign = Math.sign(f(low));
  for (let step = 0; step < BISECTION_STEPS; step++) {
    const middle = (low + high) / 2;
    if (Math.sign(f(middle)) === sign) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

// ---------------------------------------------------------------------------
// 走査
// ---------------------------------------------------------------------------

export interface TransitEventsInput {
  /** 期間の頭（UT のユリウス日） */
  startJd: number;
  /** 日数（1 〜 MAX_DAYS[bodies]） */
  days: number;
  bodies: BodySet;
  /** ネイタル天体（StoredChart.planets）。id 11（ノード）は相手から外す */
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

/** アスペクトの相手（ネイタル天体・ASC・MC を同じ形に均す） */
export interface EventTarget {
  kind: "planet" | "angle";
  name: string;
  /** ネイタル天体なら天体 ID、ASC / MC なら null */
  id: number | null;
  /** ネイタルのカスプで見た在ハウス。ASC / MC は null */
  house: number | null;
  lon: number;
}

/** 留（逆行の始まり・終わり） */
export interface StationEvent {
  id: number;
  name: string;
  jd: number;
  to: "retrograde" | "direct";
  lon: number;
}

/** 星座イングレス */
export interface EventIngress {
  id: number;
  name: string;
  jd: number;
  signIndex: number;
  sign: string;
  retrograde: boolean;
}

/** アスペクトが成立していた 1 区間（時刻つき） */
export interface EventWindow {
  transitId: number;
  transit: string;
  target: EventTarget;
  aspect: AspectKind;
  /** オーブに入った瞬間。期間頭からすでに入っていれば null */
  entering: number | null;
  /** ぴったり成立した瞬間（1 窓に複数あってよい＝外惑星の留またぎ） */
  exact: number[];
  /** オーブから外れた瞬間。期間末まで続いていれば null */
  leaving: number | null;
  /** 窓の中での最小オーブ（exact があれば 0） */
  minOrb: number;
  minOrbAt: number;
  /** 入った時点でオーブが縮む向きだったか（期間頭から入っている窓は期間頭で判定） */
  applyingAtStart: boolean;
  clipped?: Clip;
}

export interface TransitEventScan {
  startJd: number;
  endJd: number;
  days: number;
  /** 天体計算の合計回数（診断用） */
  ephemerisCalls: number;
  windows: EventWindow[];
  stations: StationEvent[];
  ingresses: EventIngress[];
}

/** アスペクト A の枝（相手のどちら側に離れているか）。0° と 180° は 1 枝しかない */
function branchesOf(angle: number): number[] {
  return angle === 0 || angle === 180 ? [angle] : [angle, -angle];
}

/**
 * 期間中に一度も届かない枝を丸ごと飛ばすための判定（掃いた弧 [low, high] に offset + 360k が入るか）。
 *
 * 外惑星は 366 日でも数度しか動かないので、12 相手 × 8 枝のうち当たりうるのはせいぜい 1〜2 本。
 * ここで落としておくと、期間の長い組（outer で 1 年）の走査がまるごと軽くなる。
 */
function reachable(low: number, high: number, offset: number): boolean {
  return offset + 360 * Math.ceil((low - offset) / 360) <= high;
}

/** ネイタル天体（ノード除く）＋ ASC ＋ MC */
function targetsOf(input: TransitEventsInput): EventTarget[] {
  const targets: EventTarget[] = input.natalPlanets
    .filter((planet) => planet.id !== 11)
    .map((planet) => ({
      kind: "planet" as const,
      name: planetName(planet.id),
      id: planet.id,
      house: getHouse(planet.lon, input.cusps),
      lon: planet.lon,
    }));
  targets.push({ kind: "angle", name: "ASC", id: null, house: null, lon: input.angles.asc });
  targets.push({ kind: "angle", name: "MC", id: null, house: null, lon: input.angles.mc });
  return targets;
}

/** 並びを落ち着かせるための相手の順（ネイタル天体が先、ASC → MC が後ろ） */
function targetRank(target: EventTarget): number {
  if (target.id !== null) return target.id;
  return target.name === "ASC" ? 100 : 101;
}

function clipOf(atStart: boolean, atEnd: boolean): Clip | null {
  if (atStart && atEnd) return "both";
  if (atStart) return "start";
  if (atEnd) return "end";
  return null;
}

/** 窓を組み立てている途中の控え（時刻は開始からの日数） */
interface OpenWindow {
  entering: number | null;
  exact: number[];
  minOrb: number;
  minOrbAt: number;
  applyingAtStart: boolean;
}

/**
 * 期間内のイベントを走査する。返すのは jd ベース ―― 時刻の文字列化は呼び出し側。
 */
export function scanTransitEvents(swe: SwissEph, input: TransitEventsInput): TransitEventScan {
  const { startJd, days } = input;
  // ⚠ 検めるのが先、天体計算はそのあと（期間の上限は CPU を守るための柵）
  assertDaysInRange(days, input.bodies);

  const orb = input.orb ?? DEFAULT_ORB;
  const bodies = bodiesOf(input.bodies);
  const sampled = sampleBodies(swe, startJd, days, bodies);
  const targets = targetsOf(input);

  const ticks = Math.round(days * TICKS_PER_DAY);
  /** tick の番号 → 開始からの日数 */
  const timeOf = (tick: number): number => (tick * TICK_MINUTES) / 1440;

  const windows: EventWindow[] = [];
  const stations: StationEvent[] = [];
  const ingresses: EventIngress[] = [];

  for (const body of bodies) {
    const sample = sampled.samples.get(body.id) as BodySample;
    const at = (t: number): { lon: number; speed: number } => positionAt(sample, body.step, t);

    // 細かい格子ぶんの位置と速度を先に用意する（ここから先は天体計算を呼ばない）
    const lon = new Float64Array(ticks + 1);
    const speed = new Float64Array(ticks + 1);
    for (let tick = 0; tick <= ticks; tick++) {
      const position = at(timeOf(tick));
      lon[tick] = position.lon;
      speed[tick] = position.speed;
    }

    // 留 ―― 速度の符号が変わった tick 間を二分法で詰める
    for (let tick = 1; tick <= ticks; tick++) {
      const wasRetrograde = (speed[tick - 1] as number) < 0;
      const isRetrograde = (speed[tick] as number) < 0;
      if (wasRetrograde === isRetrograde) continue;
      const t = bisect((x) => at(x).speed, timeOf(tick - 1), timeOf(tick));
      stations.push({
        id: body.id,
        name: body.name,
        jd: startJd + t,
        to: isRetrograde ? "retrograde" : "direct",
        lon: at(t).lon,
      });
    }

    // イングレス ―― 星座が変わった tick 間で、30° の倍数を横切る瞬間を詰める
    for (let tick = 1; tick <= ticks; tick++) {
      const previousSign = signIndex(lon[tick - 1] as number);
      const currentSign = signIndex(lon[tick] as number);
      if (previousSign === currentSign) continue;
      // 順行なら入った星座の頭、逆行なら出た星座の頭が境界
      const forward = currentSign === (previousSign + 1) % 12;
      const boundary = 30 * (forward ? currentSign : previousSign);
      const t = bisect((x) => wrap180(at(x).lon - boundary), timeOf(tick - 1), timeOf(tick));
      ingresses.push({
        id: body.id,
        name: body.name,
        jd: startJd + t,
        signIndex: currentSign,
        sign: SIGNS[currentSign] as string,
        retrograde: at(t).speed < 0,
      });
    }

    // この天体が期間中に掃いた弧（格子の範囲＋1 区間ぶん動ける幅とオーブ）。枝の足切りに使う
    const margin = body.step * sample.speed.reduce((m, s) => Math.max(m, Math.abs(s)), 0) + orb;
    const sweptLow = Math.min(...sample.lon) - margin;
    const sweptHigh = Math.max(...sample.lon) + margin;

    // アスペクト窓 ―― 天体 × 相手 × アスペクト × 枝で 1 本ずつ追う
    for (const target of targets) {
      for (const aspect of ASPECTS) {
        for (const branch of branchesOf(aspect.angle)) {
          if (!reachable(sweptLow, sweptHigh, target.lon + branch)) continue;
          const errorAt = (t: number): number => wrap180(at(t).lon - target.lon - branch);
          let open: OpenWindow | null = null;
          let previousError = 0;

          const close = (current: OpenWindow, leaving: number | null): void => {
            const exact = current.exact.map((t) => startJd + t);
            const window: EventWindow = {
              transitId: body.id,
              transit: body.name,
              target,
              aspect: { angle: aspect.angle, name: aspect.name, symbol: aspect.symbol },
              entering: current.entering === null ? null : startJd + current.entering,
              exact,
              leaving: leaving === null ? null : startJd + leaving,
              minOrb: exact.length > 0 ? 0 : Math.round(current.minOrb * 1000) / 1000,
              minOrbAt: exact.length > 0 ? (exact[0] as number) : startJd + current.minOrbAt,
              applyingAtStart: current.applyingAtStart,
            };
            const clipped = clipOf(current.entering === null, leaving === null);
            if (clipped) window.clipped = clipped;
            windows.push(window);
          };

          for (let tick = 0; tick <= ticks; tick++) {
            const t = timeOf(tick);
            const error = wrap180((lon[tick] as number) - target.lon - branch);
            const inside = Math.abs(error) <= orb;

            if (inside) {
              if (!open) {
                // 入った瞬間（期間頭からすでに入っていれば entering は無い）
                const entering =
                  tick === 0
                    ? null
                    : bisect((x) => Math.abs(errorAt(x)) - orb, timeOf(tick - 1), t);
                const edge = at(entering ?? 0);
                const edgeError = wrap180(edge.lon - target.lon - branch);
                open = {
                  entering,
                  exact: [],
                  minOrb: Math.abs(error),
                  minOrbAt: t,
                  // オーブが縮む向きか＝ sign(e)·ė < 0
                  applyingAtStart: edgeError * edge.speed < 0,
                };
              } else if (Math.abs(error) < open.minOrb) {
                open.minOrb = Math.abs(error);
                open.minOrbAt = t;
              }
              // 符号が変わったら exact（外惑星は留をまたいで 1 窓に何度も起こる）
              if (error === 0) {
                // ぴったり 0 が続く場合（止まっている天体を真上に置いたとき）は最初の 1 回だけ
                if (tick === 0 || previousError !== 0) open.exact.push(t);
              } else if (tick > 0 && previousError !== 0 && previousError * error < 0) {
                open.exact.push(bisect(errorAt, timeOf(tick - 1), t));
              }
            } else if (open) {
              close(open, bisect((x) => Math.abs(errorAt(x)) - orb, timeOf(tick - 1), t));
              open = null;
            }
            previousError = error;
          }
          if (open) close(open, null);
        }
      }
    }
  }

  // 並びは時系列。同じ瞬間なら天体順 → 相手の順で落ち着かせる
  windows.sort(
    (a, b) =>
      (a.entering ?? startJd) - (b.entering ?? startJd) ||
      a.transitId - b.transitId ||
      targetRank(a.target) - targetRank(b.target) ||
      a.aspect.angle - b.aspect.angle,
  );
  stations.sort((a, b) => a.jd - b.jd || a.id - b.id);
  ingresses.sort((a, b) => a.jd - b.jd || a.id - b.id);

  return {
    startJd,
    endJd: startJd + days,
    days,
    ephemerisCalls: sampled.calls,
    windows,
    stations,
    ingresses,
  };
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** 「MM-DD HH:mm」の月日の部分だけ */
function datePart(moment: string): string {
  return moment.split(" ")[0] as string;
}

/** 「MM-DD HH:mm」の時刻の部分だけ */
function timePart(moment: string): string {
  return moment.split(" ")[1] as string;
}

/** 端で切れている窓の但し書き（yearly.ts と同じ言い回し） */
function clipNote(clipped: Clip | undefined): string {
  if (clipped === "both") return "期間を通して継続";
  if (clipped === "start") return "期間頭から継続";
  if (clipped === "end") return "期間末まで継続";
  return "";
}

/**
 * 1 本の時系列にまとめる。`when` は呼び出し側が渡す「MM-DD HH:mm」（表示時差込み）。
 *
 * 期間が年をまたぐことは稀なので行は月日＋時刻で足りる ―― 年は見出しに出してある。
 */
export function formatEventsText(scan: TransitEventScan, when: (jd: number) => string): string[] {
  const startDate = datePart(when(scan.startJd));

  /** 同じ日なら時刻だけ、日が違えば月日つき */
  const shortMoment = (jd: number, referenceDate: string): string => {
    const moment = when(jd);
    return datePart(moment) === referenceDate ? timePart(moment) : moment;
  };

  const entries: { jd: number; rank: number; text: string }[] = [];

  for (const window of scan.windows) {
    const referenceDate = window.entering === null ? startDate : datePart(when(window.entering));
    const from = window.entering === null ? `${startDate} —` : when(window.entering);
    const note = clipNote(window.clipped);
    const to =
      window.leaving === null
        ? `（${note}）`
        : `${shortMoment(window.leaving, referenceDate)}${window.entering === null ? `（${note}）` : ""}`;
    const house = window.target.house === null ? "" : `(${window.target.house}H)`;
    const detail =
      window.exact.length > 0
        ? `exact ${window.exact.map((jd) => shortMoment(jd, referenceDate)).join(", ")}`
        : `最小オーブ ${window.minOrb.toFixed(2)}°（exact なし）`;
    entries.push({
      jd: window.entering ?? scan.startJd,
      rank: 0,
      text:
        `${from}〜${to}  t.${window.transit} ${window.aspect.symbol} ` +
        `n.${window.target.name}${house}  ${detail}`,
    });
  }

  for (const station of scan.stations) {
    entries.push({
      jd: station.jd,
      rank: 1,
      text: `${when(station.jd)}  t.${station.name} 留（${station.to === "retrograde" ? "逆行へ" : "順行へ"}）`,
    });
  }

  for (const ingress of scan.ingresses) {
    const back = ingress.retrograde ? "（逆行で戻る）" : "";
    entries.push({
      jd: ingress.jd,
      rank: 2,
      text: `${when(ingress.jd)}  t.${ingress.name} ${ingress.sign}入り${back}`,
    });
  }

  entries.sort((a, b) => a.jd - b.jd || a.rank - b.rank);

  const lines = ["■ 期間内のイベント（時系列。t.＝トランジット / n.＝ネイタル）"];
  if (entries.length === 0) lines.push("なし");
  else lines.push(...entries.map((entry) => entry.text));

  const exacts = scan.windows.reduce((total, window) => total + window.exact.length, 0);
  lines.push("");
  lines.push(
    `■ 件数 アスペクト窓 ${scan.windows.length} / exact ${exacts} / ` +
      `留 ${scan.stations.length} / イングレス ${scan.ingresses.length}`,
  );
  return lines;
}
