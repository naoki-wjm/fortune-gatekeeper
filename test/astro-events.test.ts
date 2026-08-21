import { describe, expect, it } from "vitest";
import { AstroError, dateFromJulianDay, normalizeDegree } from "../src/astro/chart";
import {
  EVENT_BODIES,
  MAX_DAYS,
  TICK_MINUTES,
  assertDaysInRange,
  bodiesOf,
  formatEventsText,
  positionAt,
  sampleBodies,
  scanTransitEvents,
  wrap180,
  type BodySet,
  type TransitEventScan,
  type TransitEventsInput,
} from "../src/astro/events";
import { makeFakeEngine, type FakeEngine } from "./stubs/fake-engine";

/** 偽エンジンと同じ式でユリウス日を作る */
function jdOf(year: number, month: number, day: number, hour = 0): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 2440587.5 + hour / 24;
}

const START_JD = jdOf(2026, 8, 20);

/** 1 分（日数） */
const MINUTE = 1 / 1440;

/**
 * 合成天体。`lon(t) = base + rate·t + amp·(sin(ωt + phase) − sin(phase))`（t は開始からの日数）。
 * 真値を式で書けるので、entering / exact / 留 / イングレスの時刻を解析解と直に比べられる。
 */
interface Wave {
  base: number;
  rate: number;
  amp?: number;
  period?: number;
  phase?: number;
}

function omegaOf(wave: Wave): number {
  return (2 * Math.PI) / (wave.period ?? 1);
}

function waveLon(wave: Wave, t: number): number {
  const amp = wave.amp ?? 0;
  const phase = wave.phase ?? 0;
  const omega = omegaOf(wave);
  return normalizeDegree(
    wave.base + wave.rate * t + amp * (Math.sin(omega * t + phase) - Math.sin(phase)),
  );
}

function waveSpeed(wave: Wave, t: number): number {
  const amp = wave.amp ?? 0;
  const phase = wave.phase ?? 0;
  const omega = omegaOf(wave);
  return wave.rate + amp * omega * Math.cos(omega * t + phase);
}

/**
 * WAVES どおりに動く偽エンジン（swe_calc_ut だけ差し替え）。
 *
 * 指定しなかった天体は 15° に止めておく ―― ネイタルの相手をすべて 30° の倍数に置いてあるので、
 * 15° はどのメジャーアスペクトにも当たらない（＝関係ない天体がイベントを作らない）。
 */
function makeEventEngine(waves: Record<number, Wave>, startJd = START_JD): FakeEngine {
  const engine = makeFakeEngine();
  engine.swe_calc_ut = (jd: number, planetId: number, _flags: number): number[] => {
    const wave = waves[planetId] ?? { base: 15, rate: 0 };
    const t = jd - startJd;
    return [waveLon(wave, t), 0, 1, waveSpeed(wave, t), 0, 0];
  };
  return engine;
}

/** ネイタルはすべて 30° の倍数（id 11 はノード＝相手から外れるはず。5° に置いて確かめる） */
const NATAL_PLANETS = [
  { id: 0, lon: 0 },
  { id: 1, lon: 30 },
  { id: 2, lon: 60 },
  { id: 3, lon: 90 },
  { id: 4, lon: 120 },
  { id: 5, lon: 150 },
  { id: 6, lon: 180 },
  { id: 7, lon: 210 },
  { id: 8, lon: 240 },
  { id: 9, lon: 270 },
  { id: 11, lon: 5 },
];

/** [0] はダミー。1H = 90° から 30° 刻み */
const CUSPS = [0, 90, 120, 150, 180, 210, 240, 270, 300, 330, 0, 30, 60];

const INPUT: TransitEventsInput = {
  startJd: START_JD,
  days: 3,
  bodies: "all",
  natalPlanets: NATAL_PLANETS,
  cusps: CUSPS,
  angles: { asc: 90, mc: 300 },
};

/** 「解析解と 1 分以内」 */
function expectWithinMinute(actual: number | null, expected: number, label: string): void {
  expect(actual, label).not.toBeNull();
  expect(Math.abs((actual as number) - expected), `${label}（${(((actual as number) - expected) * 1440).toFixed(2)} 分ずれ）`).toBeLessThan(MINUTE);
}

describe("期間内のトランジットイベント（疎サンプル＋3 次エルミート補間）", () => {
  it("等速で動く天体の entering / exact / leaving が解析解と 1 分以内で一致する", () => {
    // 月を 13°/日 で 100° から走らせる ―― ネイタルの太陽（0°）に 120° トラインを 1 本だけ作る
    const engine = makeEventEngine({ 1: { base: 100, rate: 13 } });
    const scan = scanTransitEvents(engine, INPUT);

    const windows = scan.windows.filter(
      (window) => window.transitId === 1 && window.target.id === 0,
    );
    expect(windows).toHaveLength(1);
    const window = windows[0] as (typeof windows)[number];

    expect(window.aspect.name).toBe("トライン");
    expect(window.transit).toBe("月");
    expect(window.target.name).toBe("太陽");
    // 119° で入り、120° でぴったり、121° で外れる
    expectWithinMinute(window.entering, START_JD + 19 / 13, "entering");
    expect(window.exact).toHaveLength(1);
    expectWithinMinute(window.exact[0] as number, START_JD + 20 / 13, "exact");
    expectWithinMinute(window.leaving, START_JD + 21 / 13, "leaving");
    // exact がある窓は最小オーブ 0、入った時点ではオーブが縮む向き
    expect(window.minOrb).toBe(0);
    expect(window.minOrbAt).toBe(window.exact[0]);
    expect(window.applyingAtStart).toBe(true);
    expect(window.clipped).toBeUndefined();
  });

  it("ノード（id 11）は動く側にも相手側にも入らない", () => {
    const engine = makeEventEngine({ 1: { base: 100, rate: 13 } });
    const scan = scanTransitEvents(engine, INPUT);
    expect(scan.windows.length).toBeGreaterThan(0);
    expect(scan.windows.some((window) => window.target.id === 11)).toBe(false);
    expect(scan.windows.some((window) => window.transitId === 11)).toBe(false);
    expect(EVENT_BODIES.map((body) => body.id as number).includes(11)).toBe(false);
  });

  it("留の時刻が解析解（速度の零点）と 1 分以内", () => {
    // 水星を正弦で戻す。速度 = rate + amp·ω·cos(ωt) の零点が留
    const wave: Wave = { base: 100, rate: 0.5, amp: 15, period: 60, phase: 0 };
    const omega = omegaOf(wave);
    const arc = Math.acos(-wave.rate / ((wave.amp as number) * omega));
    const toRetrograde = arc / omega;
    const toDirect = (2 * Math.PI - arc) / omega;

    const engine = makeEventEngine({ 2: wave });
    const scan = scanTransitEvents(engine, { ...INPUT, days: 45, bodies: "no_moon" });
    const stations = scan.stations.filter((station) => station.id === 2);

    expect(stations).toHaveLength(2);
    expect(stations[0]?.to).toBe("retrograde");
    expect(stations[1]?.to).toBe("direct");
    expectWithinMinute(stations[0]?.jd as number, START_JD + toRetrograde, "留（逆行へ）");
    expectWithinMinute(stations[1]?.jd as number, START_JD + toDirect, "留（順行へ）");
    // 留の瞬間の黄経も真値と合う
    expect(stations[0]?.lon).toBeCloseTo(waveLon(wave, toRetrograde), 4);
    expect(stations[0]?.name).toBe("水星");
  });

  it("イングレスは 30° の倍数を横切る瞬間（逆行で戻るぶんも拾う）", () => {
    // 金星を 28° から 2°/日 で ―― 30°（牡牛座）を 1 日目、60°（双子座）を 16 日目に横切る
    const engine = makeEventEngine({ 3: { base: 28, rate: 2 } });
    const scan = scanTransitEvents(engine, { ...INPUT, days: 20 });
    const ingresses = scan.ingresses.filter((ingress) => ingress.id === 3);

    expect(ingresses).toHaveLength(2);
    expect(ingresses[0]?.sign).toBe("牡牛座");
    expect(ingresses[0]?.signIndex).toBe(1);
    expect(ingresses[0]?.retrograde).toBe(false);
    expectWithinMinute(ingresses[0]?.jd as number, START_JD + 1, "牡牛座入り");
    expect(ingresses[1]?.sign).toBe("双子座");
    expectWithinMinute(ingresses[1]?.jd as number, START_JD + 16, "双子座入り");

    // 逆行で戻るイングレス（火星を 31° から −2°/日 で 30° まで下ろす）
    const back = makeEventEngine({ 4: { base: 31, rate: -2 } });
    const backward = scanTransitEvents(back, { ...INPUT, days: 3 });
    const returning = backward.ingresses.filter((ingress) => ingress.id === 4);
    expect(returning).toHaveLength(1);
    expect(returning[0]?.sign).toBe("牡羊座");
    expect(returning[0]?.retrograde).toBe(true);
    expectWithinMinute(returning[0]?.jd as number, START_JD + 0.5, "牡羊座へ逆戻り");
  });

  it("0°/360° の継ぎ目をまたいでも切れない（350° → 10°）", () => {
    // 火星を 350° から 2°/日 で ―― 5 日目に 0° を越え、ネイタルの太陽（0°）に合を作る
    const engine = makeEventEngine({ 4: { base: 350, rate: 2 } });
    const scan = scanTransitEvents(engine, { ...INPUT, days: 10 });

    const ingresses = scan.ingresses.filter((ingress) => ingress.id === 4);
    expect(ingresses).toHaveLength(1);
    expect(ingresses[0]?.sign).toBe("牡羊座");
    expectWithinMinute(ingresses[0]?.jd as number, START_JD + 5, "牡羊座入り");

    const windows = scan.windows.filter(
      (window) => window.transitId === 4 && window.target.id === 0,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.aspect.name).toBe("コンジャンクション");
    expectWithinMinute(windows[0]?.entering as number, START_JD + 4.5, "合に入る");
    expectWithinMinute(windows[0]?.exact[0] as number, START_JD + 5, "合ぴったり");
    expectWithinMinute(windows[0]?.leaving as number, START_JD + 5.5, "合から外れる");
  });

  it("期間の端で切れた窓は entering / leaving が null（clipped が付く）", () => {
    const engine = makeEventEngine({
      5: { base: 0.3, rate: 0.001 }, // 木星: 期間を通してネイタル太陽と合
      6: { base: 0.5, rate: 0.2 }, // 土星: 期間頭から合、2.5 日目に外れる
      7: { base: 358.5, rate: 0.2 }, // 天王星: 2.5 日目に入り、期間末まで続く
    });
    const scan = scanTransitEvents(engine, { ...INPUT, days: 5, bodies: "outer" });
    const windowOf = (id: number) =>
      scan.windows.find((window) => window.transitId === id && window.target.id === 0);

    const through = windowOf(5);
    expect(through?.clipped).toBe("both");
    expect(through?.entering).toBeNull();
    expect(through?.leaving).toBeNull();
    expect(through?.exact).toEqual([]);
    expect(through?.minOrb).toBeCloseTo(0.3, 3);

    const fromStart = windowOf(6);
    expect(fromStart?.clipped).toBe("start");
    expect(fromStart?.entering).toBeNull();
    expectWithinMinute(fromStart?.leaving as number, START_JD + 2.5, "外れる");
    // 期間頭の時点でオーブは開く向き＝離反
    expect(fromStart?.applyingAtStart).toBe(false);

    const toEnd = windowOf(7);
    expect(toEnd?.clipped).toBe("end");
    expectWithinMinute(toEnd?.entering as number, START_JD + 2.5, "入る");
    expect(toEnd?.leaving).toBeNull();
    expect(toEnd?.applyingAtStart).toBe(true);
  });

  it("スクエアの 2 枝は別の窓になる（aspect はどちらも「スクエア」）", () => {
    // 月を 265° から 13°/日 で ―― 270°（−90 枝）と 450°＝90°（+90 枝）を通る
    const engine = makeEventEngine({ 1: { base: 265, rate: 13 } });
    const scan = scanTransitEvents(engine, { ...INPUT, days: 16 });
    const squares = scan.windows.filter(
      (window) =>
        window.transitId === 1 && window.target.id === 0 && window.aspect.angle === 90,
    );

    expect(squares).toHaveLength(2);
    expect(squares.map((window) => window.aspect.name)).toEqual(["スクエア", "スクエア"]);
    expect(squares.map((window) => window.aspect.symbol)).toEqual(["□", "□"]);
    expectWithinMinute(squares[0]?.exact[0] as number, START_JD + 5 / 13, "−90 枝の exact");
    expectWithinMinute(squares[1]?.exact[0] as number, START_JD + 185 / 13, "+90 枝の exact");
    // 枝の符号そのものは返さない（読む側には「スクエア」で足りる）
    expect(Object.keys(squares[0] as object)).not.toContain("branch");
  });

  it("期間の上限は bodies ごと。超えたら天体計算をせずに断る", () => {
    for (const [set, max] of Object.entries(MAX_DAYS)) {
      expect(() => assertDaysInRange(max, set as BodySet), set).not.toThrow();
      expect(() => assertDaysInRange(max + 1, set as BodySet), set).toThrow(AstroError);
    }
    expect(() => assertDaysInRange(0, "all")).toThrow(AstroError);
    // 逃げ道（月を外す・外惑星だけ・1 年なら年間概要）を文言に書いてある
    expect(() => assertDaysInRange(40, "all")).toThrow(/no_moon/);
    expect(() => assertDaysInRange(40, "all")).toThrow(/outer/);
    expect(() => assertDaysInRange(40, "all")).toThrow(/yearly_overview/);

    // 弾いた時点で天体計算は 1 回も走っていない（CPU を守るのが目的）
    const engine = makeEventEngine({});
    let calls = 0;
    const inner = engine.swe_calc_ut;
    engine.swe_calc_ut = (jd: number, planetId: number, flags: number): number[] => {
      calls++;
      return inner(jd, planetId, flags);
    };
    expect(() => scanTransitEvents(engine, { ...INPUT, days: 40, bodies: "all" })).toThrow(
      AstroError,
    );
    expect(() => scanTransitEvents(engine, { ...INPUT, days: 0 })).toThrow(AstroError);
    expect(calls).toBe(0);
  });

  it("bodies が天体の組を決め、天体計算の回数は理論値（Σ ceil(days/step) + 1）どおり", () => {
    expect(bodiesOf("all").map((body) => body.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bodiesOf("no_moon").map((body) => body.id)).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bodiesOf("outer").map((body) => body.id)).toEqual([5, 6, 7, 8, 9]);

    for (const set of ["all", "no_moon", "outer"] as BodySet[]) {
      const scan = scanTransitEvents(makeEventEngine({}), { ...INPUT, days: 7, bodies: set });
      const expected = bodiesOf(set).reduce(
        (total, body) => total + Math.ceil(7 / body.step) + 1,
        0,
      );
      expect(scan.ephemerisCalls, set).toBe(expected);
      // 走った天体はその組のぶんだけ
      const sampled = sampleBodies(makeEventEngine({}), START_JD, 7, bodiesOf(set));
      expect([...sampled.samples.keys()]).toEqual(bodiesOf(set).map((body) => body.id));
    }

    // 31 日・全天体でも 205 回（10 分刻みで総当たりすれば 44,650 回）
    const month = scanTransitEvents(makeEventEngine({}), { ...INPUT, days: 31, bodies: "all" });
    expect(month.ephemerisCalls).toBe(205);
  });

  it("天体計算は日付順にまとめて呼ぶ（同じ jd が続けば地球の位置が使い回される）", () => {
    const engine = makeEventEngine({});
    const jds: number[] = [];
    const inner = engine.swe_calc_ut;
    engine.swe_calc_ut = (jd: number, planetId: number, flags: number): number[] => {
      jds.push(jd);
      return inner(jd, planetId, flags);
    };
    scanTransitEvents(engine, { ...INPUT, days: 10 });
    for (let index = 1; index < jds.length; index++) {
      expect(jds[index]).toBeGreaterThanOrEqual(jds[index - 1] as number);
    }
    // 袖は要らない（エルミートは区間の両端だけで決まる）＝ 期間の頭ちょうどから始まる
    expect(jds[0]).toBe(START_JD);
  });

  it("補間は格子点の上では標本そのもの、間でも真値との差はごくわずか", () => {
    // 月らしい波（13.2 ± 1.8°/日・周期 27.55 日）を 1 日おき、木星らしい波（0.083 ± 0.094°/日・
    // 周期 399 日）を 4 日おきの格子で ―― 刻み幅を決めたときと同じ土俵
    const moon: Wave = { base: 100, rate: 13.2, amp: 7.9, period: 27.55, phase: 0.4 };
    const jupiter: Wave = { base: 88, rate: 0.083, amp: 6, period: 399, phase: 0.3 };
    const sampled = sampleBodies(
      makeEventEngine({ 1: moon, 5: jupiter }),
      START_JD,
      31,
      bodiesOf("all"),
    );

    for (const target of [
      { id: 1, step: 1, wave: moon },
      { id: 5, step: 4, wave: jupiter },
    ]) {
      const sample = sampled.samples.get(target.id) as { lon: number[]; speed: number[] };
      // 格子点の上（0 と step の倍数）は標本そのもの
      for (const t of [0, target.step, target.step * 2, 28]) {
        expect(positionAt(sample, target.step, t).lon).toBeCloseTo(waveLon(target.wave, t), 8);
        expect(positionAt(sample, target.step, t).speed).toBeCloseTo(
          waveSpeed(target.wave, t),
          8,
        );
      }
      for (let t = 0; t <= 31; t += 0.05) {
        const at = positionAt(sample, target.step, t);
        expect(Math.abs(wrap180(at.lon - waveLon(target.wave, t))), `${target.id}: t=${t}`)
          .toBeLessThan(2e-4);
        expect(Math.abs(at.speed - waveSpeed(target.wave, t)), `${target.id}: t=${t} の速度`)
          .toBeLessThan(1e-3);
      }
    }
  });

  it("細かさは 10 分刻み", () => {
    expect(TICK_MINUTES).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** 開始から d 日 ＋ h 時 m 分 の jd */
function moment(d: number, hour = 0, minute = 0): number {
  return START_JD + d + hour / 24 + minute / 1440;
}

/** 呼び出し側が渡す「MM-DD HH:mm」（ここでは UTC のまま） */
const when = (jd: number): string =>
  dateFromJulianDay(jd).toISOString().slice(5, 16).replace("T", " ");

const SUN_TARGET = { kind: "planet" as const, name: "太陽", id: 0, house: 5, lon: 0 };
const MOON_TARGET = { kind: "planet" as const, name: "月", id: 1, house: 3, lon: 30 };
const ASC_TARGET = { kind: "angle" as const, name: "ASC", id: null, house: null, lon: 90 };

/** 走査の結果を手で書き起こした見本（窓あり／exact 複数／exact なし／留／イングレス） */
const SAMPLE: TransitEventScan = {
  startJd: START_JD,
  endJd: START_JD + 14,
  days: 14,
  ephemerisCalls: 205,
  windows: [
    {
      transitId: 1,
      transit: "月",
      target: SUN_TARGET,
      aspect: { angle: 120, name: "トライン", symbol: "△" },
      entering: moment(2, 1, 20),
      exact: [moment(2, 3, 14)],
      leaving: moment(2, 5, 8),
      minOrb: 0,
      minOrbAt: moment(2, 3, 14),
      applyingAtStart: true,
    },
    {
      transitId: 6,
      transit: "土星",
      target: ASC_TARGET,
      aspect: { angle: 90, name: "スクエア", symbol: "□" },
      entering: moment(3, 9, 30),
      exact: [moment(5, 11, 47), moment(13, 3, 10)],
      leaving: null,
      minOrb: 0,
      minOrbAt: moment(5, 11, 47),
      applyingAtStart: true,
      clipped: "end",
    },
    {
      transitId: 5,
      transit: "木星",
      target: MOON_TARGET,
      aspect: { angle: 60, name: "セクスタイル", symbol: "⚹" },
      entering: null,
      exact: [],
      leaving: moment(5, 6, 15),
      minOrb: 0.41,
      minOrbAt: moment(5, 6, 15),
      applyingAtStart: false,
      clipped: "start",
    },
  ],
  stations: [
    { id: 2, name: "水星", jd: moment(2, 14, 2), to: "retrograde", lon: 145.3 },
  ],
  ingresses: [
    {
      id: 3,
      name: "金星",
      jd: moment(4, 9, 30),
      signIndex: 5,
      sign: "乙女座",
      retrograde: false,
    },
  ],
};

describe("トランジットイベントのテキスト整形", () => {
  it("1 本の時系列にまとめ、末尾に件数を出す", () => {
    const lines = formatEventsText(SAMPLE, when);
    expect(lines[0]).toBe("■ 期間内のイベント（時系列。t.＝トランジット / n.＝ネイタル）");
    // 並びの鍵は entering（無ければ期間頭）＝ 期間頭から続く木星の窓が先頭に来る
    expect(lines.slice(1, 6)).toEqual([
      "08-20 —〜08-25 06:15（期間頭から継続）  t.木星 ⚹ n.月(3H)  最小オーブ 0.41°（exact なし）",
      "08-22 01:20〜05:08  t.月 △ n.太陽(5H)  exact 03:14",
      "08-22 14:02  t.水星 留（逆行へ）",
      "08-23 09:30〜（期間末まで継続）  t.土星 □ n.ASC  exact 08-25 11:47, 09-02 03:10",
      "08-24 09:30  t.金星 乙女座入り",
    ]);
    expect(lines[lines.length - 1]).toBe(
      "■ 件数 アスペクト窓 3 / exact 3 / 留 1 / イングレス 1",
    );
  });

  it("同じ日なら時刻だけ、日が違えば月日つき", () => {
    const lines = formatEventsText(SAMPLE, when);
    // 入りと外れが同じ日 → 外れは時刻だけ
    expect(lines.some((line) => line.includes("08-22 01:20〜05:08"))).toBe(true);
    // exact が別の日 → 月日つきで並べる
    expect(lines.some((line) => line.includes("exact 08-25 11:47, 09-02 03:10"))).toBe(true);
  });

  it("留の向き・逆行イングレスの但し書き", () => {
    const scan: TransitEventScan = {
      ...SAMPLE,
      windows: [],
      stations: [
        { id: 2, name: "水星", jd: moment(1, 4, 0), to: "retrograde", lon: 145.3 },
        { id: 2, name: "水星", jd: moment(9, 22, 30), to: "direct", lon: 130.1 },
      ],
      ingresses: [
        { id: 6, name: "土星", jd: moment(3), signIndex: 11, sign: "魚座", retrograde: true },
      ],
    };
    const lines = formatEventsText(scan, when);
    expect(lines).toContain("08-21 04:00  t.水星 留（逆行へ）");
    expect(lines).toContain("08-29 22:30  t.水星 留（順行へ）");
    expect(lines).toContain("08-23 00:00  t.土星 魚座入り（逆行で戻る）");
    expect(lines[lines.length - 1]).toBe(
      "■ 件数 アスペクト窓 0 / exact 0 / 留 2 / イングレス 1",
    );
  });

  it("イベントが 1 件も無ければ「なし」", () => {
    const empty: TransitEventScan = {
      ...SAMPLE,
      windows: [],
      stations: [],
      ingresses: [],
    };
    const lines = formatEventsText(empty, when);
    expect(lines).toEqual([
      "■ 期間内のイベント（時系列。t.＝トランジット / n.＝ネイタル）",
      "なし",
      "",
      "■ 件数 アスペクト窓 0 / exact 0 / 留 0 / イングレス 0",
    ]);
  });

  it("期間を通して続く窓は「期間を通して継続」", () => {
    const scan: TransitEventScan = {
      ...SAMPLE,
      windows: [
        {
          ...(SAMPLE.windows[2] as (typeof SAMPLE.windows)[number]),
          leaving: null,
          clipped: "both",
        },
      ],
      stations: [],
      ingresses: [],
    };
    const lines = formatEventsText(scan, when);
    expect(lines[1]).toBe(
      "08-20 —〜（期間を通して継続）  t.木星 ⚹ n.月(3H)  最小オーブ 0.41°（exact なし）",
    );
  });

  it("実際の走査結果もそのまま文字列になる", () => {
    const engine = makeEventEngine({
      1: { base: 100, rate: 13 },
      2: { base: 28, rate: 2 },
      5: { base: 0.3, rate: 0.001 },
    });
    const scan = scanTransitEvents(engine, { ...INPUT, days: 10 });
    const lines = formatEventsText(scan, when);
    expect(lines.every((line) => !line.includes("undefined"))).toBe(true);
    expect(lines.some((line) => line.includes("t.月 "))).toBe(true);
    expect(lines.some((line) => line.includes("入り"))).toBe(true);
    // 行数は「見出し＋イベント＋空行＋件数」、件数行は走査結果と合う
    const exacts = scan.windows.reduce((total, window) => total + window.exact.length, 0);
    expect(lines).toHaveLength(scan.windows.length + scan.stations.length + scan.ingresses.length + 3);
    expect(lines[lines.length - 1]).toBe(
      `■ 件数 アスペクト窓 ${scan.windows.length} / exact ${exacts} / ` +
        `留 ${scan.stations.length} / イングレス ${scan.ingresses.length}`,
    );
  });
});
