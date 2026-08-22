import { describe, expect, it } from "vitest";
import { BRANCHES, dayGanzhiIndex, julianDayNumber } from "../src/nakko";
import {
  KYUSEI_CONVENTIONS,
  KyuseiError,
  PALACES,
  STARS,
  STAR_COUNT,
  TIGER_MONTH_STAR_BY_GROUP,
  board,
  cellAt,
  dateFromJulianDayNumber,
  dayStar,
  directionOfBranch,
  directionOfStar,
  formatBoardText,
  formatSatsuText,
  monthStar,
  nearestJiaziJdn,
  oppositeBranch,
  oppositeDirection,
  satsu,
  starOf,
  wrapStar,
  yearStar,
  type Direction,
  type SolsticeDay,
} from "../src/kyusei";

/** 盤の並び（返り値の固定順） */
const ORDER: readonly Direction[] = [
  "北",
  "北東",
  "東",
  "南東",
  "南",
  "南西",
  "西",
  "北西",
  "中宮",
];

/** 「その年の十二支」（四柱推命と同じ (年 − 4) mod 12。立春で切った年を渡す） */
const branchOfYear = (solarYear: number): string =>
  BRANCHES[((solarYear - 4) % 12 + 12) % 12] as string;

/** 盤のある方位に座る星の番号 */
const starAt = (center: number, direction: Direction): number =>
  cellAt(board(center), direction).star.number;

// ---------------------------------------------------------------------------
// 九星の台帳
// ---------------------------------------------------------------------------

describe("九星の台帳", () => {
  it("9 つちょうどで、番号は 1 から順", () => {
    expect(STARS).toHaveLength(STAR_COUNT);
    expect(STARS.map((star) => star.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("五行は 水土木木土金金土火、色は名前の 2 文字目と同じ", () => {
    expect(STARS.map((star) => star.element).join("")).toBe("水土木木土金金土火");
    for (const star of STARS) {
      expect(star.name).toBe(`${star.short_name}${star.element}星`);
      expect(star.short_name[1]).toBe(star.color);
    }
  });

  it("starOf は 1〜9 だけを受ける", () => {
    expect(starOf(1).name).toBe("一白水星");
    expect(starOf(5).short_name).toBe("五黄");
    expect(starOf(9).element).toBe("火");
    expect(() => starOf(0)).toThrow(KyuseiError);
    expect(() => starOf(10)).toThrow(KyuseiError);
    expect(() => starOf(1.5)).toThrow(KyuseiError);
  });

  it("wrapStar は輪にして 1〜9 に畳む", () => {
    expect(wrapStar(10)).toBe(1);
    expect(wrapStar(0)).toBe(9);
    expect(wrapStar(-1)).toBe(8);
    expect(wrapStar(19)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 後天定位
// ---------------------------------------------------------------------------

describe("後天定位（宮と方位）", () => {
  it("並びは 北・北東・東・南東・南・南西・西・北西・中宮 で固定", () => {
    expect(PALACES.map((palace) => palace.direction)).toEqual(ORDER);
  });

  it("定位の星は 北1・南西2・東3・南東4・中宮5・北西6・西7・北東8・南9", () => {
    const byDirection = new Map(PALACES.map((palace) => [palace.direction, palace.number]));
    expect(byDirection.get("北")).toBe(1);
    expect(byDirection.get("南西")).toBe(2);
    expect(byDirection.get("東")).toBe(3);
    expect(byDirection.get("南東")).toBe(4);
    expect(byDirection.get("中宮")).toBe(5);
    expect(byDirection.get("北西")).toBe(6);
    expect(byDirection.get("西")).toBe(7);
    expect(byDirection.get("北東")).toBe(8);
    expect(byDirection.get("南")).toBe(9);
  });

  it("南を上・東を左に並べると縦横斜めが 15 の魔方陣になる（洛書の検算）", () => {
    const grid: readonly (readonly Direction[])[] = [
      ["南東", "南", "南西"],
      ["東", "中宮", "西"],
      ["北東", "北", "北西"],
    ];
    const byDirection = new Map(PALACES.map((palace) => [palace.direction, palace.number]));
    const at = (direction: Direction): number => byDirection.get(direction) as number;
    for (const row of grid) {
      expect(row.reduce((sum, direction) => sum + at(direction), 0)).toBe(15);
    }
    for (let column = 0; column < 3; column += 1) {
      const cells = grid.map((row) => at(row[column] as Direction));
      expect(cells.reduce((sum, value) => sum + value, 0)).toBe(15);
    }
    expect(at("南東") + at("中宮") + at("北西")).toBe(15);
    expect(at("南西") + at("中宮") + at("北東")).toBe(15);
  });

  it("八卦は中宮だけ持たない", () => {
    for (const palace of PALACES) {
      if (palace.direction === "中宮") expect(palace.trigram).toBeNull();
      else expect(typeof palace.trigram).toBe("string");
    }
  });

  it("向かいは 北↔南・北東↔南西・東↔西・南東↔北西。中宮に向かいは無い", () => {
    expect(oppositeDirection("北")).toBe("南");
    expect(oppositeDirection("南")).toBe("北");
    expect(oppositeDirection("北東")).toBe("南西");
    expect(oppositeDirection("南西")).toBe("北東");
    expect(oppositeDirection("東")).toBe("西");
    expect(oppositeDirection("西")).toBe("東");
    expect(oppositeDirection("南東")).toBe("北西");
    expect(oppositeDirection("北西")).toBe("南東");
    expect(oppositeDirection("中宮")).toBeNull();
    // 向かいの向かいは自分
    for (const direction of ORDER) {
      const back = oppositeDirection(direction);
      if (back) expect(oppositeDirection(back)).toBe(direction);
    }
  });
});

// ---------------------------------------------------------------------------
// 年の星（本命星）
// ---------------------------------------------------------------------------

describe("yearStar（年の星＝本命星）", () => {
  it("11 − 数字根 で出る（手計算した例と一致する）", () => {
    // 1900 → 1+9+0+0 = 10 → 1、11 − 1 = 10 → 1
    expect(yearStar(1900)).toBe(1);
    // 1984 → 1+9+8+4 = 22 → 4、11 − 4 = 7
    expect(yearStar(1984)).toBe(7);
    // 1986 → 1+9+8+6 = 24 → 6、11 − 6 = 5
    expect(yearStar(1986)).toBe(5);
    // 2021 → 2+0+2+1 = 5、11 − 5 = 6
    expect(yearStar(2021)).toBe(6);
    // 2024 → 2+0+2+4 = 8、11 − 8 = 3
    expect(yearStar(2024)).toBe(3);
    // 2026 → 2+0+2+6 = 10 → 1、11 − 1 = 10 → 1
    expect(yearStar(2026)).toBe(1);
  });

  it("数字根が 9 になる年（9 の倍数）は二黒", () => {
    // 2025 → 2+0+2+5 = 9、11 − 9 = 2。9 で割り切れる年はここに落ちる
    expect(yearStar(2025)).toBe(2);
    expect(yearStar(2016)).toBe(2);
    expect(yearStar(1998)).toBe(2);
  });

  it("1 年ごとに 1 つ下がり、9 年で一周する", () => {
    for (let year = 1900; year <= 2100; year += 1) {
      expect(yearStar(year + 1)).toBe(wrapStar(yearStar(year) - 1));
      expect(yearStar(year + 9)).toBe(yearStar(year));
    }
  });

  it("どの年も 1〜9 に入る", () => {
    for (let year = 1; year <= 3000; year += 1) {
      const star = yearStar(year);
      expect(Number.isInteger(star)).toBe(true);
      expect(star).toBeGreaterThanOrEqual(1);
      expect(star).toBeLessThanOrEqual(9);
    }
  });

  it("西暦 1〜9999 の外と、整数でない年は断る", () => {
    expect(yearStar(1)).toBeGreaterThanOrEqual(1);
    expect(yearStar(9999)).toBeGreaterThanOrEqual(1);
    expect(() => yearStar(0)).toThrow(KyuseiError);
    expect(() => yearStar(10000)).toThrow(KyuseiError);
    expect(() => yearStar(-1)).toThrow(KyuseiError);
    expect(() => yearStar(2026.5)).toThrow(KyuseiError);
  });
});

// ---------------------------------------------------------------------------
// 月の星（月命星・月盤の中宮）
// ---------------------------------------------------------------------------

describe("monthStar（月の星＝月命星・月盤の中宮）", () => {
  it("年の星の組で寅月が決まる（一四七＝八白・三六九＝五黄・二五八＝二黒）", () => {
    for (const yearStarNumber of [1, 4, 7]) expect(monthStar(yearStarNumber, 0)).toBe(8);
    for (const yearStarNumber of [3, 6, 9]) expect(monthStar(yearStarNumber, 0)).toBe(5);
    for (const yearStarNumber of [2, 5, 8]) expect(monthStar(yearStarNumber, 0)).toBe(2);
    // 台帳そのものも同じ 3 組で、9 つの星をちょうど埋める
    expect(TIGER_MONTH_STAR_BY_GROUP.flatMap((group) => group.year_stars).sort()).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("一四七の年は 寅八白・卯七赤・辰六白・巳五黄・午四緑・未三碧・申二黒・酉一白・戌九紫・亥八白・子七赤・丑六白", () => {
    expect(Array.from({ length: 12 }, (_unused, order) => monthStar(1, order))).toEqual([
      8, 7, 6, 5, 4, 3, 2, 1, 9, 8, 7, 6,
    ]);
  });

  it("三六九の年は寅月五黄から 1 つずつ下がる", () => {
    expect(Array.from({ length: 12 }, (_unused, order) => monthStar(9, order))).toEqual([
      5, 4, 3, 2, 1, 9, 8, 7, 6, 5, 4, 3,
    ]);
  });

  it("二五八の年は寅月二黒から 1 つずつ下がる", () => {
    expect(Array.from({ length: 12 }, (_unused, order) => monthStar(5, order))).toEqual([
      2, 1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 9,
    ]);
  });

  it("9 か月で一周するので、寅月と亥月・卯月と子月・辰月と丑月が同じ星になる", () => {
    for (let yearStarNumber = 1; yearStarNumber <= 9; yearStarNumber += 1) {
      for (let order = 0; order <= 2; order += 1) {
        expect(monthStar(yearStarNumber, order + 9)).toBe(monthStar(yearStarNumber, order));
      }
    }
  });

  it("年をまたいでも切れない ―― 丑月の次の寅月がちゃんと 1 つ下", () => {
    // 月盤が月ごとに 1 つ下がり続けることの検算。ここが合わないと寅月の表の組み分けが疑わしい
    for (let year = 1900; year <= 2100; year += 1) {
      const lastMonth = monthStar(yearStar(year), 11); // 丑月
      const nextTiger = monthStar(yearStar(year + 1), 0); // 翌年の寅月
      expect(nextTiger).toBe(wrapStar(lastMonth - 1));
    }
  });

  it("12 か月で 12 下がる＝寅月の星は 1 年ごとに 3 ずつ下がり、3 年で一周する", () => {
    for (let year = 1900; year <= 2100; year += 1) {
      expect(monthStar(yearStar(year + 1), 0)).toBe(wrapStar(monthStar(yearStar(year), 0) - 3));
      expect(monthStar(yearStar(year + 3), 0)).toBe(monthStar(yearStar(year), 0));
    }
  });

  it("気学暦の慣例（子午卯酉＝八白／辰戌丑未＝五黄／寅申巳亥＝二黒）と一致する", () => {
    // 仕様書の草案（二五八＝五黄・三六九＝二黒）を標準へ直した根拠。
    // 2020 庚子・七赤 → 八白、2021 辛丑・六白 → 五黄、2022 壬寅・五黄 → 二黒 … と続く
    const expected: Readonly<Record<string, number>> = {
      子: 8, 午: 8, 卯: 8, 酉: 8,
      辰: 5, 戌: 5, 丑: 5, 未: 5,
      寅: 2, 申: 2, 巳: 2, 亥: 2,
    };
    for (let year = 1900; year <= 2100; year += 1) {
      expect(monthStar(yearStar(year), 0)).toBe(expected[branchOfYear(year)]);
    }
    // 名指しの検算（年干支と本命星も一緒に確かめる）
    expect(branchOfYear(2020)).toBe("子");
    expect(yearStar(2020)).toBe(7);
    expect(monthStar(7, 0)).toBe(8);
    expect(branchOfYear(2021)).toBe("丑");
    expect(yearStar(2021)).toBe(6);
    expect(monthStar(6, 0)).toBe(5);
    expect(branchOfYear(2022)).toBe("寅");
    expect(yearStar(2022)).toBe(5);
    expect(monthStar(5, 0)).toBe(2);
  });

  it("年の星も月の順番も範囲の外は断る", () => {
    expect(() => monthStar(0, 0)).toThrow(KyuseiError);
    expect(() => monthStar(10, 0)).toThrow(KyuseiError);
    expect(() => monthStar(1, -1)).toThrow(KyuseiError);
    expect(() => monthStar(1, 12)).toThrow(KyuseiError);
    expect(() => monthStar(1, 1.5)).toThrow(KyuseiError);
  });
});

// ---------------------------------------------------------------------------
// 日の星（日命星・日盤の中宮）
// ---------------------------------------------------------------------------

/** 実在の至（暦日は日本時間で丸めたもの。丸めるのは本来は配線側の仕事） */
const SUMMER_2025: SolsticeDay = { kind: "summer", year: 2025, month: 6, day: 21 };
const WINTER_2025: SolsticeDay = { kind: "winter", year: 2025, month: 12, day: 22 };
const SUMMER_2026: SolsticeDay = { kind: "summer", year: 2026, month: 6, day: 21 };
const WINTER_2026: SolsticeDay = { kind: "winter", year: 2026, month: 12, day: 22 };
const REAL_SOLSTICES: readonly SolsticeDay[] = [
  SUMMER_2025,
  WINTER_2025,
  SUMMER_2026,
  WINTER_2026,
];

/** 引き分け（至の日が甲午＝前後の甲子から同じ 30 日）を作るための合成した冬至 */
const TIE_WINTER: SolsticeDay = { kind: "winter", year: 2026, month: 1, day: 20 };
const TIE_SOLSTICES: readonly SolsticeDay[] = [SUMMER_2025, TIE_WINTER, SUMMER_2026];

describe("暦日と甲子（日の星の土台）", () => {
  it("1949-10-01 は甲子（nakko.ts の検算値を手計算で追った）", () => {
    // JDN = 1 + floor((153×7+2)/5) + 365×6749 + floor(6749/4) − floor(6749/100) + floor(6749/400) − 32045
    //     = 1 + 214 + 2463385 + 1687 − 67 + 16 − 32045 = 2433191
    // 日干支 = (2433191 + 49) mod 60 = 2433240 mod 60 = 0 ＝ 甲子（2433240 ÷ 60 = 40554 ちょうど）
    expect(julianDayNumber(1949, 10, 1)).toBe(2433191);
    expect(dayGanzhiIndex(1949, 10, 1)).toBe(0);
    expect(nearestJiaziJdn({ year: 1949, month: 10, day: 1 })).toBe(2433191);
  });

  it("dateFromJulianDayNumber は julianDayNumber の逆", () => {
    expect(dateFromJulianDayNumber(2433191)).toEqual({ year: 1949, month: 10, day: 1 });
    expect(dateFromJulianDayNumber(2451545)).toEqual({ year: 2000, month: 1, day: 1 });
    for (let jdn = 2433191; jdn < 2433191 + 800; jdn += 7) {
      const date = dateFromJulianDayNumber(jdn);
      expect(julianDayNumber(date.year, date.month, date.day)).toBe(jdn);
    }
  });

  it("いちばん近い甲子は 30 日より近いほうを採る", () => {
    // 2025-12-22 は乙丑（index 1）＝手前の甲子 2025-12-21 が 1 日前
    expect(dayGanzhiIndex(2025, 12, 22)).toBe(1);
    expect(nearestJiaziJdn(WINTER_2025)).toBe(julianDayNumber(2025, 12, 21));
    // 2025-06-21 は辛酉（index 57）＝次の甲子 2025-06-24 が 3 日後
    expect(dayGanzhiIndex(2025, 6, 21)).toBe(57);
    expect(nearestJiaziJdn(SUMMER_2025)).toBe(julianDayNumber(2025, 6, 24));
  });

  it("前後がちょうど 30 日で並んだときは後の甲子を採る（採用規約）", () => {
    // 2026-01-20 は甲午（index 30）＝手前の 2025-12-21 も次の 2026-02-19 も 30 日
    expect(dayGanzhiIndex(2026, 1, 20)).toBe(30);
    expect(julianDayNumber(2026, 1, 20) - julianDayNumber(2025, 12, 21)).toBe(30);
    expect(julianDayNumber(2026, 2, 19) - julianDayNumber(2026, 1, 20)).toBe(30);
    expect(nearestJiaziJdn(TIE_WINTER)).toBe(julianDayNumber(2026, 2, 19));
  });
});

describe("dayStar（日の星）", () => {
  it("陽遁は冬至に最も近い甲子から一白で始まり、1 日 1 つ上がる", () => {
    const start = dayStar({ year: 2025, month: 12, day: 21 }, REAL_SOLSTICES);
    expect(start).toEqual({
      star: 1,
      dun: "陽遁",
      switch: { kind: "winter", year: 2025, month: 12, day: 21 },
      days_since_switch: 0,
    });
    expect(dayStar({ year: 2025, month: 12, day: 22 }, REAL_SOLSTICES).star).toBe(2);
    expect(dayStar({ year: 2025, month: 12, day: 23 }, REAL_SOLSTICES).star).toBe(3);
    // 8 日後が九紫、9 日後で一白へ戻る
    expect(dayStar({ year: 2025, month: 12, day: 29 }, REAL_SOLSTICES).star).toBe(9);
    expect(dayStar({ year: 2025, month: 12, day: 30 }, REAL_SOLSTICES)).toMatchObject({
      star: 1,
      days_since_switch: 9,
    });
  });

  it("陰遁は夏至に最も近い甲子から九紫で始まり、1 日 1 つ下がる", () => {
    const start = dayStar({ year: 2025, month: 6, day: 24 }, REAL_SOLSTICES);
    expect(start).toEqual({
      star: 9,
      dun: "陰遁",
      switch: { kind: "summer", year: 2025, month: 6, day: 24 },
      days_since_switch: 0,
    });
    expect(dayStar({ year: 2025, month: 6, day: 25 }, REAL_SOLSTICES).star).toBe(8);
    expect(dayStar({ year: 2025, month: 6, day: 26 }, REAL_SOLSTICES).star).toBe(7);
    // 8 日後が一白、9 日後で九紫へ戻る
    expect(dayStar({ year: 2025, month: 7, day: 2 }, REAL_SOLSTICES).star).toBe(1);
    expect(dayStar({ year: 2025, month: 7, day: 3 }, REAL_SOLSTICES)).toMatchObject({
      star: 9,
      days_since_switch: 9,
    });
  });

  it("切り替えの当日と前日で遁が入れ替わり、一白が 2 日続く（折り返し）", () => {
    const before = dayStar({ year: 2025, month: 12, day: 20 }, REAL_SOLSTICES);
    const onDay = dayStar({ year: 2025, month: 12, day: 21 }, REAL_SOLSTICES);
    // 前日は夏至から数えて 179 日目の陰遁。179 mod 9 = 8 なので 9 − 8 = 一白
    expect(before).toMatchObject({ star: 1, dun: "陰遁", days_since_switch: 179 });
    expect(onDay).toMatchObject({ star: 1, dun: "陽遁", days_since_switch: 0 });
    expect(before.switch).toEqual({ kind: "summer", year: 2025, month: 6, day: 24 });
    // 折り返しの前後は鏡になる（三碧・二黒・一白 ／ 一白・二黒・三碧）
    expect(dayStar({ year: 2025, month: 12, day: 19 }, REAL_SOLSTICES).star).toBe(2);
    expect(dayStar({ year: 2025, month: 12, day: 22 }, REAL_SOLSTICES).star).toBe(2);
    expect(dayStar({ year: 2025, month: 12, day: 18 }, REAL_SOLSTICES).star).toBe(3);
    expect(dayStar({ year: 2025, month: 12, day: 23 }, REAL_SOLSTICES).star).toBe(3);
  });

  it("実在の日付で 1 本（2026-08-22 は夏至の甲子 2026-06-19 から 64 日目の八白）", () => {
    expect(dayGanzhiIndex(2026, 6, 19)).toBe(0);
    expect(julianDayNumber(2026, 8, 22) - julianDayNumber(2026, 6, 19)).toBe(64);
    // 陰遁は 9 − (64 mod 9) = 9 − 1 = 8
    expect(dayStar({ year: 2026, month: 8, day: 22 }, REAL_SOLSTICES)).toEqual({
      star: 8,
      dun: "陰遁",
      switch: { kind: "summer", year: 2026, month: 6, day: 19 },
      days_since_switch: 64,
    });
  });

  it("切り替えの間隔が 240 日でも閏遁を挟まず、そのまま数え続ける", () => {
    // 合成した冬至（2026-01-20＝甲午）の甲子は 2026-02-19 で、前の甲子 2025-06-24 から 240 日
    expect(nearestJiaziJdn(TIE_WINTER) - nearestJiaziJdn(SUMMER_2025)).toBe(240);
    // 180 日目（ふつうの間隔なら切り替わっているころ）もまだ陰遁のまま
    expect(dayStar({ year: 2025, month: 12, day: 21 }, TIE_SOLSTICES)).toMatchObject({
      star: 9,
      dun: "陰遁",
      days_since_switch: 180,
    });
    // 239 日目まで陰遁で数え、240 日目にようやく陽遁の一白へ
    expect(dayStar({ year: 2026, month: 2, day: 18 }, TIE_SOLSTICES)).toMatchObject({
      star: 4,
      dun: "陰遁",
      days_since_switch: 239,
    });
    expect(dayStar({ year: 2026, month: 2, day: 19 }, TIE_SOLSTICES)).toMatchObject({
      star: 1,
      dun: "陽遁",
      days_since_switch: 0,
    });
  });

  it("陽遁・陰遁とも 9 日でひと巡りする", () => {
    for (let offset = 0; offset < 40; offset += 1) {
      const jdn = julianDayNumber(2025, 12, 21) + offset;
      const date = dateFromJulianDayNumber(jdn);
      const next = dateFromJulianDayNumber(jdn + 9);
      expect(dayStar(next, REAL_SOLSTICES).star).toBe(dayStar(date, REAL_SOLSTICES).star);
    }
  });

  it("至が足りなければ断る", () => {
    // 1 つも渡されていない
    expect(() => dayStar({ year: 2026, month: 8, day: 22 }, [])).toThrow(KyuseiError);
    // 対象日より後の至が無い（渡されていない至の甲子が入り込む余地がある）
    expect(() => dayStar({ year: 2026, month: 8, day: 22 }, [SUMMER_2026])).toThrow(
      /対象日より後/,
    );
    // 対象日以前の切り替えが無い（冬至の甲子が対象日より後ろ側に来ている場合）
    expect(() => dayStar({ year: 2026, month: 2, day: 18 }, [TIE_WINTER, SUMMER_2026])).toThrow(
      /対象日以前の切り替え/,
    );
  });

  it("至の並びが古い順でない・冬至と夏至が交互でないときも断る", () => {
    expect(() => dayStar({ year: 2026, month: 8, day: 22 }, [WINTER_2025, SUMMER_2025])).toThrow(
      /昇順/,
    );
    expect(() =>
      dayStar({ year: 2026, month: 8, day: 22 }, [SUMMER_2025, SUMMER_2026, WINTER_2026]),
    ).toThrow(/交互/);
  });

  it("暦に無い日付は断る", () => {
    expect(() => dayStar({ year: 2026, month: 2, day: 30 }, REAL_SOLSTICES)).toThrow(
      /暦に存在しない/,
    );
    expect(() => dayStar({ year: 2026, month: 13, day: 1 }, REAL_SOLSTICES)).toThrow(KyuseiError);
    expect(() =>
      dayStar({ year: 2026, month: 8, day: 22 }, [
        { kind: "winter", year: 2025, month: 11, day: 31 },
        SUMMER_2026,
        WINTER_2026,
      ]),
    ).toThrow(/暦に存在しない/);
  });
});

// ---------------------------------------------------------------------------
// 盤
// ---------------------------------------------------------------------------

describe("board（盤）", () => {
  it("五黄中宮は後天定位そのまま", () => {
    const view = board(5);
    expect(view.center.name).toBe("五黄土星");
    for (const cell of view.cells) {
      expect(cell.star.number).toBe(cell.palace);
    }
  });

  it("六白中宮は 北 二黒・南西 三碧・東 四緑・南東 五黄・北西 七赤・西 八白・北東 九紫・南 一白", () => {
    expect(starAt(6, "北")).toBe(2);
    expect(starAt(6, "南西")).toBe(3);
    expect(starAt(6, "東")).toBe(4);
    expect(starAt(6, "南東")).toBe(5);
    expect(starAt(6, "中宮")).toBe(6);
    expect(starAt(6, "北西")).toBe(7);
    expect(starAt(6, "西")).toBe(8);
    expect(starAt(6, "北東")).toBe(9);
    // 南だけ 10 になって 1 に回る
    expect(starAt(6, "南")).toBe(1);
  });

  it("升目の並びは 北・北東・東・南東・南・南西・西・北西・中宮 で固定", () => {
    for (let center = 1; center <= 9; center += 1) {
      expect(board(center).cells.map((cell) => cell.direction)).toEqual(ORDER);
    }
  });

  it("どの中宮でも 9 宮の星は 1〜9 の並べ替えになる", () => {
    for (let center = 1; center <= 9; center += 1) {
      const view = board(center);
      expect(view.center.number).toBe(center);
      expect(cellAt(view, "中宮").star.number).toBe(center);
      expect(view.cells.map((cell) => cell.star.number).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
    }
  });

  it("中宮を 1 つ進めると、どの宮の星も 1 つ進む", () => {
    for (let center = 1; center <= 9; center += 1) {
      const current = board(center);
      const next = board(wrapStar(center + 1));
      for (const direction of ORDER) {
        expect(cellAt(next, direction).star.number).toBe(
          wrapStar(cellAt(current, direction).star.number + 1),
        );
      }
    }
  });

  it("directionOfStar は星の座る方位を返す", () => {
    const view = board(6);
    expect(directionOfStar(view, 5)).toBe("南東");
    expect(directionOfStar(view, 6)).toBe("中宮");
    expect(directionOfStar(view, 1)).toBe("南");
    expect(() => directionOfStar(view, 0)).toThrow(KyuseiError);
  });

  it("中宮の星も方位も範囲の外は断る", () => {
    expect(() => board(0)).toThrow(KyuseiError);
    expect(() => board(10)).toThrow(KyuseiError);
    expect(() => cellAt(board(1), "真東" as Direction)).toThrow(KyuseiError);
  });
});

// ---------------------------------------------------------------------------
// 殺
// ---------------------------------------------------------------------------

describe("satsu（殺）", () => {
  it("五黄が中宮のときは五黄殺も暗剣殺も出ない", () => {
    expect(satsu(board(5))).toEqual([]);
  });

  it("五黄殺はその盤で五黄の座る方位、暗剣殺はその向かい", () => {
    // 六白中宮では五黄が南東
    expect(satsu(board(6))).toEqual([
      { name: "五黄殺", direction: "南東" },
      { name: "暗剣殺", direction: "北西" },
    ]);
    // 一白中宮では五黄が南（定位 9 の宮。1 + 9 − 5 = 5）
    expect(starAt(1, "南")).toBe(5);
    expect(satsu(board(1))).toEqual([
      { name: "五黄殺", direction: "南" },
      { name: "暗剣殺", direction: "北" },
    ]);
  });

  it("破は支の対冲の方位で、名前は盤の種類で決まる", () => {
    const view = board(5);
    expect(satsu(view, { kind: "year", branch: "卯" })).toEqual([
      { name: "歳破", direction: "西", branch: "酉" },
    ]);
    expect(satsu(view, { kind: "month", branch: "子" })).toEqual([
      { name: "月破", direction: "南", branch: "午" },
    ]);
    expect(satsu(view, { kind: "day", branch: "午" })).toEqual([
      { name: "日破", direction: "北", branch: "子" },
    ]);
  });

  it("破は八方位に丸めてある（丑と寅・辰と巳・未と申・戌と亥は同じ隅に落ちる）", () => {
    expect(directionOfBranch("丑")).toBe("北東");
    expect(directionOfBranch("寅")).toBe("北東");
    expect(directionOfBranch("辰")).toBe("南東");
    expect(directionOfBranch("巳")).toBe("南東");
    expect(directionOfBranch("未")).toBe("南西");
    expect(directionOfBranch("申")).toBe("南西");
    expect(directionOfBranch("戌")).toBe("北西");
    expect(directionOfBranch("亥")).toBe("北西");
    // 丑年も寅年も歳破は南西（未・申の隅）
    const view = board(5);
    expect(satsu(view, { kind: "year", branch: "丑" })).toEqual([
      { name: "歳破", direction: "南西", branch: "未" },
    ]);
    expect(satsu(view, { kind: "year", branch: "寅" })).toEqual([
      { name: "歳破", direction: "南西", branch: "申" },
    ]);
  });

  it("対冲の支は 6 つ離れた支（子午・丑未・寅申・卯酉・辰戌・巳亥）", () => {
    expect(oppositeBranch("子")).toBe("午");
    expect(oppositeBranch("丑")).toBe("未");
    expect(oppositeBranch("寅")).toBe("申");
    expect(oppositeBranch("卯")).toBe("酉");
    expect(oppositeBranch("辰")).toBe("戌");
    expect(oppositeBranch("巳")).toBe("亥");
    for (const branch of BRANCHES) {
      expect(oppositeBranch(oppositeBranch(branch))).toBe(branch);
    }
    expect(() => oppositeBranch("甲")).toThrow(KyuseiError);
    expect(() => directionOfBranch("甲")).toThrow(KyuseiError);
  });

  it("本命殺・月命殺は星の座る方位、的殺はその向かい", () => {
    // 六白中宮では二黒が北・一白が南
    expect(satsu(board(6), { honmei: 2, getsumei: 1 })).toEqual([
      { name: "五黄殺", direction: "南東" },
      { name: "暗剣殺", direction: "北西" },
      { name: "本命殺", direction: "北" },
      { name: "本命的殺", direction: "南" },
      { name: "月命殺", direction: "南" },
      { name: "月命的殺", direction: "北" },
    ]);
  });

  it("本命星・月命星が中宮ならその殺は出ない", () => {
    const list = satsu(board(6), { honmei: 6, getsumei: 3 });
    expect(list.map((entry) => entry.name)).toEqual([
      "五黄殺",
      "暗剣殺",
      "月命殺",
      "月命的殺",
    ]);
  });

  it("同じ方位に殺が重なってもそのまま全部返す", () => {
    // 本命星が五黄なら本命殺と五黄殺が、本命星＝月命星なら本命殺と月命殺が同じ方位に重なる
    expect(satsu(board(6), { honmei: 5, getsumei: 5 })).toEqual([
      { name: "五黄殺", direction: "南東" },
      { name: "暗剣殺", direction: "北西" },
      { name: "本命殺", direction: "南東" },
      { name: "本命的殺", direction: "北西" },
      { name: "月命殺", direction: "南東" },
      { name: "月命的殺", direction: "北西" },
    ]);
  });

  it("支だけ渡して盤の種類を省くと断る（歳破・月破・日破の名前が決まらないため）", () => {
    expect(() => satsu(board(5), { branch: "卯" })).toThrow(KyuseiError);
    expect(() => satsu(board(5), { kind: "week" as "year", branch: "卯" })).toThrow(KyuseiError);
    // 種類だけなら破が出ないだけで通る
    expect(satsu(board(5), { kind: "year" })).toEqual([]);
  });

  it("知らない支や範囲の外の星は断る", () => {
    expect(() => satsu(board(5), { kind: "year", branch: "戊" })).toThrow(KyuseiError);
    expect(() => satsu(board(5), { honmei: 0 })).toThrow(KyuseiError);
    expect(() => satsu(board(5), { getsumei: 10 })).toThrow(KyuseiError);
  });
});

// ---------------------------------------------------------------------------
// 規約
// ---------------------------------------------------------------------------

describe("KYUSEI_CONVENTIONS（規約の台帳）", () => {
  it("採った規約が名前で並んでいる", () => {
    expect(Object.keys(KYUSEI_CONVENTIONS)).toEqual([
      "year_boundary",
      "month_boundary",
      "day_boundary",
      "year_star",
      "month_star",
      "dun",
      "leap_dun",
      "board",
      "break_directions",
      "satsu",
      "hour_board",
      "scope",
    ]);
    for (const value of Object.values(KYUSEI_CONVENTIONS)) {
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("沼どころ（年界・日界・遁・閏遁・破の丸め・時盤なし）が名指しで書いてある", () => {
    expect(KYUSEI_CONVENTIONS.year_boundary).toContain("立春");
    expect(KYUSEI_CONVENTIONS.day_boundary).toContain("0 時");
    expect(KYUSEI_CONVENTIONS.dun).toContain("甲子");
    expect(KYUSEI_CONVENTIONS.dun).toContain("後の甲子");
    expect(KYUSEI_CONVENTIONS.leap_dun).toContain("閏遁は置かない");
    expect(KYUSEI_CONVENTIONS.break_directions).toContain("八方位に丸めてある");
    expect(KYUSEI_CONVENTIONS.hour_board).toContain("時盤は持たない");
  });

  it("吉凶・相性の言葉は入っていない（範囲外だと断る scope の一文を除く）", () => {
    const { scope, ...rest } = KYUSEI_CONVENTIONS;
    const all = Object.values(rest).join("\n");
    for (const word of ["吉方", "凶方", "開運", "相性", "運勢"]) {
      expect(all).not.toContain(word);
    }
    // scope はむしろ「載せない」と名指しで断る一文
    expect(scope).toContain("載せない");
  });
});

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

describe("formatBoardText（盤の升目）", () => {
  it("南を上・東を左にした 3×3 で、行がそろっている", () => {
    const text = formatBoardText(board(6), "年盤");
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("■ 年盤（中宮 六白金星／南が上・東が左）");
    // 升目は「方位 星の短名」。列のあいだは 2 文字以上の余白で空く
    expect((lines[1] as string).split(/ {2,}/)).toEqual(["南東 五黄", "南 一白", "南西 三碧"]);
    expect((lines[2] as string).split(/ {2,}/)).toEqual(["東 四緑", "中宮 六白", "西 八白"]);
    expect((lines[3] as string).split(/ {2,}/)).toEqual(["北東 九紫", "北 二黒", "北西 七赤"]);
    // 行末に余白は残さない
    for (const line of lines) expect(line).toBe((line as string).trimEnd());
  });

  it("五黄中宮なら定位そのままの升目になる", () => {
    const lines = formatBoardText(board(5), "日盤").split("\n");
    expect(lines[0]).toBe("■ 日盤（中宮 五黄土星／南が上・東が左）");
    expect((lines[1] as string).split(/ {2,}/)).toEqual(["南東 四緑", "南 九紫", "南西 二黒"]);
    expect((lines[2] as string).split(/ {2,}/)).toEqual(["東 三碧", "中宮 五黄", "西 七赤"]);
    expect((lines[3] as string).split(/ {2,}/)).toEqual(["北東 八白", "北 一白", "北西 六白"]);
  });

  it("升目の左端は全角幅でそろう（3 行とも同じ桁で始まる）", () => {
    const lines = formatBoardText(board(3), "月盤").split("\n").slice(1);
    const columns = lines.map((line) => line.indexOf(" ".repeat(2)));
    expect(new Set(columns).size).toBeGreaterThan(0);
    // どの行も 3 つの升目に割れる
    for (const line of lines) expect(line.split(/ {2,}/)).toHaveLength(3);
  });
});

describe("formatSatsuText（殺の行）", () => {
  it("立っている殺を「名前: 方位」で並べ、破だけ対冲の支を添える", () => {
    const list = satsu(board(6), { kind: "year", branch: "卯", honmei: 2 });
    expect(formatSatsuText(list)).toBe(
      "五黄殺: 南東 / 暗剣殺: 北西 / 歳破: 西（酉） / 本命殺: 北 / 本命的殺: 南",
    );
  });

  it("1 つも立っていなければ「なし」", () => {
    expect(formatSatsuText(satsu(board(5)))).toBe("殺: なし");
  });

  it("吉凶の言葉は足さない（札の名前と方位だけ）", () => {
    const text = formatSatsuText(satsu(board(2), { kind: "day", branch: "酉", getsumei: 7 }));
    expect(text).not.toMatch(/[吉凶運]/);
    expect(text).toContain("日破");
  });
});
