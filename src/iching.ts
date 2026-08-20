/**
 * 易（周易）の立筮（純関数）。
 *
 * 背骨は draw.ts と同じ ―― 立てるのはサーバー、読むのは呼び出した側の Claude。
 * ここは六爻を乱数で出して本卦・変爻・之卦・互卦を組み立てるだけで、
 * 卦辞も爻辞も占断も持たない。
 *
 * 三つの立て方（method）は確率がそれぞれ違い、そこが易の味なので手順ごとシミュレートする。
 * 確率表から答えを直接引かないのは、出目（コインの表裏・筮竹の本数）も返すため。
 *
 *  - coins    擲銭法: コイン 3 枚を 6 回。6/7/8/9 が 1:3:3:1
 *  - yarrow   本筮法: 筮竹 50 本の三変を 6 回。老陰1/16・少陽5/16・少陰7/16・老陽3/16
 *  - abridged 略筮法: 筮竹で下卦・上卦・変爻を 1 回ずつ。変爻はちょうど 1 本
 */
import { cryptoRandom, type RandomSource } from "./random";
import { hexagramByBits, trigramByNumber, type Hexagram, type Trigram } from "./hexagrams";

/** 立て方の id。既定は coins */
export const CAST_METHOD_IDS = ["coins", "yarrow", "abridged"] as const;
export type CastMethodId = (typeof CAST_METHOD_IDS)[number];

const METHOD_NAMES: Record<CastMethodId, string> = {
  coins: "擲銭法",
  yarrow: "本筮法",
  abridged: "略筮法",
};

/** 爻の数値。6=老陰・7=少陽・8=少陰・9=老陽（老＝変爻） */
export type LineValue = 6 | 7 | 8 | 9;

const VALUE_NAMES: Record<LineValue, string> = {
  6: "老陰",
  7: "少陽",
  8: "少陰",
  9: "老陽",
};

/** 爻の位の呼び名（初爻から上爻へ） */
const POSITION_NAMES = ["初", "二", "三", "四", "五", "上"];

/** 入力が受け付けられなかったときのエラー（JSON-RPC ではなく isError で返す。DrawError と同じ扱い） */
export class CastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastError";
  }
}

/** 本筮法の過程（三変で除いた本数と、手元に残った本数） */
export interface YarrowProcess {
  /** 一変・二変・三変で除いた本数。合計 = 49 - remaining */
  removed: number[];
  /** 三変を終えて残った本数（24 / 28 / 32 / 36）。これを 4 で割ると爻の数値になる */
  remaining: number;
}

export interface HexagramLine {
  /** 1（初爻）〜6（上爻） */
  position: number;
  value: LineValue;
  yin_yang: "yin" | "yang";
  /** 老陽・老陰なら true（之卦で反転する爻） */
  changing: boolean;
  /** 伝統表記。陽=九・陰=六、位は 初/二/三/四/五/上（例: 初九・六二・上六） */
  label: string;
  /** 擲銭法のみ。コイン 3 枚の出目（表=3・裏=2） */
  coins?: number[];
  /** 本筮法のみ。三変の過程 */
  yarrow?: YarrowProcess;
}

/** 返り値用の八卦（内部のビット列は落とす） */
export interface TrigramView {
  number: number;
  name: string;
  nature: string;
  symbol: string;
}

/** 返り値用の卦 */
export interface HexagramView {
  number: number;
  name: string;
  symbol: string;
  upper: TrigramView;
  lower: TrigramView;
}

/** 略筮法の過程（卦ぜんたいで 3 回引くので、爻ではなくここに載る） */
export interface AbridgedProcess {
  /** 下卦: 数えた筮竹の本数と、そこから出た先天八卦の番号 */
  lower: { stalks: number; number: number };
  /** 上卦: 同上 */
  upper: { stalks: number; number: number };
  /** 変爻: 数えた筮竹の本数と、そこから出た爻の位（1〜6） */
  changing: { stalks: number; position: number };
}

export interface CastResult {
  method: { id: CastMethodId; name: string };
  /** 立てた時刻（ISO 8601） */
  cast_at: string;
  /** 初爻から上爻へ 6 本 */
  lines: HexagramLine[];
  /** 本卦 */
  primary: HexagramView;
  /** 変爻の位（無ければ空配列） */
  changing_lines: number[];
  /** 之卦。変爻が無ければ null */
  resulting: HexagramView | null;
  /** 互卦（2・3・4 爻を下卦、3・4・5 爻を上卦にしたもの） */
  nuclear: HexagramView;
  /** 略筮法のみ */
  abridged?: AbridgedProcess;
}

export interface CastOptions {
  method?: string;
}

// ---------------------------------------------------------------------------
// 爻を出す
// ---------------------------------------------------------------------------

/**
 * count を divisor で数えた余り。ただし 0 は divisor 扱い（筮法の作法）。
 * mod 4 / mod 8 / mod 6 のいずれもこの数え方をする。
 */
function remainder(count: number, divisor: number): number {
  return ((count + divisor - 1) % divisor) + 1;
}

function buildLine(position: number, value: LineValue): HexagramLine {
  const isYang = value === 7 || value === 9;
  return {
    position,
    value,
    yin_yang: isYang ? "yang" : "yin",
    // 老陽（9）・老陰（6）が変爻。少陽（7）・少陰（8）は動かない
    changing: value === 6 || value === 9,
    label: lineLabel(position, isYang),
  };
}

/** 初爻と上爻は位が先（初九・上六）、二〜五爻は陰陽が先（九二・六三） */
function lineLabel(position: number, isYang: boolean): string {
  const yinYang = isYang ? "九" : "六";
  const place = POSITION_NAMES[position - 1] ?? String(position);
  return position === 1 || position === 6 ? `${place}${yinYang}` : `${yinYang}${place}`;
}

/**
 * 擲銭法。コイン 3 枚を 1 爻ぶんずつ投げる。
 * 表=3・裏=2 の合計で 6（老陰）/7（少陽）/8（少陰）/9（老陽）＝ 1:3:3:1。
 * 出目そのものを返すので、確率表から直接引かず 1 枚ずつ乱数を回す。
 */
function castLinesByCoins(random: RandomSource): HexagramLine[] {
  const lines: HexagramLine[] = [];
  for (let position = 1; position <= 6; position++) {
    const coins: number[] = [0, 1, 2].map(() => (random.int(2) === 1 ? 3 : 2));
    const total = coins.reduce((sum, face) => sum + face, 0) as LineValue;
    lines.push({ ...buildLine(position, total), coins });
  }
  return lines;
}

/** 大衍の数 50。うち 1 本は使わずに置くので、手元は 49 本から始まる */
const YARROW_TOTAL = 50;
const YARROW_IN_HAND = YARROW_TOTAL - 1;

/**
 * 本筮法の一変。
 *
 * 手元の筮竹を左右に分け（どちらの山も 1 本以上）、右の山から 1 本を抜いて指に挟み（掛一）、
 * 左右それぞれを 4 本ずつ数えた余り（0 は 4 扱い）を取り除く。取り除いた合計を返す。
 * 一変は 5 か 9、二変・三変は 4 か 8 にしかならない。
 *
 * ※ 分け方は一様乱数。山を空にできない都合で、二変・三変の 4/8 は厳密な 1/2 から
 *   数％だけずれる（手で分けても同じことが起きる範囲のずれ）。
 */
function yarrowChange(stalks: number, random: RandomSource): number {
  const left = 1 + random.int(stalks - 1); // 1..stalks-1（右の山も 1 本以上残る）
  const right = stalks - left - 1; // 掛一の 1 本を抜いた右の山
  return 1 + remainder(left, 4) + remainder(right, 4);
}

/**
 * 本筮法。1 爻につき三変を行い、残った本数を 4 で割って爻の数値にする。
 * 残りは必ず 24 / 28 / 32 / 36 のどれかなので、6〜9 の外には出ない。
 */
function castLinesByYarrow(random: RandomSource): HexagramLine[] {
  const lines: HexagramLine[] = [];
  for (let position = 1; position <= 6; position++) {
    let stalks = YARROW_IN_HAND;
    const removed: number[] = [];
    for (let change = 0; change < 3; change++) {
      const cut = yarrowChange(stalks, random);
      removed.push(cut);
      stalks -= cut;
    }
    const value = (stalks / 4) as LineValue;
    lines.push({ ...buildLine(position, value), yarrow: { removed, remaining: stalks } });
  }
  return lines;
}

/** 略筮法の一手。筮竹を二分して片方の山の本数を数える（どちらの山も 1 本以上） */
function countStalks(random: RandomSource): number {
  return 1 + random.int(YARROW_IN_HAND - 1); // 1..48（mod 8 も mod 6 も割り切れる幅）
}

/**
 * 略筮法。下卦（mod 8）・上卦（mod 8）・変爻（mod 6）を順に得る。0 は 8 / 6 扱い。
 * 八卦の番号は先天八卦の順（乾1・兌2・離3・震4・巽5・坎6・艮7・坤8）。
 * 変爻はちょうど 1 本で、その爻だけ老（陽なら 9・陰なら 6）、ほかは少（7 / 8）になる。
 */
function castByAbridged(random: RandomSource): {
  lines: HexagramLine[];
  abridged: AbridgedProcess;
} {
  const lowerStalks = countStalks(random);
  const lowerNumber = remainder(lowerStalks, 8);
  const upperStalks = countStalks(random);
  const upperNumber = remainder(upperStalks, 8);
  const changingStalks = countStalks(random);
  const changingPosition = remainder(changingStalks, 6);

  const lower = trigramByNumber(lowerNumber);
  const upper = trigramByNumber(upperNumber);
  const bits = lower.bits | (upper.bits << 3);

  const lines: HexagramLine[] = [];
  for (let position = 1; position <= 6; position++) {
    const isYang = ((bits >> (position - 1)) & 1) === 1;
    const changing = position === changingPosition;
    const value: LineValue = changing ? (isYang ? 9 : 6) : isYang ? 7 : 8;
    lines.push(buildLine(position, value));
  }

  return {
    lines,
    abridged: {
      lower: { stalks: lowerStalks, number: lowerNumber },
      upper: { stalks: upperStalks, number: upperNumber },
      changing: { stalks: changingStalks, position: changingPosition },
    },
  };
}

// ---------------------------------------------------------------------------
// 卦を組み立てる
// ---------------------------------------------------------------------------

/** 六爻をビット列にする（初爻が bit0・陽=1） */
function linesToBits(lines: readonly HexagramLine[]): number {
  let bits = 0;
  for (const line of lines) {
    if (line.yin_yang === "yang") bits |= 1 << (line.position - 1);
  }
  return bits;
}

/** 之卦のビット列（変爻だけ陰陽を入れ替える） */
function changedBits(bits: number, changingPositions: readonly number[]): number {
  let next = bits;
  for (const position of changingPositions) next ^= 1 << (position - 1);
  return next;
}

/** 互卦のビット列（2・3・4 爻が下卦、3・4・5 爻が上卦） */
function nuclearBits(bits: number): number {
  const bit = (position: number) => (bits >> (position - 1)) & 1;
  const lower = bit(2) | (bit(3) << 1) | (bit(4) << 2);
  const upper = bit(3) | (bit(4) << 1) | (bit(5) << 2);
  return lower | (upper << 3);
}

function trigramView(trigram: Trigram): TrigramView {
  return {
    number: trigram.number,
    name: trigram.name,
    nature: trigram.nature,
    symbol: trigram.symbol,
  };
}

function hexagramView(hexagram: Hexagram): HexagramView {
  return {
    number: hexagram.number,
    name: hexagram.name,
    symbol: hexagram.symbol,
    upper: trigramView(hexagram.upper),
    lower: trigramView(hexagram.lower),
  };
}

function resolveMethod(raw: string | undefined): CastMethodId {
  if (raw === undefined) return "coins";
  const found = CAST_METHOD_IDS.find((id) => id === raw);
  if (!found) {
    throw new CastError(`知らない立て方です: ${raw}（${CAST_METHOD_IDS.join(" / ")}）`);
  }
  return found;
}

/**
 * 卦を立てる。
 *
 * 乱数はここでしか回さない（LLM に振らせない）。method を省くと擲銭法。
 */
export function castHexagram(
  options: CastOptions = {},
  random: RandomSource = cryptoRandom,
): CastResult {
  const methodId = resolveMethod(options.method);

  let lines: HexagramLine[];
  let abridged: AbridgedProcess | undefined;
  if (methodId === "coins") {
    lines = castLinesByCoins(random);
  } else if (methodId === "yarrow") {
    lines = castLinesByYarrow(random);
  } else {
    const cast = castByAbridged(random);
    lines = cast.lines;
    abridged = cast.abridged;
  }

  const primaryBits = linesToBits(lines);
  const changing = lines.filter((line) => line.changing).map((line) => line.position);

  const result: CastResult = {
    method: { id: methodId, name: METHOD_NAMES[methodId] },
    cast_at: new Date().toISOString(),
    lines,
    primary: hexagramView(hexagramByBits(primaryBits)),
    changing_lines: changing,
    resulting:
      changing.length > 0
        ? hexagramView(hexagramByBits(changedBits(primaryBits, changing)))
        : null,
    nuclear: hexagramView(hexagramByBits(nuclearBits(primaryBits))),
  };
  if (abridged) result.abridged = abridged;
  return result;
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** 第3卦 水雷屯 ䷂ */
function hexagramLabel(hexagram: HexagramView): string {
  return `第${hexagram.number}卦 ${hexagram.name} ${hexagram.symbol}`;
}

/** 坎☵ 水 */
function trigramLabel(trigram: TrigramView): string {
  return `${trigram.name}${trigram.symbol} ${trigram.nature}`;
}

/** 変爻だけ（老陽・変）を添える。少陽・少陰は素の label のまま */
function lineLabelWithNote(line: HexagramLine): string {
  return line.changing ? `${line.label}（${VALUE_NAMES[line.value]}・変）` : line.label;
}

/** 出目・筮竹の本数を 1 行にまとめる（テキストの末尾に置く）。無ければ空 */
function processLine(result: CastResult): string | null {
  if (result.method.id === "coins") {
    const throws = result.lines.map((line) => (line.coins ?? []).join("+"));
    return `出目: ${throws.join(", ")}`;
  }
  if (result.method.id === "yarrow") {
    const changes = result.lines.map((line) =>
      line.yarrow ? `${line.yarrow.removed.join("-")}→${line.yarrow.remaining}` : "",
    );
    return `筮竹: ${changes.join(", ")}`;
  }
  const abridged = result.abridged;
  if (!abridged) return null;
  return (
    `筮竹: 下卦 ${abridged.lower.stalks}→${abridged.lower.number}` +
    `, 上卦 ${abridged.upper.stalks}→${abridged.upper.number}` +
    `, 変爻 ${abridged.changing.stalks}→${abridged.changing.position}`
  );
}

/**
 * Claude が読む用のテキスト表現。
 *
 * 卦辞・爻辞は載せない ―― 卦名と爻の並びだけ渡して、読みは呼び出した側に委ねる。
 * 変爻が無いときは「変爻: なし」で止め、之卦の行そのものを出さない。
 */
export function formatCastResult(result: CastResult): string {
  const lines = [`易（${result.method.name}）`];

  lines.push(
    `本卦: ${hexagramLabel(result.primary)}` +
      `（上: ${trigramLabel(result.primary.upper)} / 下: ${trigramLabel(result.primary.lower)}）`,
  );
  lines.push(`爻: ${result.lines.map(lineLabelWithNote).join(" ")}`);

  if (result.changing_lines.length === 0) {
    lines.push("変爻: なし");
  } else {
    const places = result.changing_lines.map(
      (position) => `${POSITION_NAMES[position - 1] ?? position}爻`,
    );
    lines.push(`変爻: ${places.join("・")}`);
    if (result.resulting) lines.push(`之卦: ${hexagramLabel(result.resulting)}`);
  }

  lines.push(`互卦: ${hexagramLabel(result.nuclear)}`);

  const process = processLine(result);
  if (process) lines.push(process);

  return lines.join("\n");
}
