/**
 * シナストリーの純関数（src/astro/chart.ts の末尾に足した 4 本）。
 *
 * ここは KV もエンジンも通らない ―― 点列とカスプを手で並べて、
 * 「総当たりか」「オーブ昇順か」「カスプちょうどはどちらのハウスか」だけを見る。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NATAL_ORB,
  formatHouseOverlay,
  formatSynastryAspect,
  houseOverlay,
  natalAspects,
  synastryAspects,
  type AspectPoint,
} from "../src/astro/chart";
import { FAKE_CUSPS } from "./stubs/fake-engine";

/** A の点列（どれも速度 0＝止まった図） */
const A: AspectPoint[] = [
  { name: "太陽", lon: 0, speed: 0 },
  { name: "月", lon: 120, speed: 0 },
  { name: "ASC", lon: 200, speed: 0 },
];

/** B の点列。A.太陽 とは合（2°）とトライン、A.ASC とはオポジション（0°）になるように置いた */
const B: AspectPoint[] = [
  { name: "太陽", lon: 121.5, speed: 0 },
  { name: "月", lon: 2, speed: 0 },
  { name: "MC", lon: 20, speed: 0 },
];

/** 「A側 記号 B側」の短い札（並び順の検算用） */
function pairs(hits: { a: string; b: string }[]): string[] {
  return hits.map((hit) => `${hit.a}-${hit.b}`);
}

describe("synastryAspects（2 枚の図の間のアスペクト）", () => {
  it("i < j ではなく総当たり ―― 同名同士も、向きの違う組も別々に出る", () => {
    const hits = synastryAspects(A, B);
    // A.太陽 × B.太陽（同名同士）も、A.太陽 × B.月 と A.月 × B.太陽 の両方も出る
    expect(pairs(hits)).toContain("太陽-太陽");
    expect(pairs(hits)).toContain("太陽-月");
    expect(pairs(hits)).toContain("月-太陽");
    // 同じ点列の中の話ではないので、natalAspects より組が多い
    expect(hits.length).toBeGreaterThan(natalAspects(A).length);
  });

  it("オーブ昇順に並ぶ（同着は先に見つけた順）", () => {
    const hits = synastryAspects(A, B);
    expect(pairs(hits)).toEqual(["ASC-MC", "太陽-太陽", "月-太陽", "太陽-月", "月-月"]);
    const orbs = hits.map((hit) => hit.aspect.orb);
    expect(orbs.map((orb) => Math.round(orb * 100) / 100)).toEqual([0, 1.5, 1.5, 2, 2]);
    for (let i = 1; i < orbs.length; i++) {
      expect(orbs[i]).toBeGreaterThanOrEqual(orbs[i - 1] as number);
    }
  });

  it("ASC / MC も相手に取る（点列に混ざっていればそのまま）", () => {
    const hits = synastryAspects(A, B);
    const opposition = hits.find((hit) => hit.a === "ASC" && hit.b === "MC");
    expect(opposition).toBeDefined();
    expect(opposition?.aspect.name).toBe("オポジション");
    expect(opposition?.aspect.orb).toBe(0);
  });

  it("止まった図同士なので接近・離反を持たない", () => {
    for (const hit of synastryAspects(A, B)) {
      expect(hit).not.toHaveProperty("applying");
      expect(Object.keys(hit).sort()).toEqual(["a", "aspect", "b"]);
    }
  });

  it("既定オーブは 5°。orb を絞ると落ちる", () => {
    const near: AspectPoint[] = [{ name: "太陽", lon: 0, speed: 0 }];
    const far: AspectPoint[] = [{ name: "月", lon: 4.9, speed: 0 }];
    expect(DEFAULT_NATAL_ORB).toBe(5);
    expect(synastryAspects(near, far)).toHaveLength(1);
    expect(synastryAspects(near, [{ name: "月", lon: 5.1, speed: 0 }])).toHaveLength(0);
    expect(synastryAspects(near, far, 2)).toHaveLength(0);
  });

  it("0° またぎも見る（359° と 2° は合）", () => {
    const hits = synastryAspects(
      [{ name: "太陽", lon: 359, speed: 0 }],
      [{ name: "月", lon: 2, speed: 0 }],
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.aspect.name).toBe("コンジャンクション");
    expect(hits[0]?.aspect.orb).toBeCloseTo(3, 10);
  });

  it("片方が空なら何も出ない", () => {
    expect(synastryAspects(A, [])).toEqual([]);
    expect(synastryAspects([], B)).toEqual([]);
  });
});

describe("houseOverlay（相手の図のハウスで数える）", () => {
  // FAKE_CUSPS は 1H が 90°、以降 30° 刻み（10H が 0°、12H が 60°）
  it("カスプちょうどは次のハウスの頭（1 つ手前は前のハウスの尻尾）", () => {
    const overlay = houseOverlay(
      [
        { id: 0, lon: 90 },
        { id: 1, lon: 89.99 },
        { id: 2, lon: 119.99 },
      ],
      FAKE_CUSPS,
    );
    expect(overlay).toEqual([
      { planet: "太陽", house: 1 },
      { planet: "月", house: 12 },
      { planet: "水星", house: 1 },
    ]);
  });

  it("0° をまたぐハウス（10H = 0°〜30°）も数えられる", () => {
    const overlay = houseOverlay(
      [
        { id: 0, lon: 0 },
        { id: 1, lon: 359.9 },
        { id: 2, lon: 29.9 },
      ],
      FAKE_CUSPS,
    );
    expect(overlay.map((entry) => entry.house)).toEqual([10, 9, 10]);
  });

  it("ノードも落とさない（アスペクトの相手にはしないが、位置は出す）", () => {
    const overlay = houseOverlay([{ id: 11, lon: 200 }], FAKE_CUSPS);
    expect(overlay).toEqual([{ planet: "Nノード", house: 4 }]);
  });

  it("並びは渡した天体のまま", () => {
    const planets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11].map((id) => ({ id, lon: id * 30 }));
    const overlay = houseOverlay(planets, FAKE_CUSPS);
    expect(overlay).toHaveLength(11);
    expect(overlay[0]?.planet).toBe("太陽");
    expect(overlay[10]?.planet).toBe("Nノード");
  });
});

describe("シナストリーのテキスト整形", () => {
  it("A. / B. の札が付き、接近・離反は付かない", () => {
    const hit = synastryAspects(
      [{ name: "太陽", lon: 0, speed: 0 }],
      [{ name: "月", lon: 1.4, speed: 0 }],
    )[0];
    expect(hit).toBeDefined();
    expect(formatSynastryAspect(hit)).toBe("A.太陽 ☌ B.月（コンジャンクション / オーブ 1.40°）");
    expect(formatSynastryAspect(hit)).not.toContain("接近");
  });

  it("在ハウスは「太陽 7H / 月 4H」の 1 行", () => {
    expect(
      formatHouseOverlay([
        { planet: "太陽", house: 7 },
        { planet: "月", house: 4 },
      ]),
    ).toBe("太陽 7H / 月 4H");
    expect(formatHouseOverlay([])).toBe("");
  });
});
