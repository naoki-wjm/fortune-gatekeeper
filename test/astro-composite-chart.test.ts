/**
 * コンポジット（中点図）の純関数（src/astro/composite.ts）。
 *
 * 配線の検算は test/astro-composite.test.ts の担当で、ここは
 * 「中点の取り方」「ARMC 経路に何を渡すか」「壊れた返り値を弾くか」だけを見る。
 * wasm には触らない（偽エンジンか、その場で組んだ最小の口を渡す）。
 */
import { describe, expect, it } from "vitest";
import { AstroError, mcToArmc, normalizeDegree, type SwissEph } from "../src/astro/chart";
import {
  COMPOSITE_PLANET_IDS,
  buildComposite,
  compositeConventions,
  compositeHouseSystem,
  equalHouseCusps,
  formatCompositeConventions,
  formatCompositePlanetLines,
  midpointLon,
  midpointPositions,
  type CompositeSide,
} from "../src/astro/composite";
import {
  FAKE_ARMC_CUSPS,
  FAKE_EPS,
  armcToMc,
  makeFakeEngine,
  type FakeEngine,
} from "./stubs/fake-engine";

/** 10 天体を「id×30° ＋ offset」に並べた図の材料 */
function sideAt(offset: number, extras: Partial<CompositeSide> = {}): CompositeSide {
  return {
    planets: COMPOSITE_PLANET_IDS.map((id) => ({ id, lon: normalizeDegree(id * 30 + offset) })),
    cusps: [0, 90, 120, 150, 180, 210, 240, 270, 300, 330, 0, 30, 60],
    ascmc: [90, 300, 0, 0, 0, 0, 0, 0],
    houseSystem: "P",
    ...extras,
  };
}

/** ARMC 経路を通す偽エンジン（往復の辻褄を合わせた状態） */
function armcEngine(): FakeEngine {
  const engine = makeFakeEngine();
  engine.armcMatchesMc = true;
  return engine;
}

// ---------------------------------------------------------------------------

describe("midpointLon（短い方の弧の中点）", () => {
  it("素直な組（10°, 50° → 30°）", () => {
    expect(midpointLon(10, 50)).toBeCloseTo(30, 12);
    expect(midpointLon(50, 10)).toBeCloseTo(30, 12);
  });

  it("0° またぎ（350°, 10° → 0°）", () => {
    expect(midpointLon(350, 10)).toBeCloseTo(0, 12);
    expect(midpointLon(10, 350)).toBeCloseTo(0, 12);
    // 遠回りの 180° 側（190°）は採らない
    expect(midpointLon(350, 10)).not.toBeCloseTo(180, 6);
  });

  it("ちょうど 180° は A から黄経が増える向きに 90°（向きで答えが変わる唯一の場合）", () => {
    expect(midpointLon(0, 180)).toBeCloseTo(90, 12);
    expect(midpointLon(180, 0)).toBeCloseTo(270, 12);
    expect(midpointLon(300, 120)).toBeCloseTo(30, 12);
    expect(midpointLon(120, 300)).toBeCloseTo(210, 12);
  });

  it("同一点はその点のまま", () => {
    expect(midpointLon(123.456, 123.456)).toBeCloseTo(123.456, 12);
    expect(midpointLon(0, 0)).toBe(0);
  });

  it("179.9° / 180.1° は対向の分岐に落ちない（幅は 1e-9° だけ）", () => {
    expect(midpointLon(0, 179.9)).toBeCloseTo(89.95, 12);
    expect(midpointLon(0, 180.1)).toBeCloseTo(270.05, 12);
  });

  it("入力は 0-360 に畳んでから見る（-10° と 350° は同じ）", () => {
    expect(midpointLon(-10, 10)).toBeCloseTo(0, 12);
    expect(midpointLon(710, 10)).toBeCloseTo(0, 12);
  });
});

describe("midpointPositions（10 天体の中点）", () => {
  it("太陽から冥王星までの 10 天体を、渡した並びのまま返す", () => {
    const midpoints = midpointPositions(sideAt(0).planets, sideAt(10).planets);
    expect(midpoints).toHaveLength(10);
    expect(midpoints.map((planet) => planet.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(midpoints[0]?.lon).toBeCloseTo(5, 12);
    expect(midpoints[9]?.lon).toBeCloseTo(275, 12);
  });

  it("ノード（id 11）は中点図に入れない", () => {
    const withNode = [...sideAt(0).planets, { id: 11, lon: 200 }];
    const midpoints = midpointPositions(withNode, [...sideAt(10).planets, { id: 11, lon: 210 }]);
    expect(midpoints.map((planet) => planet.id)).not.toContain(11);
    expect(midpoints).toHaveLength(10);
  });

  it("片方に欠けている天体があれば断る（黙って 9 天体の図を返さない）", () => {
    const short = sideAt(0).planets.filter((planet) => planet.id !== 3);
    expect(() => midpointPositions(short, sideAt(10).planets)).toThrow(AstroError);
    expect(() => midpointPositions(short, sideAt(10).planets)).toThrow("金星");
    expect(() => midpointPositions(sideAt(0).planets, short)).toThrow("金星");
  });
});

describe("compositeHouseSystem / equalHouseCusps", () => {
  it("2 枚が同じ方式ならそれ、違えばプラシーダス", () => {
    expect(compositeHouseSystem("W", "W")).toBe("W");
    expect(compositeHouseSystem("K", "K")).toBe("K");
    expect(compositeHouseSystem("W", "K")).toBe("P");
    expect(compositeHouseSystem("E", "P")).toBe("P");
  });

  it("イコールのカスプは ASC から 30° 刻み（[0] はダミー）", () => {
    const cusps = equalHouseCusps(100);
    expect(cusps).toHaveLength(13);
    expect(cusps[0]).toBe(0);
    expect(cusps.slice(1)).toEqual([100, 130, 160, 190, 220, 250, 280, 310, 340, 10, 40, 70]);
  });
});

describe("buildComposite（既定＝中点 MC から立て直す経路）", () => {
  it("MC の中点を ARMC に直し、2 人の緯度の平均でハウスを立てる", () => {
    const engine = armcEngine();
    const a = sideAt(0, { birth: { jd: 2_448_000.5, lat: 35 } });
    const b = sideAt(10, { ascmc: [90, 320, 0, 0, 0, 0, 0, 0], birth: { jd: 2_450_000.5, lat: 51 } });

    const composite = buildComposite(engine, a, b);

    expect(composite.ascMethod).toBe("derived_from_mc_midpoint");
    expect(composite.houseSystem).toBe("P");
    // 黄道傾斜は 2 人の出生 jd の中間で引く
    expect(engine.armcCalls).toHaveLength(1);
    const call = engine.armcCalls[0];
    expect(call?.eps).toBe(FAKE_EPS);
    expect(call?.hsys).toBe("P");
    // 緯度は単純平均（35 と 51 の真ん中）
    expect(call?.lat).toBeCloseTo(43, 12);
    // ARMC は中点 MC（300° と 320° の真ん中＝310°）から作る
    expect(call?.armc).toBeCloseTo(mcToArmc(310, FAKE_EPS), 12);

    // 立て直した MC は中点 MC に戻る（往復が閉じている証拠）
    expect(composite.ascmc[1]).toBeCloseTo(310, 9);
    expect(composite.cusps).toEqual(FAKE_ARMC_CUSPS);
    expect(composite.planets[0]?.lon).toBeCloseTo(5, 12);
  });

  it("中間の jd で黄道傾斜を引く（swe_calc_ut の planetId は SE_ECL_NUT）", () => {
    const engine = armcEngine();
    const calls: { jd: number; planetId: number }[] = [];
    const spy: SwissEph = {
      ...engine,
      swe_calc_ut(jd: number, planetId: number, flags: number) {
        calls.push({ jd, planetId });
        return engine.swe_calc_ut(jd, planetId, flags);
      },
    };
    buildComposite(
      spy,
      sideAt(0, { birth: { jd: 2_448_000.5, lat: 35 } }),
      sideAt(10, { birth: { jd: 2_450_000.5, lat: 35 } }),
    );
    expect(calls).toEqual([{ jd: 2_449_000.5, planetId: -1 }]);
  });

  it("2 枚で方式が違えばプラシーダスで立てる", () => {
    const engine = armcEngine();
    const composite = buildComposite(
      engine,
      sideAt(0, { houseSystem: "W", birth: { jd: 2_448_000.5, lat: 35 } }),
      sideAt(10, { houseSystem: "K", birth: { jd: 2_450_000.5, lat: 35 } }),
    );
    expect(composite.houseSystem).toBe("P");
    expect(engine.armcCalls[0]?.hsys).toBe("P");
  });

  it("同じ方式なら引き継ぐ", () => {
    const engine = armcEngine();
    const composite = buildComposite(
      engine,
      sideAt(0, { houseSystem: "W", birth: { jd: 2_448_000.5, lat: 35 } }),
      sideAt(10, { houseSystem: "W", birth: { jd: 2_450_000.5, lat: 35 } }),
    );
    expect(composite.houseSystem).toBe("W");
    expect(engine.armcCalls[0]?.hsys).toBe("W");
  });
});

describe("buildComposite（簡易方式＝出生データが無いとき）", () => {
  it("ASC も中点・カスプは 30° 等分。エンジンには触らない", () => {
    const engine = armcEngine();
    const composite = buildComposite(
      engine,
      sideAt(0, { birth: { jd: 2_448_000.5, lat: 35 } }),
      sideAt(10, { cusps: [0, 130, 160, 190, 220, 250, 280, 310, 340, 10, 40, 70, 100] }),
    );

    expect(composite.ascMethod).toBe("asc_midpoint_equal_houses");
    expect(composite.houseSystem).toBe("E");
    // ASC は 90° と 130° の中点
    expect(composite.cusps[1]).toBeCloseTo(110, 12);
    expect(composite.cusps.slice(1)).toEqual([
      110, 140, 170, 200, 230, 260, 290, 320, 350, 20, 50, 80,
    ]);
    // MC は MC どうしの中点のまま（10 カスプとは一致しない）
    expect(composite.ascmc[1]).toBeCloseTo(300, 12);
    expect(composite.ascmc[0]).toBeCloseTo(110, 12);

    expect(engine.armcCalls).toHaveLength(0);
    expect(engine.juldays).toHaveLength(0);
  });

  it("両方に出生データが無くても組み立てられる（エンジンが null でも通る）", () => {
    const composite = buildComposite(null, sideAt(0), sideAt(10));
    expect(composite.ascMethod).toBe("asc_midpoint_equal_houses");
    expect(composite.planets).toHaveLength(10);
  });

  it("出生データが揃っているのにエンジンが無ければ、配線の取り違えとして断る", () => {
    expect(() =>
      buildComposite(
        null,
        sideAt(0, { birth: { jd: 2_448_000.5, lat: 35 } }),
        sideAt(10, { birth: { jd: 2_450_000.5, lat: 35 } }),
      ),
    ).toThrow(AstroError);
  });
});

describe("buildComposite の検算（wrapper の返り値は呼び出し側で確かめる）", () => {
  const birthA = { jd: 2_448_000.5, lat: 35 };
  const birthB = { jd: 2_450_000.5, lat: 35 };

  function build(engine: SwissEph) {
    return buildComposite(engine, sideAt(0, { birth: birthA }), sideAt(10, { birth: birthB }));
  }

  it("立て直した MC が中点 MC と違えば断る", () => {
    // 既定の偽エンジンは ascmc[1] を決め打ち（310°）で返す＝中点 MC（300°）と一致しない
    const engine = makeFakeEngine();
    expect(engine.armcMatchesMc).toBe(false);
    expect(() => build(engine)).toThrow(AstroError);
    expect(() => build(engine)).toThrow("MC を立て直せませんでした");
  });

  it("カスプが 12 本そろっていなければ断る", () => {
    const engine = armcEngine();
    const broken: SwissEph = {
      ...engine,
      swe_houses_armc(armc: number, _lat: number, eps: number, _hsys: string) {
        return { cusps: [0, 100, 130], ascmc: [100, armcToMc(armc, eps), 0, 0, 0, 0, 0, 0] };
      },
    };
    expect(() => build(broken)).toThrow("壊れた値");
  });

  it("カスプに数でないものが混ざっていれば断る", () => {
    const engine = armcEngine();
    const cusps = [...FAKE_ARMC_CUSPS];
    cusps[5] = Number.NaN;
    const broken: SwissEph = {
      ...engine,
      swe_houses_armc(armc: number, _lat: number, eps: number, _hsys: string) {
        return { cusps, ascmc: [100, armcToMc(armc, eps), 0, 0, 0, 0, 0, 0] };
      },
    };
    expect(() => build(broken)).toThrow("壊れた値");
  });

  it("wrapper が投げてきたら、ハウス方式の言い添えに直して返す（緯度は書かない）", () => {
    const engine = armcEngine();
    const throwing: SwissEph = {
      ...engine,
      swe_houses_armc() {
        throw new Error("swe_houses_armc");
      },
    };
    expect(() => build(throwing)).toThrow(AstroError);
    try {
      build(throwing);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("ハウス方式 P");
      expect(message).toContain("ホールサイン（W）");
      expect(message).not.toContain("35");
    }
  });

  it("黄道傾斜がありえない値なら断る", () => {
    const engine = armcEngine();
    const broken: SwissEph = {
      ...engine,
      swe_calc_ut(jd: number, planetId: number, flags: number) {
        if (planetId === -1) return [99, 0, 0, 0, 0, 0];
        return engine.swe_calc_ut(jd, planetId, flags);
      },
    };
    expect(() => build(broken)).toThrow("黄道傾斜");
  });
});

describe("規約と整形", () => {
  it("規約は名前で返す（既定の経路）", () => {
    const engine = armcEngine();
    const composite = buildComposite(
      engine,
      sideAt(0, { birth: { jd: 2_448_000.5, lat: 35 } }),
      sideAt(10, { birth: { jd: 2_450_000.5, lat: 51 } }),
    );
    expect(compositeConventions(composite)).toEqual({
      method: "midpoint",
      midpoint: "shorter_arc",
      opposition_tiebreak: "clockwise_from_a",
      bodies: "10_planets_plus_asc_mc",
      nodes: "excluded",
      asc: "derived_from_mc_midpoint",
      house_system: "P",
      latitude: "mean_of_birth_latitudes",
      obliquity: "at_mean_birth_jd",
    });
    expect(formatCompositeConventions(composite)).toContain("ダヴィソンではない");
    expect(formatCompositeConventions(composite)).toContain("2 人の出生緯度の平均");
  });

  it("規約は名前で返す（簡易方式）", () => {
    const composite = buildComposite(null, sideAt(0), sideAt(10));
    expect(compositeConventions(composite)).toEqual({
      method: "midpoint",
      midpoint: "shorter_arc",
      opposition_tiebreak: "clockwise_from_a",
      bodies: "10_planets_plus_asc_mc",
      nodes: "excluded",
      asc: "asc_midpoint_equal_houses",
      house_system: "E",
      houses: "equal_from_asc",
    });
    expect(formatCompositeConventions(composite)).toContain("簡易方式");
  });

  it("天体の行に逆行の印は付かない（中点図は速度を持たない）", () => {
    const lines = formatCompositePlanetLines(
      [
        { id: 0, lon: 84.0333 },
        { id: 3, lon: 200 },
      ],
      FAKE_ARMC_CUSPS,
    );
    expect(lines[0]).toBe("太陽 双子座 24°01′ (12H)");
    expect(lines[1]).toBe("金星 天秤座 20°00′ (4H)");
    for (const line of lines) expect(line).not.toContain("逆行");
  });
});
