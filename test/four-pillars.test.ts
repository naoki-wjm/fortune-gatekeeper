/**
 * 四柱推命の検算。
 *
 * ここは wasm を読まない ―― 太陽黄経も節入りの日数も、数値をそのまま渡す。
 * 表は仕様書から写し取るだけにせず、**別の導き方でもう一度出して突き合わせる**
 * （写すだけだと「表と実装が同じ勘違いをしている」場合に気づけないため）。
 */
import { describe, expect, it } from "vitest";
import {
  BRANCHES,
  STEMS,
  branchElement,
  ganzhiOf,
  type NakkoMoment,
} from "../src/nakko";
import {
  FOUR_PILLARS_CONVENTIONS,
  FourPillarsError,
  SOLAR_TERMS,
  TEN_GODS,
  TWELVE_STAGES,
  branchIndexOf,
  branchYinYang,
  calculateDateFortune,
  calculateFourPillars,
  formatDateFortuneText,
  formatFourPillarsText,
  ganzhiIndexOf,
  hiddenStemsOf,
  HOUR_BOUNDARY_NOTE_MINUTES,
  hourBoundaryNoteOf,
  isBranchClash,
  isBranchHarmony,
  isStemCombination,
  isYangStem,
  orderedPillars,
  solarTermSpanFromJd,
  stemElement,
  stemIndexOf,
  stemYinYang,
  tenGod,
  twelveStage,
  voidOf,
  type DateFortuneInput,
  type FourPillarsInput,
  type FourPillarsResult,
} from "../src/four-pillars";

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

/**
 * 検算の土台にする命式: 2000-01-01 12:00（日本時間）。
 *
 * 太陽黄経は 280.1°（冬至 270° の 11 日後あたり）。
 *  - 立春前（270〜315° の 1 月）なので年柱は 1999 年＝己卯
 *  - monthBranchOrder(280.1) = 10 ＝ 子月、年干 己 の五虎遁で 丙子
 *  - 日干支は JDN から 戊午（納甲側のテストで検算済み）
 *  - 12 時は午刻、戊日の五鼠遁（戊癸→壬子）で 戊午
 * 節入りは 大雪（12/7 ごろ）から 24.6 日、次の 小寒（1/6 ごろ）まで 5.4 日。
 */
const SAMPLE_SUN_LONGITUDE = 280.1;
const SAMPLE_TERM = { days_since_previous: 24.6, days_until_next: 5.4 };

function sample(overrides: Partial<FourPillarsInput> = {}): FourPillarsResult {
  return calculateFourPillars({
    moment: moment(2000, 1, 1, 12, 0),
    sun_longitude: SAMPLE_SUN_LONGITUDE,
    term: SAMPLE_TERM,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 天干・地支の素性
// ---------------------------------------------------------------------------

describe("天干・地支の素性", () => {
  it("天干の五行と陰陽（甲乙＝木・丙丁＝火・戊己＝土・庚辛＝金・壬癸＝水、偶数番が陽）", () => {
    const expected = "木木火火土土金金水水";
    STEMS.forEach((stem, index) => {
      expect(stemElement(stem), `${stem} の五行`).toBe(expected[index]);
      expect(isYangStem(stem), `${stem} の陰陽`).toBe(index % 2 === 0);
      expect(stemYinYang(stem)).toBe(index % 2 === 0 ? "陽" : "陰");
      expect(stemIndexOf(stem)).toBe(index);
    });
  });

  it("地支の陰陽（子寅辰午申戌が陽）", () => {
    for (const branch of ["子", "寅", "辰", "午", "申", "戌"]) {
      expect(branchYinYang(branch), branch).toBe("陽");
    }
    for (const branch of ["丑", "卯", "巳", "未", "酉", "亥"]) {
      expect(branchYinYang(branch), branch).toBe("陰");
    }
  });

  it("六十干支の逆引きが 60 通りとも一周する", () => {
    for (let index = 0; index < 60; index++) {
      expect(ganzhiIndexOf(ganzhiOf(index).ganzhi)).toBe(index);
    }
  });

  it("知らない干支・六十干支に無い組み合わせは弾く", () => {
    expect(() => stemIndexOf("子")).toThrow(FourPillarsError);
    expect(() => branchIndexOf("甲")).toThrow(FourPillarsError);
    // 甲は陽干なので陰支（丑）とは組めない
    expect(() => ganzhiIndexOf("甲丑")).toThrow("六十干支にない組み合わせ");
  });
});

// ---------------------------------------------------------------------------
// 通変星
// ---------------------------------------------------------------------------

/**
 * 通変星の別実装。
 *
 * 実装側は nakko.ts の relationOf（六親）を経由するので、ここでは五行の輪を
 * 「木→火→土→金→水→木」の並びとして直に持ち、何歩先かだけで生剋を測る。
 *  - 0 歩＝同じ五行 / 1 歩＝我生 / 2 歩＝我剋 / 3 歩＝剋我 / 4 歩＝生我
 */
const ELEMENT_RING = "木火土金水";
const TEN_GOD_BY_GAP: readonly (readonly [string, string])[] = [
  ["比肩", "劫財"], // 同じ五行
  ["食神", "傷官"], // 我生
  ["偏財", "正財"], // 我剋
  ["偏官", "正官"], // 剋我
  ["偏印", "印綬"], // 生我
];

function expectedTenGod(dayStem: string, otherStem: string): string {
  const day = STEMS.indexOf(dayStem);
  const other = STEMS.indexOf(otherStem);
  const gap =
    (ELEMENT_RING.indexOf(stemElement(otherStem)) -
      ELEMENT_RING.indexOf(stemElement(dayStem)) +
      5) %
    5;
  const pair = TEN_GOD_BY_GAP[gap] as readonly [string, string];
  return day % 2 === other % 2 ? pair[0] : pair[1];
}

describe("通変星（十神）", () => {
  it("日干 10 × 相手干 10 の総当たりが、別実装と一致する", () => {
    let checked = 0;
    for (const day of STEMS) {
      for (const other of STEMS) {
        expect(tenGod(day, other), `${day} 日から見た ${other}`).toBe(expectedTenGod(day, other));
        checked++;
      }
    }
    expect(checked).toBe(100);
  });

  it("どの日干から見ても、10 種がちょうど 1 回ずつ出る", () => {
    for (const day of STEMS) {
      const gods = STEMS.map((other) => tenGod(day, other));
      expect(new Set(gods).size, `${day} 日`).toBe(10);
      expect([...gods].sort()).toEqual([...TEN_GODS].sort());
    }
  });

  it("自分自身は比肩、同じ五行の相方は劫財", () => {
    for (let index = 0; index < 10; index++) {
      const self = STEMS[index] as string;
      // 同じ五行のもう一方（甲↔乙・丙↔丁 ……）
      const twin = STEMS[index % 2 === 0 ? index + 1 : index - 1] as string;
      expect(tenGod(self, self)).toBe("比肩");
      expect(tenGod(self, twin), `${self} から見た ${twin}`).toBe("劫財");
    }
  });

  it("甲日の 10 干（食神＝丙・傷官＝丁・偏財＝戊・正財＝己・偏官＝庚・正官＝辛・偏印＝壬・印綬＝癸）", () => {
    const expected: Record<string, string> = {
      甲: "比肩",
      乙: "劫財",
      丙: "食神",
      丁: "傷官",
      戊: "偏財",
      己: "正財",
      庚: "偏官",
      辛: "正官",
      壬: "偏印",
      癸: "印綬",
    };
    for (const [stem, god] of Object.entries(expected)) {
      expect(tenGod("甲", stem), `甲 日の ${stem}`).toBe(god);
    }
  });

  it("陰の日干では陰陽が入れ替わる（己日の壬は正財、癸は偏財）", () => {
    // 己（陰土）剋 水 ＝ 財。壬は陽なので陰陽が違って正財、癸は陰なので同じで偏財
    expect(tenGod("己", "壬")).toBe("正財");
    expect(tenGod("己", "癸")).toBe("偏財");
    // 己 を生む 火 ＝ 印。丙は陽で陰陽が違うので印綬、丁は陰で同じなので偏印
    expect(tenGod("己", "丙")).toBe("印綬");
    expect(tenGod("己", "丁")).toBe("偏印");
  });
});

// ---------------------------------------------------------------------------
// 十二運
// ---------------------------------------------------------------------------

/**
 * 十二運の期待表（手で並べたもの）。
 * 文字列は 長生・沐浴・冠帯・建禄・帝旺・衰・病・死・墓・絶・胎・養 の順に置いた 12 支。
 *
 * 手計算の過程（陽干は長生から順行、陰干は長生から逆行）:
 *  - 甲（陽木・長生 亥）: 亥長生 → 子沐浴 → 丑冠帯 → 寅建禄 → 卯帝旺 → 辰衰 → 巳病 → 午死
 *                        → 未墓 → 申絶 → 酉胎 → 戌養
 *  - 乙（陰木・長生 午）: 午長生 → 巳沐浴 → 辰冠帯 → 卯建禄 → 寅帝旺 → 丑衰 → 子病 → 亥死
 *                        → 戌墓 → 酉絶 → 申胎 → 未養
 *  - 丙・戊（長生 寅、順行）: 寅長生 → 卯 → 辰 → 巳建禄 → 午帝旺 → 未 → 申 → 酉 → 戌 → 亥 → 子 → 丑
 *  - 丁・己（長生 酉、逆行）: 酉長生 → 申 → 未 → 午建禄 → 巳帝旺 → 辰 → 卯 → 寅 → 丑 → 子 → 亥 → 戌
 *  - 庚（陽金・長生 巳）: 巳長生 → 午 → 未 → 申建禄 → 酉帝旺 → 戌 → 亥 → 子 → 丑 → 寅 → 卯 → 辰
 *  - 辛（陰金・長生 子）: 子長生 → 亥 → 戌 → 酉建禄 → 申帝旺 → 未 → 午 → 巳 → 辰 → 卯 → 寅 → 丑
 *  - 壬（陽水・長生 申）: 申長生 → 酉 → 戌 → 亥建禄 → 子帝旺 → 丑 → 寅 → 卯 → 辰 → 巳 → 午 → 未
 *  - 癸（陰水・長生 卯）: 卯長生 → 寅 → 丑 → 子建禄 → 亥帝旺 → 戌 → 酉 → 申 → 未 → 午 → 巳 → 辰
 *
 * 4 つ目（建禄）が「その干の禄」に、5 つ目（帝旺）が旺支になっているのが検算のかなめ。
 * 禄は 甲寅・乙卯・丙戊巳・丁己午・庚申・辛酉・壬亥・癸子。
 */
const TWELVE_STAGE_TABLE: Readonly<Record<string, string>> = {
  甲: "亥子丑寅卯辰巳午未申酉戌",
  乙: "午巳辰卯寅丑子亥戌酉申未",
  丙: "寅卯辰巳午未申酉戌亥子丑",
  丁: "酉申未午巳辰卯寅丑子亥戌",
  戊: "寅卯辰巳午未申酉戌亥子丑",
  己: "酉申未午巳辰卯寅丑子亥戌",
  庚: "巳午未申酉戌亥子丑寅卯辰",
  辛: "子亥戌酉申未午巳辰卯寅丑",
  壬: "申酉戌亥子丑寅卯辰巳午未",
  癸: "卯寅丑子亥戌酉申未午巳辰",
};

/** 天干の禄（建禄の支） */
const ROKU: Readonly<Record<string, string>> = {
  甲: "寅",
  乙: "卯",
  丙: "巳",
  丁: "午",
  戊: "巳",
  己: "午",
  庚: "申",
  辛: "酉",
  壬: "亥",
  癸: "子",
};

describe("十二運（陰干逆行）", () => {
  it("10 干 × 12 支の総当たりが手計算の表と一致する", () => {
    let checked = 0;
    for (const [stem, order] of Object.entries(TWELVE_STAGE_TABLE)) {
      order.split("").forEach((branch, index) => {
        expect(twelveStage(stem, branch), `${stem} 日の ${branch}`).toBe(TWELVE_STAGES[index]);
        checked++;
      });
    }
    expect(checked).toBe(120);
  });

  it("どの日干でも 12 支に 12 段がちょうど 1 回ずつ乗る", () => {
    for (const stem of STEMS) {
      const stages = BRANCHES.map((branch) => twelveStage(stem, branch));
      expect(new Set(stages).size, `${stem} 日`).toBe(12);
    }
  });

  it("建禄がその干の禄に立ち、帝旺はその隣（陽干は次・陰干は前）", () => {
    for (const stem of STEMS) {
      const roku = ROKU[stem] as string;
      expect(twelveStage(stem, roku), `${stem} の禄 ${roku}`).toBe("建禄");
      const step = isYangStem(stem) ? 1 : -1;
      const next = BRANCHES[(branchIndexOf(roku) + step + 12) % 12] as string;
      expect(twelveStage(stem, next), `${stem} の帝旺 ${next}`).toBe("帝旺");
    }
  });

  it("陰干は逆行する（甲は亥が長生・乙は亥が死。同じ木でも向きが逆）", () => {
    expect(twelveStage("甲", "亥")).toBe("長生");
    expect(twelveStage("乙", "亥")).toBe("死");
    expect(twelveStage("乙", "午")).toBe("長生");
    expect(twelveStage("甲", "午")).toBe("死");
    // 陽生陰死方式なら「乙は亥で死」ではなく「乙も亥で長生」になる ―― そちらは採らない
    expect(twelveStage("辛", "子")).toBe("長生");
    expect(twelveStage("庚", "子")).toBe("死");
  });

  it("知らない干支は弾く", () => {
    expect(() => twelveStage("子", "子")).toThrow(FourPillarsError);
    expect(() => twelveStage("甲", "甲")).toThrow(FourPillarsError);
  });
});

// ---------------------------------------------------------------------------
// 空亡
// ---------------------------------------------------------------------------

describe("空亡（旬空）", () => {
  it("6 旬ぜんぶ（甲子＝戌亥・甲戌＝申酉・甲申＝午未・甲午＝辰巳・甲辰＝寅卯・甲寅＝子丑）", () => {
    const expected: [string, [string, string]][] = [
      ["甲子", ["戌", "亥"]],
      ["甲戌", ["申", "酉"]],
      ["甲申", ["午", "未"]],
      ["甲午", ["辰", "巳"]],
      ["甲辰", ["寅", "卯"]],
      ["甲寅", ["子", "丑"]],
    ];
    for (const [head, branches] of expected) {
      const view = voidOf(ganzhiIndexOf(head));
      expect(view.decade, head).toBe(`${head}旬`);
      expect(view.branches, head).toEqual(branches);
    }
  });

  it("旬のどこから引いても同じ答えになる（癸酉は甲子旬）", () => {
    expect(voidOf(ganzhiIndexOf("癸酉")).decade).toBe("甲子旬");
    expect(voidOf(ganzhiIndexOf("癸酉")).branches).toEqual(["戌", "亥"]);
    expect(voidOf(ganzhiIndexOf("戊辰")).decade).toBe("甲子旬");
    expect(voidOf(ganzhiIndexOf("癸亥")).decade).toBe("甲寅旬");
  });

  it("60 干支ぜんぶで、その旬の 10 柱に出てこない 2 支と一致する", () => {
    for (let index = 0; index < 60; index++) {
      const head = index - (index % 10);
      const used = new Set(
        Array.from({ length: 10 }, (_unused, offset) => ganzhiOf(head + offset).branch),
      );
      const missing = BRANCHES.filter((branch) => !used.has(branch));
      expect(missing.length).toBe(2);
      expect(voidOf(index).branches, ganzhiOf(index).ganzhi).toEqual(missing);
    }
  });
});

// ---------------------------------------------------------------------------
// 蔵干
// ---------------------------------------------------------------------------

describe("蔵干（人元）", () => {
  /** 本気 → 中気 → 余気 の順に並べた期待表 */
  const expected: Readonly<Record<string, string[]>> = {
    子: ["癸"],
    丑: ["己", "辛", "癸"],
    寅: ["甲", "丙", "戊"],
    卯: ["乙"],
    辰: ["戊", "癸", "乙"],
    巳: ["丙", "庚", "戊"],
    午: ["丁", "己"],
    未: ["己", "乙", "丁"],
    申: ["庚", "壬", "戊"],
    酉: ["辛"],
    戌: ["戊", "丁", "辛"],
    亥: ["壬", "甲"],
  };

  it("12 支ぶんの表がそろっていて、本気 → 中気 → 余気の順に並ぶ", () => {
    const ranks = ["本気", "中気", "余気"];
    for (const branch of BRANCHES) {
      const hidden = hiddenStemsOf(branch, "甲");
      expect(hidden.map((entry) => entry.stem), branch).toEqual(expected[branch]);
      hidden.forEach((entry, index) => {
        expect(entry.rank, `${branch} の ${index + 1} 番目`).toBe(ranks[index]);
      });
    }
  });

  it("本気の五行は、その地支の五行と必ず同じ（子＝癸・午＝丁の陰陽のねじれも込みで）", () => {
    for (const branch of BRANCHES) {
      const honki = hiddenStemsOf(branch, "甲")[0];
      expect(honki?.element, `${branch} の本気`).toBe(branchElement(branch));
    }
    // 陽支なのに陰干を蔵す 2 つ（子＝癸・午＝丁）
    expect(hiddenStemsOf("子", "甲")[0]?.stem).toBe("癸");
    expect(hiddenStemsOf("午", "甲")[0]?.stem).toBe("丁");
  });

  it("辰戌丑未（土の墓庫）は 本気＝土・中気＝納まる五行・余気＝前の月の五行", () => {
    // 丑 は子（水）のあとで金の庫、辰 は卯（木）のあとで水の庫、
    // 未 は午（火）のあとで木の庫、戌 は酉（金）のあとで火の庫
    const cases: [string, string, string, string][] = [
      ["丑", "己", "辛", "癸"],
      ["辰", "戊", "癸", "乙"],
      ["未", "己", "乙", "丁"],
      ["戌", "戊", "丁", "辛"],
    ];
    for (const [branch, honki, chuki, yoki] of cases) {
      const hidden = hiddenStemsOf(branch, "甲");
      expect(hidden.map((entry) => entry.stem), branch).toEqual([honki, chuki, yoki]);
      expect(stemElement(honki), `${branch} の本気`).toBe("土");
      // 余気は 1 つ前の支の五行
      const previous = BRANCHES[(branchIndexOf(branch) + 11) % 12] as string;
      expect(stemElement(yoki), `${branch} の余気`).toBe(branchElement(previous));
    }
  });

  it("寅申巳亥（生地）は 中気＝そこで長生する陽干（寅＝丙・巳＝庚・申＝壬・亥＝甲）", () => {
    for (const [branch, chuki] of [
      ["寅", "丙"],
      ["巳", "庚"],
      ["申", "壬"],
      ["亥", "甲"],
    ] as [string, string][]) {
      expect(hiddenStemsOf(branch, "甲")[1]?.stem, branch).toBe(chuki);
      expect(twelveStage(chuki, branch), `${chuki} は ${branch} で長生`).toBe("長生");
    }
  });

  it("蔵干にも日干から見た通変星が付く（戊日の午は 本気丁＝印綬・中気己＝劫財）", () => {
    const hidden = hiddenStemsOf("午", "戊");
    expect(hidden).toEqual([
      { stem: "丁", rank: "本気", element: "火", ten_god: "印綬" },
      { stem: "己", rank: "中気", element: "土", ten_god: "劫財" },
    ]);
  });

  it("知らない地支は弾く", () => {
    expect(() => hiddenStemsOf("甲", "甲")).toThrow(FourPillarsError);
  });
});

// ---------------------------------------------------------------------------
// 干支どうしの関係
// ---------------------------------------------------------------------------

describe("天干五合・六合・六沖", () => {
  it("天干五合は 甲己・乙庚・丙辛・丁壬・戊癸 の 5 組で、どの干も 1 組にだけ入る", () => {
    const pairs: [string, string][] = [
      ["甲", "己"],
      ["乙", "庚"],
      ["丙", "辛"],
      ["丁", "壬"],
      ["戊", "癸"],
    ];
    for (const [a, b] of pairs) {
      expect(isStemCombination(a, b), `${a}${b}`).toBe(true);
      expect(isStemCombination(b, a), `${b}${a}（逆向き）`).toBe(true);
    }
    for (const stem of STEMS) {
      const partners = STEMS.filter((other) => isStemCombination(stem, other));
      expect(partners.length, `${stem} の相方`).toBe(1);
      // 自分自身とは合わない
      expect(isStemCombination(stem, stem)).toBe(false);
    }
  });

  it("六合は 子丑・寅亥・卯戌・辰酉・巳申・午未 の 6 組で、どの支も 1 組にだけ入る", () => {
    const pairs: [string, string][] = [
      ["子", "丑"],
      ["寅", "亥"],
      ["卯", "戌"],
      ["辰", "酉"],
      ["巳", "申"],
      ["午", "未"],
    ];
    for (const [a, b] of pairs) {
      expect(isBranchHarmony(a, b), `${a}${b}`).toBe(true);
      expect(isBranchHarmony(b, a), `${b}${a}（逆向き）`).toBe(true);
    }
    for (const branch of BRANCHES) {
      expect(BRANCHES.filter((other) => isBranchHarmony(branch, other)).length, branch).toBe(1);
      expect(isBranchHarmony(branch, branch)).toBe(false);
    }
  });

  it("六沖は 子午・丑未・寅申・卯酉・辰戌・巳亥 の 6 組で、向かい合う支どうし", () => {
    const pairs: [string, string][] = [
      ["子", "午"],
      ["丑", "未"],
      ["寅", "申"],
      ["卯", "酉"],
      ["辰", "戌"],
      ["巳", "亥"],
    ];
    for (const [a, b] of pairs) {
      expect(isBranchClash(a, b), `${a}${b}`).toBe(true);
      expect(isBranchClash(b, a), `${b}${a}（逆向き）`).toBe(true);
    }
    for (const branch of BRANCHES) {
      expect(BRANCHES.filter((other) => isBranchClash(branch, other)).length, branch).toBe(1);
      expect(isBranchClash(branch, branch)).toBe(false);
    }
  });

  it("六合と六沖が同じ組に重なることはない", () => {
    for (const a of BRANCHES) {
      for (const b of BRANCHES) {
        expect(isBranchHarmony(a, b) && isBranchClash(a, b), `${a}${b}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 時辰の境
// ---------------------------------------------------------------------------

describe("時辰の境ぎわの印", () => {
  /** 閾値は 15 分で固定（名前つきの規約） */
  it("閾値は HOUR_BOUNDARY_NOTE_MINUTES ＝ 15 分", () => {
    expect(HOUR_BOUNDARY_NOTE_MINUTES).toBe(15);
  });

  it("時辰の頭から 15 分以内は「前」、次の境まで 15 分以内は「次」、真ん中は印なし", () => {
    const note = { side: "前", within_minutes: 15 };
    // 午刻は 11:00〜13:00
    expect(hourBoundaryNoteOf(11, 0)).toEqual(note);
    expect(hourBoundaryNoteOf(11, 15)).toEqual(note);
    expect(hourBoundaryNoteOf(11, 16)).toBeNull();
    expect(hourBoundaryNoteOf(12, 0)).toBeNull();
    expect(hourBoundaryNoteOf(12, 44)).toBeNull();
    expect(hourBoundaryNoteOf(12, 45)).toEqual({ side: "次", within_minutes: 15 });
    expect(hourBoundaryNoteOf(12, 59)).toEqual({ side: "次", within_minutes: 15 });
  });

  it("子刻（23:00〜01:00）も日をまたいで同じように測る", () => {
    expect(hourBoundaryNoteOf(23, 0)?.side).toBe("前");
    expect(hourBoundaryNoteOf(23, 15)?.side).toBe("前");
    expect(hourBoundaryNoteOf(23, 30)).toBeNull();
    expect(hourBoundaryNoteOf(0, 30)).toBeNull();
    expect(hourBoundaryNoteOf(0, 45)?.side).toBe("次");
    expect(hourBoundaryNoteOf(0, 59)?.side).toBe("次");
  });

  it("1 日 1440 分ぜんぶで、返るのは null かこの 2 通りだけ（分数そのものは決して返らない）", () => {
    const seen = new Set<string>();
    let flagged = 0;
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        const note = hourBoundaryNoteOf(hour, minute);
        if (note === null) continue;
        flagged++;
        expect(note.within_minutes, `${hour}:${minute}`).toBe(15);
        expect(["前", "次"]).toContain(note.side);
        seen.add(JSON.stringify(note));
      }
    }
    // 12 の時辰 × （頭から 16 分 ＋ 終わりの 15 分）
    expect(flagged).toBe(12 * 31);
    expect(seen.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 命式
// ---------------------------------------------------------------------------

describe("命式（2000-01-01 12:00・黄経 280.1°）", () => {
  it("四柱は 己卯年 丙子月 戊午日 戊午時（立春前なので年柱は 1999 年）", () => {
    const result = sample();
    expect(orderedPillars(result.pillars).map((pillar) => pillar.ganzhi)).toEqual([
      "己卯",
      "丙子",
      "戊午",
      "戊午",
    ]);
    expect(result.pillars.year.label).toBe("年柱");
    expect(result.day_master).toEqual({ stem: "戊", element: "土", yin_yang: "陽" });
  });

  it("通変星は日干 戊 から（年 己＝劫財・月 丙＝偏印・日＝日主・時 戊＝比肩）", () => {
    const result = sample();
    expect(orderedPillars(result.pillars).map((pillar) => pillar.ten_god)).toEqual([
      "劫財",
      "偏印",
      "日主",
      "比肩",
    ]);
  });

  it("蔵干と、その本気で代表した通変星", () => {
    const result = sample();
    expect(
      orderedPillars(result.pillars).map((pillar) =>
        pillar.hidden_stems.map((entry) => entry.stem).join("/"),
      ),
    ).toEqual(["乙", "癸", "丁/己", "丁/己"]);
    expect(orderedPillars(result.pillars).map((pillar) => pillar.hidden_ten_god)).toEqual([
      "正官", // 卯の本気 乙（陰木）は 戊（陽土）を剋す ＝ 陰陽が違うので正官
      "正財", // 子の本気 癸（陰水）は 戊 が剋す ＝ 陰陽が違うので正財
      "印綬", // 午の本気 丁（陰火）は 戊 を生む ＝ 陰陽が違うので印綬
      "印綬",
    ]);
  });

  it("十二運は日干 戊 から（卯＝沐浴・子＝胎・午＝帝旺）", () => {
    const result = sample();
    expect(orderedPillars(result.pillars).map((pillar) => pillar.twelve_stage)).toEqual([
      "沐浴",
      "胎",
      "帝旺",
      "帝旺",
    ]);
  });

  it("空亡は日柱 戊午（甲寅旬）から 子丑 ―― 月支の子が当たる", () => {
    const result = sample();
    expect(result.void).toEqual({ decade: "甲寅旬", branches: ["子", "丑"] });
    expect(orderedPillars(result.pillars).map((pillar) => pillar.is_void)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    // 日柱の支が自分の旬の空亡に当たることはない
    expect(result.pillars.day.is_void).toBe(false);
  });

  it("節入りは 大雪 から／次は 小寒（黄経 280.1° は子月の中）", () => {
    const result = sample();
    expect(result.solar_term).toEqual({
      previous: { name: "大雪", longitude: 255 },
      next: { name: "小寒", longitude: 285 },
      days_since_previous: 24.6,
      days_until_next: 5.4,
    });
    // 節の並びは月支の並びと同じ 12 個
    expect(SOLAR_TERMS.length).toBe(12);
    expect(SOLAR_TERMS.map((term) => term.branch).join("")).toBe("寅卯辰巳午未申酉戌亥子丑");
  });

  it("節入りを渡さなければ solar_term は付かない", () => {
    const result = calculateFourPillars({
      moment: moment(2000, 1, 1, 12, 0),
      sun_longitude: SAMPLE_SUN_LONGITUDE,
    });
    expect(result.solar_term).toBeUndefined();
    expect(result.luck_cycles.forward.start_age).toBeNull();
    expect(result.luck_cycles.forward.start_months).toBeNull();
    expect(result.luck_cycles.forward.pillars[0]?.start_age).toBeNull();
    // 干支の並びだけは出る
    expect(result.luck_cycles.forward.pillars[0]?.ganzhi).toBe("丁丑");
  });

  it("時辰の境ぎわでなければ印は付かない（12:00 は午刻のど真ん中）", () => {
    expect(sample().hour_boundary).toBeNull();
  });

  it("境ぎわなら「どちら側か」だけが付く（12:50 は次の未刻まで 15 分以内）", () => {
    const result = sample({ moment: moment(2000, 1, 1, 12, 50) });
    expect(result.hour_boundary).toEqual({ side: "次", within_minutes: 15 });
    // 印に分数は入らない
    expect(Object.keys(result.hour_boundary as object).sort()).toEqual([
      "side",
      "within_minutes",
    ]);
  });

  it("規約がそのまま乗る", () => {
    expect(sample().conventions).toEqual({ ...FOUR_PILLARS_CONVENTIONS });
    expect(sample().conventions.twelve_stages).toContain("陰干逆行");
    expect(sample().conventions.hidden_stems).toContain("月律分野表");
    // 起運の精度も名前つきの規約として返す（流派の丸めとは別物、と言い切っておく）
    expect(sample().conventions.luck_start_precision).toContain("0.1 年");
    expect(sample().conventions.luck_start_precision).toContain("約 7 時間の粗さ");
    expect(sample().conventions.luck_cycles).toContain("流派の丸め");
  });

  it("起運は 0.1 年までしか返さない（出生時刻が逆算されないように）", () => {
    // 節入りまでの日数が 26 秒ちがう 2 つ ―― 4 桁で返していたころは別の値になっていた
    const term = (days: number) => ({ days_since_previous: 30.4 - days, days_until_next: days });
    const a = calculateFourPillars({
      moment: moment(2000, 1, 1, 12, 0),
      sun_longitude: SAMPLE_SUN_LONGITUDE,
      term: term(5.4),
    });
    const b = calculateFourPillars({
      moment: moment(2000, 1, 1, 12, 0),
      sun_longitude: SAMPLE_SUN_LONGITUDE,
      term: term(5.4003),
    });
    expect(a.luck_cycles).toEqual(b.luck_cycles);
    expect(a.luck_cycles.forward.start_age).toBe(1.8);
    // 月数は「丸めたあとの起運 × 12」を整数へ ―― 元の日数からは作らない
    expect(a.luck_cycles.forward.start_months).toBe(22);
    expect(Number.isInteger(a.luck_cycles.forward.start_months)).toBe(true);
    // 小数 1 桁より細かい桁は 1 つも出さない
    for (const cycle of [a.luck_cycles.forward, a.luck_cycles.backward]) {
      for (const value of [cycle.start_age, ...cycle.pillars.map((p) => p.start_age)]) {
        expect(Math.round((value as number) * 10)).toBeCloseTo((value as number) * 10, 9);
      }
    }
  });

  it("同じ引数なら何度呼んでも同じ命式（乱数を使っていない）", () => {
    expect(sample()).toEqual(sample());
  });
});

// ---------------------------------------------------------------------------
// 23 時台の代替
// ---------------------------------------------------------------------------

describe("23 時台の日界の代替", () => {
  /** 2000-01-01 23:30。既定（日界 0 時）は 戊午日の子刻＝壬子（戊癸→壬子の五鼠遁） */
  const late = () =>
    calculateFourPillars({
      moment: moment(2000, 1, 1, 23, 30),
      sun_longitude: SAMPLE_SUN_LONGITUDE,
      term: SAMPLE_TERM,
    });

  it("既定は日界 0 時のまま（日柱 戊午・時柱 壬子）", () => {
    const result = late();
    expect(result.pillars.day.ganzhi).toBe("戊午");
    expect(result.pillars.hour.ganzhi).toBe("壬子");
  });

  it("日界23時は日柱も時柱も翌日、夜子時は日柱だけ据え置き", () => {
    const alternatives = late().alternatives;
    expect(alternatives?.map((entry) => entry.name)).toEqual(["日界23時", "夜子時"]);
    // 翌日は 己未。己 の五鼠遁（甲己→甲子）で子刻は 甲子
    expect(alternatives?.[0]?.day.ganzhi).toBe("己未");
    expect(alternatives?.[0]?.hour.ganzhi).toBe("甲子");
    expect(alternatives?.[1]?.day.ganzhi).toBe("戊午");
    expect(alternatives?.[1]?.hour.ganzhi).toBe("甲子");
  });

  it("月末・年末をまたいでも翌日の日干支が続く（1999-12-31 23:30 の翌日は 2000-01-01 ＝ 戊午）", () => {
    const result = calculateFourPillars({
      moment: moment(1999, 12, 31, 23, 30),
      sun_longitude: 279.1,
      term: SAMPLE_TERM,
    });
    expect(result.pillars.day.ganzhi).toBe("丁巳");
    expect(result.alternatives?.[0]?.day.ganzhi).toBe("戊午");
    // 夜子時の日柱は当日のまま
    expect(result.alternatives?.[1]?.day.ganzhi).toBe("丁巳");
  });

  it("23 時台でなければ代替は付かない（22:59 と 00:00）", () => {
    for (const [hour, minute] of [
      [22, 59],
      [0, 0],
      [12, 0],
    ] as [number, number][]) {
      const result = calculateFourPillars({
        moment: moment(2000, 1, 1, hour, minute),
        sun_longitude: SAMPLE_SUN_LONGITUDE,
      });
      expect(result.alternatives, `${hour}:${minute}`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 大運
// ---------------------------------------------------------------------------

describe("大運", () => {
  it("順行は月柱の次から 10 柱、逆行は前から 10 柱", () => {
    const cycles = sample().luck_cycles;
    // 月柱は 丙子（六十干支の 12 番）
    expect(ganzhiIndexOf("丙子")).toBe(12);
    expect(cycles.forward.pillars.map((pillar) => pillar.ganzhi)).toEqual([
      "丁丑",
      "戊寅",
      "己卯",
      "庚辰",
      "辛巳",
      "壬午",
      "癸未",
      "甲申",
      "乙酉",
      "丙戌",
    ]);
    expect(cycles.backward.pillars.map((pillar) => pillar.ganzhi)).toEqual([
      "乙亥",
      "甲戌",
      "癸酉",
      "壬申",
      "辛未",
      "庚午",
      "己巳",
      "戊辰",
      "丁卯",
      "丙寅",
    ]);
  });

  it("起運は 節入りまでの日数 ÷ 3（順行は次の節入りまで、逆行は前の節入りから）", () => {
    const cycles = sample().luck_cycles;
    // 次の小寒まで 5.4 日 → 1.8 年（1.8 × 12 = 21.6 → 22 か月）
    expect(cycles.forward.start_age).toBe(1.8);
    expect(cycles.forward.start_months).toBe(22);
    expect(cycles.forward.days_to_term).toBe(5.4);
    // 前の大雪から 24.6 日 → 8.2 年（8.2 × 12 = 98.4 → 98 か月）
    expect(cycles.backward.start_age).toBe(8.2);
    expect(cycles.backward.start_months).toBe(98);
    expect(cycles.backward.days_to_term).toBe(24.6);
  });

  it("開始年齢は起運から 10 年ずつ（起運と同じ小数 1 桁）", () => {
    const cycles = sample().luck_cycles;
    expect(cycles.forward.pillars.map((pillar) => pillar.start_age)).toEqual([
      1.8, 11.8, 21.8, 31.8, 41.8, 51.8, 61.8, 71.8, 81.8, 91.8,
    ]);
    expect(cycles.forward.pillars[0]?.end_age).toBe(11.8);
    expect(cycles.backward.pillars[0]?.start_age).toBe(8.2);
    expect(cycles.backward.pillars[9]?.start_age).toBe(98.2);
  });

  it("性別は預からず、どちらの向きが誰に当たるかだけ添える（年干 己＝陰なので順行は女性）", () => {
    const cycles = sample().luck_cycles;
    expect(cycles.forward.applies_to).toBe("女性");
    expect(cycles.backward.applies_to).toBe("男性");
    expect(cycles.direction_rule).toContain("陽年干（甲丙戊庚壬）の男性");
    expect(cycles.direction_rule).toContain("年干は己＝陰");
  });

  it("陽年干の命式では順行が男性に当たる", () => {
    // 2026-08-22（丙午年）。丙 は陽干
    const result = calculateFourPillars({
      moment: moment(2026, 8, 22, 12, 0),
      sun_longitude: 149.6,
      term: { days_since_previous: 15, days_until_next: 15 },
    });
    expect(result.pillars.year.ganzhi).toBe("丙午");
    expect(result.luck_cycles.forward.applies_to).toBe("男性");
    expect(result.luck_cycles.backward.applies_to).toBe("女性");
    // 15 日 ÷ 3 ＝ 5 年でどちらも同じ
    expect(result.luck_cycles.forward.start_age).toBe(5);
    expect(result.luck_cycles.backward.start_age).toBe(5);
  });

  it("各柱に通変星・十二運・空亡が付く", () => {
    const first = sample().luck_cycles.forward.pillars[0];
    // 丁丑。戊 日から見て 丁（陰火）は生我・陰陽違い ＝ 印綬、丑 は 戊 の 12 段目＝養
    expect(first).toMatchObject({
      index: 1,
      ganzhi: "丁丑",
      ten_god: "印綬",
      twelve_stage: "養",
      is_void: true, // 甲寅旬の空亡は子丑
    });
  });

  it("節入りの日数が向きどおりでなければ弾く", () => {
    const bad = (term: { days_since_previous: number; days_until_next: number }) => () =>
      calculateFourPillars({
        moment: moment(2000, 1, 1, 12, 0),
        sun_longitude: SAMPLE_SUN_LONGITUDE,
        term,
      });
    expect(bad({ days_since_previous: -1, days_until_next: 5 })).toThrow("0 以上");
    expect(bad({ days_since_previous: 1, days_until_next: 0 })).toThrow("0 より大きく");
  });

  it("solarTermSpanFromJd は jd の引き算そのまま（丸めない）", () => {
    const span = solarTermSpanFromJd(2451545.5, 2451520.9, 2451550.9);
    // jd は 240 万台なので引き算だけで小数の埃が出る。ここでは丸めず、そのまま渡す
    expect(span.days_since_previous).toBeCloseTo(24.6, 6);
    expect(span.days_until_next).toBeCloseTo(5.4, 6);
    // 命式に食わせるところで小数 1 桁に整えられる
    const result = calculateFourPillars({
      moment: moment(2000, 1, 1, 12, 0),
      sun_longitude: SAMPLE_SUN_LONGITUDE,
      term: span,
    });
    expect(result.solar_term?.days_since_previous).toBe(24.6);
    expect(result.solar_term?.days_until_next).toBe(5.4);
  });
});

// ---------------------------------------------------------------------------
// 流年・月運・日運
// ---------------------------------------------------------------------------

describe("流年・月運・日運", () => {
  /** 2026-08-22 12:00（黄経 149.6°）＝ 丙午年 丙申月 戊辰日 戊午時 */
  const target: DateFortuneInput = {
    moment: moment(2026, 8, 22, 12, 0),
    sun_longitude: 149.6,
    include_hour: true,
  };

  it("年柱は立春切替・月柱は節気・日柱は日界 0 時（納甲側と同じ四柱）", () => {
    const fortune = calculateDateFortune(sample(), target);
    expect([fortune.year.ganzhi, fortune.month.ganzhi, fortune.day.ganzhi]).toEqual([
      "丙午",
      "丙申",
      "戊辰",
    ]);
    expect(fortune.hour?.ganzhi).toBe("戊午");
    expect(fortune.date).toEqual({
      year: 2026,
      month: 8,
      day: 22,
      hour: 12,
      minute: 0,
      utc_offset: 9,
    });
  });

  it("通変星・十二運・空亡は命式の日干（戊）と日柱の旬（甲寅旬）から", () => {
    const fortune = calculateDateFortune(sample(), target);
    expect(fortune.day_master).toBe("戊");
    expect(fortune.void).toEqual({ decade: "甲寅旬", branches: ["子", "丑"] });
    // 丙（陽火）は 戊（陽土）を生む・陰陽同じ ＝ 偏印。午 は 戊 の帝旺
    expect(fortune.year).toMatchObject({
      label: "流年",
      ten_god: "偏印",
      twelve_stage: "帝旺",
      is_void: false,
    });
    // 申 は 戊 の病
    expect(fortune.month).toMatchObject({ label: "月運", ten_god: "偏印", twelve_stage: "病" });
    // 戊 は比肩。辰 は 戊 の冠帯
    expect(fortune.day).toMatchObject({ label: "日運", ten_god: "比肩", twelve_stage: "冠帯" });
  });

  it("命式との関係は天干五合・六合・六沖だけ（流年 午 が月柱 子 を沖する）", () => {
    const fortune = calculateDateFortune(sample(), target);
    expect(fortune.year.relations).toEqual([
      { from: "流年", to: "月柱", kind: "六沖", pair: "子午" },
    ]);
    expect(fortune.month.relations).toEqual([]);
    expect(fortune.day.relations).toEqual([]);
    expect(fortune.hour?.relations).toEqual([
      { from: "時運", to: "月柱", kind: "六沖", pair: "子午" },
    ]);
    // まとめの relations は各柱のぶんを並べたもの
    expect(fortune.relations.length).toBe(2);
    expect(new Set(fortune.relations.map((relation) => relation.kind))).toEqual(new Set(["六沖"]));
  });

  it("天干五合と六合も拾う（癸卯の日は 命式の月干 丙 とは合わないが、支の卯は年柱の卯と重なる）", () => {
    // 甲己合・卯戌合が立つ日付を組み立てる。命式は 己卯年 丙子月 戊午日
    // 2000-01-01 の日柱 戊午 から 6 日進めた 甲子 日を使う（甲 は年干 己 と五合、子 は日柱の午と沖）
    const fortune = calculateDateFortune(sample(), {
      moment: moment(2000, 1, 7, 12, 0),
      sun_longitude: 286,
    });
    expect(fortune.day.ganzhi).toBe("甲子");
    expect(fortune.day.relations).toEqual([
      { from: "日運", to: "年柱", kind: "天干五合", pair: "甲己" },
      { from: "日運", to: "日柱", kind: "六沖", pair: "子午" },
      { from: "日運", to: "時柱", kind: "六沖", pair: "子午" },
    ]);
    // 日運の子は命式の月支 子 と同じなので、六合にも六沖にもならない
    expect(
      fortune.day.relations.filter((relation) => relation.to === "月柱"),
    ).toEqual([]);
  });

  it("include_hour を立てなければ時運は出ない（時刻も返り値に載せない）", () => {
    const fortune = calculateDateFortune(sample(), {
      moment: moment(2026, 8, 22, 12, 0),
      sun_longitude: 149.6,
    });
    expect(fortune.hour).toBeUndefined();
    expect(fortune.date.hour).toBeUndefined();
    expect(fortune.date.minute).toBeUndefined();
    expect(fortune.relations.length).toBe(1);
  });

  it("蔵干も命式の日干から読んだ通変星つきで付く", () => {
    const fortune = calculateDateFortune(sample(), target);
    expect(fortune.month.hidden_stems).toEqual([
      { stem: "庚", rank: "本気", element: "金", ten_god: "食神" },
      { stem: "壬", rank: "中気", element: "水", ten_god: "偏財" },
      { stem: "戊", rank: "余気", element: "土", ten_god: "比肩" },
    ]);
  });

  it("規約がそのまま乗る", () => {
    const fortune = calculateDateFortune(sample(), target);
    expect(fortune.conventions.relations).toContain("三合・刑・害は初版の範囲外");
  });
});

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** 表の 1 行から、見出しを外して列だけ取り出す */
function cellsOf(text: string, label: string): string[] {
  const line = text.split("\n").find((row) => row.startsWith(label));
  expect(line, `${label} の行`).toBeDefined();
  return (line as string)
    .slice(label.length)
    .trim()
    .split(/\s+/);
}

describe("命式のテキスト整形", () => {
  it("頭に本が載せるかたちの表が来る（年柱・月柱・日柱・時柱 × 天干・地支・蔵干・通変星・十二運・空亡）", () => {
    const text = formatFourPillarsText(sample());
    const lines = text.split("\n");
    expect(lines[0]).toBe("■ 四柱推命（命式）");
    expect(lines[1]?.trim().split(/\s+/)).toEqual(["年柱", "月柱", "日柱", "時柱"]);
    expect(cellsOf(text, "天干")).toEqual(["己(陰土)", "丙(陽火)", "戊(陽土)", "戊(陽土)"]);
    expect(cellsOf(text, "通変星")).toEqual(["劫財", "偏印", "日主", "比肩"]);
    expect(cellsOf(text, "地支")).toEqual(["卯(陰木)", "子(陽水)", "午(陽火)", "午(陽火)"]);
    expect(cellsOf(text, "蔵干")).toEqual(["乙", "癸", "丁/己", "丁/己"]);
    expect(cellsOf(text, "蔵干通変")).toEqual(["正官", "正財", "印綬", "印綬"]);
    expect(cellsOf(text, "十二運")).toEqual(["沐浴", "胎", "帝旺", "帝旺"]);
    expect(cellsOf(text, "空亡")).toEqual(["－", "空亡", "－", "－"]);
  });

  it("空亡・節入り・時辰・大運・規約が続く", () => {
    const text = formatFourPillarsText(sample());
    expect(text).toContain("空亡（戊午日＝甲寅旬）: 子・丑");
    expect(text).toContain("節入り: 大雪から 24.6 日／次の小寒まで 5.4 日");
    // 12:00 は境ぎわでないので、印の一文そのものが出ない（規約の行では触れる）
    expect(text).not.toContain("隣の時柱になり得ます");
    expect(text).toContain("時辰は境から 15 分以内のときだけ印を出す");
    expect(text).toContain("大運（順行・女性）: 起運 1.8 年（約 22 か月／もとになった日数 5.4 日 ÷ 3）");
    expect(text).toContain("大運（逆行・男性）: 起運 8.2 年");
    expect(text).toContain("1.8〜11.8");
    expect(text).toContain("規約: 日界 0 時／時刻の補正なし／節気は太陽黄経");
  });

  it("出生の年月日・時差そのものは書かない（命式・蔵干・大運は派生値なので書く）", () => {
    const text = formatFourPillarsText(sample());
    expect(text).not.toContain("2000");
    expect(text).not.toContain("1999");
    expect(text).not.toContain("+9");
    expect(text).not.toContain("12:00");
  });

  it("境ぎわなら一文だけ添える（分数は書かない）", () => {
    const text = formatFourPillarsText(sample({ moment: moment(2000, 1, 1, 12, 50) }));
    expect(text).toContain(
      "時辰の境（次の未刻）まで 15 分以内 ―― 時刻補正をかける流派では隣の時柱になり得ます",
    );
    // 「あと 10 分」のような分数は出さない
    expect(text).not.toContain("10 分");
    expect(text).not.toContain("50");
  });

  it("時辰の頭ぎわなら「前の◯刻から」と書く", () => {
    const text = formatFourPillarsText(sample({ moment: moment(2000, 1, 1, 11, 5) }));
    expect(text).toContain("時辰の境（前の巳刻）から 15 分以内");
  });
});

// ---------------------------------------------------------------------------
// 出生の「分」が漏れないこと
// ---------------------------------------------------------------------------

describe("出生時刻の分が漏れない", () => {
  /** text と structuredContent（＝返り値そのもの）を 1 本の文字列にして見張る */
  const surface = (result: FourPillarsResult): string =>
    formatFourPillarsText(result) + "\n" + JSON.stringify(result);

  it("12:47 生まれで、text にも structuredContent にも 47 が出ない", () => {
    const result = sample({ moment: moment(2000, 1, 1, 12, 47) });
    // 境ぎわの印は立つ（12:47 は次の境 13:00 まで 13 分）
    expect(result.hour_boundary).toEqual({ side: "次", within_minutes: 15 });
    expect(surface(result)).not.toContain("47");
    // 「あと 13 分」も出ない
    expect(surface(result)).not.toContain("13 分");
  });

  it("同じ印になる分ちがいは、text も structuredContent も 1 文字たがわず同じ", () => {
    // 次の境ぎわ（12:45〜12:59）は全部おなじ見え方になる
    const nearNext = [45, 47, 52, 58, 59].map((minute) =>
      surface(sample({ moment: moment(2000, 1, 1, 12, minute) })),
    );
    expect(new Set(nearNext).size, "次の境ぎわ").toBe(1);

    // 時辰の頭ぎわ（11:00〜11:15）も同じ
    const nearPrevious = [0, 7, 11, 15].map((minute) =>
      surface(sample({ moment: moment(2000, 1, 1, 11, minute) })),
    );
    expect(new Set(nearPrevious).size, "頭ぎわ").toBe(1);

    // 境から離れているところ（11:16〜12:44）も全部おなじ
    const middle = [16, 30, 44].map((minute) =>
      surface(sample({ moment: moment(2000, 1, 1, 12, minute % 60) })),
    );
    expect(new Set(middle).size, "真ん中").toBe(1);
  });

  it("1 つの時辰 120 分ぶんで、見え方は 3 通りしかない（前ぎわ・印なし・次ぎわ）", () => {
    const seen = new Set<string>();
    for (let minute = 0; minute < 60; minute++) {
      seen.add(surface(sample({ moment: moment(2000, 1, 1, 11, minute) })));
      seen.add(surface(sample({ moment: moment(2000, 1, 1, 12, minute) })));
    }
    expect(seen.size).toBe(3);
  });

  it("23 時台なら代替の 2 通りが並ぶ", () => {
    const text = formatFourPillarsText(
      calculateFourPillars({
        moment: moment(2000, 1, 1, 23, 30),
        sun_longitude: SAMPLE_SUN_LONGITUDE,
        term: SAMPLE_TERM,
      }),
    );
    expect(text).toContain("23 時台の生まれです。既定は日界 0 時。ほかの規約なら:");
    expect(text).toContain("日界23時");
    expect(text).toContain("日柱 己未／時柱 甲子");
    expect(text).toContain("夜子時");
    expect(text).toContain("日柱 戊午／時柱 甲子");
    expect(text).toContain("代替の年柱・月柱は出していません");
  });

  it("節入りを渡さなければ節入りの行は出ず、起運は不明と書く", () => {
    const text = formatFourPillarsText(
      calculateFourPillars({
        moment: moment(2000, 1, 1, 12, 0),
        sun_longitude: SAMPLE_SUN_LONGITUDE,
      }),
    );
    expect(text).not.toContain("節入り:");
    expect(text).toContain("起運は不明（節入りまでの日数が渡されていません）");
  });
});

describe("流年・月運・日運のテキスト整形", () => {
  it("見た日付・日主・柱ごとの一覧・立った関係が並ぶ", () => {
    const text = formatDateFortuneText(
      calculateDateFortune(sample(), {
        moment: moment(2026, 8, 22, 12, 0),
        sun_longitude: 149.6,
        include_hour: true,
      }),
    );
    expect(text.split("\n")[0]).toBe("■ 流年・月運・日運（2026-08-22 12:00）");
    expect(text).toContain("日主 戊 から見た値です");
    expect(text).toContain("流年");
    expect(text).toContain("丙午");
    expect(text).toContain("月柱と六沖（子午）");
    expect(text).toContain("蔵干 丁/己");
    expect(text).toContain("規約: 流年は立春切替");
  });

  it("関係が 1 つも立たなければそう書く", () => {
    // 命式（己卯年 丙子月 戊午日 戊午時）と何も合わない日を選ぶ
    const fortune = calculateDateFortune(sample(), {
      moment: moment(2026, 8, 22, 12, 0),
      sun_longitude: 149.6,
    });
    // こちらは六沖が 1 つ立つので、立たない側は作り物で確かめる
    expect(fortune.relations.length).toBe(1);
    const empty = { ...fortune, relations: [] };
    expect(formatDateFortuneText(empty)).toContain(
      "命式との天干五合・六合・六沖は立っていません",
    );
  });

  it("時刻を渡さなければ日付だけを書く", () => {
    const text = formatDateFortuneText(
      calculateDateFortune(sample(), {
        moment: moment(2026, 8, 22, 12, 0),
        sun_longitude: 149.6,
      }),
    );
    expect(text.split("\n")[0]).toBe("■ 流年・月運・日運（2026-08-22）");
    expect(text).not.toContain("時運");
  });
});

// ---------------------------------------------------------------------------
// 受け付けない引数
// ---------------------------------------------------------------------------

describe("受け付けない引数", () => {
  const base = { sun_longitude: SAMPLE_SUN_LONGITUDE };
  const cases: { label: string; input: FourPillarsInput; hit: string }[] = [
    {
      label: "存在しない日付（2 月 31 日）",
      input: { ...base, moment: moment(2000, 2, 31) },
      hit: "暦に存在しない日付です",
    },
    {
      label: "月が 13",
      input: { ...base, moment: moment(2000, 13, 1) },
      hit: "月は 1〜12",
    },
    {
      label: "小数の日",
      input: { ...base, moment: moment(2000, 1, 1.5) },
      hit: "整数で指定してください",
    },
    {
      label: "時が 24",
      input: { ...base, moment: moment(2000, 1, 1, 24) },
      hit: "時は 0〜23",
    },
    {
      label: "分が 60",
      input: { ...base, moment: moment(2000, 1, 1, 0, 60) },
      hit: "分は 0〜59",
    },
    {
      label: "時差が桁違い",
      input: { ...base, moment: moment(2000, 1, 1, 0, 0, 90) },
      hit: "時差は -14〜14",
    },
    {
      label: "太陽黄経が数でない",
      input: { moment: moment(2000, 1, 1), sun_longitude: Number.NaN },
      hit: "太陽黄経は数値で",
    },
  ];

  for (const entry of cases) {
    it(entry.label, () => {
      expect(() => calculateFourPillars(entry.input)).toThrow(FourPillarsError);
      expect(() => calculateFourPillars(entry.input)).toThrow(entry.hit);
    });
  }

  it("うるう年の 2 月 29 日は通る", () => {
    expect(() =>
      calculateFourPillars({ ...base, moment: moment(2000, 2, 29), sun_longitude: 340 }),
    ).not.toThrow();
    expect(() =>
      calculateFourPillars({ ...base, moment: moment(1999, 2, 29), sun_longitude: 340 }),
    ).toThrow(FourPillarsError);
  });

  it("対象日の打ち間違いも弾く", () => {
    expect(() =>
      calculateDateFortune(sample(), {
        moment: moment(2026, 4, 31),
        sun_longitude: 40,
      }),
    ).toThrow("対象日の 2026-04-31");
  });
});

// ---------------------------------------------------------------------------
// 通しの見張り
// ---------------------------------------------------------------------------

describe("通しの見張り", () => {
  it("いろいろな日時で、命式の中身がそろって矛盾しない", () => {
    const days: [number, number, number][] = [
      [1930, 2, 4],
      [1959, 3, 6],
      [2023, 3, 14], // Claude の公開日（人の誕生日と紛れない日付を見本に使う）
      [1999, 8, 8],
      [2000, 2, 29],
      [2011, 6, 15],
      [2026, 8, 22],
    ];
    let checked = 0;
    for (const [year, month, day] of days) {
      for (const hour of [0, 5, 11, 17, 23]) {
        // 黄経は暦とずれていても構わない（純関数の筋を見るだけ）。30 の倍数ちょうどは避ける
        const sunLon = ((month - 1) * 30 + day + 315) % 360;
        const result = calculateFourPillars({
          moment: moment(year, month, day, hour, 30),
          sun_longitude: sunLon,
          term: { days_since_previous: 12.3, days_until_next: 17.7 },
        });
        const dayStem = result.day_master.stem;
        for (const pillar of orderedPillars(result.pillars)) {
          // 天干・地支・干支がそろっている
          expect(pillar.ganzhi).toBe(`${pillar.stem}${pillar.branch}`);
          // 通変星は日干から（日柱だけ「日主」）
          expect(pillar.ten_god).toBe(
            pillar.label === "日柱" ? "日主" : tenGod(dayStem, pillar.stem),
          );
          expect(pillar.twelve_stage).toBe(twelveStage(dayStem, pillar.branch));
          expect(pillar.hidden_ten_god).toBe(pillar.hidden_stems[0]?.ten_god);
          expect(pillar.is_void).toBe(result.void.branches.includes(pillar.branch));
          expect(pillar.branch_element).toBe(branchElement(pillar.branch));
        }
        // 大運は順逆それぞれ 10 柱、月柱から 1 つずつ離れていく
        const monthIndex = ganzhiIndexOf(result.pillars.month.ganzhi);
        result.luck_cycles.forward.pillars.forEach((pillar, offset) => {
          expect(ganzhiIndexOf(pillar.ganzhi)).toBe((monthIndex + offset + 1) % 60);
        });
        result.luck_cycles.backward.pillars.forEach((pillar, offset) => {
          expect(ganzhiIndexOf(pillar.ganzhi)).toBe((monthIndex - offset - 1 + 60) % 60);
        });
        // 23 時台のときだけ代替が付く
        expect(result.alternatives === undefined).toBe(hour !== 23);
        // テキストに出生の年は出ない
        expect(formatFourPillarsText(result)).not.toContain(String(year));
        checked++;
      }
    }
    expect(checked).toBe(35);
  });
});
