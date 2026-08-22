import { describe, expect, it } from "vitest";
import {
  DICE_HOUSES,
  DICE_PLANETS,
  DICE_SIGNS,
  DiceError,
  MAX_DICE_COUNT,
  formatAstroDiceText,
  rollAstroDice,
} from "../src/astro-dice";
import type { RandomSource } from "../src/random";

/** 常に下限を返す乱数源（＝どのダイスも 1 面目） */
const alwaysZero: RandomSource = { int: () => 0 };
/** 常に上限を返す乱数源（＝どのダイスも 12 面目） */
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

describe("ダイスの面", () => {
  it("天体・星座・ハウスとも 12 面ある", () => {
    expect(DICE_PLANETS).toHaveLength(12);
    expect(DICE_SIGNS).toHaveLength(12);
    expect(DICE_HOUSES).toHaveLength(12);
  });

  it("天体は名前・記号・英名がすべて一意", () => {
    expect(new Set(DICE_PLANETS.map((planet) => planet.name)).size).toBe(12);
    expect(new Set(DICE_PLANETS.map((planet) => planet.symbol)).size).toBe(12);
    expect(new Set(DICE_PLANETS.map((planet) => planet.name_en)).size).toBe(12);
  });

  it("星座は名前・記号・英名がすべて一意", () => {
    expect(new Set(DICE_SIGNS.map((sign) => sign.name)).size).toBe(12);
    expect(new Set(DICE_SIGNS.map((sign) => sign.symbol)).size).toBe(12);
    expect(new Set(DICE_SIGNS.map((sign) => sign.name_en)).size).toBe(12);
  });

  it("ハウスは 1〜12 の通し番号で、名前が番号と揃っている", () => {
    expect(DICE_HOUSES.map((house) => house.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    for (const house of DICE_HOUSES) {
      expect(house.name).toBe(`第${house.number}ハウス`);
    }
  });

  it("天体は 10 天体＋ノード 2 つ、星座は牡羊座から魚座まで", () => {
    expect(DICE_PLANETS[0]).toEqual({ name: "太陽", symbol: "☉", name_en: "Sun" });
    expect(DICE_PLANETS[9]).toEqual({ name: "冥王星", symbol: "♇", name_en: "Pluto" });
    expect(DICE_PLANETS[10]).toEqual({
      name: "ノースノード",
      symbol: "☊",
      name_en: "North Node",
    });
    expect(DICE_PLANETS[11]).toEqual({
      name: "サウスノード",
      symbol: "☋",
      name_en: "South Node",
    });
    expect(DICE_SIGNS[0]).toEqual({ name: "牡羊座", symbol: "♈", name_en: "Aries" });
    expect(DICE_SIGNS[11]).toEqual({ name: "魚座", symbol: "♓", name_en: "Pisces" });
  });

  it("記号は星座記号の並び（U+2648 から）に沿っている", () => {
    DICE_SIGNS.forEach((sign, index) => {
      expect(sign.symbol).toBe(String.fromCodePoint(0x2648 + index));
    });
  });
});

describe("振る", () => {
  it("偽の乱数源で決まった面が出る（下限＝各ダイスの 1 面目）", () => {
    const rolls = rollAstroDice(1, alwaysZero);
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toEqual({
      planet: { name: "太陽", symbol: "☉", name_en: "Sun" },
      sign: { name: "牡羊座", symbol: "♈", name_en: "Aries" },
      house: { number: 1, name: "第1ハウス" },
    });
  });

  it("偽の乱数源で決まった面が出る（上限＝各ダイスの 12 面目）", () => {
    const rolls = rollAstroDice(1, alwaysMax);
    expect(rolls[0]).toEqual({
      planet: { name: "サウスノード", symbol: "☋", name_en: "South Node" },
      sign: { name: "魚座", symbol: "♓", name_en: "Pisces" },
      house: { number: 12, name: "第12ハウス" },
    });
  });

  it("ダイスは天体・星座・ハウスの順に 1 個ずつ独立に振る", () => {
    // 出目は 0 始まり。太陽(0) × 牡羊座(0) × 第7ハウス(6)
    const rolls = rollAstroDice(1, scripted([0, 0, 6]));
    expect(rolls[0]?.planet.name).toBe("太陽");
    expect(rolls[0]?.sign.name).toBe("牡羊座");
    expect(rolls[0]?.house.number).toBe(7);
  });

  it("count を省くと 1 組", () => {
    expect(rollAstroDice(undefined, alwaysZero)).toHaveLength(1);
    expect(rollAstroDice(1, alwaysZero)).toHaveLength(1);
  });

  it("count 1〜3 で組数が合い、1 組につきダイスを 3 個振る", () => {
    for (let count = 1; count <= MAX_DICE_COUNT; count++) {
      let throws = 0;
      const counting: RandomSource = {
        int(max) {
          throws++;
          return alwaysZero.int(max);
        },
      };
      expect(rollAstroDice(count, counting)).toHaveLength(count);
      expect(throws).toBe(count * 3);
    }
  });

  it("組ごとに別の目が出る（同じ組を焼き回さない）", () => {
    // 2 組ぶんの出目を並べる: 月(1)×牡牛座(1)×第2ハウス(1)、火星(4)×獅子座(4)×第5ハウス(4)
    const rolls = rollAstroDice(2, scripted([1, 1, 1, 4, 4, 4]));
    expect(rolls[0]?.planet.name).toBe("月");
    expect(rolls[1]?.planet.name).toBe("火星");
    expect(rolls[1]?.sign.name).toBe("獅子座");
    expect(rolls[1]?.house.number).toBe(5);
  });

  it("count が範囲外・整数でなければ DiceError", () => {
    for (const count of [0, -1, MAX_DICE_COUNT + 1, 1.5, Number.NaN]) {
      expect(() => rollAstroDice(count, alwaysZero)).toThrow(DiceError);
    }
    expect(() => rollAstroDice(0, alwaysZero)).toThrow("count は 1 〜 3 の整数にしてください");
  });

  it("素の乱数源でも 12 面の中からしか出ない", () => {
    for (let i = 0; i < 50; i++) {
      const roll = rollAstroDice(1)[0]!;
      expect(DICE_PLANETS).toContainEqual(roll.planet);
      expect(DICE_SIGNS).toContainEqual(roll.sign);
      expect(DICE_HOUSES).toContainEqual(roll.house);
    }
  });
});

describe("テキスト整形", () => {
  it("1 組は見出し＋1 行", () => {
    const rolls = rollAstroDice(1, scripted([0, 0, 6]));
    expect(formatAstroDiceText(rolls)).toBe(
      ["アストロダイス / 1組", "1. ☉ 太陽 × ♈ 牡羊座 × 第7ハウス"].join("\n"),
    );
  });

  it("複数組は 1. 2. 3. と続く", () => {
    const rolls = rollAstroDice(3, scripted([0, 0, 0, 1, 1, 1, 11, 11, 11]));
    expect(formatAstroDiceText(rolls)).toBe(
      [
        "アストロダイス / 3組",
        "1. ☉ 太陽 × ♈ 牡羊座 × 第1ハウス",
        "2. ☽ 月 × ♉ 牡牛座 × 第2ハウス",
        "3. ☋ サウスノード × ♓ 魚座 × 第12ハウス",
      ].join("\n"),
    );
  });

  it("意味テキストのたぐいは載らない（行数は組数＋1 で固定）", () => {
    const rolls = rollAstroDice(2, alwaysMax);
    const lines = formatAstroDiceText(rolls).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("アストロダイス / 2組");
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^\d\. . .+ × . .+ × 第\d+ハウス$/u);
    }
  });
});
