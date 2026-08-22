/**
 * 西洋ジオマンシー（土占い）のシールドチャート（純関数）。
 *
 * 背骨は draw.ts・iching.ts・astro-dice.ts と同じ ―― 立てるのはサーバー、読むのは呼び出した側の Claude。
 * ここは 16 図形の名前と点の並びを組み立てるだけで、意味も占断も持たない
 * （ジオマンシーは広く知られた体系なので、読みは Claude 自身の知識に任せる）。
 *
 * **乱数を使うのは母 4 つを立てるところだけ**（4 図形 × 4 行 = 16 行ぶんの奇偶＝16 ビット）。
 * 娘・姪・証人・裁判官・和解者はそこから完全に導出される――乱数を継ぎ足さない。
 *
 * 図形は 4 行あり、上から 頭・首・体・足（火・風・水・地）。
 * 各行は「点 1 つ（奇数）」か「点 2 つ（偶数）」のどちらかなので、1 図形 = 4 ビット = 16 通り。
 *
 * シールドチャートの組み立て:
 *   母 M1〜M4   … 乱数で立てる
 *   娘 D1〜D4   … 母の転置（D1 = M1〜M4 の 1 行目を上から並べたもの、D2 = 2 行目…）
 *   姪 N1〜N4   … N1=M1+M2、N2=M3+M4、N3=D1+D2、N4=D3+D4
 *   証人        … 右 RW=N1+N2、左 LW=N3+N4
 *   裁判官 J    … RW+LW
 *   和解者 R    … J+M1（導出で出るので参考として添える）
 * 「+」は行ごとの加算で、点の和が偶数なら 2 点・奇数なら 1 点（＝ビットの排他的論理和）。
 */
import { cryptoRandom, type RandomSource } from "./random";

/** 1 行の点の数。1=1 点（奇数）・2=2 点（偶数） */
export type FigureDots = 1 | 2;

/** 図形の行数（頭・首・体・足） */
export const FIGURE_ROWS = 4;

/** 16 図形の 1 つ */
export interface Figure {
  /** ラテン名（Via / Populus / …） */
  latin: string;
  /** 日本語名（道・群衆・…） */
  name: string;
  /** 上から 頭・首・体・足の点の数。4 要素 */
  lines: readonly FigureDots[];
  /** 点の並びの 1 行表記。1 点=• / 2 点=•• を上から「|」でつなぐ（例: Acquisitio は •|••|•|••） */
  glyph: string;
}

/**
 * 16 図形の素。並び順に意味は無い（番号を持たない体系なので、覚えやすい対で並べてある）。
 * lines は上から 頭・首・体・足。
 */
const FIGURE_TABLE: readonly { latin: string; name: string; lines: readonly FigureDots[] }[] = [
  { latin: "Via", name: "道", lines: [1, 1, 1, 1] },
  { latin: "Populus", name: "群衆", lines: [2, 2, 2, 2] },
  { latin: "Fortuna Major", name: "大吉", lines: [2, 2, 1, 1] },
  { latin: "Fortuna Minor", name: "小吉", lines: [1, 1, 2, 2] },
  { latin: "Puer", name: "少年", lines: [1, 1, 2, 1] },
  { latin: "Puella", name: "少女", lines: [1, 2, 1, 1] },
  { latin: "Amissio", name: "損失", lines: [2, 1, 2, 1] },
  { latin: "Acquisitio", name: "獲得", lines: [1, 2, 1, 2] },
  { latin: "Conjunctio", name: "結合", lines: [2, 1, 1, 2] },
  { latin: "Carcer", name: "牢獄", lines: [1, 2, 2, 1] },
  { latin: "Tristitia", name: "悲しみ", lines: [2, 2, 2, 1] },
  { latin: "Laetitia", name: "喜び", lines: [1, 2, 2, 2] },
  { latin: "Albus", name: "白", lines: [2, 2, 1, 2] },
  { latin: "Rubeus", name: "赤", lines: [2, 1, 2, 2] },
  { latin: "Caput Draconis", name: "竜頭", lines: [2, 1, 1, 1] },
  { latin: "Cauda Draconis", name: "竜尾", lines: [1, 1, 1, 2] },
];

/** 点の並びの 1 行表記を作る（1 点=• / 2 点=••、上から「|」でつなぐ） */
function toGlyph(lines: readonly FigureDots[]): string {
  return lines.map((dots) => (dots === 1 ? "•" : "••")).join("|");
}

/**
 * 図形を 4 ビットの数にする（頭が最上位ビット・1 点=1・2 点=0）。
 * 4 行 × 2 通り = 16 なので、この鍵と 16 図形はちょうど 1 対 1 に対応する。
 */
function figureKey(lines: readonly FigureDots[]): number {
  return lines.reduce((bits, dots) => (bits << 1) | (dots === 1 ? 1 : 0), 0);
}

/** 16 図形。glyph は lines から導くので、表と食い違うことがない */
export const FIGURES: readonly Figure[] = FIGURE_TABLE.map((entry) => ({
  latin: entry.latin,
  name: entry.name,
  lines: [...entry.lines],
  glyph: toGlyph(entry.lines),
}));

const FIGURE_BY_KEY = new Map(FIGURES.map((figure) => [figureKey(figure.lines), figure]));

/** 点の並び（4 行）から図形を引く。4 行でなければ例外 */
export function figureByLines(lines: readonly FigureDots[]): Figure {
  if (lines.length !== FIGURE_ROWS) {
    throw new RangeError(`図形は ${FIGURE_ROWS} 行です: ${lines.length} 行`);
  }
  const figure = FIGURE_BY_KEY.get(figureKey(lines));
  // 16 通りをすべて表に持っているので、4 行あればここは必ず見つかる
  if (!figure) throw new RangeError(`知らない点の並びです: ${lines.join(",")}`);
  return figure;
}

/** ラテン名から図形を引く（テスト・作例の組み立て用）。無ければ例外 */
export function figureByLatin(latin: string): Figure {
  const figure = FIGURES.find((entry) => entry.latin === latin);
  if (!figure) throw new RangeError(`知らない図形です: ${latin}`);
  return figure;
}

/**
 * 図形どうしの加算。行ごとに点を足し、偶数なら 2 点・奇数なら 1 点にする。
 * （ビットで見れば排他的論理和。同じ図形どうしを足すと必ず Populus になる）
 */
export function addFigures(a: Figure, b: Figure): Figure {
  const lines = a.lines.map(
    (dots, row): FigureDots => ((dots + (b.lines[row] as FigureDots)) % 2 === 0 ? 2 : 1),
  );
  return figureByLines(lines);
}

/** シールドチャート一式（母 4・娘 4・姪 4・証人 2・裁判官 1 ＋参考の和解者 1） */
export interface ShieldChart {
  /** 母 M1〜M4。乱数で立てた 4 つ */
  mothers: Figure[];
  /** 娘 D1〜D4。母の転置 */
  daughters: Figure[];
  /** 姪 N1〜N4 */
  nieces: Figure[];
  /** 証人（右＝母方・左＝娘方） */
  witnesses: { right: Figure; left: Figure };
  /** 裁判官（右証人＋左証人）。点の総和は必ず偶数になる */
  judge: Figure;
  /** 和解者（裁判官＋母 1）。導出で出るので参考として添える */
  reconciler: Figure;
}

/**
 * 母 4 つを立てる。
 *
 * 伝統では砂や紙に点を打ち、その数の奇偶で 1 点／2 点を決める。
 * ここは奇偶だけが要るので、1 行につき乱数を 1 ビット引く（4 図形 × 4 行 = 16 ビット）。
 * 引く順は母ごとに上から（M1 の頭・首・体・足 → M2 の頭…）。
 */
function castMothers(random: RandomSource): Figure[] {
  const mothers: Figure[] = [];
  for (let index = 0; index < FIGURE_ROWS; index++) {
    const lines: FigureDots[] = [];
    for (let row = 0; row < FIGURE_ROWS; row++) {
      // 1 = 奇数 → 点 1 つ、0 = 偶数 → 点 2 つ
      lines.push(random.int(2) === 1 ? 1 : 2);
    }
    mothers.push(figureByLines(lines));
  }
  return mothers;
}

/**
 * 母 4 つからシールドチャートを組み立てる（乱数を使わない完全な導出）。
 *
 * 娘は母の転置 ―― D1 は母 4 つの 1 行目（頭）を上から並べたもの、D2 は 2 行目（首）…と続く。
 */
export function buildShieldChart(mothers: readonly Figure[]): ShieldChart {
  if (mothers.length !== FIGURE_ROWS) {
    throw new RangeError(`母は ${FIGURE_ROWS} つ必要です: ${mothers.length} つ`);
  }

  const daughters: Figure[] = [];
  for (let row = 0; row < FIGURE_ROWS; row++) {
    daughters.push(figureByLines(mothers.map((mother) => mother.lines[row] as FigureDots)));
  }

  const nieces = [
    addFigures(mothers[0] as Figure, mothers[1] as Figure),
    addFigures(mothers[2] as Figure, mothers[3] as Figure),
    addFigures(daughters[0] as Figure, daughters[1] as Figure),
    addFigures(daughters[2] as Figure, daughters[3] as Figure),
  ];

  const right = addFigures(nieces[0] as Figure, nieces[1] as Figure);
  const left = addFigures(nieces[2] as Figure, nieces[3] as Figure);
  const judge = addFigures(right, left);

  return {
    mothers: [...mothers],
    daughters,
    nieces,
    witnesses: { right, left },
    judge,
    reconciler: addFigures(judge, mothers[0] as Figure),
  };
}

/**
 * シールドチャートを立てる。
 *
 * 乱数はここでしか回さない（LLM に立てさせない）。回すのも母 4 つぶんの 16 ビットだけで、
 * 残りは buildShieldChart の導出に任せる。
 */
export function castGeomancy(random: RandomSource = cryptoRandom): ShieldChart {
  return buildShieldChart(castMothers(random));
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** Puer（少年）•|•|••|• */
function figureLabel(figure: Figure): string {
  return `${figure.latin}（${figure.name}）${figure.glyph}`;
}

/** 1 Via（道）•|•|•|•  2 …  3 …  4 … */
function numberedFigures(figures: readonly Figure[]): string {
  return figures.map((figure, index) => `${index + 1} ${figureLabel(figure)}`).join("  ");
}

/**
 * Claude が読む用のテキスト表現。
 *
 * 意味は載せない ―― 図形の名前と点の並びだけ渡して、読みは呼び出した側に委ねる。
 */
export function formatShieldChartText(chart: ShieldChart): string {
  return [
    "ジオマンシー / シールドチャート",
    `母: ${numberedFigures(chart.mothers)}`,
    `娘: ${numberedFigures(chart.daughters)}`,
    `姪: ${numberedFigures(chart.nieces)}`,
    `証人: 右 ${figureLabel(chart.witnesses.right)}  左 ${figureLabel(chart.witnesses.left)}`,
    `裁判官: ${figureLabel(chart.judge)}`,
    `和解者（参考）: ${figureLabel(chart.reconciler)}`,
  ].join("\n");
}
