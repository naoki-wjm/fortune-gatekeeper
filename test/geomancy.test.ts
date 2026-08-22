import { describe, expect, it } from "vitest";
import {
  FIGURES,
  FIGURE_ROWS,
  addFigures,
  buildShieldChart,
  castGeomancy,
  figureByLatin,
  figureByLines,
  formatShieldChartText,
  type Figure,
  type FigureDots,
} from "../src/geomancy";
import type { RandomSource } from "../src/random";

/** 常に下限を返す乱数源（int(2)=0 ＝ 偶数 ＝ どの行も 2 点） */
const alwaysZero: RandomSource = { int: () => 0 };
/** 常に上限を返す乱数源（int(2)=1 ＝ 奇数 ＝ どの行も 1 点） */
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

/**
 * 決定的な偽乱数（xorshift32）。多数回まわして性質を確かめる用。
 * 線形合同法だと最下位ビットが 0/1 で交互になり、1 ビットずつ引くこの用途では使えない。
 */
function pseudo(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    int(maxExclusive: number): number {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      return state % maxExclusive;
    },
  };
}

/** 図形を 4 ビットにする（頭が最上位ビット・1 点=1・2 点=0）。台帳と別口で数え直す */
function bits(lines: readonly FigureDots[]): number {
  return lines.reduce((value, dots) => value * 2 + (dots === 1 ? 1 : 0), 0);
}

/** 図形の点の総数（1 点の行と 2 点の行の合計） */
function dotTotal(figure: Figure): number {
  return figure.lines.reduce((sum, dots) => sum + dots, 0);
}

const latins = (figures: readonly Figure[]) => figures.map((figure) => figure.latin);

describe("16 図形の台帳", () => {
  it("16 図形あり、どれも 4 行（頭・首・体・足）", () => {
    expect(FIGURES).toHaveLength(16);
    expect(FIGURE_ROWS).toBe(4);
    for (const figure of FIGURES) {
      expect(figure.lines).toHaveLength(4);
      for (const dots of figure.lines) expect([1, 2]).toContain(dots);
    }
  });

  it("ラテン名・日本語名・点の並び・glyph がすべて一意", () => {
    expect(new Set(FIGURES.map((figure) => figure.latin)).size).toBe(16);
    expect(new Set(FIGURES.map((figure) => figure.name)).size).toBe(16);
    expect(new Set(FIGURES.map((figure) => figure.lines.join(","))).size).toBe(16);
    expect(new Set(FIGURES.map((figure) => figure.glyph)).size).toBe(16);
  });

  it("4 ビット（0〜15）と 1 対 1 に対応する", () => {
    const keys = FIGURES.map((figure) => bits(figure.lines)).sort((a, b) => a - b);
    expect(keys).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("点の並びから図形を引ける（16 通りすべて）", () => {
    for (const figure of FIGURES) {
      expect(figureByLines(figure.lines)).toBe(figure);
    }
    expect(figureByLatin("Conjunctio").lines).toEqual([2, 1, 1, 2]);
    expect(() => figureByLines([1, 1, 1] as FigureDots[])).toThrow(RangeError);
    expect(() => figureByLatin("Rota Fortunae")).toThrow(RangeError);
  });

  it("よく知られた並びと合っている（取り違えやすい対を名指しで確かめる）", () => {
    // 上から 頭・首・体・足。1=点1つ、2=点2つ
    expect(figureByLatin("Via").lines).toEqual([1, 1, 1, 1]);
    expect(figureByLatin("Populus").lines).toEqual([2, 2, 2, 2]);
    // Puer は体だけが 2 点、Puella は首だけが 2 点
    expect(figureByLatin("Puer").lines).toEqual([1, 1, 2, 1]);
    expect(figureByLatin("Puella").lines).toEqual([1, 2, 1, 1]);
    // Albus は体だけが 1 点、Rubeus は首だけが 1 点
    expect(figureByLatin("Albus").lines).toEqual([2, 2, 1, 2]);
    expect(figureByLatin("Rubeus").lines).toEqual([2, 1, 2, 2]);
    // Caput は頭だけが 2 点、Cauda は足だけが 2 点
    expect(figureByLatin("Caput Draconis").lines).toEqual([2, 1, 1, 1]);
    expect(figureByLatin("Cauda Draconis").lines).toEqual([1, 1, 1, 2]);
  });

  it("上下をひっくり返した対になっている（Fortuna・Amissio/Acquisitio）", () => {
    expect(figureByLatin("Fortuna Major").lines).toEqual([2, 2, 1, 1]);
    expect(figureByLatin("Fortuna Minor").lines).toEqual([1, 1, 2, 2]);
    expect(figureByLatin("Amissio").lines).toEqual([2, 1, 2, 1]);
    expect(figureByLatin("Acquisitio").lines).toEqual([1, 2, 1, 2]);
    expect(figureByLatin("Tristitia").lines).toEqual([2, 2, 2, 1]);
    expect(figureByLatin("Laetitia").lines).toEqual([1, 2, 2, 2]);
    expect(figureByLatin("Conjunctio").lines).toEqual([2, 1, 1, 2]);
    expect(figureByLatin("Carcer").lines).toEqual([1, 2, 2, 1]);
  });

  it("glyph は点の並びの 1 行表記（1 点=• / 2 点=••）", () => {
    expect(figureByLatin("Via").glyph).toBe("•|•|•|•");
    expect(figureByLatin("Populus").glyph).toBe("••|••|••|••");
    expect(figureByLatin("Acquisitio").glyph).toBe("•|••|•|••");
    for (const figure of FIGURES) {
      expect(figure.glyph).toBe(figure.lines.map((dots) => (dots === 1 ? "•" : "••")).join("|"));
    }
  });
});

describe("図形の加算", () => {
  it("行ごとに足して、偶数なら 2 点・奇数なら 1 点", () => {
    // Puer[1,1,2,1] + Albus[2,2,1,2] は全行が奇数 → Via
    expect(addFigures(figureByLatin("Puer"), figureByLatin("Albus")).latin).toBe("Via");
  });

  it("Populus は足しても変わらない（全行 2 点＝偶数のため）", () => {
    for (const figure of FIGURES) {
      expect(addFigures(figure, figureByLatin("Populus"))).toBe(figure);
    }
  });

  it("同じ図形どうしを足すと必ず Populus になる", () => {
    for (const figure of FIGURES) {
      expect(addFigures(figure, figure).latin).toBe("Populus");
    }
  });

  it("順番を入れ替えても同じ", () => {
    for (const a of FIGURES) {
      for (const b of FIGURES) {
        expect(addFigures(a, b)).toBe(addFigures(b, a));
      }
    }
  });
});

/**
 * 既知の作例（手計算）。母 4 つを決め打ちにして、導出だけを確かめる。
 *
 *   M1 Puer     [1,1,2,1]
 *   M2 Albus    [2,2,1,2]
 *   M3 Populus  [2,2,2,2]
 *   M4 Rubeus   [2,1,2,2]
 *
 * 娘＝母の転置（縦に読む）:
 *   D1 頭の列 = 1,2,2,2 → [1,2,2,2] Laetitia
 *   D2 首の列 = 1,2,2,1 → [1,2,2,1] Carcer
 *   D3 体の列 = 2,1,2,2 → [2,1,2,2] Rubeus
 *   D4 足の列 = 1,2,2,2 → [1,2,2,2] Laetitia
 *
 * 姪（行ごとの和が偶数なら 2 点・奇数なら 1 点）:
 *   N1 = M1+M2 = (1+2,1+2,2+1,1+2) = (3,3,3,3) → [1,1,1,1] Via
 *   N2 = M3+M4 = (2+2,2+1,2+2,2+2) = (4,3,4,4) → [2,1,2,2] Rubeus
 *   N3 = D1+D2 = (1+1,2+2,2+2,2+1) = (2,4,4,3) → [2,2,2,1] Tristitia
 *   N4 = D3+D4 = (2+1,1+2,2+2,2+2) = (3,3,4,4) → [1,1,2,2] Fortuna Minor
 *
 * 証人・裁判官・和解者:
 *   RW = N1+N2 = (1+2,1+1,1+2,1+2) = (3,2,3,3) → [1,2,1,1] Puella
 *   LW = N3+N4 = (2+1,2+1,2+2,1+2) = (3,3,4,3) → [1,1,2,1] Puer
 *   J  = RW+LW = (1+1,2+1,1+2,1+1) = (2,3,3,2) → [2,1,1,2] Conjunctio（点の和 6＝偶数）
 *   R  = J+M1  = (2+1,1+1,1+2,2+1) = (3,2,3,3) → [1,2,1,1] Puella
 */
const EXAMPLE_MOTHERS = ["Puer", "Albus", "Populus", "Rubeus"].map(figureByLatin);
/** 上の作例と同じ母が立つ出目（母ごとに上から 4 ビット。1=奇数=1 点、0=偶数=2 点） */
const EXAMPLE_ROLLS = [1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0];

describe("シールドチャートの導出", () => {
  const chart = buildShieldChart(EXAMPLE_MOTHERS);

  it("娘は母の転置（1 行目・2 行目…を縦に読む）", () => {
    expect(latins(chart.daughters)).toEqual(["Laetitia", "Carcer", "Rubeus", "Laetitia"]);
    // 定義そのもの: D[j] の i 行目 = M[i] の j 行目
    for (let row = 0; row < FIGURE_ROWS; row++) {
      for (let index = 0; index < FIGURE_ROWS; index++) {
        expect(chart.daughters[row]?.lines[index]).toBe(chart.mothers[index]?.lines[row]);
      }
    }
  });

  it("姪は N1=M1+M2 / N2=M3+M4 / N3=D1+D2 / N4=D3+D4", () => {
    expect(latins(chart.nieces)).toEqual(["Via", "Rubeus", "Tristitia", "Fortuna Minor"]);
  });

  it("証人・裁判官・和解者が手計算と一致する", () => {
    expect(chart.witnesses.right.latin).toBe("Puella");
    expect(chart.witnesses.left.latin).toBe("Puer");
    expect(chart.judge.latin).toBe("Conjunctio");
    expect(chart.judge.lines).toEqual([2, 1, 1, 2]);
    expect(chart.reconciler.latin).toBe("Puella");
  });

  it("母はそのまま持ち越される（15 図形＋和解者の形）", () => {
    expect(latins(chart.mothers)).toEqual(["Puer", "Albus", "Populus", "Rubeus"]);
    expect(chart.mothers).toHaveLength(4);
    expect(chart.daughters).toHaveLength(4);
    expect(chart.nieces).toHaveLength(4);
    expect(Object.keys(chart)).toEqual([
      "mothers",
      "daughters",
      "nieces",
      "witnesses",
      "judge",
      "reconciler",
    ]);
  });

  it("母が 4 つでなければ例外", () => {
    expect(() => buildShieldChart(EXAMPLE_MOTHERS.slice(0, 3))).toThrow(RangeError);
    expect(() => buildShieldChart([])).toThrow("母は 4 つ必要です");
  });
});

describe("裁判官の点の総和は必ず偶数", () => {
  it("偽乱数を 500 回まわしても崩れない", () => {
    const random = pseudo(20260822);
    const judges = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const chart = castGeomancy(random);
      expect(dotTotal(chart.judge) % 2).toBe(0);
      judges.add(chart.judge.latin);
    }
    // 偶数の点を持つ 8 図形だけが裁判官になれる（16 図形のうち半分）
    expect([...judges].sort()).toEqual([
      "Acquisitio",
      "Amissio",
      "Carcer",
      "Conjunctio",
      "Fortuna Major",
      "Fortuna Minor",
      "Populus",
      "Via",
    ]);
  });

  it("素の乱数源でも崩れない", () => {
    for (let i = 0; i < 50; i++) {
      expect(dotTotal(castGeomancy().judge) % 2).toBe(0);
    }
  });

  it("16 図形のうち点の総和が偶数なのはちょうど 8 つ", () => {
    expect(FIGURES.filter((figure) => dotTotal(figure) % 2 === 0)).toHaveLength(8);
  });
});

describe("立てる", () => {
  it("乱数は母 4 つぶんの 16 ビットだけ（あとは導出）", () => {
    const draws: number[] = [];
    const counting: RandomSource = {
      int(max) {
        draws.push(max);
        return alwaysZero.int(max);
      },
    };
    castGeomancy(counting);
    expect(draws).toHaveLength(16);
    // どの引きも 2 通り（＝1 ビット）
    expect(draws.every((max) => max === 2)).toBe(true);
  });

  it("偽の乱数源で決定的に立つ（下限＝どの行も 2 点）", () => {
    const chart = castGeomancy(alwaysZero);
    expect(latins(chart.mothers)).toEqual(["Populus", "Populus", "Populus", "Populus"]);
    expect(latins(chart.daughters)).toEqual(["Populus", "Populus", "Populus", "Populus"]);
    expect(latins(chart.nieces)).toEqual(["Populus", "Populus", "Populus", "Populus"]);
    expect(chart.judge.latin).toBe("Populus");
    expect(chart.reconciler.latin).toBe("Populus");
  });

  it("偽の乱数源で決定的に立つ（上限＝どの行も 1 点）", () => {
    const chart = castGeomancy(alwaysMax);
    expect(latins(chart.mothers)).toEqual(["Via", "Via", "Via", "Via"]);
    expect(latins(chart.daughters)).toEqual(["Via", "Via", "Via", "Via"]);
    // Via+Via は Populus
    expect(latins(chart.nieces)).toEqual(["Populus", "Populus", "Populus", "Populus"]);
    expect(chart.witnesses.right.latin).toBe("Populus");
    expect(chart.judge.latin).toBe("Populus");
    // 和解者は 裁判官(Populus)+M1(Via) なので Via に戻る
    expect(chart.reconciler.latin).toBe("Via");
  });

  it("出目の並びは母ごとに上から（作例の 16 ビットで作例の図が立つ）", () => {
    const chart = castGeomancy(scripted(EXAMPLE_ROLLS));
    expect(latins(chart.mothers)).toEqual(["Puer", "Albus", "Populus", "Rubeus"]);
    expect(chart.judge.latin).toBe("Conjunctio");
    expect(chart).toEqual(buildShieldChart(EXAMPLE_MOTHERS));
  });

  it("素の乱数源でも 16 図形の中からしか出ない", () => {
    for (let i = 0; i < 30; i++) {
      const chart = castGeomancy();
      const all = [
        ...chart.mothers,
        ...chart.daughters,
        ...chart.nieces,
        chart.witnesses.right,
        chart.witnesses.left,
        chart.judge,
        chart.reconciler,
      ];
      expect(all).toHaveLength(16); // 15 図形＋和解者
      for (const figure of all) expect(FIGURES).toContain(figure);
    }
  });
});

describe("テキスト整形", () => {
  const text = formatShieldChartText(buildShieldChart(EXAMPLE_MOTHERS));

  it("作例が見出し＋6 行になる", () => {
    expect(text).toBe(
      [
        "ジオマンシー / シールドチャート",
        "母: 1 Puer（少年）•|•|••|•  2 Albus（白）••|••|•|••  3 Populus（群衆）••|••|••|••  4 Rubeus（赤）••|•|••|••",
        "娘: 1 Laetitia（喜び）•|••|••|••  2 Carcer（牢獄）•|••|••|•  3 Rubeus（赤）••|•|••|••  4 Laetitia（喜び）•|••|••|••",
        "姪: 1 Via（道）•|•|•|•  2 Rubeus（赤）••|•|••|••  3 Tristitia（悲しみ）••|••|••|•  4 Fortuna Minor（小吉）•|•|••|••",
        "証人: 右 Puella（少女）•|••|•|•  左 Puer（少年）•|•|••|•",
        "裁判官: Conjunctio（結合）••|•|•|••",
        "和解者（参考）: Puella（少女）•|••|•|•",
      ].join("\n"),
    );
  });

  it("行数は常に 7（母・娘・姪・証人・裁判官・和解者＋見出し）", () => {
    for (let i = 0; i < 20; i++) {
      const lines = formatShieldChartText(castGeomancy()).split("\n");
      expect(lines).toHaveLength(7);
      expect(lines[0]).toBe("ジオマンシー / シールドチャート");
      expect(lines[6]).toMatch(/^和解者（参考）: /);
    }
  });

  it("意味テキストのたぐいは載らない", () => {
    expect(text).not.toContain("意味");
    expect(text).not.toContain("解説");
  });
});
