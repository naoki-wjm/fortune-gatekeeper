import { describe, expect, it } from "vitest";
import { AstroError, dateFromJulianDay, normalizeDegree } from "../src/astro/chart";
import {
  BASE_STEP,
  YEARLY_PLANETS,
  buildDailyTable,
  formatYearlyText,
  scanYearlyRange,
  type YearlyScan,
  type YearlyScanInput,
} from "../src/astro/yearly";
import { makeFakeEngine, type FakeEngine } from "./stubs/fake-engine";
import { bruteScanYearlyRange } from "./stubs/brute-yearly";

/** 偽エンジンと同じ式でユリウス日を作る */
function jdOf(year: number, month: number, day: number, hour = 0): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 2440587.5 + hour / 24;
}

/** ソーラーリターンの瞬間らしく、半端な時刻から始める */
const START_JD = jdOf(2026, 3, 10, 9.6);
const END_JD = START_JD + 365.24;

/**
 * 合成天体。`lon(t) = base + rate·t + amp·(sin(ωt + phase) − sin(phase))`（t は開始からの日数）。
 * 正弦の戻りで逆行が出る ―― 本物の天体と違って**真値を式で書けるので**、
 * 「毎日そのまま評価した日次スキャン」を物差しにできる。
 */
interface Wave {
  base: number;
  rate: number;
  amp: number;
  period: number;
  phase: number;
}

/** 逆行・イングレス・アスペクトが一通り出るように選んだパラメータ（紙一重の日を避けてある） */
const WAVES: Record<number, Wave> = {
  2: { base: 12.3, rate: 1.2, amp: 26, period: 116, phase: Math.PI },
  3: { base: 200.7, rate: 1.0, amp: 60, period: 225, phase: 0.7 },
  4: { base: 310.2, rate: 0.5, amp: 40, period: 400, phase: 3.7 },
  5: { base: 88.6, rate: 0.083, amp: 11, period: 399, phase: 0.3 },
  6: { base: 358.4, rate: 0.033, amp: 7, period: 378, phase: 1.1 },
  7: { base: 59.5, rate: 0.011, amp: 4, period: 370, phase: 2.2 },
  8: { base: 29.6, rate: 0.006, amp: 2.5, period: 367, phase: 0.9 },
  9: { base: 300.4, rate: 0.0015, amp: 0.25, period: 366, phase: 1.4 },
};

function waveLon(wave: Wave, t: number): number {
  const omega = (2 * Math.PI) / wave.period;
  return normalizeDegree(
    wave.base + wave.rate * t + wave.amp * (Math.sin(omega * t + wave.phase) - Math.sin(wave.phase)),
  );
}

function waveSpeed(wave: Wave, t: number): number {
  const omega = (2 * Math.PI) / wave.period;
  return wave.rate + wave.amp * omega * Math.cos(omega * t + wave.phase);
}

/** WAVES どおりに動く偽エンジン（swe_calc_ut だけ差し替え） */
function makeWaveEngine(waves: Record<number, Wave> = WAVES, startJd = START_JD): FakeEngine {
  const engine = makeFakeEngine();
  engine.swe_calc_ut = (jd: number, planetId: number, _flags: number): number[] => {
    const wave = waves[planetId];
    if (!wave) return [0, 0, 1, 0, 0, 0];
    const t = jd - startJd;
    return [waveLon(wave, t), 0, 1, waveSpeed(wave, t), 0, 0];
  };
  return engine;
}

/** ネイタル（トランジットが通りかかるように配置した 11 天体。id 11 はノード＝除外されるはず） */
const NATAL_PLANETS = [
  { id: 0, lon: 5 },
  { id: 1, lon: 190 },
  { id: 2, lon: 120 },
  { id: 3, lon: 29 },
  { id: 4, lon: 240 },
  { id: 5, lon: 200 },
  { id: 6, lon: 270 },
  { id: 7, lon: 88 },
  { id: 8, lon: 315 },
  { id: 9, lon: 45 },
  { id: 11, lon: 5 },
];

/** [0] はダミー。1H = 90° から 30° 刻み */
const CUSPS = [0, 90, 120, 150, 180, 210, 240, 270, 300, 330, 0, 30, 60];

const INPUT: YearlyScanInput = {
  startJd: START_JD,
  endJd: END_JD,
  natalPlanets: NATAL_PLANETS,
  cusps: CUSPS,
  angles: { asc: 90, mc: 300.6 },
};

/** 日付の比較用に、jd を「開始から何日目か」に直した要約 */
function summarize(scan: YearlyScan): unknown {
  const day = (jd: number): number => Math.round((jd - START_JD) * 100) / 100;
  return {
    retrogrades: scan.retrogrades.map((period) => ({
      planet: period.planet,
      start: day(period.startJd),
      end: day(period.endJd),
      clipped: period.clipped ?? null,
    })),
    ingresses: scan.ingresses.map((ingress) => ({
      planet: ingress.planet,
      day: day(ingress.jd),
      sign: ingress.sign,
      retrograde: ingress.retrograde,
    })),
    angleAspects: scan.angleAspects.map((window) => ({
      transit: window.transit,
      angle: window.angle,
      symbol: window.aspect.symbol,
      start: day(window.startJd),
      end: day(window.endJd),
      exact: day(window.exactJd),
      clipped: window.clipped ?? null,
    })),
    natalAspects: scan.natalAspects.map((window) => ({
      transit: window.transit,
      natal: window.natal,
      house: window.house,
      symbol: window.aspect.symbol,
      start: day(window.startJd),
      end: day(window.endJd),
      exact: day(window.exactJd),
      clipped: window.clipped ?? null,
    })),
  };
}

describe("年間概要の走査（疎サンプル＋3 次補間）", () => {
  it("毎日の総当たり（真値）と同じ日付を出す", () => {
    const scan = scanYearlyRange(makeWaveEngine(), INPUT);
    const truth = bruteScanYearlyRange(makeWaveEngine(), INPUT);

    // イベントが一通り出ている図であることを先に確かめる（空同士の一致では意味がない）
    expect(truth.retrogrades.length).toBeGreaterThan(8);
    expect(truth.ingresses.length).toBeGreaterThan(2);
    expect(truth.angleAspects.length).toBeGreaterThan(0);
    expect(truth.natalAspects.length).toBeGreaterThan(4);

    expect(summarize(scan)).toEqual(summarize(truth));

    // 最接近のオーブも真値と同じ桁で出る
    scan.natalAspects.forEach((window, index) => {
      expect(window.minOrb).toBeCloseTo(truth.natalAspects[index]?.minOrb as number, 2);
    });
  });

  it("ノード（id 11）はアスペクト探索から外れる", () => {
    const scan = scanYearlyRange(makeWaveEngine(), INPUT);
    expect(scan.natalAspects.length).toBeGreaterThan(0);
    expect(scan.natalAspects.some((window) => window.natalId === 11)).toBe(false);
  });

  it("0°/360° をまたいでも補間が切れない（アンラップ）", () => {
    // 350° から 1 日 1° で進み、開始 10 日で 0° をまたぐ天体
    const wrapping: Record<number, Wave> = {
      5: { base: 350, rate: 1, amp: 0, period: 100, phase: 0 },
    };
    const engine = makeWaveEngine(wrapping);
    const table = buildDailyTable(engine, START_JD, 40, 5, 8);

    for (let d = 0; d <= 40; d++) {
      expect(table.lon[d] as number).toBeCloseTo(waveLon(wrapping[5] as Wave, d), 6);
      expect(table.speed[d] as number).toBeCloseTo(1, 6);
    }
    // 継ぎ目の前後（359° → 0° → 1°）でも値が飛ばない
    expect(table.lon[9] as number).toBeCloseTo(359, 6);
    expect(table.lon[10] as number).toBeCloseTo(0, 6);
    expect(table.lon[11] as number).toBeCloseTo(1, 6);
  });

  it("イングレスは 0° またぎでも拾う（魚座 → 牡羊座）", () => {
    const scan = scanYearlyRange(makeWaveEngine(), INPUT);
    const truth = bruteScanYearlyRange(makeWaveEngine(), INPUT);
    const aries = scan.ingresses.filter((ingress) => ingress.sign === "牡羊座");
    expect(aries.length).toBeGreaterThan(0);
    expect(aries.map((ingress) => ingress.jd)).toEqual(
      truth.ingresses.filter((ingress) => ingress.sign === "牡羊座").map((ingress) => ingress.jd),
    );
  });

  it("期間の端で切れた窓に clipped が付く", () => {
    const scan = scanYearlyRange(makeWaveEngine(), INPUT);

    // 水星は位相 π ＝ 開始時点ですでに逆行（もっと前から続いている）
    const mercury = scan.retrogrades.filter((period) => period.id === 2);
    expect(mercury[0]?.startJd).toBe(START_JD);
    expect(mercury[0]?.clipped).toBe("start");

    // 火星は期間末にまだ逆行中（次の年へ続く）＝ endJd で閉じる
    const mars = scan.retrogrades.filter((period) => period.id === 4);
    const last = mars[mars.length - 1];
    expect(last?.endJd).toBe(END_JD);
    expect(last?.clipped).toBe("end");

    // 冥王星は 1 年を通して MC とコンジャンクション（両端が切れている）
    const mc = scan.angleAspects.find(
      (window) => window.transitId === 9 && window.angle === "MC",
    );
    expect(mc?.aspect.name).toBe("コンジャンクション");
    expect(mc?.clipped).toBe("both");
    expect(mc?.startJd).toBe(START_JD);
    expect(mc?.endJd).toBe(END_JD);
  });

  it("start は入った最初の日、end は外れた最初の日", () => {
    const scan = scanYearlyRange(makeWaveEngine(), INPUT);
    const truth = bruteScanYearlyRange(makeWaveEngine(), INPUT);

    // 窓の中の日はアスペクトが立っていて、end の日にはもう外れている（真値で確かめる）
    const window = truth.natalAspects.find((candidate) => candidate.clipped === undefined);
    expect(window).toBeDefined();
    const target = NATAL_PLANETS.find((planet) => planet.id === (window?.natalId as number));
    const wave = WAVES[window?.transitId as number] as Wave;
    const orbAt = (jd: number): number => {
      let diff = Math.abs(waveLon(wave, jd - START_JD) - (target?.lon as number));
      if (diff > 180) diff = 360 - diff;
      return Math.abs(diff - (window?.aspect.angle as number));
    };
    expect(orbAt(window?.startJd as number)).toBeLessThanOrEqual(1);
    expect(orbAt((window?.startJd as number) - 1)).toBeGreaterThan(1);
    expect(orbAt((window?.endJd as number) - 1)).toBeLessThanOrEqual(1);
    expect(orbAt(window?.endJd as number)).toBeGreaterThan(1);

    // 疎サンプル版も同じ窓を出している
    expect(
      scan.natalAspects.some(
        (candidate) =>
          candidate.startJd === window?.startJd && candidate.endJd === window?.endJd,
      ),
    ).toBe(true);
  });

  it("並びは start の時系列（同日なら天体順）", () => {
    const scan = scanYearlyRange(makeWaveEngine(), INPUT);
    for (let i = 1; i < scan.natalAspects.length; i++) {
      const previous = scan.natalAspects[i - 1] as { startJd: number; transitId: number };
      const current = scan.natalAspects[i] as { startJd: number; transitId: number };
      expect(current.startJd).toBeGreaterThanOrEqual(previous.startJd);
      if (current.startJd === previous.startJd) {
        expect(current.transitId).toBeGreaterThanOrEqual(previous.transitId);
      }
    }
    for (let i = 1; i < scan.ingresses.length; i++) {
      expect(scan.ingresses[i]?.jd).toBeGreaterThanOrEqual(scan.ingresses[i - 1]?.jd as number);
    }
  });

  it("ソーラーリターン年としてありえない長さは計算しない", () => {
    const engine = makeWaveEngine();
    expect(() => scanYearlyRange(engine, { ...INPUT, endJd: START_JD + 200 })).toThrow(AstroError);
    expect(() => scanYearlyRange(engine, { ...INPUT, endJd: START_JD + 500 })).toThrow(
      /300〜400日/,
    );
    // 弾いた時点で天体計算は 1 回も走っていない（CPU を守るのが目的）
    const counting = makeWaveEngine();
    let calls = 0;
    const inner = counting.swe_calc_ut;
    counting.swe_calc_ut = (jd: number, planetId: number, flags: number): number[] => {
      calls++;
      return inner(jd, planetId, flags);
    };
    expect(() => scanYearlyRange(counting, { ...INPUT, endJd: START_JD + 500 })).toThrow(
      AstroError,
    );
    expect(calls).toBe(0);
  });

  it("刻み幅はすべて BASE_STEP の倍数（同じ日付に当たる天体をまとめて呼ぶため）", () => {
    for (const planet of YEARLY_PLANETS) {
      expect(planet.step % BASE_STEP, planet.name).toBe(0);
    }
  });

  it("天体計算は日付順にまとめて呼ぶ（同じ jd が続けば地球の位置が使い回される）", () => {
    const engine = makeWaveEngine();
    const jds: number[] = [];
    const inner = engine.swe_calc_ut;
    engine.swe_calc_ut = (jd: number, planetId: number, flags: number): number[] => {
      jds.push(jd);
      return inner(jd, planetId, flags);
    };
    scanYearlyRange(engine, INPUT);
    // jd は単調非減少（同じ日付の天体が隣り合い、日付をさかのぼらない）
    for (let i = 1; i < jds.length; i++) {
      expect(jds[i]).toBeGreaterThanOrEqual(jds[i - 1] as number);
    }
    // 先頭は最も粗い刻み（16 日）の袖、末尾も同様に期間末の先
    expect(jds[0]).toBe(START_JD - 16);
  });

  it("天体計算の回数は理論値（Σ ceil(days/step) + 4）どおり", () => {
    const engine = makeWaveEngine();
    const scan = scanYearlyRange(engine, INPUT);
    const expected = YEARLY_PLANETS.reduce(
      (total, planet) => total + Math.ceil(scan.days / planet.step) + 4,
      0,
    );
    expect(scan.days).toBe(365);
    expect(scan.ephemerisCalls).toBe(expected);
    // 総当たり（8 天体 × 366 日 ＝ 2,928 回）の 1 割強で済んでいる
    expect(scan.ephemerisCalls).toBeLessThan(400);
  });

  it("日次表は格子点の上では標本そのもの", () => {
    const engine = makeWaveEngine();
    const table = buildDailyTable(engine, START_JD, 365, 5, 8);
    for (const d of [0, 8, 16, 360]) {
      expect(table.lon[d] as number).toBeCloseTo(waveLon(WAVES[5] as Wave, d), 8);
    }
    // 格子の間でも真値との差は 1e-3° 未満（Moshier 暦自身の精度と同じ桁）
    for (let d = 0; d <= 365; d++) {
      const diff = Math.abs((table.lon[d] as number) - waveLon(WAVES[5] as Wave, d));
      expect(Math.min(diff, 360 - diff)).toBeLessThan(1e-3);
    }
  });
});

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** 開始から d 日目の jd */
function day(d: number): number {
  return START_JD + d;
}

const dateOf = (jd: number): string => dateFromJulianDay(jd).toISOString().slice(0, 10);

/** 4 節ぶんの見本（走査の結果を手で書き起こしたもの） */
const SAMPLE: YearlyScan = {
  days: 365,
  ephemerisCalls: 355,
  retrogrades: [
    { id: 2, planet: "水星", startJd: START_JD, endJd: day(23), clipped: "start" },
    { id: 2, planet: "水星", startJd: day(130), endJd: day(151) },
    { id: 4, planet: "火星", startJd: day(300), endJd: END_JD, clipped: "end" },
  ],
  ingresses: [
    { id: 8, planet: "海王星", jd: day(20), signIndex: 0, sign: "牡羊座", retrograde: false },
    { id: 6, planet: "土星", jd: day(175), signIndex: 11, sign: "魚座", retrograde: true },
  ],
  angleAspects: [
    {
      transitId: 5,
      transit: "木星",
      angle: "ASC",
      aspect: { angle: 120, name: "トライン", symbol: "△" },
      startJd: day(52),
      endJd: day(71),
      exactJd: day(61),
      minOrb: 0.02,
    },
  ],
  natalAspects: [
    {
      transitId: 6,
      transit: "土星",
      natalId: 0,
      natal: "太陽",
      house: 5,
      aspect: { angle: 90, name: "スクエア", symbol: "□" },
      startJd: day(52),
      endJd: day(71),
      exactJd: day(61),
      minOrb: 0.13,
    },
    {
      transitId: 6,
      transit: "土星",
      natalId: 0,
      natal: "太陽",
      house: 5,
      aspect: { angle: 90, name: "スクエア", symbol: "□" },
      startJd: day(145),
      endJd: END_JD,
      exactJd: day(163),
      minOrb: 0.01,
      clipped: "end",
    },
  ],
};

describe("年間概要のテキスト整形", () => {
  it("4 節（逆行・イングレス・ASC/MC・ネイタル）を calc.js と同じ順で出す", () => {
    const lines = formatYearlyText(SAMPLE, dateOf);
    expect(lines[0]).toBe("■ 逆行期間");
    expect(lines).toContain("■ 星座イングレス（木星〜冥王星）");
    expect(lines).toContain("■ ASC / MC へのトランジット");
    expect(lines).toContain("■ ネイタル天体へのトランジット");
  });

  it("逆行は 8 天体すべてを並べ、出番の無い天体は「なし」", () => {
    const lines = formatYearlyText(SAMPLE, dateOf);
    expect(lines).toContain(
      `水星: ${dateOf(START_JD)}〜${dateOf(day(23))}（期間頭から継続）, ${dateOf(day(130))}〜${dateOf(day(151))}`,
    );
    expect(lines).toContain(`火星: ${dateOf(day(300))}〜${dateOf(END_JD)}（期間末まで継続）`);
    expect(lines).toContain("金星: なし");
    expect(lines).toContain("木星: なし");
    expect(lines).toContain("冥王星: なし");
    // 並びは YEARLY_PLANETS（水星→冥王星）のまま
    expect(lines.slice(1, 9).map((line) => line.split(":")[0])).toEqual(
      YEARLY_PLANETS.map((planet) => planet.name),
    );
  });

  it("イングレスは逆行で戻るものに但し書きを付ける", () => {
    const lines = formatYearlyText(SAMPLE, dateOf);
    expect(lines).toContain(`海王星: ${dateOf(day(20))} 牡羊座入り`);
    expect(lines).toContain(`土星: ${dateOf(day(175))} 魚座入り（逆行で戻る）`);
  });

  it("トランジットは期間と最接近の日を添える", () => {
    const lines = formatYearlyText(SAMPLE, dateOf);
    expect(lines).toContain(
      `t.木星 △ n.ASC: ${dateOf(day(52))}〜${dateOf(day(71))}（最接近 ${dateOf(day(61))}）`,
    );
    expect(lines).toContain(
      `t.土星 □ n.太陽(5H): ${dateOf(day(52))}〜${dateOf(day(71))}（最接近 ${dateOf(day(61))}）`,
    );
    expect(lines).toContain(
      `t.土星 □ n.太陽(5H): ${dateOf(day(145))}〜${dateOf(END_JD)}（最接近 ${dateOf(day(163))}、期間末まで継続）`,
    );
  });

  it("0 件の節は「なし」だけを出す", () => {
    const empty: YearlyScan = {
      days: 365,
      ephemerisCalls: 0,
      retrogrades: [],
      ingresses: [],
      angleAspects: [],
      natalAspects: [],
    };
    const lines = formatYearlyText(empty, dateOf);
    expect(lines.filter((line) => line === "なし")).toHaveLength(3);
    expect(lines.filter((line) => line.endsWith(": なし"))).toHaveLength(8);
  });

  it("実際の走査結果もそのまま文字列になる", () => {
    const scan = scanYearlyRange(makeWaveEngine(), INPUT);
    const lines = formatYearlyText(scan, dateOf);
    // 逆行の 8 行＋見出し、各節の見出しがそろっている
    expect(lines.filter((line) => line.startsWith("■"))).toHaveLength(4);
    expect(lines.some((line) => line.startsWith("t.冥王星 ☌ n.MC:"))).toBe(true);
    expect(lines.every((line) => !line.includes("undefined"))).toBe(true);
  });
});
