/**
 * 納甲（断易）の検算。
 *
 * ここは wasm を読まない ―― 太陽黄経は「数値をそのまま渡す」か、偽エンジンに言わせる。
 * 本物の Swiss Ephemeris で黄経そのものを確かめるのは test/nakko-real.test.ts の持ち場。
 */
import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../src/mcp";
import { castHexagram } from "../src/iching";
import { HEXAGRAMS } from "../src/hexagrams";
import {
  BEASTS,
  BRANCHES,
  PALACES,
  STEMS,
  TRIGRAM_NAKKO,
  beastStartIndex,
  bitsOfHexagramView,
  branchElement,
  buildNakko,
  dayGanzhiIndex,
  formatNakkoText,
  fourPillars,
  ganzhiOf,
  hourBranchIndex,
  isBeforeRisshun,
  julianDayNumber,
  momentFromDate,
  monthBranchOrder,
  nakkoOfLine,
  palaceByBits,
  relationOf,
  sunLongitude,
  type NakkoMoment,
} from "../src/nakko";
import type { RandomSource } from "../src/random";
import { makeFakeEngine, type FakeEngine } from "./stubs/fake-engine";

/** 常に上限を返す乱数源（擲銭法なら六爻すべて老陽＝乾為天） */
const alwaysMax: RandomSource = { int: (max) => max - 1 };
/** 常に下限を返す乱数源（擲銭法なら六爻すべて老陰＝坤為地） */
const alwaysZero: RandomSource = { int: () => 0 };

/** 日時を組み立てる小道具（既定は日本時間の 0 時 0 分） */
function moment(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  utcOffset = 9,
): NakkoMoment {
  return { year, month, day, hour, minute, utcOffset };
}

// ---------------------------------------------------------------------------
// 日干支
// ---------------------------------------------------------------------------

describe("日干支", () => {
  it("既知の日と合う（2000-01-01 は戊午、1949-10-01 は甲子）", () => {
    expect(ganzhiOf(dayGanzhiIndex(2000, 1, 1)).ganzhi).toBe("戊午");
    expect(dayGanzhiIndex(2000, 1, 1)).toBe(54);
    expect(ganzhiOf(dayGanzhiIndex(1949, 10, 1)).ganzhi).toBe("甲子");
    expect(dayGanzhiIndex(1949, 10, 1)).toBe(0);
  });

  it("JDN は正午の JD（2000-01-01 が 2451545、2026-08-22 が 2461275）", () => {
    expect(julianDayNumber(2000, 1, 1)).toBe(2451545);
    expect(julianDayNumber(2026, 8, 22)).toBe(2461275);
  });

  it("1 日進むと 1 つ進み、60 日で一周する", () => {
    expect(ganzhiOf(dayGanzhiIndex(2026, 8, 22)).ganzhi).toBe("戊辰");
    expect(ganzhiOf(dayGanzhiIndex(2026, 8, 23)).ganzhi).toBe("己巳");
    // 2000 年はうるう年なので 1/1 と 3/1 はちょうど 60 日離れる
    expect(dayGanzhiIndex(2000, 3, 1)).toBe(dayGanzhiIndex(2000, 1, 1));
    // 1900 年はうるう年ではないので 1 日ずれる
    expect(dayGanzhiIndex(1900, 3, 1)).toBe((dayGanzhiIndex(1900, 1, 1) + 59) % 60);
  });

  it("月をまたいでも切れ目が無い（8/31 → 9/1）", () => {
    const last = dayGanzhiIndex(2026, 8, 31);
    expect(dayGanzhiIndex(2026, 9, 1)).toBe((last + 1) % 60);
  });

  it("時差を変えても、同じ暦日なら日干支は同じ（日界は 0 時＝その土地の暦日で決まる）", () => {
    const jst = fourPillars(moment(2026, 8, 22, 23, 30, 9), 149.6);
    const utc = fourPillars(moment(2026, 8, 22, 23, 30, 0), 149.6);
    expect(jst.day.ganzhi).toBe("戊辰");
    expect(utc.day.ganzhi).toBe("戊辰");
  });
});

// ---------------------------------------------------------------------------
// 時柱
// ---------------------------------------------------------------------------

describe("時支", () => {
  it("23:00〜00:59 が子、01:00〜02:59 が丑 …… 21:00〜22:59 が亥", () => {
    expect(hourBranchIndex(23)).toBe(0);
    expect(hourBranchIndex(0)).toBe(0);
    expect(hourBranchIndex(1)).toBe(1);
    expect(hourBranchIndex(2)).toBe(1);
    expect(hourBranchIndex(21)).toBe(11);
    expect(hourBranchIndex(22)).toBe(11);
    // 12 支をひととおり
    expect(Array.from({ length: 24 }, (_unused, hour) => BRANCHES[hourBranchIndex(hour)])).toEqual([
      "子", "丑", "丑", "寅", "寅", "卯", "卯", "辰", "辰", "巳", "巳", "午",
      "午", "未", "未", "申", "申", "酉", "酉", "戌", "戌", "亥", "亥", "子",
    ]);
  });

  it("22:59 は亥・23:00 は子・00:59 は子・01:00 は丑", () => {
    const at = (hour: number, minute: number) =>
      fourPillars(moment(2026, 8, 22, hour, minute), 149.6).hour.branch;
    expect(at(22, 59)).toBe("亥");
    expect(at(23, 0)).toBe("子");
    expect(at(0, 59)).toBe("子");
    expect(at(1, 0)).toBe("丑");
  });

  it("23 時台でも日は繰り上がらない（日干支も時干の起こしも「その日」のまま）", () => {
    const evening = fourPillars(moment(2026, 8, 22, 23, 30), 149.6);
    const nextMorning = fourPillars(moment(2026, 8, 23, 0, 30), 149.6);
    expect(evening.day.ganzhi).toBe("戊辰");
    expect(nextMorning.day.ganzhi).toBe("己巳");
    // どちらも子刻だが、日干が違うので時干も違う
    expect(evening.hour.branch).toBe("子");
    expect(nextMorning.hour.branch).toBe("子");
    expect(evening.hour.stem).not.toBe(nextMorning.hour.stem);
  });
});

describe("五鼠遁（日干 → 時干）", () => {
  it("甲己→甲子・乙庚→丙子・丙辛→戊子・丁壬→庚子・戊癸→壬子", () => {
    const expected: Record<string, string> = {
      甲: "甲", 己: "甲",
      乙: "丙", 庚: "丙",
      丙: "戊", 辛: "戊",
      丁: "庚", 壬: "庚",
      戊: "壬", 癸: "壬",
    };
    // 2026-08-22（戊辰）から 10 日ぶん見れば日干が一周する
    for (let offset = 0; offset < 10; offset++) {
      const day = 22 + offset;
      const pillars = fourPillars(moment(2026, 8, day, 0, 0), 149.6);
      expect(pillars.hour.branch).toBe("子");
      expect(pillars.hour.stem, `${pillars.day.ganzhi} 日の子刻`).toBe(
        expected[pillars.day.stem],
      );
    }
  });

  it("子刻から 1 刻進むごとに干も 1 つ進む（戊辰日の亥刻は癸亥）", () => {
    const at = (hour: number) => fourPillars(moment(2026, 8, 22, hour), 149.6).hour.ganzhi;
    expect(at(0)).toBe("壬子");
    expect(at(1)).toBe("癸丑");
    expect(at(3)).toBe("甲寅");
    expect(at(5)).toBe("乙卯");
    expect(at(21)).toBe("癸亥");
  });
});

// ---------------------------------------------------------------------------
// 年柱・月柱
// ---------------------------------------------------------------------------

describe("年干支（立春基準）", () => {
  it("1984 が甲子、2026 が丙午", () => {
    expect(fourPillars(moment(1984, 6, 1), 70).year.ganzhi).toBe("甲子");
    expect(fourPillars(moment(2026, 8, 22), 149.6).year.ganzhi).toBe("丙午");
  });

  it("太陽黄経 314.9°（立春前）は前年、315.0°（立春）から当年", () => {
    expect(fourPillars(moment(2026, 2, 3), 314.9).year.ganzhi).toBe("乙巳");
    expect(fourPillars(moment(2026, 2, 4), 315).year.ganzhi).toBe("丙午");
    // 判定そのもの
    expect(isBeforeRisshun(314.9, 2)).toBe(true);
    expect(isBeforeRisshun(315, 2)).toBe(false);
    expect(isBeforeRisshun(270, 1)).toBe(true);
    expect(isBeforeRisshun(269.9, 1)).toBe(false);
  });

  it("同じ黄経の帯でも 12 月は前年扱いにしない（暦年と年干支がそろっている）", () => {
    expect(isBeforeRisshun(280, 12)).toBe(false);
    expect(fourPillars(moment(2026, 12, 25), 273).year.ganzhi).toBe("丙午");
  });
});

describe("月支（太陽黄経の 12 区切り）", () => {
  it("315° が寅月の頭で、30° ごとに次の支へ", () => {
    expect(monthBranchOrder(315)).toBe(0);
    expect(monthBranchOrder(344.99)).toBe(0);
    expect(monthBranchOrder(345)).toBe(1);
    expect(monthBranchOrder(0)).toBe(1);
    expect(monthBranchOrder(15)).toBe(2);
    expect(monthBranchOrder(314.99)).toBe(11);
  });

  it("12 区切りが 寅卯辰巳午未申酉戌亥子丑 の順に並ぶ", () => {
    const branches = Array.from(
      { length: 12 },
      (_unused, index) => fourPillars(moment(2026, 6, 1), 315 + index * 30 + 1).month.branch,
    );
    expect(branches).toEqual([
      "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥", "子", "丑",
    ]);
  });

  it("節の境は黄経ちょうどで切り替わる（149.99° は申月、150.0° も申月、164.99°→165° で酉月）", () => {
    expect(fourPillars(moment(2026, 8, 22), 149.99).month.ganzhi).toBe("丙申");
    expect(fourPillars(moment(2026, 8, 22), 150).month.ganzhi).toBe("丙申");
    expect(fourPillars(moment(2026, 9, 22), 164.99).month.branch).toBe("申");
    expect(fourPillars(moment(2026, 9, 22), 165).month.branch).toBe("酉");
  });
});

describe("五虎遁（年干 → 月干）", () => {
  it("甲己→丙寅・乙庚→戊寅・丙辛→庚寅・丁壬→壬寅・戊癸→甲寅", () => {
    const expected: Record<string, string> = {
      甲: "丙", 己: "丙",
      乙: "戊", 庚: "戊",
      丙: "庚", 辛: "庚",
      丁: "壬", 壬: "壬",
      戊: "甲", 癸: "甲",
    };
    // 1984（甲子）から 10 年ぶんで年干が一周する。黄経 316° ＝ 寅月の頭あたり
    for (let offset = 0; offset < 10; offset++) {
      const pillars = fourPillars(moment(1984 + offset, 2, 10), 316);
      expect(pillars.month.branch).toBe("寅");
      expect(pillars.month.stem, `${pillars.year.ganzhi} 年の寅月`).toBe(
        expected[pillars.year.stem],
      );
    }
  });

  it("寅月から 1 つ進むごとに干も 1 つ進む（丙午年の申月は丙申）", () => {
    const at = (order: number) => fourPillars(moment(2026, 6, 1), 316 + order * 30).month.ganzhi;
    expect(at(0)).toBe("庚寅");
    expect(at(1)).toBe("辛卯");
    expect(at(6)).toBe("丙申");
  });
});

// ---------------------------------------------------------------------------
// 納甲表
// ---------------------------------------------------------------------------

describe("八卦の納甲表", () => {
  const expected: Record<string, { stems: [string, string]; branches: string[] }> = {
    乾: { stems: ["甲", "壬"], branches: ["子", "寅", "辰", "午", "申", "戌"] },
    坤: { stems: ["乙", "癸"], branches: ["未", "巳", "卯", "丑", "亥", "酉"] },
    震: { stems: ["庚", "庚"], branches: ["子", "寅", "辰", "午", "申", "戌"] },
    巽: { stems: ["辛", "辛"], branches: ["丑", "亥", "酉", "未", "巳", "卯"] },
    坎: { stems: ["戊", "戊"], branches: ["寅", "辰", "午", "申", "戌", "子"] },
    離: { stems: ["己", "己"], branches: ["卯", "丑", "亥", "酉", "未", "巳"] },
    艮: { stems: ["丙", "丙"], branches: ["辰", "午", "申", "戌", "子", "寅"] },
    兌: { stems: ["丁", "丁"], branches: ["巳", "卯", "丑", "亥", "酉", "未"] },
  };

  it("8 つの卦ぶん、内卦（初〜三爻）と外卦（四〜上爻）の干支がそろっている", () => {
    expect(Object.keys(TRIGRAM_NAKKO).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, table] of Object.entries(expected)) {
      const nakko = TRIGRAM_NAKKO[name];
      expect(nakko?.inner.stem, `${name} の内卦の干`).toBe(table.stems[0]);
      expect(nakko?.outer.stem, `${name} の外卦の干`).toBe(table.stems[1]);
      expect(
        [...(nakko?.inner.branches ?? []), ...(nakko?.outer.branches ?? [])],
        `${name} の支`,
      ).toEqual(table.branches);
    }
  });

  it("陽の卦（乾震坎艮）は 2 支ずつ順行、陰の卦（坤巽離兌）は 2 支ずつ逆行", () => {
    const step = (name: string, forward: boolean) => {
      const nakko = TRIGRAM_NAKKO[name];
      const all = [...(nakko?.inner.branches ?? []), ...(nakko?.outer.branches ?? [])];
      for (let i = 1; i < 6; i++) {
        const previous = BRANCHES.indexOf(all[i - 1] as string);
        const current = BRANCHES.indexOf(all[i] as string);
        expect((current - previous + 12) % 12, `${name} の ${i + 1} 爻目`).toBe(forward ? 2 : 10);
      }
    };
    for (const name of ["乾", "震", "坎", "艮"]) step(name, true);
    for (const name of ["坤", "巽", "離", "兌"]) step(name, false);
  });

  it("爻の位で内卦・外卦を選び分ける（火天大有は下が乾・上が離）", () => {
    const at = (position: number) => nakkoOfLine("乾", "離", position);
    expect(at(1)).toEqual({ stem: "甲", branch: "子" });
    expect(at(2)).toEqual({ stem: "甲", branch: "寅" });
    expect(at(3)).toEqual({ stem: "甲", branch: "辰" });
    expect(at(4)).toEqual({ stem: "己", branch: "酉" });
    expect(at(5)).toEqual({ stem: "己", branch: "未" });
    expect(at(6)).toEqual({ stem: "己", branch: "巳" });
  });
});

// ---------------------------------------------------------------------------
// 八宮・世応
// ---------------------------------------------------------------------------

describe("八宮（世応）", () => {
  it("64 卦がちょうど 1 つの宮に 1 回ずつ現れる（8 宮 × 8 代の全単射）", () => {
    const seen = new Set<string>();
    const perPalace = new Map<string, number>();
    for (const hexagram of HEXAGRAMS) {
      const palace = palaceByBits(hexagram.bits);
      const key = `${palace.name}-${palace.generation}`;
      expect(seen.has(key), `${key} が 2 回出た（${hexagram.name}）`).toBe(false);
      seen.add(key);
      perPalace.set(palace.name, (perPalace.get(palace.name) ?? 0) + 1);
    }
    expect(seen.size).toBe(64);
    expect(perPalace.size).toBe(8);
    for (const count of perPalace.values()) expect(count).toBe(8);
  });

  it("既知の卦の宮と代が合う", () => {
    const lookup = (name: string) => {
      const hexagram = HEXAGRAMS.find((item) => item.name === name);
      const palace = palaceByBits(hexagram?.bits as number);
      return `${palace.name}${palace.generation}`;
    };
    expect(lookup("乾為天")).toBe("乾宮本宮");
    expect(lookup("天風姤")).toBe("乾宮一世");
    expect(lookup("火天大有")).toBe("乾宮帰魂");
    expect(lookup("水雷屯")).toBe("坎宮二世");
    expect(lookup("雷天大壮")).toBe("坤宮四世");
    expect(lookup("山風蠱")).toBe("巽宮帰魂");
    expect(lookup("火水未済")).toBe("離宮三世");
  });

  it("世爻の位は 本宮6・一世1・二世2・三世3・四世4・五世5・遊魂4・帰魂3", () => {
    const selves = new Map<string, number>();
    for (const hexagram of HEXAGRAMS) {
      const palace = palaceByBits(hexagram.bits);
      const known = selves.get(palace.generation);
      if (known === undefined) selves.set(palace.generation, palace.self);
      else expect(palace.self).toBe(known);
    }
    expect(Object.fromEntries(selves)).toEqual({
      本宮: 6,
      一世: 1,
      二世: 2,
      三世: 3,
      四世: 4,
      五世: 5,
      遊魂: 4,
      帰魂: 3,
    });
  });

  it("応爻は世爻から 3 つ隔てた爻（火天大有は世三・応上）", () => {
    for (const hexagram of HEXAGRAMS) {
      const palace = palaceByBits(hexagram.bits);
      expect(Math.abs(palace.other - palace.self) % 3).toBe(0);
      expect(palace.other).toBe(palace.self > 3 ? palace.self - 3 : palace.self + 3);
    }
    const dayou = HEXAGRAMS.find((item) => item.name === "火天大有");
    const palace = palaceByBits(dayou?.bits as number);
    expect(palace.self).toBe(3);
    expect(palace.other).toBe(6);
  });

  it("八純卦は本宮で、宮の五行は 乾兌=金・震巽=木・坎=水・離=火・坤艮=土", () => {
    for (const { trigram, element } of PALACES) {
      const pure = HEXAGRAMS.find(
        (item) => item.upper.name === trigram && item.lower.name === trigram,
      );
      const palace = palaceByBits(pure?.bits as number);
      expect(palace.name).toBe(`${trigram}宮`);
      expect(palace.generation).toBe("本宮");
      expect(palace.element).toBe(element);
    }
  });
});

// ---------------------------------------------------------------------------
// 六親・六獣
// ---------------------------------------------------------------------------

describe("六親", () => {
  it("五行 5 × 5 の 25 通り", () => {
    const table: Record<string, Record<string, string>> = {
      木: { 木: "兄弟", 火: "子孫", 土: "妻財", 金: "官鬼", 水: "父母" },
      火: { 火: "兄弟", 土: "子孫", 金: "妻財", 水: "官鬼", 木: "父母" },
      土: { 土: "兄弟", 金: "子孫", 水: "妻財", 木: "官鬼", 火: "父母" },
      金: { 金: "兄弟", 水: "子孫", 木: "妻財", 火: "官鬼", 土: "父母" },
      水: { 水: "兄弟", 木: "子孫", 火: "妻財", 土: "官鬼", 金: "父母" },
    };
    let count = 0;
    for (const [self, row] of Object.entries(table)) {
      for (const [line, relation] of Object.entries(row)) {
        expect(relationOf(self, line), `我=${self} / 爻=${line}`).toBe(relation);
        count++;
      }
    }
    expect(count).toBe(25);
  });

  it("地支の五行（子亥=水・寅卯=木・巳午=火・申酉=金・辰戌丑未=土）", () => {
    expect(BRANCHES.map((branch) => branchElement(branch))).toEqual([
      "水", "土", "木", "木", "土", "火", "火", "土", "金", "金", "土", "水",
    ]);
  });
});

describe("六獣", () => {
  it("日干 甲乙→青龍・丙丁→朱雀・戊→勾陳・己→螣蛇・庚辛→白虎・壬癸→玄武 を初爻に置く", () => {
    const expected: Record<string, string> = {
      甲: "青龍", 乙: "青龍",
      丙: "朱雀", 丁: "朱雀",
      戊: "勾陳",
      己: "螣蛇",
      庚: "白虎", 辛: "白虎",
      壬: "玄武", 癸: "玄武",
    };
    for (const stem of STEMS) {
      expect(BEASTS[beastStartIndex(stem)], `${stem} 日`).toBe(expected[stem]);
    }
  });

  it("初爻から上へ 青龍→朱雀→勾陳→螣蛇→白虎→玄武 の順に巡る（戊日は勾陳から）", () => {
    // 戊辰日（2026-08-22）の乾為天
    const result = castHexagram({}, alwaysMax);
    const nakko = buildNakko(result, moment(2026, 8, 22, 21, 30), 149.6);
    expect(nakko.pillars.day.ganzhi).toBe("戊辰");
    expect(nakko.lines.map((line) => line.beast)).toEqual([
      "勾陳",
      "螣蛇",
      "白虎",
      "玄武",
      "青龍",
      "朱雀",
    ]);
  });

  it("六獣は 6 つで、どの日干でも初爻からの並びは輪をずらしただけ", () => {
    expect(BEASTS).toEqual(["青龍", "朱雀", "勾陳", "螣蛇", "白虎", "玄武"]);
    for (const stem of STEMS) {
      const start = beastStartIndex(stem);
      const order = Array.from({ length: 6 }, (_unused, index) => BEASTS[(start + index) % 6]);
      expect(new Set(order).size).toBe(6);
    }
  });
});

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

describe("buildNakko", () => {
  /** 六爻すべて老陽＝乾為天、之卦は坤為地。2026-08-22 21:30 JST・太陽黄経 149.6° */
  function qian() {
    const result = castHexagram({}, alwaysMax);
    return { result, nakko: buildNakko(result, moment(2026, 8, 22, 21, 30), 149.6) };
  }

  it("乾為天の納甲・六親（乾宮=金）が古典の表と合う", () => {
    const { nakko } = qian();
    expect(nakko.palace).toEqual({ name: "乾宮", element: "金", generation: "本宮" });
    expect(nakko.self_line).toBe(6);
    expect(nakko.other_line).toBe(3);
    expect(
      nakko.lines.map((line) => `${line.label} ${line.stem}${line.branch} ${line.relation}`),
    ).toEqual([
      "初爻 甲子 子孫",
      "二爻 甲寅 妻財",
      "三爻 甲辰 父母",
      "四爻 壬午 官鬼",
      "五爻 壬申 兄弟",
      "上爻 壬戌 父母",
    ]);
    expect(nakko.lines.filter((line) => line.is_self).map((line) => line.position)).toEqual([6]);
    expect(nakko.lines.filter((line) => line.is_other).map((line) => line.position)).toEqual([3]);
  });

  it("四柱と立卦の瞬間が structuredContent に載る", () => {
    const { nakko } = qian();
    expect(nakko.moment).toEqual({ local: "2026-08-22T21:30+09:00", utc_offset: 9 });
    expect(nakko.pillars.year.ganzhi).toBe("丙午");
    expect(nakko.pillars.month.ganzhi).toBe("丙申");
    expect(nakko.pillars.day.ganzhi).toBe("戊辰");
    expect(nakko.pillars.hour.ganzhi).toBe("癸亥");
    expect(nakko.pillars.day).toEqual({ stem: "戊", branch: "辰", ganzhi: "戊辰" });
    expect(nakko.sun_longitude).toBe(149.6);
  });

  it("之卦の六親は本卦の宮の五行で付く（坤為地でも坤宮=土ではなく乾宮=金で読む）", () => {
    const { nakko } = qian();
    expect(nakko.changed_lines).toBeDefined();
    expect(
      nakko.changed_lines?.map((line) => `${line.label} ${line.stem}${line.branch} ${line.relation}`),
    ).toEqual([
      "初爻 乙未 父母",
      "二爻 乙巳 官鬼",
      "三爻 乙卯 妻財",
      "四爻 癸丑 父母",
      "五爻 癸亥 子孫",
      "上爻 癸酉 兄弟",
    ]);
    // 坤宮（土）で読んだら未土は兄弟になるはず ―― そうなっていないことを確かめる
    expect(relationOf("土", "土")).toBe("兄弟");
    expect(nakko.changed_lines?.[0]?.relation).toBe("父母");
  });

  it("之卦の爻には世応も六獣も付かない（本卦だけの札）", () => {
    const { nakko } = qian();
    const keys = Object.keys(nakko.changed_lines?.[0] ?? {}).sort();
    expect(keys).toEqual(["branch", "element", "label", "position", "relation", "stem"]);
  });

  it("坤為地から立てると宮も六親も入れ替わる（坤宮=土）", () => {
    const result = castHexagram({}, alwaysZero);
    const nakko = buildNakko(result, moment(2026, 8, 22, 21, 30), 149.6);
    expect(result.primary.name).toBe("坤為地");
    expect(nakko.palace).toEqual({ name: "坤宮", element: "土", generation: "本宮" });
    expect(
      nakko.lines.map((line) => `${line.stem}${line.branch} ${line.relation}`),
    ).toEqual([
      "乙未 兄弟",
      "乙巳 父母",
      "乙卯 官鬼",
      "癸丑 兄弟",
      "癸亥 妻財",
      "癸酉 子孫",
    ]);
  });

  it("変爻が無ければ changed_lines が付かない", () => {
    // 略筮法は必ず変爻 1 本なので、擲銭法で少陽・少陰だけの卦を作る
    const noChange: RandomSource = {
      int: (() => {
        let index = 0;
        // 表・表・裏 = 3+3+2 = 8（少陰）を 6 回
        return (): number => [1, 1, 0][index++ % 3] as number;
      })(),
    };
    const result = castHexagram({}, noChange);
    expect(result.changing_lines).toEqual([]);
    const nakko = buildNakko(result, moment(2026, 8, 22), 149.6);
    expect(nakko.changed_lines).toBeUndefined();
    expect(Object.keys(nakko)).not.toContain("changed_lines");
  });

  it("卦のビット列は上下の八卦から組み直せる", () => {
    for (const hexagram of HEXAGRAMS) {
      expect(
        bitsOfHexagramView({
          number: hexagram.number,
          name: hexagram.name,
          symbol: hexagram.symbol,
          upper: hexagram.upper,
          lower: hexagram.lower,
        }),
      ).toBe(hexagram.bits);
    }
  });
});

describe("formatNakkoText", () => {
  it("上爻から初爻へ並べ、世と応に札を付ける", () => {
    const result = castHexagram({}, alwaysMax);
    const nakko = buildNakko(result, moment(2026, 8, 22, 21, 30), 149.6);
    expect(formatNakkoText(result, nakko)).toBe(
      [
        "■ 納甲（断易）",
        "立卦: 2026-08-22 21:30（+9）  丙午年 丙申月 戊辰日 癸亥時（太陽黄経 149.6°）",
        "本卦 乾為天: 乾宮・本宮（金）  世: 上爻  応: 三爻",
        "上爻 壬戌 父母 朱雀 ─ 世",
        "五爻 壬申 兄弟 青龍",
        "四爻 壬午 官鬼 玄武",
        "三爻 甲辰 父母 白虎 ─ 応",
        "二爻 甲寅 妻財 螣蛇",
        "初爻 甲子 子孫 勾陳",
        "之卦 坤為地: 上爻 癸酉 兄弟 / 五爻 癸亥 子孫 / 四爻 癸丑 父母 / " +
          "三爻 乙卯 妻財 / 二爻 乙巳 官鬼 / 初爻 乙未 父母",
      ].join("\n"),
    );
  });

  it("吉凶も用神も書かない（表を渡すだけ）", () => {
    const result = castHexagram({}, alwaysMax);
    const text = formatNakkoText(result, buildNakko(result, moment(2026, 8, 22), 149.6));
    for (const word of ["吉", "凶", "用神", "卦辞", "爻辞"]) {
      expect(text).not.toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// 日時の解決（時差・現在時刻）
// ---------------------------------------------------------------------------

describe("momentFromDate", () => {
  it("UTC の瞬間を、その土地の時計で読み直す", () => {
    const instant = new Date("2026-08-22T15:30:00Z");
    expect(momentFromDate(instant, 9)).toEqual({
      year: 2026,
      month: 8,
      day: 23,
      hour: 0,
      minute: 30,
      utcOffset: 9,
    });
    expect(momentFromDate(instant, 0)).toEqual({
      year: 2026,
      month: 8,
      day: 22,
      hour: 15,
      minute: 30,
      utcOffset: 0,
    });
    expect(momentFromDate(instant, -5.5)).toEqual({
      year: 2026,
      month: 8,
      day: 22,
      hour: 10,
      minute: 0,
      utcOffset: -5.5,
    });
  });
});

describe("sunLongitude", () => {
  it("太陽（id 0）を SEFLG_MOSEPH だけで 1 回呼ぶ", () => {
    const engine = makeFakeEngine();
    const calls: { jd: number; id: number; flags: number }[] = [];
    const base = engine.swe_calc_ut;
    engine.swe_calc_ut = (jd: number, id: number, flags: number): number[] => {
      calls.push({ jd, id, flags });
      return base(jd, id, flags);
    };
    engine.offset = 149.6;

    const lon = sunLongitude(engine, moment(2026, 8, 22, 21, 30));
    expect(lon).toBeCloseTo(149.6, 6);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(0);
    // 速度は要らない（SEFLG_MOSEPH の 4 だけ。260 は速度つき）
    expect(calls[0]?.flags).toBe(4);
    // 21:30 JST = 12:30 UT
    expect(calls[0]?.jd).toBeCloseTo(2461274.5 + 12.5 / 24, 8);
  });
});

// ---------------------------------------------------------------------------
// MCP の口（cast_hexagram の nakko 引数）
// ---------------------------------------------------------------------------

const ENDPOINT = "http://localhost/mcp";

/** 偽エンジン・固定時刻で cast_hexagram を 1 発呼ぶ */
async function castViaMcp(
  args: Record<string, unknown>,
  options: { sunLongitude?: number; now?: string; engine?: FakeEngine | null } = {},
): Promise<any> {
  const engine = options.engine === undefined ? makeFakeEngine() : options.engine;
  if (engine) engine.offset = options.sunLongitude ?? 149.6;
  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "cast_hexagram", arguments: args },
      }),
    }),
    {
      getEngine: engine ? async () => engine : undefined,
      now: () => new Date(options.now ?? "2026-08-22T15:30:00Z"),
    },
  );
  const text = await response.text();
  return JSON.parse(text).result;
}

describe("cast_hexagram の nakko 引数", () => {
  it("日時をすべて省くと現在時刻・時差は既定の 9（日本時間）", async () => {
    // 2026-08-22 15:30 UTC は日本時間だと 8/23 00:30
    const result = await castViaMcp({ nakko: true });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.nakko.moment).toEqual({
      local: "2026-08-23T00:30+09:00",
      utc_offset: 9,
    });
    expect(result.structuredContent.nakko.pillars.day.ganzhi).toBe("己巳");
  });

  it("utc_offset を渡すとその土地の時計で読む", async () => {
    const result = await castViaMcp({ nakko: true, utc_offset: 0 });
    expect(result.structuredContent.nakko.moment).toEqual({
      local: "2026-08-22T15:30+00:00",
      utc_offset: 0,
    });
    expect(result.structuredContent.nakko.pillars.day.ganzhi).toBe("戊辰");
  });

  it("hour・minute を省くと 0 時 0 分（12 時ではない）", async () => {
    const result = await castViaMcp({ nakko: true, year: 2026, month: 8, day: 22 });
    expect(result.structuredContent.nakko.moment.local).toBe("2026-08-22T00:00+09:00");
    // 0 時は子刻
    expect(result.structuredContent.nakko.pillars.hour.branch).toBe("子");
  });

  it("year / month / day は 3 つそろえる（一部だけはエラー）", async () => {
    for (const partial of [
      { year: 2026 },
      { year: 2026, month: 8 },
      { month: 8, day: 22 },
      { hour: 21 },
      { minute: 30 },
    ]) {
      const result = await castViaMcp({ nakko: true, ...partial });
      expect(result.isError, JSON.stringify(partial)).toBe(true);
      expect(result.content[0].text).toContain("year / month / day をそろえて");
    }
  });

  it("暦に存在しない日付は断る", async () => {
    const result = await castViaMcp({ nakko: true, year: 2026, month: 2, day: 31 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("2026-02-31 は暦に存在しない日付です");
    expect(result.content[0].text).toContain("2026年2月は28日まで");

    const leap = await castViaMcp({ nakko: true, year: 2028, month: 2, day: 29 });
    expect(leap.isError).toBeUndefined();
  });

  it("範囲の外・型違いも断る", async () => {
    const badMonth = await castViaMcp({ nakko: true, year: 2026, month: 13, day: 1 });
    expect(badMonth.isError).toBe(true);
    expect(badMonth.content[0].text).toContain("month は 1 以上 12 以下");

    const badOffset = await castViaMcp({ nakko: true, utc_offset: 20 });
    expect(badOffset.isError).toBe(true);
    expect(badOffset.content[0].text).toContain("utc_offset は -14 以上 14 以下");

    const fractionalDay = await castViaMcp({ nakko: true, year: 2026, month: 8, day: 22.5 });
    expect(fractionalDay.isError).toBe(true);
    expect(fractionalDay.content[0].text).toContain("day は整数で指定してください");

    const badFlag = await castViaMcp({ nakko: "yes" });
    expect(badFlag.isError).toBe(true);
    expect(badFlag.content[0].text).toContain("nakko は true / false");
  });

  it("立春の前後で年干支が切り替わる（偽エンジンの黄経で）", async () => {
    const before = await castViaMcp(
      { nakko: true, year: 2026, month: 2, day: 3, hour: 12 },
      { sunLongitude: 314.9 },
    );
    expect(before.structuredContent.nakko.pillars.year.ganzhi).toBe("乙巳");

    const after = await castViaMcp(
      { nakko: true, year: 2026, month: 2, day: 5, hour: 12 },
      { sunLongitude: 315 },
    );
    expect(after.structuredContent.nakko.pillars.year.ganzhi).toBe("丙午");
  });

  it("nakko: false（既定）のときはエンジンに一度も触らない", async () => {
    const result = await castViaMcp({}, { engine: null });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.nakko).toBeUndefined();
  });

  it("エンジンが無いのに nakko: true を頼まれたら、そう言って断る", async () => {
    const result = await castViaMcp({ nakko: true }, { engine: null });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("天体計算エンジンが使えないため納甲を出せません");
  });

  it("本卦・之卦・四柱がテキストにも出る", async () => {
    const result = await castViaMcp({ nakko: true, year: 2026, month: 8, day: 22, hour: 21, minute: 30 });
    const text: string = result.content[0].text;
    // 既存の易の本文がそのまま頭に残っている
    expect(text.split("\n")[0]).toBe("易（擲銭法）");
    expect(text).toContain("■ 納甲（断易）");
    expect(text).toContain("立卦: 2026-08-22 21:30（+9）  丙午年 丙申月 戊辰日 癸亥時");
    expect(text).toMatch(/世: .爻  応: .爻/);
  });
});
