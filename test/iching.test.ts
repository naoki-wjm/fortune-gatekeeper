import { describe, expect, it } from "vitest";
import {
  HEXAGRAMS,
  TRIGRAMS,
  hexagramByBits,
  hexagramByNumber,
  trigramByBits,
  trigramByNumber,
} from "../src/hexagrams";
import {
  CastError,
  castHexagram,
  formatCastResult,
  type CastResult,
  type LineValue,
} from "../src/iching";
import type { RandomSource } from "../src/random";

/** 常に下限を返す乱数源 */
const alwaysZero: RandomSource = { int: () => 0 };
/** 常に上限を返す乱数源 */
const alwaysMax: RandomSource = { int: (max) => max - 1 };

/** 決め打ちの出目を順に返す乱数源（足りない・範囲外はその場で落とす） */
function scripted(values: readonly number[]): RandomSource {
  let index = 0;
  return {
    int(maxExclusive: number): number {
      const value = values[index++];
      if (value === undefined) throw new Error(`出目が足りません（${index} 個目）`);
      if (value < 0 || value >= maxExclusive) {
        throw new Error(`出目 ${value} が範囲外です（0 以上 ${maxExclusive} 未満）`);
      }
      return value;
    },
  };
}

/** 上下の八卦の名前から卦を探す（表の整合を確かめる用） */
function byTrigrams(upper: string, lower: string) {
  return HEXAGRAMS.find(
    (hexagram) => hexagram.upper.name === upper && hexagram.lower.name === lower,
  );
}

/** 6 爻をひっくり返す（綜卦）。ビット列の上下反転 */
function reverseBits(bits: number): number {
  let reversed = 0;
  for (let i = 0; i < 6; i++) if ((bits >> i) & 1) reversed |= 1 << (5 - i);
  return reversed;
}

describe("八卦の表", () => {
  it("8 つあり、先天八卦の順（乾1・兌2・離3・震4・巽5・坎6・艮7・坤8）に並んでいる", () => {
    expect(TRIGRAMS).toHaveLength(8);
    expect(TRIGRAMS.map((trigram) => trigram.name)).toEqual([
      "乾",
      "兌",
      "離",
      "震",
      "巽",
      "坎",
      "艮",
      "坤",
    ]);
    expect(TRIGRAMS.map((trigram) => trigram.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(TRIGRAMS.map((trigram) => trigram.nature)).toEqual([
      "天",
      "沢",
      "火",
      "雷",
      "風",
      "水",
      "山",
      "地",
    ]);
  });

  it("記号は U+2630 から先天八卦の順に並ぶ", () => {
    for (const trigram of TRIGRAMS) {
      expect(trigram.symbol).toBe(String.fromCodePoint(0x2630 + trigram.number - 1));
    }
  });

  it("ビット列は 0〜7 が一意（初爻が bit0・陽=1）", () => {
    expect(new Set(TRIGRAMS.map((trigram) => trigram.bits)).size).toBe(8);
    // 乾＝三本とも陽、坤＝三本とも陰、震＝初爻だけ陽、艮＝上爻だけ陽
    expect(trigramByNumber(1).bits).toBe(0b111);
    expect(trigramByNumber(8).bits).toBe(0b000);
    expect(trigramByNumber(4).bits).toBe(0b001);
    expect(trigramByNumber(7).bits).toBe(0b100);
    for (let bits = 0; bits < 8; bits++) {
      expect(trigramByBits(bits).bits).toBe(bits);
    }
  });

  it("範囲外は例外", () => {
    expect(() => trigramByNumber(0)).toThrow(RangeError);
    expect(() => trigramByNumber(9)).toThrow(RangeError);
    expect(() => trigramByBits(8)).toThrow(RangeError);
  });
});

describe("六十四卦の表", () => {
  it("64 個あり、番号 1〜64 が一意で並び順どおり", () => {
    expect(HEXAGRAMS).toHaveLength(64);
    expect(HEXAGRAMS.map((hexagram) => hexagram.number)).toEqual(
      Array.from({ length: 64 }, (_, i) => i + 1),
    );
    expect(new Set(HEXAGRAMS.map((hexagram) => hexagram.name)).size).toBe(64);
  });

  it("記号は U+4DC0+(番号-1)", () => {
    for (const hexagram of HEXAGRAMS) {
      expect(hexagram.symbol).toBe(String.fromCodePoint(0x4dc0 + hexagram.number - 1));
    }
    expect(hexagramByNumber(1)!.symbol).toBe("䷀");
    expect(hexagramByNumber(3)!.symbol).toBe("䷂");
    expect(hexagramByNumber(64)!.symbol).toBe("䷿");
  });

  it("卦象（上下の八卦の組み合わせ）が 0〜63 を一通り埋める", () => {
    const bits = HEXAGRAMS.map((hexagram) => hexagram.bits);
    expect(new Set(bits).size).toBe(64);
    expect([...bits].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));
    for (const hexagram of HEXAGRAMS) {
      expect(hexagramByBits(hexagram.bits)).toBe(hexagram);
      expect(hexagram.bits).toBe(hexagram.lower.bits | (hexagram.upper.bits << 3));
    }
  });

  it("上下の八卦と卦名・番号が合っている", () => {
    expect(byTrigrams("坎", "震")).toMatchObject({ number: 3, name: "水雷屯" });
    expect(byTrigrams("乾", "乾")).toMatchObject({ number: 1, name: "乾為天" });
    expect(byTrigrams("坤", "坤")).toMatchObject({ number: 2, name: "坤為地" });
    expect(byTrigrams("坤", "乾")).toMatchObject({ number: 11, name: "地天泰" });
    expect(byTrigrams("乾", "坤")).toMatchObject({ number: 12, name: "天地否" });
    expect(byTrigrams("坎", "離")).toMatchObject({ number: 63, name: "水火既済" });
    expect(byTrigrams("離", "坎")).toMatchObject({ number: 64, name: "火水未済" });
    // 八純卦は「◯為△」の形（上下が同じ八卦）
    for (const hexagram of HEXAGRAMS) {
      if (hexagram.upper === hexagram.lower) {
        expect(hexagram.name).toBe(`${hexagram.upper.name}為${hexagram.upper.nature}`);
      }
    }
  });

  it("序卦は 2 つずつ対（綜卦、ひっくり返して同じなら錯卦）になっている", () => {
    // 表の写し間違いをまとめて捕まえるための構造テスト
    for (let i = 0; i < 64; i += 2) {
      const odd = HEXAGRAMS[i]!;
      const even = HEXAGRAMS[i + 1]!;
      const flipped = reverseBits(odd.bits);
      const expected = flipped === odd.bits ? ~odd.bits & 0b111111 : flipped;
      expect({ pair: `${odd.name}↔${even.name}`, bits: even.bits }).toEqual({
        pair: `${odd.name}↔${even.name}`,
        bits: expected,
      });
    }
  });

  it("卦名は「沢」で統一（旧字の「澤」は使わない）", () => {
    for (const hexagram of HEXAGRAMS) {
      expect(hexagram.name).not.toContain("澤");
    }
    expect(HEXAGRAMS.filter((hexagram) => hexagram.name.includes("沢")).length).toBeGreaterThan(0);
  });
});

describe("castHexagram（擲銭法）", () => {
  it("裏だけなら六爻すべて老陰＝坤為地、之卦は乾為天", () => {
    const result = castHexagram({ method: "coins" }, alwaysZero);
    expect(result.method).toEqual({ id: "coins", name: "擲銭法" });
    expect(result.lines).toHaveLength(6);
    expect(result.lines.map((line) => line.value)).toEqual([6, 6, 6, 6, 6, 6]);
    expect(result.lines.map((line) => line.coins)).toEqual(Array(6).fill([2, 2, 2]));
    expect(result.lines.every((line) => line.yin_yang === "yin" && line.changing)).toBe(true);
    expect(result.primary).toMatchObject({ number: 2, name: "坤為地" });
    expect(result.changing_lines).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.resulting).toMatchObject({ number: 1, name: "乾為天" });
    expect(result.nuclear).toMatchObject({ number: 2, name: "坤為地" });
  });

  it("表だけなら六爻すべて老陽＝乾為天、之卦は坤為地", () => {
    const result = castHexagram({ method: "coins" }, alwaysMax);
    expect(result.lines.map((line) => line.value)).toEqual([9, 9, 9, 9, 9, 9]);
    expect(result.lines.map((line) => line.coins)).toEqual(Array(6).fill([3, 3, 3]));
    expect(result.primary).toMatchObject({ number: 1, name: "乾為天" });
    expect(result.resulting).toMatchObject({ number: 2, name: "坤為地" });
    expect(result.nuclear).toMatchObject({ number: 1, name: "乾為天" });
  });

  it("既定の method は擲銭法", () => {
    expect(castHexagram({}, alwaysZero).method.id).toBe("coins");
    expect(castHexagram(undefined, alwaysZero).method.id).toBe("coins");
  });

  // 初爻だけ老陽、あとは少陰と少陽 → 水雷屯（第3卦）
  const TUN_COINS = [1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0];

  it("爻の値・伝統表記・変爻・之卦・互卦が揃う（水雷屯）", () => {
    const result = castHexagram({ method: "coins" }, scripted(TUN_COINS));
    expect(result.lines.map((line) => line.value)).toEqual([9, 8, 8, 8, 7, 8]);
    expect(result.lines.map((line) => line.label)).toEqual([
      "初九",
      "六二",
      "六三",
      "六四",
      "九五",
      "上六",
    ]);
    expect(result.lines.map((line) => line.yin_yang)).toEqual([
      "yang",
      "yin",
      "yin",
      "yin",
      "yang",
      "yin",
    ]);
    expect(result.lines.map((line) => line.changing)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(result.primary).toMatchObject({
      number: 3,
      name: "水雷屯",
      symbol: "䷂",
      upper: { number: 6, name: "坎", nature: "水", symbol: "☵" },
      lower: { number: 4, name: "震", nature: "雷", symbol: "☳" },
    });
    expect(result.changing_lines).toEqual([1]);
    // 初爻を陽から陰に返すと水地比
    expect(result.resulting).toMatchObject({ number: 8, name: "水地比" });
    // 2・3・4 爻が坤、3・4・5 爻が艮 → 山地剝
    expect(result.nuclear).toMatchObject({ number: 23, name: "山地剝" });
  });

  it("変爻が無ければ changing_lines は空・resulting は null", () => {
    // 少陰（表2枚＋裏1枚）を 6 回
    const result = castHexagram({ method: "coins" }, scripted(Array(6).fill([1, 1, 0]).flat()));
    expect(result.lines.map((line) => line.value)).toEqual([8, 8, 8, 8, 8, 8]);
    expect(result.changing_lines).toEqual([]);
    expect(result.resulting).toBeNull();
    expect(result.primary).toMatchObject({ number: 2, name: "坤為地" });
  });

  it("cast_at は ISO 8601、abridged は付かない", () => {
    const result = castHexagram({ method: "coins" });
    expect(result.cast_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.abridged).toBeUndefined();
    expect(result.lines.every((line) => line.yarrow === undefined)).toBe(true);
  });

  it("6/7/8/9 が 1:3:3:1（実乱数の粗い分布）", () => {
    const counts: Record<number, number> = { 6: 0, 7: 0, 8: 0, 9: 0 };
    const casts = 2000;
    for (let i = 0; i < casts; i++) {
      for (const line of castHexagram({ method: "coins" }).lines) counts[line.value]!++;
    }
    const total = casts * 6;
    const expectedRatio: Record<number, number> = { 6: 1 / 8, 7: 3 / 8, 8: 3 / 8, 9: 1 / 8 };
    for (const value of [6, 7, 8, 9]) {
      expect(counts[value]! / total).toBeCloseTo(expectedRatio[value]!, 1);
    }
  });
});

describe("castHexagram（本筮法）", () => {
  it("三変の過程（除いた本数と残り）を返す", () => {
    const zero = castHexagram({ method: "yarrow" }, alwaysZero);
    expect(zero.method).toEqual({ id: "yarrow", name: "本筮法" });
    expect(zero.lines.map((line) => line.yarrow)).toEqual(
      Array(6).fill({ removed: [5, 4, 4], remaining: 36 }),
    );
    expect(zero.lines.map((line) => line.value)).toEqual([9, 9, 9, 9, 9, 9]);
    expect(zero.primary).toMatchObject({ number: 1, name: "乾為天" });
    expect(zero.resulting).toMatchObject({ number: 2, name: "坤為地" });

    const max = castHexagram({ method: "yarrow" }, alwaysMax);
    expect(max.lines.map((line) => line.yarrow)).toEqual(
      Array(6).fill({ removed: [9, 8, 8], remaining: 24 }),
    );
    expect(max.lines.map((line) => line.value)).toEqual([6, 6, 6, 6, 6, 6]);
    expect(max.primary).toMatchObject({ number: 2, name: "坤為地" });
    expect(max.resulting).toMatchObject({ number: 1, name: "乾為天" });
  });

  it("残り本数は必ず 24/28/32/36 で、4 で割ると爻の値になる", () => {
    for (let i = 0; i < 200; i++) {
      for (const line of castHexagram({ method: "yarrow" }).lines) {
        expect(line.yarrow).toBeDefined();
        expect([24, 28, 32, 36]).toContain(line.yarrow!.remaining);
        expect(line.yarrow!.remaining / 4).toBe(line.value);
        // 一変は 5 か 9、二変・三変は 4 か 8
        expect([5, 9]).toContain(line.yarrow!.removed[0]);
        expect([4, 8]).toContain(line.yarrow!.removed[1]);
        expect([4, 8]).toContain(line.yarrow!.removed[2]);
        expect(line.yarrow!.removed.reduce((a, b) => a + b, 0)).toBe(49 - line.yarrow!.remaining);
      }
      expect(castHexagram({ method: "yarrow" }).abridged).toBeUndefined();
    }
  });

  it("老陰1/16・少陽5/16・少陰7/16・老陽3/16（実乱数の粗い分布）", () => {
    // 山を空にできない都合で理論値から数％ずれるので、許容範囲は広めに取る
    const counts: Record<number, number> = { 6: 0, 7: 0, 8: 0, 9: 0 };
    const casts = 3000;
    for (let i = 0; i < casts; i++) {
      for (const line of castHexagram({ method: "yarrow" }).lines) counts[line.value]!++;
    }
    const total = casts * 6;
    const expectedRatio: Record<number, number> = {
      6: 1 / 16,
      7: 5 / 16,
      8: 7 / 16,
      9: 3 / 16,
    };
    for (const value of [6, 7, 8, 9] as LineValue[]) {
      expect(Math.abs(counts[value]! / total - expectedRatio[value]!)).toBeLessThan(0.03);
    }
    // 擲銭法（1:3:3:1）と違って少陰に寄る、が確かめたい形
    expect(counts[8]!).toBeGreaterThan(counts[7]!);
    expect(counts[9]!).toBeGreaterThan(counts[6]!);
  });
});

describe("castHexagram（略筮法）", () => {
  it("変爻はちょうど 1 本", () => {
    for (let i = 0; i < 300; i++) {
      const result = castHexagram({ method: "abridged" });
      expect(result.changing_lines).toHaveLength(1);
      expect(result.resulting).not.toBeNull();
      expect(result.lines.filter((line) => line.changing)).toHaveLength(1);
      // 爻ごとの過程は持たない（過程は卦レベルの abridged に載る）
      expect(result.lines.every((line) => line.coins === undefined)).toBe(true);
      expect(result.lines.every((line) => line.yarrow === undefined)).toBe(true);
      expect(result.abridged).toBeDefined();
    }
  });

  it("下卦・上卦は先天八卦の番号どおり（0 は 8 扱い）", () => {
    for (let number = 1; number <= 8; number++) {
      // countStalks = 1 + int(48) なので、本数 n を出すには n-1 を仕込む
      const result = castHexagram({ method: "abridged" }, scripted([number - 1, number - 1, 0]));
      const trigram = trigramByNumber(number);
      expect(result.primary.lower).toMatchObject({ number, name: trigram.name });
      expect(result.primary.upper).toMatchObject({ number, name: trigram.name });
      expect(result.abridged!.lower).toEqual({ stalks: number, number });
      expect(result.abridged!.upper).toEqual({ stalks: number, number });
    }
    // 48 本は 8 で割り切れるので坤（8番）、6 でも割り切れるので上爻
    const wrapped = castHexagram({ method: "abridged" }, scripted([47, 47, 47]));
    expect(wrapped.abridged).toEqual({
      lower: { stalks: 48, number: 8 },
      upper: { stalks: 48, number: 8 },
      changing: { stalks: 48, position: 6 },
    });
    expect(wrapped.primary).toMatchObject({ number: 2, name: "坤為地" });
    expect(wrapped.changing_lines).toEqual([6]);
    // 上爻だけ陽に返ると山地剝
    expect(wrapped.resulting).toMatchObject({ number: 23, name: "山地剝" });
  });

  it("変爻だけ老（9 / 6）、ほかは少（7 / 8）になる（水雷屯・初爻）", () => {
    // 下卦 4=震、上卦 6=坎、変爻 1=初爻
    const result = castHexagram({ method: "abridged" }, scripted([3, 5, 0]));
    expect(result.method).toEqual({ id: "abridged", name: "略筮法" });
    expect(result.primary).toMatchObject({ number: 3, name: "水雷屯" });
    expect(result.lines.map((line) => line.value)).toEqual([9, 8, 8, 8, 7, 8]);
    expect(result.changing_lines).toEqual([1]);
    expect(result.resulting).toMatchObject({ number: 8, name: "水地比" });
    expect(result.nuclear).toMatchObject({ number: 23, name: "山地剝" });
    expect(result.abridged).toEqual({
      lower: { stalks: 4, number: 4 },
      upper: { stalks: 6, number: 6 },
      changing: { stalks: 1, position: 1 },
    });
  });

  it("乾為天の初爻が動けば天風姤", () => {
    const result = castHexagram({ method: "abridged" }, alwaysZero);
    expect(result.primary).toMatchObject({ number: 1, name: "乾為天" });
    expect(result.lines.map((line) => line.value)).toEqual([9, 7, 7, 7, 7, 7]);
    expect(result.resulting).toMatchObject({ number: 44, name: "天風姤" });
  });
});

describe("castHexagram（共通）", () => {
  it("知らない method は CastError", () => {
    expect(() => castHexagram({ method: "tortoise" })).toThrow(CastError);
    expect(() => castHexagram({ method: "" })).toThrow(CastError);
    expect(() => castHexagram({ method: "COINS" })).toThrow(CastError);
  });

  it("どの立て方でも、之卦は本卦の変爻だけを反転したもの", () => {
    for (const method of ["coins", "yarrow", "abridged"]) {
      for (let i = 0; i < 60; i++) {
        const result = castHexagram({ method });
        const primaryBits = hexagramByBits(
          HEXAGRAMS.find((hexagram) => hexagram.number === result.primary.number)!.bits,
        ).bits;
        let expectedBits = primaryBits;
        for (const position of result.changing_lines) expectedBits ^= 1 << (position - 1);

        if (result.changing_lines.length === 0) {
          expect(result.resulting).toBeNull();
        } else {
          expect(result.resulting!.number).toBe(hexagramByBits(expectedBits).number);
        }

        // 爻の陰陽と label と本卦の卦象が食い違わない
        for (const line of result.lines) {
          const bit = (primaryBits >> (line.position - 1)) & 1;
          expect(line.yin_yang).toBe(bit === 1 ? "yang" : "yin");
          expect(line.label).toContain(bit === 1 ? "九" : "六");
          expect(line.changing).toBe(line.value === 6 || line.value === 9);
        }
      }
    }
  });

  it("互卦は 2・3・4 爻が下卦、3・4・5 爻が上卦", () => {
    for (let i = 0; i < 100; i++) {
      const result = castHexagram({ method: "coins" });
      const bits = HEXAGRAMS.find((hexagram) => hexagram.number === result.primary.number)!.bits;
      const bit = (position: number) => (bits >> (position - 1)) & 1;
      const lower = bit(2) | (bit(3) << 1) | (bit(4) << 2);
      const upper = bit(3) | (bit(4) << 1) | (bit(5) << 2);
      expect(result.nuclear.number).toBe(hexagramByBits(lower | (upper << 3)).number);
    }
  });
});

describe("formatCastResult", () => {
  it("擲銭法・変爻ありの見た目", () => {
    const result = castHexagram(
      { method: "coins" },
      scripted([1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0]),
    );
    expect(formatCastResult(result)).toBe(
      [
        "易（擲銭法）",
        "本卦: 第3卦 水雷屯 ䷂（上: 坎☵ 水 / 下: 震☳ 雷）",
        "爻: 初九（老陽・変） 六二 六三 六四 九五 上六",
        "変爻: 初爻",
        "之卦: 第8卦 水地比 ䷇",
        "互卦: 第23卦 山地剝 ䷖",
        "出目: 3+3+3, 3+3+2, 3+3+2, 3+3+2, 3+2+2, 3+3+2",
      ].join("\n"),
    );
  });

  it("変爻が無ければ「変爻: なし」で、之卦の行を出さない", () => {
    const result = castHexagram({ method: "coins" }, scripted(Array(6).fill([1, 1, 0]).flat()));
    const text = formatCastResult(result);
    expect(text).toBe(
      [
        "易（擲銭法）",
        "本卦: 第2卦 坤為地 ䷁（上: 坤☷ 地 / 下: 坤☷ 地）",
        "爻: 初六 六二 六三 六四 六五 上六",
        "変爻: なし",
        "互卦: 第2卦 坤為地 ䷁",
        "出目: 3+3+2, 3+3+2, 3+3+2, 3+3+2, 3+3+2, 3+3+2",
      ].join("\n"),
    );
    expect(text).not.toContain("之卦");
  });

  it("本筮法は筮竹の本数を末尾 1 行にまとめる", () => {
    const result = castHexagram({ method: "yarrow" }, alwaysZero);
    expect(formatCastResult(result)).toBe(
      [
        "易（本筮法）",
        "本卦: 第1卦 乾為天 ䷀（上: 乾☰ 天 / 下: 乾☰ 天）",
        "爻: 初九（老陽・変） 九二（老陽・変） 九三（老陽・変） 九四（老陽・変） 九五（老陽・変） 上九（老陽・変）",
        "変爻: 初爻・二爻・三爻・四爻・五爻・上爻",
        "之卦: 第2卦 坤為地 ䷁",
        "互卦: 第1卦 乾為天 ䷀",
        "筮竹: 5-4-4→36, 5-4-4→36, 5-4-4→36, 5-4-4→36, 5-4-4→36, 5-4-4→36",
      ].join("\n"),
    );
  });

  it("略筮法は下卦・上卦・変爻の本数を末尾 1 行にまとめる", () => {
    const result = castHexagram({ method: "abridged" }, scripted([3, 5, 0]));
    expect(formatCastResult(result)).toBe(
      [
        "易（略筮法）",
        "本卦: 第3卦 水雷屯 ䷂（上: 坎☵ 水 / 下: 震☳ 雷）",
        "爻: 初九（老陽・変） 六二 六三 六四 九五 上六",
        "変爻: 初爻",
        "之卦: 第8卦 水地比 ䷇",
        "互卦: 第23卦 山地剝 ䷖",
        "筮竹: 下卦 4→4, 上卦 6→6, 変爻 1→1",
      ].join("\n"),
    );
  });

  it("卦辞・爻辞のたぐいは載らない（見出しだけ）", () => {
    const result: CastResult = castHexagram({ method: "coins" });
    const text = formatCastResult(result);
    // 卦名・記号・爻の表記以外は出ない＝行数は固定（変爻の有無で 6 か 7 行）
    const lines = text.split("\n");
    expect(lines.length).toBe(result.changing_lines.length > 0 ? 7 : 6);
    expect(lines[0]).toBe("易（擲銭法）");
    expect(lines[1]).toMatch(/^本卦: 第\d+卦 .+ .（上: .. . \/ 下: .. .）$/u);
    expect(lines[lines.length - 1]).toMatch(/^出目: /);
  });
});
