/**
 * サビアン度数（src/sabian.ts）の検算。
 *
 * 見ているのは**境の数え方**だけです ―― 切り上げ規約なので「0 度」は無く、
 * 星座の頭（0°00′）が 1 度、尻尾（29°59′）が 30 度になります。
 * 普段の度数表示（`formatDegree` の「牡牛座 14°30′」）と 1 ずれるのはこの規約のせいで、
 * ずれているのではなく**そういう数え方**だというのを、ここで固定しておきます。
 *
 * シンボルの文言は持たないので、確かめるのも数と札だけです。
 */
import { describe, expect, it } from "vitest";
import { SABIAN_CONVENTION, sabianDegreeOf } from "../src/sabian";
import { SIGNS } from "../src/astro/chart";

describe("サビアン度数の境", () => {
  it.each([
    { lon: 0, sign: "牡羊座", degree: 1, serial: 1 },
    { lon: 0.99, sign: "牡羊座", degree: 1, serial: 1 },
    { lon: 1.0, sign: "牡羊座", degree: 2, serial: 2 },
    { lon: 29.99, sign: "牡羊座", degree: 30, serial: 30 },
    { lon: 30, sign: "牡牛座", degree: 1, serial: 31 },
    { lon: 44.5, sign: "牡牛座", degree: 15, serial: 45 },
    { lon: 359.99, sign: "魚座", degree: 30, serial: 360 },
  ])("$lon° → $sign $degree 度（通し $serial）", ({ lon, sign, degree, serial }) => {
    const result = sabianDegreeOf(lon);
    expect(result.sign).toBe(sign);
    expect(result.degree).toBe(degree);
    expect(result.serial).toBe(serial);
    expect(result.sign_index).toBe(SIGNS.indexOf(sign));
    expect(result.label).toBe(`${sign} ${degree} 度`);
  });

  it("0 度は無い（切り上げなので 1〜30 の 30 通り）", () => {
    for (let lon = 0; lon < 360; lon += 0.25) {
      const { degree } = sabianDegreeOf(lon);
      expect(degree).toBeGreaterThanOrEqual(1);
      expect(degree).toBeLessThanOrEqual(30);
    }
  });

  it("通し番号は 1〜360 を漏れも重なりも無く埋める", () => {
    const seen = new Set<number>();
    // 各度数の真ん中（0.5° ずつ）で引けば、360 個ちょうど揃うはず
    for (let index = 0; index < 360; index++) {
      seen.add(sabianDegreeOf(index + 0.5).serial);
    }
    expect(seen.size).toBe(360);
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(360);
  });

  it("通し番号は sign_index × 30 ＋ degree", () => {
    for (const lon of [0, 17.25, 123.4, 271.9, 359.999]) {
      const result = sabianDegreeOf(lon);
      expect(result.serial).toBe(result.sign_index * 30 + result.degree);
    }
  });
});

describe("範囲の外の黄経", () => {
  it("−1° は 359° と同じ（魚座 30 度）", () => {
    expect(sabianDegreeOf(-1)).toEqual(sabianDegreeOf(359));
    expect(sabianDegreeOf(-1).label).toBe("魚座 30 度");
  });

  it("360° は 0° と同じ（牡羊座 1 度）", () => {
    expect(sabianDegreeOf(360)).toEqual(sabianDegreeOf(0));
    expect(sabianDegreeOf(360).label).toBe("牡羊座 1 度");
  });

  it("720° / −360° のような何周ぶんでも畳める", () => {
    expect(sabianDegreeOf(720 + 44.5).serial).toBe(45);
    expect(sabianDegreeOf(-360 + 44.5).serial).toBe(45);
  });

  it("浮動小数の埃で 13 星座目に落ちない", () => {
    // normalizeDegree が 359.9999… を 360 に丸めてしまうと sign_index が 12 になる
    for (const lon of [-1e-15, 359.9999999999999, 360 - 1e-13]) {
      const result = sabianDegreeOf(lon);
      expect(result.sign_index).toBeGreaterThanOrEqual(0);
      expect(result.sign_index).toBeLessThanOrEqual(11);
      expect(result.sign).toBe(SIGNS[result.sign_index]);
    }
  });
});

describe("規約", () => {
  it("名前で固定して持っている（切り上げ・シンボルは載せない）", () => {
    expect(SABIAN_CONVENTION.rounding).toBe("ceil");
    expect(SABIAN_CONVENTION.rounding_label).toContain("切り上げ");
    expect(SABIAN_CONVENTION.symbols).toContain("載せない");
  });
});
