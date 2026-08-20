import { describe, expect, it } from "vitest";
import {
  CALC_FLAGS,
  anglesOf,
  computeChart,
  computePlanets,
  crossAspects,
  dateFromJulianDay,
  formatCrossAspect,
  formatCuspLine,
  formatDegree,
  formatPlanetLine,
  getAspect,
  getHouse,
  houseSystemName,
  isApplying,
  julianDay,
  mcToArmc,
  normalizeDegree,
  planetName,
  signIndex,
} from "../src/astro/chart";
import { FAKE_CUSPS, makeFakeEngine } from "./stubs/fake-engine";

describe("度数の表記", () => {
  it("0°ちょうどは牡羊座の頭", () => {
    expect(formatDegree(0)).toBe("牡羊座 0°00′");
    expect(signIndex(0)).toBe(0);
  });

  it("29.9° は星座の尻尾（29°54′）", () => {
    expect(formatDegree(29.9)).toBe("牡羊座 29°54′");
    expect(signIndex(29.9)).toBe(0);
  });

  it("30° ちょうどで次の星座に移る", () => {
    expect(formatDegree(30)).toBe("牡牛座 0°00′");
    expect(signIndex(30)).toBe(1);
  });

  it("最後の星座と 360° の折り返し", () => {
    expect(formatDegree(359.75)).toBe("魚座 29°45′");
    expect(signIndex(359.75)).toBe(11);
    // 360° は 0° に畳む（丸めで 12 番目の星座を探しにいかない）
    expect(formatDegree(360)).toBe("牡羊座 0°00′");
    expect(signIndex(360)).toBe(0);
    // 負の値も畳む
    expect(formatDegree(-0.5)).toBe("魚座 29°30′");
    expect(normalizeDegree(-0.5)).toBeCloseTo(359.5, 10);
  });

  it("天体名とハウス方式名", () => {
    expect(planetName(0)).toBe("太陽");
    expect(planetName(11)).toBe("Nノード");
    expect(planetName(99)).toBe("天体99");
    expect(houseSystemName("P")).toBe("プラシーダス");
    expect(houseSystemName("W")).toBe("ホールサイン");
  });

  it("天体 1 行は「名前 星座 度数（在ハウス）（逆行）」", () => {
    expect(formatPlanetLine({ id: 0, lon: 120.5, speed: 1 }, { house: 2 })).toBe(
      "太陽 獅子座 0°30′ (2H)",
    );
    expect(formatPlanetLine({ id: 2, lon: 120.5, speed: -0.2 }, { house: 2 })).toBe(
      "水星 獅子座 0°30′ (2H)（逆行）",
    );
    // ハウスを渡さなければ括弧ごと出ない
    expect(formatPlanetLine({ id: 1, lon: 0, speed: 1 })).toBe("月 牡羊座 0°00′");
  });
});

describe("在ハウスの判定", () => {
  it("カスプの間に落ちる", () => {
    expect(getHouse(95, FAKE_CUSPS)).toBe(1);
    expect(getHouse(119.99, FAKE_CUSPS)).toBe(1);
    expect(getHouse(120, FAKE_CUSPS)).toBe(2);
  });

  it("カスプちょうどはそのハウスの頭", () => {
    expect(getHouse(90, FAKE_CUSPS)).toBe(1);
    expect(getHouse(300, FAKE_CUSPS)).toBe(8);
  });

  it("0° をまたぐハウス（9H = 330°〜0°、10H = 0°〜30°）", () => {
    expect(getHouse(330, FAKE_CUSPS)).toBe(9);
    expect(getHouse(359.9, FAKE_CUSPS)).toBe(9);
    expect(getHouse(0, FAKE_CUSPS)).toBe(10);
    expect(getHouse(29.9, FAKE_CUSPS)).toBe(10);
    expect(getHouse(30, FAKE_CUSPS)).toBe(11);
  });
});

describe("アスペクトの判定", () => {
  it("メジャー 5 種を拾う", () => {
    expect(getAspect(0, 0)?.name).toBe("コンジャンクション");
    expect(getAspect(0, 60)?.name).toBe("セクスタイル");
    expect(getAspect(0, 90)?.name).toBe("スクエア");
    expect(getAspect(0, 120)?.name).toBe("トライン");
    expect(getAspect(0, 180)?.name).toBe("オポジション");
    // マイナーは持たない
    expect(getAspect(0, 150)).toBeNull();
    expect(getAspect(0, 45)).toBeNull();
  });

  it("オーブ 1.0° はちょうど内側、1.1° は外", () => {
    const hit = getAspect(0, 61);
    expect(hit?.name).toBe("セクスタイル");
    expect(hit?.orb).toBeCloseTo(1, 10);
    expect(getAspect(0, 61.1)).toBeNull();

    expect(getAspect(0, 179)?.name).toBe("オポジション");
    expect(getAspect(0, 178.9)).toBeNull();

    // オーブを広げれば拾える
    expect(getAspect(0, 61.1, 2)?.name).toBe("セクスタイル");
  });

  it("0° をまたぐ離角も短いほうで測る", () => {
    expect(getAspect(359.5, 0.2)?.name).toBe("コンジャンクション");
    expect(getAspect(359.5, 0.2)?.orb).toBeCloseTo(0.7, 10);
    // 2° 離れていればオーブ 1° では拾わない
    expect(getAspect(359, 1)).toBeNull();
  });

  it("接近・離反は 1 日後のオーブで決める", () => {
    // 動かないネイタル 0° に、89° から順行してくるトランジット（スクエアへ接近）
    expect(isApplying(0, 89, 0, 1, 90)).toBe(true);
    // 91° から離れていく側
    expect(isApplying(0, 91, 0, 1, 90)).toBe(false);
  });

  it("クロスアスペクトはオーブの狭い順に並ぶ", () => {
    const natal = [
      { name: "太陽", lon: 0, speed: 0 },
      { name: "月", lon: 10, speed: 0 },
    ];
    const transit = [
      { name: "木星", lon: 0.8, speed: 1 },
      { name: "土星", lon: 10.2, speed: 1 },
    ];
    const hits = crossAspects(natal, transit);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.natal).toBe("月");
    expect(hits[0]?.transit).toBe("土星");
    expect(hits[0]?.aspect.orb).toBeCloseTo(0.2, 10);
    expect(hits[1]?.natal).toBe("太陽");
    expect(formatCrossAspect(hits[1]!)).toContain("T.木星 ☌ N.太陽");
    expect(formatCrossAspect(hits[1]!)).toContain("オーブ 0.80°");
  });
});

describe("エンジンを受け取る計算", () => {
  it("ユリウス日は「時＋分／60 −時差」で作る", () => {
    const swe = makeFakeEngine();
    const utc = julianDay(swe, {
      year: 1990,
      month: 6,
      day: 15,
      hour: 12,
      minute: 0,
      utcOffset: 0,
    });
    const jst = julianDay(swe, {
      year: 1990,
      month: 6,
      day: 15,
      hour: 21,
      minute: 0,
      utcOffset: 9,
    });
    // 日本時間 21:00 は 12:00 UTC と同じ瞬間
    expect(jst).toBeCloseTo(utc, 10);

    const withMinutes = julianDay(swe, {
      year: 1990,
      month: 6,
      day: 15,
      hour: 12,
      minute: 30,
      utcOffset: 0,
    });
    // jd は 240 万台の大きな数なので、差を取ると下の桁は少し暴れる
    expect(withMinutes - utc).toBeCloseTo(0.5 / 24, 8);
  });

  it("11 天体を Moshier フラグで引く", () => {
    const swe = makeFakeEngine();
    const planets = computePlanets(swe, 2_451_545);
    expect(CALC_FLAGS).toBe(260);
    expect(planets).toHaveLength(11);
    expect(planets.map((planet) => planet.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);
    expect(planets[0]).toEqual({ id: 0, lon: 0, speed: 1 });
    // 金星だけ逆行させてある
    expect(planets[3]?.speed).toBeLessThan(0);
  });

  it("ユリウス日は UTC の Date に戻せる（リターンの瞬間の表示に使う）", () => {
    // 2000-01-01 12:00 UT ＝ J2000.0
    expect(dateFromJulianDay(2_451_545).toISOString()).toBe("2000-01-01T12:00:00.000Z");
    expect(dateFromJulianDay(2_440_587.5).toISOString()).toBe("1970-01-01T00:00:00.000Z");
    // 秒より下の埃は丸める（59.9999 秒が 1 分手前で止まらないように）
    const dusty = dateFromJulianDay(2_451_545 + (3 * 3600 - 0.0004) / 86_400);
    expect(dusty.toISOString()).toBe("2000-01-01T15:00:00.000Z");

    // 偽エンジンの swe_julday と往復する
    const swe = makeFakeEngine();
    const jd = julianDay(swe, {
      year: 2026,
      month: 8,
      day: 21,
      hour: 0,
      minute: 3,
      utcOffset: 9,
    });
    expect(dateFromJulianDay(jd).toISOString()).toBe("2026-08-20T15:03:00.000Z");
  });

  it("ハウスカスプの 1 行と、黄経 MC → ARMC", () => {
    expect(formatCuspLine(FAKE_CUSPS).split(" / ")).toHaveLength(12);
    expect(formatCuspLine(FAKE_CUSPS).startsWith("1H 蟹座 0°00′ / 2H 獅子座 0°00′")).toBe(true);

    // 春分点・秋分点では黄経と赤経が一致する（傾斜の影響が出ない）
    expect(mcToArmc(0, 23.44)).toBeCloseTo(0, 10);
    expect(mcToArmc(180, 23.44)).toBeCloseTo(180, 10);
    // 90° は傾斜のぶんだけ手前に来る
    expect(mcToArmc(90, 23.44)).toBeCloseTo(90, 10);
    expect(mcToArmc(45, 23.44)).toBeGreaterThan(41);
    expect(mcToArmc(45, 23.44)).toBeLessThan(45);
    // 負に回っても 0-360 に畳む
    expect(mcToArmc(350, 23.44)).toBeGreaterThan(340);
  });

  it("チャート 1 枚は天体＋カスプ＋ASC/MC", () => {
    const swe = makeFakeEngine();
    const chart = computeChart(
      swe,
      { year: 1990, month: 6, day: 15, hour: 12, minute: 0, utcOffset: 0 },
      { lat: 35.6895, lng: 139.6917, houseSystem: "P" },
    );
    expect(chart.planets).toHaveLength(11);
    expect(chart.cusps).toHaveLength(13);
    expect(anglesOf(chart)).toEqual({ asc: 90, mc: 300 });
    // ハウス計算にはネイタルの緯度経度とハウス方式がそのまま渡る
    expect(swe.houseCalls).toHaveLength(1);
    expect(swe.houseCalls[0]?.lat).toBe(35.6895);
    expect(swe.houseCalls[0]?.lng).toBe(139.6917);
    expect(swe.houseCalls[0]?.hsys).toBe("P");
  });
});
