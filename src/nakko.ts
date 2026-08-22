/**
 * 納甲（断易・五行易）の付け足し（純関数）。
 *
 * 背骨は iching.ts と同じ ―― 立てるのはサーバー、読むのは呼び出した側の Claude。
 * ここは「立卦の日時」と「立った卦」から**導けるものだけ**を並べる係で、
 * 卦辞も爻辞も六親の吉凶も持たない。
 *
 * ⚠ **乱数は 1 ビットも増やさない**。四柱も納甲も世応も六親も六獣も、
 *    すべて日時と卦からの導出＝同じ卦を同じ日時で立てれば必ず同じ表になる。
 *
 * 外から要るものは太陽黄経ひとつだけ（月支と年の境＝立春の判定に使う）。
 * それも立卦の**その瞬間で 1 回**しか呼ばない（sunLongitude）。
 */
import { julianDay, normalizeDegree, type SwissEph } from "./astro/chart";
import { CastError, type CastResult, type HexagramView } from "./iching";
import { TRIGRAMS, trigramByNumber } from "./hexagrams";

// ---------------------------------------------------------------------------
// 干支の台帳
// ---------------------------------------------------------------------------

/** 天干（甲=0） */
export const STEMS: readonly string[] = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];

/** 地支（子=0） */
export const BRANCHES: readonly string[] = [
  "子",
  "丑",
  "寅",
  "卯",
  "辰",
  "巳",
  "午",
  "未",
  "申",
  "酉",
  "戌",
  "亥",
];

/** 地支の五行（子亥＝水・寅卯＝木・巳午＝火・申酉＝金・辰戌丑未＝土） */
const BRANCH_ELEMENTS: readonly string[] = [
  "水", // 子
  "土", // 丑
  "木", // 寅
  "木", // 卯
  "土", // 辰
  "火", // 巳
  "火", // 午
  "土", // 未
  "金", // 申
  "金", // 酉
  "土", // 戌
  "水", // 亥
];

const BRANCH_ELEMENT_BY_NAME = new Map(
  BRANCHES.map((branch, index) => [branch, BRANCH_ELEMENTS[index] as string]),
);

/** 地支の名前 → 五行 */
export function branchElement(branch: string): string {
  const element = BRANCH_ELEMENT_BY_NAME.get(branch);
  if (element === undefined) throw new RangeError(`知らない地支です: ${branch}`);
  return element;
}

/** 相生（木生火生土生金生水生木） */
const GENERATES: Record<string, string> = { 木: "火", 火: "土", 土: "金", 金: "水", 水: "木" };
/** 相剋（木剋土・土剋水・水剋火・火剋金・金剋木） */
const CONTROLS: Record<string, string> = { 木: "土", 土: "水", 水: "火", 火: "金", 金: "木" };

/** 割り算の余り（負の数でも 0 以上 divisor 未満に畳む） */
function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** 60 干支の index（甲子=0）→ 干支 */
export function ganzhiOf(index: number): Pillar {
  const normalized = mod(index, 60);
  const stem = STEMS[normalized % 10] as string;
  const branch = BRANCHES[normalized % 12] as string;
  return { stem, branch, ganzhi: `${stem}${branch}` };
}

function pillarOf(stemIndex: number, branchIndex: number): Pillar {
  const stem = STEMS[mod(stemIndex, 10)] as string;
  const branch = BRANCHES[mod(branchIndex, 12)] as string;
  return { stem, branch, ganzhi: `${stem}${branch}` };
}

// ---------------------------------------------------------------------------
// 日時
// ---------------------------------------------------------------------------

/** 立卦の日時。utcOffset の土地の時計で読む（日本は 9） */
export interface NakkoMoment {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  utcOffset: number;
}

/** 日時を省いたときに使う時差（＝日本時間） */
export const DEFAULT_UTC_OFFSET = 9;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** 各月の日数（[0] は 1 月。2 月だけうるう年で伸びる） */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** グレゴリオ暦のうるう年（4 で割り切れ、100 で割り切れない、または 400 で割り切れる） */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** その月の日数 */
export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] as number;
}

/** その年月日が暦に実在するか（月は 1〜12 で検算済みという前提） */
export function isCalendarDay(year: number, month: number, day: number): boolean {
  return day >= 1 && day <= daysInMonth(year, month);
}

/**
 * 実在しない暦日を弾く。
 *
 * 日の範囲（1〜31）だけでは 2026-02-31 が通ってしまい、日付の計算はそれを黙って
 * 3 月 3 日に繰り上げる ―― 打ち間違いが「別の日の卦」として静かに返ってくるのが困る。
 * （占星術層の同名の関数と同じ規則。あちらのファイルには手を入れない約束なので写した）
 */
export function assertCalendarDay(year: number, month: number, day: number): void {
  if (isCalendarDay(year, month, day)) return;
  throw new CastError(
    `${year}-${pad(month)}-${pad(day)} は暦に存在しない日付です` +
      `（${year}年${month}月は${daysInMonth(year, month)}日まで）`,
  );
}

/**
 * グレゴリオ暦の年月日 → ユリウス日番号（JDN）。
 *
 * JDN は「その日の正午の JD」＝ 暦日と 1 対 1 に対応する整数なので、時刻も時差も要らない
 * （日界は 0 時＝その土地の暦日をそのまま使う、という約束のため）。
 */
export function julianDayNumber(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

/** UTC の Date ＋ 時差 → その土地の時計で読んだ日時 */
export function momentFromDate(now: Date, utcOffset: number): NakkoMoment {
  const shifted = new Date(now.getTime() + utcOffset * 3_600_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    utcOffset,
  };
}

/** 時差 → 「+09:00」「-03:30」（ISO 8601 用） */
function offsetSuffix(utcOffset: number): string {
  const sign = utcOffset < 0 ? "-" : "+";
  const total = Math.round(Math.abs(utcOffset) * 60);
  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** 時差 → 「+9」「-3.5」（読み物用の短い札） */
function offsetLabel(utcOffset: number): string {
  const sign = utcOffset < 0 ? "-" : "+";
  const absolute = Math.abs(utcOffset);
  return `${sign}${Number.isInteger(absolute) ? absolute : absolute.toFixed(1)}`;
}

/** 「2026-08-22T21:30+09:00」 */
export function formatMomentIso(moment: NakkoMoment): string {
  return (
    `${moment.year}-${pad(moment.month)}-${pad(moment.day)}` +
    `T${pad(moment.hour)}:${pad(moment.minute)}${offsetSuffix(moment.utcOffset)}`
  );
}

/**
 * 「2026-08-22 21:30（+9）」。
 * 日付と時刻は ISO 表記（moment.local）から切り出す ―― 同じ値を二度組み立てないため。
 */
function formatMomentPlain(local: string, utcOffset: number): string {
  const [date, time] = local.split("T");
  return `${date} ${(time ?? "").slice(0, 5)}（${offsetLabel(utcOffset)}）`;
}

// ---------------------------------------------------------------------------
// 四柱（年月日時の干支）
// ---------------------------------------------------------------------------

export interface Pillar {
  stem: string;
  branch: string;
  ganzhi: string;
}

export interface FourPillars {
  year: Pillar;
  month: Pillar;
  day: Pillar;
  hour: Pillar;
}

/**
 * 日干支の基点。JDN 0 が甲戌にあたるので (JDN + 49) mod 60 で甲子=0 に揃う。
 * 検算: 2000-01-01（JDN 2451545）→ 54 ＝ 戊午。1949-10-01（JDN 2433191）→ 0 ＝ 甲子。
 */
const DAY_GANZHI_SHIFT = 49;

/** 暦日 → 日干支の index（甲子=0）。日界は 0 時＝23 時台も「その日」のまま */
export function dayGanzhiIndex(year: number, month: number, day: number): number {
  return mod(julianDayNumber(year, month, day) + DAY_GANZHI_SHIFT, 60);
}

/**
 * 時支の index（子=0）。23:00〜00:59 が子、01:00〜02:59 が丑 …… 21:00〜22:59 が亥。
 * 23 時台は子だが**日は繰り上げない**（日干支も時干の起こしも「その日」のまま）。
 */
export function hourBranchIndex(hour: number): number {
  return Math.floor(mod(hour + 1, 24) / 2);
}

/**
 * 月支の index（0=寅、1=卯 …… 11=丑）。太陽黄経 315°（立春）を寅月の頭に置く。
 * 節入りの時刻を暦から引かず黄経そのもので切るので、境の日でも時刻ぶんまで正しい。
 */
export function monthBranchOrder(sunLongitude: number): number {
  return Math.floor(mod(sunLongitude - 315, 360) / 30);
}

/**
 * 立春の前か（＝暦年より 1 つ前の年干支を使うか）。
 *
 * 太陽黄経 270°（冬至）〜315°（立春）の帯のうち、暦の 1〜2 月にあたるところが「立春前」。
 * 同じ帯でも 12 月は暦年と年干支がそろっているので触らない。
 */
export function isBeforeRisshun(sunLongitude: number, month: number): boolean {
  const lon = normalizeDegree(sunLongitude);
  return lon >= 270 && lon < 315 && (month === 1 || month === 2);
}

/**
 * 四柱（年・月・日・時の干支）。
 *
 *  - 年: 立春基準（(年 − 4) mod 60、1984 が甲子）。立春前は前年扱い
 *  - 月: 月支は太陽黄経から、月干は年干からの五虎遁（甲己→丙寅・乙庚→戊寅・丙辛→庚寅・丁壬→壬寅・戊癸→甲寅）
 *  - 日: JDN から。日界は 0 時
 *  - 時: 時支は 2 時間刻み（23 時から子）、時干は日干からの五鼠遁（甲己→甲子・乙庚→丙子・丙辛→戊子・丁壬→庚子・戊癸→壬子）
 */
export function fourPillars(moment: NakkoMoment, sunLongitude: number): FourPillars {
  const solarYear = isBeforeRisshun(sunLongitude, moment.month) ? moment.year - 1 : moment.year;
  const yearIndex = mod(solarYear - 4, 60);
  const year = ganzhiOf(yearIndex);

  // 五虎遁: 年干 甲己 の寅月が丙寅、以下 2 干ずつ進む
  const monthOrder = monthBranchOrder(sunLongitude);
  const tigerStem = ((yearIndex % 10) % 5) * 2 + 2;
  const month = pillarOf(tigerStem + monthOrder, monthOrder + 2);

  const dayIndex = dayGanzhiIndex(moment.year, moment.month, moment.day);
  const day = ganzhiOf(dayIndex);

  // 五鼠遁: 日干 甲己 の子刻が甲子、以下 2 干ずつ進む
  const branchOrder = hourBranchIndex(moment.hour);
  const ratStem = ((dayIndex % 10) % 5) * 2;
  const hour = pillarOf(ratStem + branchOrder, branchOrder);

  return { year, month, day, hour };
}

// ---------------------------------------------------------------------------
// 納甲（八卦ごとの干支の配当）
// ---------------------------------------------------------------------------

interface TrigramNakko {
  /** 内卦（初・二・三爻）に付く干と支 */
  inner: { stem: string; branches: readonly string[] };
  /** 外卦（四・五・上爻）に付く干と支 */
  outer: { stem: string; branches: readonly string[] };
}

/**
 * 八卦の納甲表（支はどちらも初爻側から）。
 *
 * 陽の卦（乾震坎艮）は 2 支ずつ順行、陰の卦（坤巽離兌）は 2 支ずつ逆行する。
 * 乾だけ内 甲・外 壬、坤だけ内 乙・外 癸で、あとは内外とも同じ干。
 */
export const TRIGRAM_NAKKO: Readonly<Record<string, TrigramNakko>> = {
  乾: {
    inner: { stem: "甲", branches: ["子", "寅", "辰"] },
    outer: { stem: "壬", branches: ["午", "申", "戌"] },
  },
  坤: {
    inner: { stem: "乙", branches: ["未", "巳", "卯"] },
    outer: { stem: "癸", branches: ["丑", "亥", "酉"] },
  },
  震: {
    inner: { stem: "庚", branches: ["子", "寅", "辰"] },
    outer: { stem: "庚", branches: ["午", "申", "戌"] },
  },
  巽: {
    inner: { stem: "辛", branches: ["丑", "亥", "酉"] },
    outer: { stem: "辛", branches: ["未", "巳", "卯"] },
  },
  坎: {
    inner: { stem: "戊", branches: ["寅", "辰", "午"] },
    outer: { stem: "戊", branches: ["申", "戌", "子"] },
  },
  離: {
    inner: { stem: "己", branches: ["卯", "丑", "亥"] },
    outer: { stem: "己", branches: ["酉", "未", "巳"] },
  },
  艮: {
    inner: { stem: "丙", branches: ["辰", "午", "申"] },
    outer: { stem: "丙", branches: ["戌", "子", "寅"] },
  },
  兌: {
    inner: { stem: "丁", branches: ["巳", "卯", "丑"] },
    outer: { stem: "丁", branches: ["亥", "酉", "未"] },
  },
};

/** 爻の位（1〜6）に付く納甲干支。1〜3 は下卦の内、4〜6 は上卦の外から取る */
export function nakkoOfLine(
  lowerTrigram: string,
  upperTrigram: string,
  position: number,
): { stem: string; branch: string } {
  const inner = position <= 3;
  const table = TRIGRAM_NAKKO[inner ? lowerTrigram : upperTrigram];
  if (!table) throw new RangeError(`知らない八卦です: ${inner ? lowerTrigram : upperTrigram}`);
  const part = inner ? table.inner : table.outer;
  return { stem: part.stem, branch: part.branches[(position - 1) % 3] as string };
}

// ---------------------------------------------------------------------------
// 八宮（世応）
// ---------------------------------------------------------------------------

/** 八宮。並びは八純卦の順（乾・兌・離・震・巽・坎・艮・坤）と、その宮の五行 */
export const PALACES: readonly { trigram: string; element: string }[] = [
  { trigram: "乾", element: "金" },
  { trigram: "兌", element: "金" },
  { trigram: "離", element: "火" },
  { trigram: "震", element: "木" },
  { trigram: "巽", element: "木" },
  { trigram: "坎", element: "水" },
  { trigram: "艮", element: "土" },
  { trigram: "坤", element: "土" },
];

/**
 * 世の代（八純卦から爻を反転していく順）。
 *
 * 一世＝初爻、二世＝初〜二爻、…… 五世＝初〜五爻を反転。
 * 遊魂は五世から四爻を戻したもの（＝反転が 1・2・3・5 爻）、
 * 帰魂は遊魂の内卦を本宮に戻したもの（＝反転が 5 爻だけ）。
 */
const GENERATIONS: readonly { name: string; flips: readonly number[]; self: number }[] = [
  { name: "本宮", flips: [], self: 6 },
  { name: "一世", flips: [1], self: 1 },
  { name: "二世", flips: [1, 2], self: 2 },
  { name: "三世", flips: [1, 2, 3], self: 3 },
  { name: "四世", flips: [1, 2, 3, 4], self: 4 },
  { name: "五世", flips: [1, 2, 3, 4, 5], self: 5 },
  { name: "遊魂", flips: [1, 2, 3, 5], self: 4 },
  { name: "帰魂", flips: [5], self: 3 },
];

export interface PalaceView {
  /** 「乾宮」 */
  name: string;
  /** 宮の五行（六親を測る「我」） */
  element: string;
  /** 本宮 / 一世 …… 五世 / 遊魂 / 帰魂 */
  generation: string;
}

interface PalaceEntry extends PalaceView {
  /** 世爻の位（1〜6） */
  self: number;
  /** 応爻の位（世から 3 つ隔てた爻） */
  other: number;
}

const TRIGRAM_BITS = new Map(TRIGRAMS.map((trigram) => [trigram.name, trigram.bits]));

/** 応爻＝世爻から 3 つ隔てた爻（6 を超えたら 6 を引く） */
function otherLineOf(self: number): number {
  const other = self + 3;
  return other > 6 ? other - 6 : other;
}

/** 六十四卦のビット列 → その卦が属する宮と代。8 宮 × 8 代でちょうど 64 卦を埋める */
const PALACE_BY_BITS = new Map<number, PalaceEntry>(
  PALACES.flatMap((palace) => {
    const pure = TRIGRAM_BITS.get(palace.trigram) as number;
    const pureBits = pure | (pure << 3);
    return GENERATIONS.map((generation) => {
      let bits = pureBits;
      for (const position of generation.flips) bits ^= 1 << (position - 1);
      const entry: PalaceEntry = {
        name: `${palace.trigram}宮`,
        element: palace.element,
        generation: generation.name,
        self: generation.self,
        other: otherLineOf(generation.self),
      };
      return [bits, entry] as [number, PalaceEntry];
    });
  }),
);

/** 六十四卦のビット列（初爻が bit0・陽=1）から宮を引く */
export function palaceByBits(bits: number): PalaceEntry {
  const entry = PALACE_BY_BITS.get(bits);
  if (!entry) throw new RangeError(`六十四卦のビット列は 0〜63 です: ${bits}`);
  return entry;
}

/** 卦（返り値用のビュー）のビット列。上下の八卦の番号から組み直す */
export function bitsOfHexagramView(view: HexagramView): number {
  const lower = trigramByNumber(view.lower.number);
  const upper = trigramByNumber(view.upper.number);
  return lower.bits | (upper.bits << 3);
}

// ---------------------------------------------------------------------------
// 六親・六獣
// ---------------------------------------------------------------------------

/**
 * 六親。宮の五行を「我」として、爻の地支の五行と比べる。
 * 同＝兄弟／我生＝子孫／生我＝父母／我剋＝妻財／剋我＝官鬼。
 */
export function relationOf(palaceElement: string, lineElement: string): string {
  if (palaceElement === lineElement) return "兄弟";
  if (GENERATES[palaceElement] === lineElement) return "子孫";
  if (GENERATES[lineElement] === palaceElement) return "父母";
  if (CONTROLS[palaceElement] === lineElement) return "妻財";
  if (CONTROLS[lineElement] === palaceElement) return "官鬼";
  throw new RangeError(`五行の組が読めません: ${palaceElement} と ${lineElement}`);
}

/** 六獣。初爻から上へこの順に巡る */
export const BEASTS: readonly string[] = ["青龍", "朱雀", "勾陳", "螣蛇", "白虎", "玄武"];

/** 日干（甲=0）→ 初爻に置く六獣の index。甲乙→青龍・丙丁→朱雀・戊→勾陳・己→螣蛇・庚辛→白虎・壬癸→玄武 */
const BEAST_START_BY_STEM: readonly number[] = [0, 0, 1, 1, 2, 3, 4, 4, 5, 5];

/** 日干の名前から、初爻に置く六獣の index */
export function beastStartIndex(dayStem: string): number {
  const stemIndex = STEMS.indexOf(dayStem);
  if (stemIndex < 0) throw new RangeError(`知らない天干です: ${dayStem}`);
  return BEAST_START_BY_STEM[stemIndex] as number;
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/** 爻の位の呼び名（初爻から上爻へ） */
const POSITION_LABELS: readonly string[] = ["初爻", "二爻", "三爻", "四爻", "五爻", "上爻"];

export interface NakkoLine {
  /** 1（初爻）〜6（上爻） */
  position: number;
  label: string;
  stem: string;
  branch: string;
  /** 地支の五行 */
  element: string;
  /** 六親（兄弟・子孫・父母・妻財・官鬼） */
  relation: string;
  /** 六獣（青龍・朱雀・勾陳・螣蛇・白虎・玄武） */
  beast: string;
  is_self: boolean;
  is_other: boolean;
}

/** 之卦の爻（世応も六獣も持たない。六親は本卦の宮で付ける） */
export interface NakkoChangedLine {
  position: number;
  label: string;
  stem: string;
  branch: string;
  element: string;
  relation: string;
}

export interface NakkoView {
  moment: { local: string; utc_offset: number };
  pillars: FourPillars;
  /** 立卦の瞬間の太陽黄経（度）。月支と年の境の根拠 */
  sun_longitude: number;
  palace: PalaceView;
  /** 世爻の位（1〜6） */
  self_line: number;
  /** 応爻の位（1〜6） */
  other_line: number;
  /** 初爻から上爻へ 6 本 */
  lines: NakkoLine[];
  /** 之卦の 6 爻。変爻が無ければ付かない */
  changed_lines?: NakkoChangedLine[];
}

/** SEFLG_MOSEPH(4) だけ。月支と年の境が要るだけなので速度は取らない（chart.ts の CALC_FLAGS は速度つき） */
const SUN_FLAGS = 4;

/** 太陽（SE_SUN） */
const SUN_ID = 0;

/**
 * 立卦の瞬間の太陽黄経（度）。
 * **納甲がエンジンに触るのはここ 1 回だけ**（nakko を付けないなら一度も触らない）。
 */
export function sunLongitude(swe: SwissEph, moment: NakkoMoment): number {
  const jd = julianDay(swe, moment);
  const result = swe.swe_calc_ut(jd, SUN_ID, SUN_FLAGS);
  return normalizeDegree(result[0] as number);
}

/** 之卦の 6 爻（六親は本卦の宮の五行で付ける＝断易の慣例） */
function changedLinesOf(resulting: HexagramView, palaceElement: string): NakkoChangedLine[] {
  return POSITION_LABELS.map((label, index) => {
    const position = index + 1;
    const { stem, branch } = nakkoOfLine(resulting.lower.name, resulting.upper.name, position);
    const element = branchElement(branch);
    return { position, label, stem, branch, element, relation: relationOf(palaceElement, element) };
  });
}

/**
 * 納甲一式を組み立てる。
 *
 * 乱数はここでは一切回さない ―― 立った卦（result）と立卦の日時（moment）と
 * その瞬間の太陽黄経（sunLon）だけから決まる。
 */
export function buildNakko(
  result: CastResult,
  moment: NakkoMoment,
  sunLon: number,
): NakkoView {
  const pillars = fourPillars(moment, sunLon);
  const palace = palaceByBits(bitsOfHexagramView(result.primary));
  const beastStart = beastStartIndex(pillars.day.stem);

  const lines: NakkoLine[] = POSITION_LABELS.map((label, index) => {
    const position = index + 1;
    const { stem, branch } = nakkoOfLine(
      result.primary.lower.name,
      result.primary.upper.name,
      position,
    );
    const element = branchElement(branch);
    return {
      position,
      label,
      stem,
      branch,
      element,
      relation: relationOf(palace.element, element),
      beast: BEASTS[(beastStart + index) % 6] as string,
      is_self: position === palace.self,
      is_other: position === palace.other,
    };
  });

  const view: NakkoView = {
    moment: { local: formatMomentIso(moment), utc_offset: moment.utcOffset },
    pillars,
    sun_longitude: sunLon,
    palace: { name: palace.name, element: palace.element, generation: palace.generation },
    self_line: palace.self,
    other_line: palace.other,
    lines,
  };
  if (result.resulting) {
    view.changed_lines = changedLinesOf(result.resulting, palace.element);
  }
  return view;
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** 「丙午年 丙申月 戊辰日 癸亥時」 */
function pillarsLabel(pillars: FourPillars): string {
  return (
    `${pillars.year.ganzhi}年 ${pillars.month.ganzhi}月 ` +
    `${pillars.day.ganzhi}日 ${pillars.hour.ganzhi}時`
  );
}

/** 「上爻 己巳 官鬼 玄武 ─ 応」（世でも応でもなければ札は付かない） */
function nakkoLineText(line: NakkoLine): string {
  const mark = line.is_self ? " ─ 世" : line.is_other ? " ─ 応" : "";
  return `${line.label} ${line.stem}${line.branch} ${line.relation} ${line.beast}${mark}`;
}

/**
 * Claude が読む用のテキスト表現（易の本文の末尾に足す節）。
 *
 * 六親の吉凶も用神の取り方も書かない ―― 表を渡すだけで、読みは呼び出した側に委ねる。
 * 爻は上爻から初爻へ並べる（卦を書き下すときの向き）。
 */
export function formatNakkoText(result: CastResult, nakko: NakkoView): string {
  const lines = ["■ 納甲（断易）"];

  lines.push(
    `立卦: ${formatMomentPlain(nakko.moment.local, nakko.moment.utc_offset)}  ` +
      `${pillarsLabel(nakko.pillars)}（太陽黄経 ${nakko.sun_longitude.toFixed(1)}°）`,
  );
  lines.push(
    `本卦 ${result.primary.name}: ${nakko.palace.name}・${nakko.palace.generation}（${nakko.palace.element}）` +
      `  世: ${POSITION_LABELS[nakko.self_line - 1]}  応: ${POSITION_LABELS[nakko.other_line - 1]}`,
  );

  for (const line of [...nakko.lines].reverse()) lines.push(nakkoLineText(line));

  if (nakko.changed_lines && result.resulting) {
    const changed = [...nakko.changed_lines]
      .reverse()
      .map((line) => `${line.label} ${line.stem}${line.branch} ${line.relation}`)
      .join(" / ");
    lines.push(`之卦 ${result.resulting.name}: ${changed}`);
  }

  return lines.join("\n");
}
