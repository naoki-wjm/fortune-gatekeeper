/**
 * 易（周易）の卦の台帳。
 *
 * 持っているのは六十四卦の「見出し」だけ——番号（序卦＝King Wen の順）・卦名・上下の八卦・
 * Unicode 記号。卦辞・爻辞・彖伝のたぐいは一切持たない。読むのは呼び出した側の Claude。
 * 六十四卦の名前は古典なので、権利の心配なくここに置ける（デッキ JSON の事情とは別）。
 *
 * ビット列の約束: 初爻（いちばん下）が bit0、上爻が bit5。陽=1・陰=0。
 * 例: 水雷屯（下が震・上が坎）は 0b010001。
 * この約束で 0〜63 と六十四卦が 1 対 1 に対応するので、爻を出したら番号を引ける。
 */

export interface Trigram {
  /** 先天八卦の番号（乾1・兌2・離3・震4・巽5・坎6・艮7・坤8） */
  number: number;
  /** 卦名（乾・兌・離・震・巽・坎・艮・坤） */
  name: string;
  /** あてる自然物（天・沢・火・雷・風・水・山・地） */
  nature: string;
  /** Unicode の八卦記号（U+2630〜U+2637） */
  symbol: string;
  /** 3 爻のビット列（初爻が bit0・陽=1） */
  bits: number;
}

/** 八卦。並びは先天八卦の順（＝ number の順） */
export const TRIGRAMS: readonly Trigram[] = [
  { number: 1, name: "乾", nature: "天", symbol: "☰", bits: 0b111 },
  { number: 2, name: "兌", nature: "沢", symbol: "☱", bits: 0b011 },
  { number: 3, name: "離", nature: "火", symbol: "☲", bits: 0b101 },
  { number: 4, name: "震", nature: "雷", symbol: "☳", bits: 0b001 },
  { number: 5, name: "巽", nature: "風", symbol: "☴", bits: 0b110 },
  { number: 6, name: "坎", nature: "水", symbol: "☵", bits: 0b010 },
  { number: 7, name: "艮", nature: "山", symbol: "☶", bits: 0b100 },
  { number: 8, name: "坤", nature: "地", symbol: "☷", bits: 0b000 },
];

const TRIGRAM_BY_NUMBER = new Map(TRIGRAMS.map((trigram) => [trigram.number, trigram]));
const TRIGRAM_BY_NAME = new Map(TRIGRAMS.map((trigram) => [trigram.name, trigram]));
const TRIGRAM_BY_BITS = new Map(TRIGRAMS.map((trigram) => [trigram.bits, trigram]));

/** 先天八卦の番号（1〜8）から八卦を引く。範囲外は例外 */
export function trigramByNumber(number: number): Trigram {
  const trigram = TRIGRAM_BY_NUMBER.get(number);
  if (!trigram) throw new RangeError(`先天八卦の番号は 1〜8 です: ${number}`);
  return trigram;
}

/** 3 爻のビット列（0〜7）から八卦を引く。範囲外は例外 */
export function trigramByBits(bits: number): Trigram {
  const trigram = TRIGRAM_BY_BITS.get(bits);
  if (!trigram) throw new RangeError(`八卦のビット列は 0〜7 です: ${bits}`);
  return trigram;
}

export interface Hexagram {
  /** 序卦（King Wen）の番号。1〜64 */
  number: number;
  /** 卦名（例: 水雷屯）。沢は「沢」で統一（「澤」は使わない） */
  name: string;
  /** Unicode の六十四卦記号。U+4DC0 から番号順に並んでいる */
  symbol: string;
  upper: Trigram;
  lower: Trigram;
  /** 6 爻のビット列（初爻が bit0・陽=1） */
  bits: number;
}

/** 表の素。並び順がそのまま序卦の番号になる */
const HEXAGRAM_TABLE: readonly { name: string; upper: string; lower: string; symbol: string }[] = [
  { name: "乾為天", upper: "乾", lower: "乾", symbol: "䷀" },
  { name: "坤為地", upper: "坤", lower: "坤", symbol: "䷁" },
  { name: "水雷屯", upper: "坎", lower: "震", symbol: "䷂" },
  { name: "山水蒙", upper: "艮", lower: "坎", symbol: "䷃" },
  { name: "水天需", upper: "坎", lower: "乾", symbol: "䷄" },
  { name: "天水訟", upper: "乾", lower: "坎", symbol: "䷅" },
  { name: "地水師", upper: "坤", lower: "坎", symbol: "䷆" },
  { name: "水地比", upper: "坎", lower: "坤", symbol: "䷇" },
  { name: "風天小畜", upper: "巽", lower: "乾", symbol: "䷈" },
  { name: "天沢履", upper: "乾", lower: "兌", symbol: "䷉" },
  { name: "地天泰", upper: "坤", lower: "乾", symbol: "䷊" },
  { name: "天地否", upper: "乾", lower: "坤", symbol: "䷋" },
  { name: "天火同人", upper: "乾", lower: "離", symbol: "䷌" },
  { name: "火天大有", upper: "離", lower: "乾", symbol: "䷍" },
  { name: "地山謙", upper: "坤", lower: "艮", symbol: "䷎" },
  { name: "雷地予", upper: "震", lower: "坤", symbol: "䷏" },
  { name: "沢雷随", upper: "兌", lower: "震", symbol: "䷐" },
  { name: "山風蠱", upper: "艮", lower: "巽", symbol: "䷑" },
  { name: "地沢臨", upper: "坤", lower: "兌", symbol: "䷒" },
  { name: "風地観", upper: "巽", lower: "坤", symbol: "䷓" },
  { name: "火雷噬嗑", upper: "離", lower: "震", symbol: "䷔" },
  { name: "山火賁", upper: "艮", lower: "離", symbol: "䷕" },
  { name: "山地剝", upper: "艮", lower: "坤", symbol: "䷖" },
  { name: "地雷復", upper: "坤", lower: "震", symbol: "䷗" },
  { name: "天雷无妄", upper: "乾", lower: "震", symbol: "䷘" },
  { name: "山天大畜", upper: "艮", lower: "乾", symbol: "䷙" },
  { name: "山雷頤", upper: "艮", lower: "震", symbol: "䷚" },
  { name: "沢風大過", upper: "兌", lower: "巽", symbol: "䷛" },
  { name: "坎為水", upper: "坎", lower: "坎", symbol: "䷜" },
  { name: "離為火", upper: "離", lower: "離", symbol: "䷝" },
  { name: "沢山咸", upper: "兌", lower: "艮", symbol: "䷞" },
  { name: "雷風恒", upper: "震", lower: "巽", symbol: "䷟" },
  { name: "天山遯", upper: "乾", lower: "艮", symbol: "䷠" },
  { name: "雷天大壮", upper: "震", lower: "乾", symbol: "䷡" },
  { name: "火地晋", upper: "離", lower: "坤", symbol: "䷢" },
  { name: "地火明夷", upper: "坤", lower: "離", symbol: "䷣" },
  { name: "風火家人", upper: "巽", lower: "離", symbol: "䷤" },
  { name: "火沢睽", upper: "離", lower: "兌", symbol: "䷥" },
  { name: "水山蹇", upper: "坎", lower: "艮", symbol: "䷦" },
  { name: "雷水解", upper: "震", lower: "坎", symbol: "䷧" },
  { name: "山沢損", upper: "艮", lower: "兌", symbol: "䷨" },
  { name: "風雷益", upper: "巽", lower: "震", symbol: "䷩" },
  { name: "沢天夬", upper: "兌", lower: "乾", symbol: "䷪" },
  { name: "天風姤", upper: "乾", lower: "巽", symbol: "䷫" },
  { name: "沢地萃", upper: "兌", lower: "坤", symbol: "䷬" },
  { name: "地風升", upper: "坤", lower: "巽", symbol: "䷭" },
  { name: "沢水困", upper: "兌", lower: "坎", symbol: "䷮" },
  { name: "水風井", upper: "坎", lower: "巽", symbol: "䷯" },
  { name: "沢火革", upper: "兌", lower: "離", symbol: "䷰" },
  { name: "火風鼎", upper: "離", lower: "巽", symbol: "䷱" },
  { name: "震為雷", upper: "震", lower: "震", symbol: "䷲" },
  { name: "艮為山", upper: "艮", lower: "艮", symbol: "䷳" },
  { name: "風山漸", upper: "巽", lower: "艮", symbol: "䷴" },
  { name: "雷沢帰妹", upper: "震", lower: "兌", symbol: "䷵" },
  { name: "雷火豊", upper: "震", lower: "離", symbol: "䷶" },
  { name: "火山旅", upper: "離", lower: "艮", symbol: "䷷" },
  { name: "巽為風", upper: "巽", lower: "巽", symbol: "䷸" },
  { name: "兌為沢", upper: "兌", lower: "兌", symbol: "䷹" },
  { name: "風水渙", upper: "巽", lower: "坎", symbol: "䷺" },
  { name: "水沢節", upper: "坎", lower: "兌", symbol: "䷻" },
  { name: "風沢中孚", upper: "巽", lower: "兌", symbol: "䷼" },
  { name: "雷山小過", upper: "震", lower: "艮", symbol: "䷽" },
  { name: "水火既済", upper: "坎", lower: "離", symbol: "䷾" },
  { name: "火水未済", upper: "離", lower: "坎", symbol: "䷿" },
];

function resolveTrigram(name: string): Trigram {
  const trigram = TRIGRAM_BY_NAME.get(name);
  if (!trigram) throw new RangeError(`知らない八卦です: ${name}`);
  return trigram;
}

/** 六十四卦。並びは序卦（King Wen）の順 */
export const HEXAGRAMS: readonly Hexagram[] = HEXAGRAM_TABLE.map((row, index) => {
  const upper = resolveTrigram(row.upper);
  const lower = resolveTrigram(row.lower);
  return {
    number: index + 1,
    name: row.name,
    symbol: row.symbol,
    upper,
    lower,
    bits: lower.bits | (upper.bits << 3),
  };
});

const HEXAGRAM_BY_BITS = new Map(HEXAGRAMS.map((hexagram) => [hexagram.bits, hexagram]));

/** 6 爻のビット列（0〜63）から卦を引く。範囲外は例外 */
export function hexagramByBits(bits: number): Hexagram {
  const hexagram = HEXAGRAM_BY_BITS.get(bits);
  if (!hexagram) throw new RangeError(`六十四卦のビット列は 0〜63 です: ${bits}`);
  return hexagram;
}

/** 序卦の番号（1〜64）から卦を引く（未知の番号なら undefined） */
export function hexagramByNumber(number: number): Hexagram | undefined {
  return HEXAGRAMS[number - 1];
}
