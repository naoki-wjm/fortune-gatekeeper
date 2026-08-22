/**
 * 九星気学の純関数。
 *
 * 背骨は four-pillars.ts・shukuyo.ts と同じ ―― 乱数は 1 ビットも無く、
 * **サーバーの仕事は「規約を名前で固定して返すこと」だけ**です。
 * 吉方位も相性も意味テキストも持ちません（「五黄殺」「歳破」といった札は計算上の名前なので出しますが、
 * 吉凶の言葉はそこに 1 語も足しません。読むのは呼び出した側の Claude です）。
 *
 * wasm には触りません。立春・節入り・冬至／夏至の瞬間は**引数で受ける**
 * （nakko.ts の `sunLongitude`、four-pillars.ts の `SolarTermSpan` と同じ流儀）。
 * ここに入ってくるのは数値と表と算術だけです。年の切り替え（立春前は前年）と、
 * 至の瞬間を暦日へ丸めるところは呼び出し側の仕事。
 *
 * 出生データそのもの（年月日）はテキストに書かず、受け取った日付を echo もしません。
 * ⚠ ただし `dayStar` は切り替えの甲子日と経過日数を返すので、**2 つ揃うと対象日が復元できます**。
 *    出生日について呼ぶときは配線側で `switch` と `days_since_switch` を落としてください
 *    （純関数としては全部返します ―― 落とすかどうかを決めるのは配線側）。
 */
import { BRANCHES, dayGanzhiIndex, daysInMonth, isCalendarDay, julianDayNumber } from "./nakko";

/** 引数の形が受け付けられなかったときの言い分 */
export class KyuseiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KyuseiError";
  }
}

/** 割り算の余り（負の数でも 0 以上 divisor 未満に畳む） */
function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// 九星の台帳
// ---------------------------------------------------------------------------

/** 九星 1 つ。番号・名前・五行・色だけ ―― 意味も吉凶も持たない */
export interface Star {
  /** 1〜9 */
  number: number;
  /** 正式名（「一白水星」） */
  name: string;
  /** 短名（「一白」）。盤の升目に書くのはこちら */
  short_name: string;
  /** 五行（水・土・木・金・火） */
  element: string;
  /** 色（白・黒・碧・緑・黄・赤・紫） */
  color: string;
}

export const STAR_COUNT = 9;

/** 九星（1 から 9 の順）。五行は 水土木木土金金土火、色は名前の 2 文字目そのもの */
export const STARS: readonly Star[] = [
  { number: 1, name: "一白水星", short_name: "一白", element: "水", color: "白" },
  { number: 2, name: "二黒土星", short_name: "二黒", element: "土", color: "黒" },
  { number: 3, name: "三碧木星", short_name: "三碧", element: "木", color: "碧" },
  { number: 4, name: "四緑木星", short_name: "四緑", element: "木", color: "緑" },
  { number: 5, name: "五黄土星", short_name: "五黄", element: "土", color: "黄" },
  { number: 6, name: "六白金星", short_name: "六白", element: "金", color: "白" },
  { number: 7, name: "七赤金星", short_name: "七赤", element: "金", color: "赤" },
  { number: 8, name: "八白土星", short_name: "八白", element: "土", color: "白" },
  { number: 9, name: "九紫火星", short_name: "九紫", element: "火", color: "紫" },
];

/** 星の番号（1〜9）が整数で範囲内か */
function assertStar(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > STAR_COUNT) {
    throw new KyuseiError(`${label} は 1〜${STAR_COUNT} の整数で指定してください: ${value}`);
  }
  return value;
}

/** 番号（1〜9）から星を引く */
export function starOf(number: number): Star {
  return STARS[assertStar(number, "星の番号") - 1] as Star;
}

/** 輪にして 1〜9 に畳む（10 は 1、0 は 9、−1 は 8） */
export function wrapStar(number: number): number {
  return mod(number - 1, STAR_COUNT) + 1;
}

// ---------------------------------------------------------------------------
// 後天定位（宮と方位）
// ---------------------------------------------------------------------------

/** 八方位＋中宮。盤の升目はこの 9 つ */
export type Direction = "北" | "北東" | "東" | "南東" | "南" | "南西" | "西" | "北西" | "中宮";

/** 後天定位の 1 宮 */
export interface Palace {
  /** 後天定位の番号（＝この宮の定位の星。中宮が 5） */
  number: number;
  direction: Direction;
  /** 八卦の名前。中宮だけ持たない */
  trigram: string | null;
}

/**
 * 後天定位（洛書）。返り値の並びはここで固定する ――
 * **北・北東・東・南東・南・南西・西・北西・中宮**（方位を時計回りに一周してから中宮）。
 *
 * 検算: 南を上・東を左に並べると縦横斜めが 15 になる魔方陣。
 *   南東4 南9 南西2 ／ 東3 中5 西7 ／ 北東8 北1 北西6
 */
export const PALACES: readonly Palace[] = [
  { number: 1, direction: "北", trigram: "坎" },
  { number: 8, direction: "北東", trigram: "艮" },
  { number: 3, direction: "東", trigram: "震" },
  { number: 4, direction: "南東", trigram: "巽" },
  { number: 9, direction: "南", trigram: "離" },
  { number: 2, direction: "南西", trigram: "坤" },
  { number: 7, direction: "西", trigram: "兌" },
  { number: 6, direction: "北西", trigram: "乾" },
  { number: 5, direction: "中宮", trigram: null },
];

/** 方位の向かい（北↔南・北東↔南西・東↔西・南東↔北西）。中宮に向かいは無い */
const OPPOSITE_DIRECTION: Readonly<Record<Direction, Direction | null>> = {
  北: "南",
  北東: "南西",
  東: "西",
  南東: "北西",
  南: "北",
  南西: "北東",
  西: "東",
  北西: "南東",
  中宮: null,
};

/** 向かいの方位。中宮なら null */
export function oppositeDirection(direction: Direction): Direction | null {
  if (!(direction in OPPOSITE_DIRECTION)) {
    throw new KyuseiError(`知らない方位です: ${direction}`);
  }
  return OPPOSITE_DIRECTION[direction];
}

// ---------------------------------------------------------------------------
// 年の星（本命星）
// ---------------------------------------------------------------------------

/** 西暦の年が整数で、扱う範囲に入っているか */
function assertSolarYear(solarYear: number, label = "年"): number {
  if (!Number.isInteger(solarYear)) {
    throw new KyuseiError(`${label}は整数で指定してください: ${solarYear}`);
  }
  if (solarYear < 1 || solarYear > 9999) {
    throw new KyuseiError(`${label}は西暦 1〜9999 で指定してください: ${solarYear}`);
  }
  return solarYear;
}

/**
 * 年の星（本命星）。
 *
 * `solarYear` は**立春で切った年**（立春前の生まれは前年を渡す）。
 * 切り替えの判定はここではやらない ―― nakko.ts の `isBeforeRisshun` と同じ太陽黄経方式で
 * 呼び出し側が済ませてから、年の整数だけを渡す。
 *
 * 算法は気学暦の慣例そのままで「**11 − 数字根**、10 になったら 9 を引く」。
 * 数字根（各桁を足して 1 桁にした数）は `((年 − 1) mod 9) + 1` と同じもの。
 *
 * 手計算で検算（仕様書の例はすべてこれと一致した）:
 *   1900 → 1+9+0+0 = 10 → 1、11 − 1 = 10 → 10 − 9 = 1 ＝ 一白
 *   1984 → 1+9+8+4 = 22 → 4、11 − 4 = 7 ＝ 七赤
 *   1986 → 1+9+8+6 = 24 → 6、11 − 6 = 5 ＝ 五黄
 *   2021 → 2+0+2+1 = 5、11 − 5 = 6 ＝ 六白
 *   2024 → 2+0+2+4 = 8、11 − 8 = 3 ＝ 三碧
 *   2025 → 2+0+2+5 = 9、11 − 9 = 2 ＝ 二黒（数字根が 9 になる境）
 *   2026 → 2+0+2+6 = 10 → 1、11 − 1 = 10 → 1 ＝ 一白
 */
export function yearStar(solarYear: number): number {
  assertSolarYear(solarYear);
  const digitRoot = mod(solarYear - 1, 9) + 1;
  const raw = 11 - digitRoot;
  return raw > STAR_COUNT ? raw - STAR_COUNT : raw;
}

// ---------------------------------------------------------------------------
// 月の星（月命星・月盤の中宮）
// ---------------------------------------------------------------------------

/**
 * 寅月（立春から）の星を、年の星の組から引く表。
 *
 * ⚠ **仕様書の草案とは 2 つの組を入れ替えてある**（草案は 二五八 → 五黄／三六九 → 二黒）。
 *    標準（市販の気学暦・高島暦の慣例）と照合して、下の並びを採った。根拠は 2 つ:
 *
 *  1. **月盤は 1 か月に 1 つずつ下がり続け、年をまたいでも切れない**。
 *     12 か月で 12 下がる＝ 9 で割った余りは 3 なので、寅月の星は 1 年ごとにきっかり 3 ずつ下がる
 *     （八白 → 五黄 → 二黒 → 八白 …）。年の星は 1 年ごとに 1 ずつ下がるので、
 *     組は 一四七 → 三六九 → 二五八 → 一四七 の順に回る。
 *  2. 気学暦の慣例「**子午卯酉の年は八白から・辰戌丑未の年は五黄から・寅申巳亥の年は二黒から**」と
 *     実年で突き合わせる:
 *       2020 年 庚子・七赤 → 子年なので寅月 八白（年の星の組は 一四七）
 *       2021 年 辛丑・六白 → 丑年なので寅月 五黄（同 三六九）… 八白の 3 つ下で切れ目が無い
 *       2022 年 壬寅・五黄 → 寅年なので寅月 二黒（同 二五八）
 *       2023 年 癸卯・四緑 → 卯年なので寅月 八白（同 一四七）… 3 年で一周
 *     年の星と並べ直すと 一四七＝八白・三六九＝五黄・二五八＝二黒。
 *
 *    草案の並び（二五八＝五黄・三六九＝二黒）だと寅月の星が 1 年ごとに 3 ずつ**上がる**ことになり、
 *    月ごとに 1 つ下がる月盤とつながらない（2020 年の丑月 六白 の次が 2021 年の寅月 二黒 になってしまう）。
 */
export const TIGER_MONTH_STAR_BY_GROUP: readonly { year_stars: readonly number[]; star: number }[] = [
  { year_stars: [1, 4, 7], star: 8 },
  { year_stars: [3, 6, 9], star: 5 },
  { year_stars: [2, 5, 8], star: 2 },
];

/** 年の星 → 寅月の星 */
const TIGER_MONTH_STAR = new Map<number, number>(
  TIGER_MONTH_STAR_BY_GROUP.flatMap((group) =>
    group.year_stars.map((yearStarNumber) => [yearStarNumber, group.star] as [number, number]),
  ),
);

/** 月の順番（0＝寅月）が整数で範囲内か */
function assertMonthOrder(monthOrder: number): number {
  if (!Number.isInteger(monthOrder) || monthOrder < 0 || monthOrder > 11) {
    throw new KyuseiError(`月の順番は 0（寅月）〜11（丑月）の整数で指定してください: ${monthOrder}`);
  }
  return monthOrder;
}

/**
 * 月の星（月命星・その月の月盤の中宮）。
 *
 * `monthOrder` は 0＝寅月（立春から）、1＝卯月 …… 11＝丑月で、
 * nakko.ts の `monthBranchOrder(太陽黄経)` が返す番号と同じ並び。
 *
 * 年の星の組で寅月の星が決まり、そこから 1 か月ごとに 1 つ下がる（八白 → 七赤 → 六白 …）。
 * **月命星も月盤の中宮も同じ表**（九星気学では「その月の星」が月盤の中宮に座る）。
 */
export function monthStar(yearStarNumber: number, monthOrder: number): number {
  assertStar(yearStarNumber, "年の星");
  assertMonthOrder(monthOrder);
  const tiger = TIGER_MONTH_STAR.get(yearStarNumber);
  if (tiger === undefined) {
    throw new KyuseiError(`寅月の星が引けません（年の星: ${yearStarNumber}）`);
  }
  return wrapStar(tiger - monthOrder);
}

// ---------------------------------------------------------------------------
// 日の星（日命星・日盤の中宮）
// ---------------------------------------------------------------------------

/** 陽遁（上がる）か陰遁（下がる）か */
export type Dun = "陽遁" | "陰遁";

/** 暦日（その土地の時計で読んだ年月日） */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** 至の暦日（冬至・夏至。瞬間を暦日へ丸めるのは呼び出し側の仕事） */
export interface SolsticeDay extends CalendarDate {
  kind: "winter" | "summer";
}

/** 日の星ひとそろい */
export interface DayStarView {
  /** その日の星（1〜9） */
  star: number;
  dun: Dun;
  /** 切り替えの甲子日（どちらの至から数え始めたかを kind に残す） */
  switch: SolsticeDay;
  /** 切り替えの甲子日からの日数（0 以上。切り替え当日が 0） */
  days_since_switch: number;
}

/** 甲子（六十干支の頭）の index */
const JIAZI_INDEX = 0;

/** 六十干支の周期（日） */
const GANZHI_CYCLE = 60;

/**
 * 至と甲子が同じ距離になる日数。
 * 前後の甲子は 60 日離れているので、ちょうど真ん中＝ 30 日のときだけ引き分けになる。
 */
const TIE_DISTANCE = GANZHI_CYCLE / 2;

/** 年月日が整数で、暦に実在するか（打ち間違いが別の日の星として静かに返るのを防ぐ） */
function assertCalendarDate(label: string, date: CalendarDate): CalendarDate {
  const entries: readonly [string, number][] = [
    ["年", date.year],
    ["月", date.month],
    ["日", date.day],
  ];
  for (const [name, value] of entries) {
    if (!Number.isInteger(value)) {
      throw new KyuseiError(`${label}の${name}は整数で指定してください: ${value}`);
    }
  }
  assertSolarYear(date.year, `${label}の年`);
  if (date.month < 1 || date.month > 12) {
    throw new KyuseiError(`${label}の月は 1〜12 で指定してください: ${date.month}`);
  }
  if (!isCalendarDay(date.year, date.month, date.day)) {
    throw new KyuseiError(
      `${label}の ${date.year}-${pad2(date.month)}-${pad2(date.day)} は暦に存在しない日付です` +
        `（${date.year}年${date.month}月は${daysInMonth(date.year, date.month)}日まで）`,
    );
  }
  return date;
}

/**
 * ユリウス日番号 → 暦日（`julianDayNumber` の逆）。
 *
 * 切り替えの甲子日を「何年何月何日」として返すためだけに要る。
 * 検算: 2433191 → 1949-10-01（nakko.ts のコメントにある甲子の日）、2451545 → 2000-01-01。
 */
export function dateFromJulianDayNumber(jdn: number): CalendarDate {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    year: 100 * b + d - 4800 + Math.floor(m / 10),
    month: m + 3 - 12 * Math.floor(m / 10),
    day: e - Math.floor((153 * m + 2) / 5) + 1,
  };
}

/**
 * その日にいちばん近い甲子日の JDN。
 *
 * 甲子は 60 日ごとなので、手前の甲子までの距離は日干支の index そのもの、
 * 次の甲子までは 60 − index。**同じ距離（どちらも 30 日）なら後の甲子を採る**（採用規約）。
 */
export function nearestJiaziJdn(date: CalendarDate): number {
  const jdn = julianDayNumber(date.year, date.month, date.day);
  const index = mod(dayGanzhiIndex(date.year, date.month, date.day) - JIAZI_INDEX, GANZHI_CYCLE);
  // index < 30 なら手前の甲子が近い。30 ちょうどは引き分け＝後を採るので、次の甲子へ回す
  return index < TIE_DISTANCE ? jdn - index : jdn - index + GANZHI_CYCLE;
}

/** 至の一覧が並びとして読めるか（昇順・冬至と夏至が交互） */
function assertSolstices(solstices: readonly SolsticeDay[]): void {
  if (solstices.length === 0) {
    throw new KyuseiError("冬至・夏至の暦日が 1 つも渡されていません");
  }
  let previousJdn = Number.NEGATIVE_INFINITY;
  let previousKind: SolsticeDay["kind"] | null = null;
  for (const [index, solstice] of solstices.entries()) {
    if (solstice.kind !== "winter" && solstice.kind !== "summer") {
      throw new KyuseiError(`至の種類は winter か summer で指定してください: ${solstice.kind}`);
    }
    assertCalendarDate(`${index + 1} つ目の至`, solstice);
    const jdn = julianDayNumber(solstice.year, solstice.month, solstice.day);
    if (jdn <= previousJdn) {
      throw new KyuseiError("冬至・夏至の暦日は古い順（昇順）に並べて渡してください");
    }
    if (previousKind !== null && previousKind === solstice.kind) {
      throw new KyuseiError("冬至と夏至は交互に並びます。抜けが無いか確かめてください");
    }
    previousJdn = jdn;
    previousKind = solstice.kind;
  }
}

/**
 * 日の星（日命星・その日の日盤の中宮）。
 *
 * ここは流派差の沼なので、規約を決めて名前で固定してある（`KYUSEI_CONVENTIONS` にも載る）:
 *
 *  - **陽遁**は冬至に最も近い甲子日から 一白 → 二黒 → …… → 九紫 → 一白 と上がる
 *  - **陰遁**は夏至に最も近い甲子日から 九紫 → 八白 → …… → 一白 → 九紫 と下がる
 *  - 「最も近い」は**暦日の差**（JDN の差の絶対値）で測り、前後が同距離（30 日）なら**後の甲子**
 *  - **閏遁は置かない**。切り替えの間隔が 240 日になる期間（至の間隔は約 182 日、
 *    甲子のずれが最大 ±30 日なので間隔は 180 日か 240 日のどちらか）も、
 *    特別な挿入をせず直前の遁をそのまま続ける ―― 陽遁なら九紫の次は一白へ戻るだけ
 *  - 日界は 0 時（23 時台も同じ日。四柱推命と同じ）
 *
 * `solstices` には**対象日の前後を挟む至**を渡す。切り替えの甲子日は至より最大 29 日手前にも
 * 30 日あとにも来るので、対象日の前は 2 つ以上あると安心（1 つ目の甲子が対象日より
 * あとに来ることがあるため）。対象日より後の至が 1 つも無いときは、渡されていない至の甲子が
 * 対象日以前にもぐり込む余地があるので断る。
 */
export function dayStar(date: CalendarDate, solstices: readonly SolsticeDay[]): DayStarView {
  assertCalendarDate("対象日", date);
  assertSolstices(solstices);

  const targetJdn = julianDayNumber(date.year, date.month, date.day);
  const last = solstices[solstices.length - 1] as SolsticeDay;
  if (julianDayNumber(last.year, last.month, last.day) <= targetJdn) {
    throw new KyuseiError(
      "対象日より後の冬至・夏至が渡されていません" +
        "（渡されていない至の甲子日が対象日以前に入り込む余地があるため、断っています）",
    );
  }

  // 対象日以前で最後の切り替え（至は昇順なので、甲子日も昇順に並ぶ ―― 至は約 182 日おき、
  // 甲子のずれは ±30 日以内なので、順番が入れ替わることはない）
  let chosen: { kind: SolsticeDay["kind"]; jdn: number } | null = null;
  for (const solstice of solstices) {
    const jdn = nearestJiaziJdn(solstice);
    if (jdn <= targetJdn) chosen = { kind: solstice.kind, jdn };
  }
  if (!chosen) {
    throw new KyuseiError(
      "対象日以前の切り替え（至に最も近い甲子日）がありません" +
        "（対象日より前の至を、2 つ以上さかのぼって渡してください）",
    );
  }

  const days = targetJdn - chosen.jdn;
  const switchDate = dateFromJulianDayNumber(chosen.jdn);
  return {
    // 陽遁は切り替え当日が一白で 1 日 1 つ上がり、陰遁は切り替え当日が九紫で 1 日 1 つ下がる
    star: chosen.kind === "winter" ? wrapStar(1 + days) : wrapStar(9 - days),
    dun: chosen.kind === "winter" ? "陽遁" : "陰遁",
    switch: { kind: chosen.kind, ...switchDate },
    days_since_switch: days,
  };
}

// ---------------------------------------------------------------------------
// 盤
// ---------------------------------------------------------------------------

/** 盤の 1 升 */
export interface BoardCell {
  /** 後天定位の番号（＝この宮の定位の星） */
  palace: number;
  direction: Direction;
  /** 八卦の名前。中宮だけ持たない */
  trigram: string | null;
  /** この盤でこの宮に座る星 */
  star: Star;
}

/** 盤ひとそろい */
export interface Board {
  /** 中宮の星 */
  center: Star;
  /** 北・北東・東・南東・南・南西・西・北西・中宮 の順に 9 升 */
  cells: BoardCell[];
}

/**
 * 盤（九星の配り）。
 *
 * 後天定位（宮 p の定位の星が p）に、中宮からの差を足すだけ ――
 * 宮 p の星 ＝ `((中宮 + p − 5 − 1) mod 9) + 1`。
 *
 * 検算: 五黄中宮なら差が 0 で定位そのまま。六白中宮なら差が +1 で
 *   北 二黒・南西 三碧・東 四緑・南東 五黄・北西 七赤・西 八白・北東 九紫・南 一白（南だけ 10 → 1 に回る）。
 */
export function board(centerStar: number): Board {
  assertStar(centerStar, "中宮の星");
  return {
    center: starOf(centerStar),
    cells: PALACES.map((palace) => ({
      palace: palace.number,
      direction: palace.direction,
      trigram: palace.trigram,
      star: starOf(wrapStar(centerStar + palace.number - 5)),
    })),
  };
}

/** 盤の中から方位で升を引く */
export function cellAt(target: Board, direction: Direction): BoardCell {
  const cell = target.cells.find((entry) => entry.direction === direction);
  if (!cell) throw new KyuseiError(`知らない方位です: ${direction}`);
  return cell;
}

/** その星がこの盤で座っている方位（中宮に居れば "中宮"） */
export function directionOfStar(target: Board, starNumber: number): Direction {
  assertStar(starNumber, "星の番号");
  const cell = target.cells.find((entry) => entry.star.number === starNumber);
  // 盤は 1〜9 の並べ替えなので必ず見つかる。見つからないなら盤の組み立てが壊れている
  if (!cell) throw new KyuseiError(`盤に ${starNumber} の星がありません。盤の組み立てを確かめてください`);
  return cell.direction;
}

// ---------------------------------------------------------------------------
// 殺
// ---------------------------------------------------------------------------

/** 殺の名前（計算上の名前。吉凶の言葉はここにも足さない） */
export type SatsuName =
  | "五黄殺"
  | "暗剣殺"
  | "歳破"
  | "月破"
  | "日破"
  | "本命殺"
  | "本命的殺"
  | "月命殺"
  | "月命的殺";

/** どの盤か（破の名前がこれで決まる） */
export type BoardKind = "year" | "month" | "day";

/** 盤の種類 → 破の名前 */
const BREAK_NAME: Readonly<Record<BoardKind, SatsuName>> = {
  year: "歳破",
  month: "月破",
  day: "日破",
};

/**
 * 十二支 → 八方位。
 *
 * 本来は 24 方位（1 支＝ 30°）だが、盤が 8 方位（1 宮＝ 45°、四隅は 60°）なので**丸めてある**。
 * 丑と寅が北東、辰と巳が南東、未と申が南西、戌と亥が北西へまとまり、
 * 四隅の宮では 60° のうち 30° だけが実際の破に当たる ―― この粗さは規約として名前で返す。
 */
const DIRECTION_BY_BRANCH: Readonly<Record<string, Direction>> = {
  子: "北",
  丑: "北東",
  寅: "北東",
  卯: "東",
  辰: "南東",
  巳: "南東",
  午: "南",
  未: "南西",
  申: "南西",
  酉: "西",
  戌: "北西",
  亥: "北西",
};

/** 対冲の支（六沖＝ index が 6 離れた支） */
export function oppositeBranch(branch: string): string {
  const index = BRANCHES.indexOf(branch);
  if (index < 0) throw new KyuseiError(`知らない地支です: ${branch}`);
  return BRANCHES[mod(index + 6, 12)] as string;
}

/** 支の方位（八方位に丸めたもの） */
export function directionOfBranch(branch: string): Direction {
  const direction = DIRECTION_BY_BRANCH[branch];
  if (!direction) throw new KyuseiError(`知らない地支です: ${branch}`);
  return direction;
}

/** 殺を出すときの手がかり（どれも任意。渡されたぶんだけ出す） */
export interface SatsuOptions {
  /** 盤の種類。破の名前を選ぶ（year＝歳破・month＝月破・day＝日破） */
  kind?: BoardKind;
  /** その盤の支（年支・月支・日支）。渡さなければ破は出さない */
  branch?: string;
  /** 本命星（1〜9）。渡さなければ本命殺・本命的殺は出さない */
  honmei?: number;
  /** 月命星（1〜9）。渡さなければ月命殺・月命的殺は出さない */
  getsumei?: number;
}

/** 立った殺 1 つ */
export interface Satsu {
  name: SatsuName;
  direction: Direction;
  /** 破のときだけ付く**対冲の支**（この方位の根拠。年支そのものではない） */
  branch?: string;
}

/**
 * その盤に立つ殺。
 *
 *  - 五黄殺: 五黄の座る方位（中宮なら出ない）
 *  - 暗剣殺: 五黄殺の向かい（五黄が中宮なら出ない）
 *  - 歳破／月破／日破: その盤の**支の対冲**の方位（八方位に丸めてある）
 *  - 本命殺: 本命星の座る方位、本命的殺: その向かい（中宮なら出ない）
 *  - 月命殺／月命的殺: 月命星で同じこと
 *
 * 同じ方位に複数の殺が重なるのは普通に起きるので、重なりを畳まずそのまま全部返す。
 */
export function satsu(target: Board, options: SatsuOptions = {}): Satsu[] {
  const list: Satsu[] = [];

  // 五黄殺・暗剣殺
  const goouDirection = directionOfStar(target, 5);
  if (goouDirection !== "中宮") {
    list.push({ name: "五黄殺", direction: goouDirection });
    const back = oppositeDirection(goouDirection);
    if (back) list.push({ name: "暗剣殺", direction: back });
  }

  // 破（歳破・月破・日破）
  if (options.kind !== undefined && !(options.kind in BREAK_NAME)) {
    throw new KyuseiError(`盤の種類は year / month / day で指定してください: ${options.kind}`);
  }
  if (options.branch !== undefined) {
    if (options.kind === undefined) {
      throw new KyuseiError(
        "破を出すには kind（year / month / day）も指定してください（歳破・月破・日破の名前が決まらないため）",
      );
    }
    const facing = oppositeBranch(options.branch);
    list.push({
      name: BREAK_NAME[options.kind],
      direction: directionOfBranch(facing),
      branch: facing,
    });
  }

  // 本命殺・本命的殺／月命殺・月命的殺
  const personal: readonly [number | undefined, SatsuName, SatsuName][] = [
    [options.honmei, "本命殺", "本命的殺"],
    [options.getsumei, "月命殺", "月命的殺"],
  ];
  for (const [starNumber, name, facingName] of personal) {
    if (starNumber === undefined) continue;
    const direction = directionOfStar(target, starNumber);
    if (direction === "中宮") continue;
    list.push({ name, direction });
    const back = oppositeDirection(direction);
    if (back) list.push({ name: facingName, direction: back });
  }

  return list;
}

// ---------------------------------------------------------------------------
// 規約
// ---------------------------------------------------------------------------

/** 盤に添える規約の一覧（名前で固定し、結果と一緒に返す） */
export const KYUSEI_CONVENTIONS: Readonly<Record<string, string>> = {
  year_boundary: "年界は立春（節分までは 1 つ前の年の星）。立春の判定は太陽黄経 315°",
  month_boundary: "月界は節（太陽黄経 30° ごと）。0 番目の寅月が立春から始まる",
  day_boundary: "日界は 0 時（23 時台も同じ日。四柱推命と同じ）",
  year_star: "本命星は 11 − 数字根（西暦の各桁を足して 1 桁にした数）。10 になったら 9 を引く",
  month_star:
    "月の星は年の星の組（一四七／三六九／二五八）で寅月が決まり（八白／五黄／二黒）、" +
    "以降 1 か月ごとに 1 つ下がる。月命星も月盤の中宮も同じ表",
  dun:
    "陽遁は冬至に最も近い甲子日から一白→二黒→…、陰遁は夏至に最も近い甲子日から九紫→八白→…。" +
    "「最も近い」は暦日の差で測り、前後が同距離（30 日）なら後の甲子を採る",
  leap_dun:
    "閏遁は置かない（切り替えの間隔が 240 日になる期間も、特別な挿入をせず直前の遁をそのまま続ける）",
  board:
    "盤は後天定位（洛書）に中宮からの差を足したもの。9 宮の並びは 北・北東・東・南東・南・南西・西・北西・中宮" +
    "、図は南を上・東を左に描く",
  break_directions:
    "破（歳破・月破・日破）は支の対冲の方位。**八方位に丸めてある**ので、" +
    "北東・南東・南西・北西では 60° のうち 30°（対冲の支の幅）だけが実際の破に当たる",
  satsu: "五黄殺・暗剣殺・本命殺・本命的殺・月命殺・月命的殺は、星が中宮に居るときは出ない",
  hour_board: "時盤は持たない（初版の範囲外）",
  scope: "名前と方位だけを返す。吉方位・凶方位・相性・意味づけは載せない",
};

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** 全角として数える符号位置の帯（表の桁をそろえるための目安。厳密な東アジア幅ではない） */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
];

/** 全角を 2、半角を 1 として数えた表示幅（four-pillars.ts と同じ考え） */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    width += WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
  }
  return width;
}

/** 表示幅で右に余白を足す（はみ出したらそのまま） */
function padRight(text: string, width: number): string {
  const space = width - displayWidth(text);
  return space > 0 ? text + " ".repeat(space) : text;
}

/** 升目 1 つぶん（「南東 五黄」） */
function boardCellText(target: Board, direction: Direction): string {
  const cell = cellAt(target, direction);
  return `${cell.direction} ${cell.star.short_name}`;
}

/** 盤の升目の並び（南が上・東が左。九星の盤を描くときの向き） */
const BOARD_ROWS: readonly (readonly Direction[])[] = [
  ["南東", "南", "南西"],
  ["東", "中宮", "西"],
  ["北東", "北", "北西"],
];

/**
 * 盤の 3×3 の升目。
 *
 * 九星の盤は**南を上**に描く慣例なので、上段が 南東・南・南西、中段が 東・中宮・西、
 * 下段が 北東・北・北西 になる（東が左、西が右）。
 */
export function formatBoardText(target: Board, title: string): string {
  const lines = [`■ ${title}（中宮 ${target.center.name}／南が上・東が左）`];
  for (const row of BOARD_ROWS) {
    lines.push(row.map((direction) => padRight(boardCellText(target, direction), 12)).join("").trimEnd());
  }
  return lines.join("\n");
}

/** 殺 1 つぶん（破だけ対冲の支を添える） */
function satsuText(entry: Satsu): string {
  return entry.branch === undefined
    ? `${entry.name}: ${entry.direction}`
    : `${entry.name}: ${entry.direction}（${entry.branch}）`;
}

/**
 * 殺の行（「五黄殺: 北西 / 暗剣殺: 南東 / 歳破: 西（酉）」）。
 *
 * 括弧に入るのは**対冲の支**＝その方位の根拠のほう（年支そのものではない）。
 * 吉凶は書かない ―― 立っている札を並べるだけで、読みは呼び出した側に委ねる。
 */
export function formatSatsuText(list: readonly Satsu[]): string {
  if (list.length === 0) return "殺: なし";
  return list.map(satsuText).join(" / ");
}
