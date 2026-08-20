import { describe, expect, it } from "vitest";
import { randomInt, shuffle, weightedPick, type RandomSource } from "../src/random";

/** 常に下限を返す乱数源 */
const alwaysZero: RandomSource = { int: () => 0 };
/** 常に上限（maxExclusive - 1）を返す乱数源 */
const alwaysMax: RandomSource = { int: (max) => max - 1 };

describe("randomInt", () => {
  it("0 以上 maxExclusive 未満に収まる", () => {
    for (let i = 0; i < 2000; i++) {
      const value = randomInt(7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it("maxExclusive が 1 なら必ず 0", () => {
    for (let i = 0; i < 50; i++) {
      expect(randomInt(1)).toBe(0);
    }
  });

  it("1 未満や非整数は撥ねる", () => {
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-3)).toThrow(RangeError);
    expect(() => randomInt(1.5)).toThrow(RangeError);
  });

  it("極端に偏らない（緩い検定）", () => {
    const buckets = [0, 0, 0, 0, 0, 0];
    const trials = 12000;
    for (let i = 0; i < trials; i++) {
      buckets[randomInt(6)] += 1;
    }
    const expected = trials / 6; // 2000
    for (const count of buckets) {
      // 期待値の ±25% に入っていれば良しとする
      expect(count).toBeGreaterThan(expected * 0.75);
      expect(count).toBeLessThan(expected * 1.25);
    }
  });
});

describe("shuffle", () => {
  it("元の配列を壊さず、中身の多重集合も変わらない", () => {
    const source = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = shuffle(source);
    expect(source).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shuffled).toHaveLength(source.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(source);
  });

  it("乱数源が常に 0 を返すなら決まった並びになる", () => {
    // Fisher-Yates で j が常に 0 なら「先頭と末尾から順に入れ替える」動きになる
    expect(shuffle(["a", "b", "c"], alwaysZero)).toEqual(["b", "c", "a"]);
  });

  it("何度か回せば並びが変わる（同じ結果ばかりにならない）", () => {
    const source = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const patterns = new Set<string>();
    for (let i = 0; i < 50; i++) {
      patterns.add(shuffle(source).join(","));
    }
    expect(patterns.size).toBeGreaterThan(1);
  });
});

describe("weightedPick", () => {
  const entries = [
    { value: "a", weight: 92 },
    { value: "b", weight: 6.5 },
    { value: "c", weight: 3 },
    { value: "d", weight: 1 },
  ];

  it("下限の目なら先頭、上限の目なら末尾", () => {
    expect(weightedPick(entries, alwaysZero)).toBe("a");
    expect(weightedPick(entries, alwaysMax)).toBe("d");
  });

  it("重みの大きい候補がいちばん多く出る", () => {
    const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    for (let i = 0; i < 4000; i++) {
      counts[weightedPick(entries)] += 1;
    }
    expect(counts["a"]).toBeGreaterThan(counts["b"]);
    expect(counts["b"]).toBeGreaterThan(counts["d"]);
    // 92 / 102.5 ≒ 89.8%
    expect(counts["a"] / 4000).toBeGreaterThan(0.85);
    expect(counts["a"] / 4000).toBeLessThan(0.95);
  });

  it("空の候補は撥ねる", () => {
    expect(() => weightedPick([])).toThrow(RangeError);
  });
});
