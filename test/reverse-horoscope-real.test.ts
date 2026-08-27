/**
 * 逆引きホロスコープを**本物の Swiss Ephemeris（wasm）**で確かめる。
 *
 * 偽エンジンのテスト（test/reverse-horoscope.test.ts）が見るのは配線と枝で、
 * 「本当にその日その配置になるのか」は誰も見ていない。ここで実物に当てる。
 *
 * 本物の wasm の読み方は test/moon-calendar-real.test.ts と同じ流儀
 * （本番の src/astro/engine.ts は workerd 流の wasm import なので Node では読めない。
 *   glue に wasmBinary を直接渡せば Node でも初期化できる）。
 *
 * 突き合わせは 2 本立て:
 *
 *  1. **6 時間刻みの総当たり**（test/stubs/brute-reverse.ts＝astro-viewer の reverse.js と同じ判定）と
 *     候補日の集合を比べる。総当たりは 6 時間より短い当たりを落とすので、
 *     「総当たりが拾った日 ⊆ 新実装の日」＋「新実装だけが拾った日は 6 時間未満の当たり」の 2 段で見る。
 *     **年代も散らす** ―― 1850・1950・2050・2150 の各 1 年ぶん（2026-08-27 再査読対応。
 *     Moshier の精度も探索の刻みも年代で変わりうるので、許容年代の端のほうも突き合わせておく）。
 *  2. **外の値**（春分の瞬間）と、太陽が牡羊座に居る期間の端を直に比べる。
 *  3. **書いてある限界の実物での当たり**（2026-08-27 再査読対応）。「留が星座の境のすぐ内側で起きる
 *     短い出入り」は 1800〜2200 年に実際にあり、いちばん浅いものでも 7.65 時間ある＝拾えている。
 *
 * 実測（手元の Node・3 回の最小値・2026-08-27）。「窓」は窓を求める走査ぶん、
 * 「計」は返す候補日に添える正午の空（日数 × 10 天体・最大 600 回）まで含めた実数:
 *
 *   条件                                  範囲   窓     計      時間
 *   太陽 牡羊座 ＋ 月 蟹座                 2 年     17    87     5ms
 *   太陽 牡羊座 ＋ 水星 牡羊座 ＋ 月（可）  10 年    343   943    51ms
 *   太陽 牡牛座 ＋ 水星 牡牛座 ＋ 月 乙女座  30 年  1,044 1,614   108ms
 *   月 牡羊座だけ                         30 年    805 1,405   203ms
 *   水星 魚座だけ（30 年は入口の枠の外）      30 年  3,845 4,445   251ms
 *   水星 魚座だけ（入口から頼める最重）        10 年  1,259 1,859   101ms
 *   冥王星 牡羊座 ＋ 太陽（1 日も無い）      30 年    333   333    23ms
 *
 *   同じ条件を 6 時間刻みで総当たりすると 1 年あたり 1,460 回 × 天体の数
 *   （30 年・2 天体なら 87,700 回）なので、二桁ぶん軽い。
 *   Workers 実機は手元の 2〜5 倍（AGENTS.md の実測メモ）なので、いちばん重い形でも 1 秒台の見当。
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { CALC_FLAGS, type SwissEph } from "../src/astro/chart";
import {
  parseReverseHoroscopeArguments,
  reverseHoroscope,
  reverseRangeJd,
  scanReverseHoroscope,
  splitByLocalDay,
  type Interval,
  type ReverseCondition,
  type ReverseHoroscopeRequest,
} from "../src/reverse-horoscope";
import { BRUTE_STEP, bruteCandidateDays } from "./stubs/brute-reverse";

let swe: SwissEph;

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
});

/** UT で見る（外の表と直に比べられるように、時差 0 で引く） */
function request(conditions: unknown[], yearFrom: number, yearTo: number): ReverseHoroscopeRequest {
  return parseReverseHoroscopeArguments({
    conditions,
    year_from: yearFrom,
    year_to: yearTo,
    utc_offset: 0,
  });
}

/**
 * 引数の口を通さずにリクエストを組む。
 *
 * 2026-08-27 に「required が 1 本だけなら 10 年ぶんまで」という枠を入口に足した（I-4）ので、
 * 「水星だけ・30 年」のようないちばん重い形は**入口からは呼べない**。それでも予算の測り直しは
 * その形でやりたい（枠の外側でも収まっていることを見ておけば、枠の内側は当然収まる）ので、
 * 計算の入口（`scanReverseHoroscope`）を直に叩くためのこれを置いてある。
 */
function rawRequest(
  conditions: ReverseCondition[],
  yearFrom: number,
  yearTo: number,
  utcOffset = 9,
): ReverseHoroscopeRequest {
  return { conditions, yearFrom, yearTo, utcOffset };
}

/** `rawRequest` に渡す 1 条件（星座は 0 = 牡羊座 の番号で） */
function required(body: ReverseCondition["body"], signIndex: number): ReverseCondition {
  return { body, signIndex, priority: "required" };
}

/**
 * 総当たりと突き合わせる。
 *
 * 6 時間刻みの格子は範囲の頭（＝現地の 0 時）から敷いてあるので、
 * **6 時間以上続く当たりは必ずどれかの格子点に当たる**。逆に言えば、総当たりが落とすのは
 * 6 時間より短い当たりだけ ―― 新実装だけが拾った日はそれに当てはまるはず、というのが下の 2 段目。
 */
function compareWithBrute(conditions: unknown[], yearFrom: number, yearTo: number): void {
  const input = request(conditions, yearFrom, yearTo);
  const range = reverseRangeJd(swe, input);
  const scan = scanReverseHoroscope(swe, input);
  const mine = splitByLocalDay(scan.intervals, input.utcOffset);
  const brute = bruteCandidateDays(swe, input, range.start, range.end);

  expect(brute.size).toBeGreaterThan(0);

  // 1 段目: 総当たりが拾った日は、必ず新実装も拾っている
  const missed = [...brute].filter((day) => !mine.has(day));
  expect(missed, `総当たりが拾った日を新実装が落とした: ${missed.join(", ")}`).toEqual([]);

  // 2 段目: 新実装だけが拾った日は、その日の当たりがどれも 6 時間より短い
  for (const [day, ranges] of mine) {
    if (brute.has(day)) continue;
    for (const entry of ranges) {
      expect(
        entry.end - entry.start,
        `${day} は総当たりが落としたのに 6 時間以上ある（${(entry.end - entry.start) * 24} 時間）`,
      ).toBeLessThan(BRUTE_STEP + 1e-6);
    }
  }
}

describe("6 時間刻みの総当たりと同じ日を拾う", () => {
  it("太陽 牡羊座 ＋ 月 蟹座（2000〜2001）", () => {
    compareWithBrute(
      [
        { body: "sun", sign: "aries" },
        { body: "moon", sign: "cancer" },
      ],
      2000,
      2001,
    );
  });

  it("太陽 乙女座 ＋ 水星 乙女座 ＋ 月 魚座（2010〜2011）", () => {
    compareWithBrute(
      [
        { body: "sun", sign: "virgo" },
        { body: "mercury", sign: "virgo" },
        { body: "moon", sign: "pisces" },
      ],
      2010,
      2011,
    );
  });

  it("月 蠍座だけ（2020〜2021。太陽が無くても動く）", () => {
    compareWithBrute([{ body: "moon", sign: "scorpio" }], 2020, 2021);
  });

  it("水星 双子座だけ（2015〜2016。粗い当たり付け → 1 日刻みの二段構えが効く形）", () => {
    compareWithBrute([{ body: "mercury", sign: "gemini" }], 2015, 2016);
  });

  it("金星 蟹座 ＋ 火星 牡羊座（2005〜2006。逆行で行き来する天体どうし）", () => {
    compareWithBrute(
      [
        { body: "venus", sign: "cancer" },
        { body: "mars", sign: "aries" },
      ],
      2005,
      2006,
    );
  });

  it("金星 乙女座 ＋ 火星 乙女座（2005〜2006。当たりが 3 日しかない狭い形）", () => {
    compareWithBrute(
      [
        { body: "venus", sign: "virgo" },
        { body: "mars", sign: "virgo" },
      ],
      2005,
      2006,
    );
  });

  it("木星 山羊座 ＋ 太陽 蟹座（2020〜2021。4 日刻みの外側の天体）", () => {
    compareWithBrute(
      [
        { body: "jupiter", sign: "capricorn" },
        { body: "sun", sign: "cancer" },
      ],
      2020,
      2021,
    );
  });

  /**
   * 年代を散らして同じことを見る（2026-08-27 再査読対応）。
   *
   * 上の 7 本はどれも 1998〜2021 年の 20 年ちょっとに固まっていて、許容年代（1800〜2200）の
   * 端のほうは誰も見ていなかった。Moshier の近似も補間の刻みも年代で振る舞いが変わりうるので、
   * 100 年おきに 1 年ぶんずつ、同じ 2 段の突き合わせをしておく。
   * 手元の Node での実測は 8 本合わせて 0.55 秒（総当たりが 1 年あたり 1,460 回 × 天体の数）。
   */
  for (const year of [1850, 1950, 2050, 2150]) {
    it(`太陽 牡羊座 ＋ 月 蟹座（${year} 年の 1 年ぶん）`, () => {
      compareWithBrute(
        [
          { body: "sun", sign: "aries" },
          { body: "moon", sign: "cancer" },
        ],
        year,
        year,
      );
    });

    it(`水星 双子座だけ（${year} 年の 1 年ぶん・二段構えの側）`, () => {
      compareWithBrute([{ body: "mercury", sign: "gemini" }], year, year);
    });
  }
});

describe("外の値との突き合わせ（太陽が牡羊座に居る期間＝春分から）", () => {
  /**
   * 手で辿れる 1 例。
   *
   * 太陽が牡羊座に入る瞬間＝**春分**で、2000 年の春分は 3 月 20 日 07:35 UT
   * （Astronomical Applications Department の分点・至点の表。日本時間なら 16:35）。
   * 出る瞬間＝牡牛座入りはその約 30.6 日後（太陽は近日点まわりで速いので、
   * 牡羊座に居るのは 1 年で最も短い部類の 30 日ちょっと）。
   *
   * つまり 2000 年の候補日は **3 月 20 日から 4 月 19 日まで**で、
   * 頭の日は 07:35〜24:00・尻の日は 00:00〜（牡牛座入りの時刻）という形になるはず。
   */
  it("2000 年の太陽 牡羊座は 3/20 07:35 UT から 4/19 まで", () => {
    const { result } = reverseHoroscope(swe, request([{ body: "sun", sign: "牡羊座" }], 2000, 2000));

    expect(result.total).toBe(31);
    expect(result.truncated).toBe(false);
    // 並びは一致の数 → 日付順。optional が無いので日付順そのもの
    const first = result.candidates[0];
    const last = result.candidates[result.candidates.length - 1];

    expect(first?.date).toBe("2000-03-20");
    expect(first?.all_day).toBe(false);
    expect(first?.time_ranges[0]?.start).toBe("2000-03-20 07:35+00:00");

    expect(last?.date).toBe("2000-04-19");
    expect(last?.all_day).toBe(false);
    // 牡牛座入り＝春分の 30.5〜30.6 日後（4 月 19 日の夕方）
    expect(last?.time_ranges[0]?.end.startsWith("2000-04-19 1")).toBe(true);

    // 真ん中の日はまるごと牡羊座（終日）
    const middle = result.candidates[15];
    expect(middle?.all_day).toBe(true);
    expect(middle?.positions.find((position) => position.body === "sun")?.sign).toBe("牡羊座");
  });

  it("太陽が牡羊座に居るのは 30.4〜30.7 日（春分から牡牛座入りまで）", () => {
    const input = request([{ body: "sun", sign: "aries" }], 2000, 2009);
    const scan = scanReverseHoroscope(swe, input);
    // 10 年ぶんで 10 本（範囲の端で切れていない）
    expect(scan.intervals).toHaveLength(10);
    for (const interval of scan.intervals) {
      const days = interval.end - interval.start;
      expect(days).toBeGreaterThan(30.4);
      expect(days).toBeLessThan(30.7);
    }
    // 太陽の窓は一発計算なので、10 年ぶんでも天体計算は 20 回ちょっと
    expect(scan.ephemerisCalls).toBeLessThan(30);
  });
});

/**
 * 書いてある限界（`REVERSE_LIMITATIONS` ＝「留が星座の境のすぐ内側で起きる短い出入りは
 * 拾えないことがある」）を、**実物の空で**確かめる。2026-08-27 再査読対応（I-3）。
 *
 * 探し方（このテストの外で 1 度だけ回した棚卸し。400 年ぶん × 8 天体で約 23 秒かかるので、
 * 見つかった実例だけをここに書き写してある）: 1800〜2200 年の水星〜冥王星の留を全部拾い
 * （速度の符号が変わる点を二分法で詰める＝水星 2,528 回・冥王星 799 回…）、その黄経が
 * 星座の境から何度離れているかで並べた。**境から 0.5° 以内の留は珍しくない**（水星 5 例・
 * 火星 1 例・天王星 2 例・冥王星 4 例…）が、そのうち「境を越えてすぐ戻る」形になるのは
 * 留が進む向きの先に境があるときだけで、いちばん浅いのが下の 3 例。
 *
 * ここで大事なのは**どれも拾えている**こと ―― 実際に穴に落ちるには、留が境から 3e-5° 以内
 * （水星で出入りが 1 時間を切る深さ）という浅さが要る。1800〜2200 年にその例は 1 つも無い。
 * 「拾えない側」は偽の空で作って固定してある（test/reverse-horoscope.test.ts）。
 */
describe("書いてある限界（境のすぐ内側の留）の実物での当たり", () => {
  /** その日の中で「その星座に居た」時刻を 1 分刻みで直に測る（総当たりの細かい版） */
  function trueStay(bodyId: number, aroundJd: number, signIdx: number): Interval {
    let first = 0;
    let last = 0;
    for (let jd = aroundJd - 1; jd < aroundJd + 1; jd += 1 / 1440) {
      const lon = swe.swe_calc_ut(jd, bodyId, CALC_FLAGS)[0] as number;
      if (lon >= signIdx * 30 && lon < (signIdx + 1) * 30) {
        if (!first) first = jd;
        last = jd;
      }
    }
    return { start: first, end: last };
  }

  it("水星が水瓶座に 7.65 時間だけ入って戻る日（1970-01-04）を拾う", () => {
    // 留は 1970-01-04 08:10 UT・黄経 300.0024°＝水瓶座の入口の内側 0.0024°
    // （400 年ぶんの棚卸しで見つかったいちばん浅い「行って戻る」）
    const station = 2440590.84042;
    const lon = swe.swe_calc_ut(station, 2, CALC_FLAGS)[0] as number;
    const speed = swe.swe_calc_ut(station, 2, CALC_FLAGS)[3] as number;
    expect(Math.abs(lon - 300)).toBeLessThan(0.005);
    expect(Math.abs(speed)).toBeLessThan(0.001); // 留（速度がほぼ 0）

    const truth = trueStay(2, station, 10);
    const stayHours = (truth.end - truth.start) * 24;
    expect(stayHours).toBeGreaterThan(7.6);
    expect(stayHours).toBeLessThan(7.7);

    const scan = scanReverseHoroscope(swe, request([{ body: "mercury", sign: "aquarius" }], 1970, 1970));
    const short = scan.intervals.filter((interval) => interval.end - interval.start < 0.5);
    expect(short).toHaveLength(1);
    // 1 分刻みの真値と、端が 2 分以内で一致する（真値の側も 1 分の格子ぶん内寄りに出る）
    const found = short[0] as Interval;
    expect(Math.abs(found.start - truth.start) * 1440).toBeLessThan(2);
    expect(Math.abs(found.end - truth.end) * 1440).toBeLessThan(2);
  });

  it("火星が双子座に 2.2 日だけ戻る日（1961-02-06 の留）も拾う", () => {
    // 留は 1961-02-06 02:51 UT・黄経 89.9924°＝蟹座の入口の手前 0.0076°（＝双子座の側）
    const station = 2437336.61872;
    const lon = swe.swe_calc_ut(station, 4, CALC_FLAGS)[0] as number;
    expect(Math.abs(lon - 90)).toBeLessThan(0.01);

    const scan = scanReverseHoroscope(swe, request([{ body: "mars", sign: "gemini" }], 1961, 1961));
    const short = scan.intervals.filter((interval) => interval.end - interval.start < 5);
    expect(short).toHaveLength(1);
    const days = (short[0] as Interval).end - (short[0] as Interval).start;
    expect(days).toBeGreaterThan(2.1);
    expect(days).toBeLessThan(2.3);
  });

  it("冥王星が魚座に 3.2 日だけ戻る日（1823-12-15 の留）も拾う（4 日刻みの側）", () => {
    // 留は 1823-12-15 00:42 UT・黄経 359.99946°＝牡羊座の入口の手前 0.00054°
    const station = 2387244.52922;
    const lon = swe.swe_calc_ut(station, 9, CALC_FLAGS)[0] as number;
    expect(Math.abs(lon - 360)).toBeLessThan(0.005);

    const scan = scanReverseHoroscope(swe, request([{ body: "pluto", sign: "pisces" }], 1823, 1824));
    const short = scan.intervals.filter((interval) => interval.end - interval.start < 10);
    expect(short).toHaveLength(1);
    const days = (short[0] as Interval).end - (short[0] as Interval).start;
    expect(days).toBeGreaterThan(3.1);
    expect(days).toBeLessThan(3.4);
  });
});

/**
 * 天体計算を数える薄皮。`scan.ephemerisCalls` が数えているのは**窓を求める走査だけ**なので、
 * 候補日に添える「正午の空」（返す日数 × 10 天体）まで含めた実数はここで数える。
 */
function countingEngine(base: SwissEph): { engine: SwissEph; calls: () => number } {
  let calls = 0;
  const counted = new Set(["swe_calc_ut", "swe_mooncross_ut", "swe_solcross_ut"]);
  const engine = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (counted.has(String(property))) calls++;
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as SwissEph;
  return { engine, calls: () => calls };
}

describe("CPU の目安（回数を数える）", () => {
  it("正午の空まで含めても、30 年ぶんの天体計算は 4,500 回に収まる", () => {
    // required 1 本の 2 つは入口の枠（10 年）の外側＝`rawRequest` で直に組む（上の項を参照）
    const cases: { label: string; input: ReverseHoroscopeRequest; limit: number }[] = [
      {
        label: "太陽＋月・30 年",
        input: rawRequest([required("sun", 0), required("moon", 3)], 1996, 2025),
        limit: 900,
      },
      {
        label: "月だけ・30 年",
        input: rawRequest([required("moon", 0)], 1996, 2025),
        limit: 1500,
      },
      {
        label: "水星だけ・30 年（いちばん重い形）",
        input: rawRequest([required("mercury", 11)], 1996, 2025),
        limit: 4500,
      },
    ];

    for (const entry of cases) {
      const counter = countingEngine(swe);
      reverseHoroscope(counter.engine, entry.input);
      expect(counter.calls(), `${entry.label}: ${counter.calls()} 回`).toBeLessThan(entry.limit);
    }
  });

  it("窓の走査だけなら 30 年ぶんでも 4,000 回に収まる", () => {
    const cases: { label: string; input: ReverseHoroscopeRequest; limit: number }[] = [
      {
        label: "月だけ・30 年",
        input: rawRequest([required("moon", 0)], 1996, 2025),
        limit: 900,
      },
      {
        label: "水星だけ・30 年（いちばん重い形）",
        input: rawRequest([required("mercury", 11)], 1996, 2025),
        limit: 4000,
      },
      {
        label: "太陽＋月＋水星・30 年",
        input: parseReverseHoroscopeArguments({
          conditions: [
            { body: "sun", sign: "taurus" },
            { body: "mercury", sign: "taurus" },
            { body: "moon", sign: "virgo" },
          ],
          year_from: 1996,
          year_to: 2025,
          utc_offset: 9,
        }),
        limit: 1200,
      },
    ];

    for (const entry of cases) {
      const scan = scanReverseHoroscope(swe, entry.input);
      expect(scan.ephemerisCalls, `${entry.label}: ${scan.ephemerisCalls} 回`).toBeLessThan(
        entry.limit,
      );
    }
  });

  /**
   * 入口の枠（2026-08-27 の I-4）を通して呼べる**いちばん重い形**。
   * required 1 本 × 10 年ぶん ―― ここが公開の入口から一度に頼める上限になる。
   */
  it("入口から頼めるいちばん重い形（水星だけ・10 年）は 2,000 回に収まる", () => {
    const input = parseReverseHoroscopeArguments({
      conditions: [{ body: "mercury", sign: "pisces" }],
      year_from: 2016,
      year_to: 2025,
      utc_offset: 9,
    });
    const counter = countingEngine(swe);
    reverseHoroscope(counter.engine, input);
    expect(counter.calls(), `水星だけ・10 年: ${counter.calls()} 回`).toBeLessThan(2000);
  });

  it("二段構え（4 日刻みで当たりを付けて 1 日刻みで詰める）は一段と同じ日を出す", () => {
    // 水星は二段構えの側。総当たりとの突き合わせは上でやってあるので、ここでは
    // 「粗い当たり付けを挟んでも候補日が変わらない」ことを別の年代でもう一度だけ見る
    const input = parseReverseHoroscopeArguments({
      conditions: [{ body: "mercury", sign: "sagittarius" }],
      year_from: 1998,
      year_to: 1999,
      utc_offset: 0,
    });
    const range = reverseRangeJd(swe, input);
    const scan = scanReverseHoroscope(swe, input);
    const mine = new Set(splitByLocalDay(scan.intervals, 0).keys());
    const brute = bruteCandidateDays(swe, input, range.start, range.end);
    for (const day of brute) expect(mine.has(day)).toBe(true);
  });
});
