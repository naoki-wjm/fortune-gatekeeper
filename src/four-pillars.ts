/**
 * 四柱推命（子平）の純関数。
 *
 * 背骨は numerology.ts と同じ ―― 乱数は 1 ビットも無く、**サーバーの仕事は「規約を固定すること」だけ**。
 * 通変星も十二運も蔵干も空亡も、意味づけは一切載せません。標準の呼び名を並べるだけで、
 * 読むのは呼び出した側の Claude です（既に知っている体系なので、名前だけ渡せば読めます）。
 *
 * 四柱そのもの（年月日時の干支）は納甲（nakko.ts）の `fourPillars` をそのまま借ります ――
 * 日界 0 時・立春 315°・五虎遁・五鼠遁の算法を二重に持たないため。
 *
 * wasm には触りません。太陽黄経も節入りの前後も**引数で受ける**（nakko.ts の `sunLongitude` と同じ流儀）。
 * ここに入ってくるのは数値と表と算術だけです。
 *
 * 出生データそのもの（年月日時・時差）はテキストに書きません。命式・蔵干・大運は派生値なので出します。
 * 時辰の境も**分数では返しません** ―― 時支（2 時間の幅）と分数を合わせると出生時刻が分単位で
 * 復元できてしまうため、「境から 15 分以内かどうか、どちら側か」という粗い印だけにしてあります。
 */
import {
  BRANCHES,
  STEMS,
  branchElement,
  dayGanzhiIndex,
  daysInMonth,
  fourPillars,
  ganzhiOf,
  hourBranchIndex,
  isCalendarDay,
  monthBranchOrder,
  relationOf,
  type FourPillars,
  type NakkoMoment,
  type Pillar,
} from "./nakko";

/** 引数の形が受け付けられなかったときの言い分 */
export class FourPillarsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FourPillarsError";
  }
}

/** 割り算の余り（負の数でも 0 以上 divisor 未満に畳む） */
function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/**
 * 桁を落とす丸め。**起運の「丸め規約」ではない**（切り上げ・満年齢といった流派の話は読む側の持ち物）。
 * 埃を落とすのが主な仕事だが、起運だけは「返す精度の上限」としても使っている（luckCycle 参照）。
 */
function trim(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// 天干・地支の素性
// ---------------------------------------------------------------------------

/** 天干の五行（甲乙＝木・丙丁＝火・戊己＝土・庚辛＝金・壬癸＝水） */
const STEM_ELEMENTS: readonly string[] = ["木", "木", "火", "火", "土", "土", "金", "金", "水", "水"];

/** 天干の名前 → index（甲=0） */
export function stemIndexOf(stem: string): number {
  const index = STEMS.indexOf(stem);
  if (index < 0) throw new FourPillarsError(`知らない天干です: ${stem}`);
  return index;
}

/** 地支の名前 → index（子=0） */
export function branchIndexOf(branch: string): number {
  const index = BRANCHES.indexOf(branch);
  if (index < 0) throw new FourPillarsError(`知らない地支です: ${branch}`);
  return index;
}

/** 天干の五行 */
export function stemElement(stem: string): string {
  return STEM_ELEMENTS[stemIndexOf(stem)] as string;
}

/** 陽干＝甲丙戊庚壬（干支の index が偶数） */
export function isYangStem(stem: string): boolean {
  return stemIndexOf(stem) % 2 === 0;
}

/** 天干の陰陽 */
export function stemYinYang(stem: string): string {
  return isYangStem(stem) ? "陽" : "陰";
}

/** 地支の陰陽（子寅辰午申戌＝陽、丑卯巳未酉亥＝陰） */
export function branchYinYang(branch: string): string {
  return branchIndexOf(branch) % 2 === 0 ? "陽" : "陰";
}

/** 干支の名前（「甲子」）→ 六十干支の index。ganzhiOf の逆引き */
const GANZHI_INDEX: ReadonlyMap<string, number> = new Map(
  Array.from({ length: 60 }, (_unused, index) => [ganzhiOf(index).ganzhi, index] as [string, number]),
);

/** 「甲子」→ 0。六十干支に無い組み合わせ（甲丑など）は弾く */
export function ganzhiIndexOf(ganzhi: string): number {
  const index = GANZHI_INDEX.get(ganzhi);
  if (index === undefined) throw new FourPillarsError(`六十干支にない組み合わせです: ${ganzhi}`);
  return index;
}

// ---------------------------------------------------------------------------
// 通変星（十神）
// ---------------------------------------------------------------------------

/**
 * 六親（納甲の言葉）→ 通変星の 2 つ組。[同じ陰陽のとき, 違う陰陽のとき]。
 *
 * 五行の生剋そのものは nakko.ts の relationOf に任せてある ―― 相生相剋の表を写し取らないため。
 * 我＝日干として、同＝比劫・我生＝食傷・我剋＝財・剋我＝官殺・生我＝印。
 */
const TEN_GOD_BY_RELATION: Readonly<Record<string, readonly [string, string]>> = {
  兄弟: ["比肩", "劫財"],
  子孫: ["食神", "傷官"],
  妻財: ["偏財", "正財"],
  官鬼: ["偏官", "正官"],
  父母: ["偏印", "印綬"],
};

/** 通変星 10 種（返り値に出る順ではなく、そろっているかを確かめるための一覧） */
export const TEN_GODS: readonly string[] = [
  "比肩",
  "劫財",
  "食神",
  "傷官",
  "偏財",
  "正財",
  "偏官",
  "正官",
  "偏印",
  "印綬",
];

/**
 * 通変星（日干から見た、ある天干の呼び名）。
 *
 * 陰陽が同じか違うかと、五行の生剋の向きだけで決まる ―― 表を持たずに導ける。
 */
export function tenGod(dayStem: string, otherStem: string): string {
  const relation = relationOf(stemElement(dayStem), stemElement(otherStem));
  const pair = TEN_GOD_BY_RELATION[relation];
  if (!pair) throw new FourPillarsError(`六親が読めません: ${relation}`);
  return isYangStem(dayStem) === isYangStem(otherStem) ? pair[0] : pair[1];
}

// ---------------------------------------------------------------------------
// 十二運（十二運星）
// ---------------------------------------------------------------------------

/** 長生から順に 12 段 */
export const TWELVE_STAGES: readonly string[] = [
  "長生",
  "沐浴",
  "冠帯",
  "建禄",
  "帝旺",
  "衰",
  "病",
  "死",
  "墓",
  "絶",
  "胎",
  "養",
];

/**
 * 各天干の長生の地支。
 *
 * 陽干は長生から順行、陰干は長生から逆行する（**陰干逆行**の規約。陽生陰死方式は採らない）。
 * 検算は建禄の位置で取れる ―― 甲の禄は寅、乙は卯、丙戊は巳、丁己は午、庚は申、辛は酉、壬は亥、癸は子。
 * 例: 甲は亥から順に 長生亥・沐浴子・冠帯丑・建禄寅 ―― 4 つ目がちゃんと寅。
 *     乙は午から逆に 長生午・沐浴巳・冠帯辰・建禄卯 ―― 4 つ目が卯。
 */
const CHANGSHENG_BRANCH: Readonly<Record<string, string>> = {
  甲: "亥",
  乙: "午",
  丙: "寅",
  丁: "酉",
  戊: "寅",
  己: "酉",
  庚: "巳",
  辛: "子",
  壬: "申",
  癸: "卯",
};

/** 日干から見た、ある地支の十二運 */
export function twelveStage(dayStem: string, branch: string): string {
  // 陽干かどうかを取るついでに、知らない干はここで弾かれる
  const yang = isYangStem(dayStem);
  const start = branchIndexOf(CHANGSHENG_BRANCH[dayStem] as string);
  const target = branchIndexOf(branch);
  // 陽干は長生から順に進み、陰干は長生から戻る
  const step = yang ? mod(target - start, 12) : mod(start - target, 12);
  return TWELVE_STAGES[step] as string;
}

// ---------------------------------------------------------------------------
// 空亡（旬空）
// ---------------------------------------------------------------------------

/** 空亡の表（旬の頭と、その旬に入らない 2 支） */
export interface VoidView {
  /** 旬の名前（甲子旬・甲戌旬 …… 甲寅旬） */
  decade: string;
  /** 旬に入らない 2 支（順に並ぶ） */
  branches: [string, string];
}

/**
 * 空亡。六十干支は 10 干 × 12 支なので、10 個ずつの旬には支が 2 つ余る ―― それが空亡。
 * 甲子旬＝戌亥／甲戌旬＝申酉／甲申旬＝午未／甲午旬＝辰巳／甲辰旬＝寅卯／甲寅旬＝子丑。
 */
export function voidOf(ganzhiIndex: number): VoidView {
  const index = mod(ganzhiIndex, 60);
  const headIndex = index - (index % 10);
  const headBranch = headIndex % 12;
  return {
    decade: `${ganzhiOf(headIndex).ganzhi}旬`,
    branches: [
      BRANCHES[mod(headBranch + 10, 12)] as string,
      BRANCHES[mod(headBranch + 11, 12)] as string,
    ],
  };
}

// ---------------------------------------------------------------------------
// 蔵干（人元）
// ---------------------------------------------------------------------------

/** 蔵干の格（本気＝その支の主・中気＝墓や長生に納まる気・余気＝前の月から残る気） */
export type HiddenStemRank = "本気" | "中気" | "余気";

/**
 * 蔵干表（三命通會などが載せる子平の標準形）。並びは本気 → 中気 → 余気。
 *
 * 節入り後の日数で 1 つを選ぶ**月律分野表は採らない**（日数の割り振りが流派で大きく割れるため）。
 * 代わりに全部並べ、節入りからの日数を別に返して、読む側が自分の表で選べるようにしてある。
 *
 * 中気・余気の役どころ:
 *  - 辰戌丑未（土の墓庫）は 余気＝前の月の五行、中気＝そこに納まる五行の陰干、本気＝土
 *    （丑＝余気癸／中気辛／本気己、辰＝余気乙／中気癸／本気戊、
 *      未＝余気丁／中気乙／本気己、戌＝余気辛／中気丁／本気戊）
 *  - 寅申巳亥（生地）は 余気＝戊（前の土の月から）、中気＝そこで長生する五行の陽干、本気＝その支の五行
 *  - 子卯酉は本気だけ、午は本気丁と中気己
 */
const HIDDEN_STEMS: Readonly<Record<string, readonly { stem: string; rank: HiddenStemRank }[]>> = {
  子: [{ stem: "癸", rank: "本気" }],
  丑: [
    { stem: "己", rank: "本気" },
    { stem: "辛", rank: "中気" },
    { stem: "癸", rank: "余気" },
  ],
  寅: [
    { stem: "甲", rank: "本気" },
    { stem: "丙", rank: "中気" },
    { stem: "戊", rank: "余気" },
  ],
  卯: [{ stem: "乙", rank: "本気" }],
  辰: [
    { stem: "戊", rank: "本気" },
    { stem: "癸", rank: "中気" },
    { stem: "乙", rank: "余気" },
  ],
  巳: [
    { stem: "丙", rank: "本気" },
    { stem: "庚", rank: "中気" },
    { stem: "戊", rank: "余気" },
  ],
  午: [
    { stem: "丁", rank: "本気" },
    { stem: "己", rank: "中気" },
  ],
  未: [
    { stem: "己", rank: "本気" },
    { stem: "乙", rank: "中気" },
    { stem: "丁", rank: "余気" },
  ],
  申: [
    { stem: "庚", rank: "本気" },
    { stem: "壬", rank: "中気" },
    { stem: "戊", rank: "余気" },
  ],
  酉: [{ stem: "辛", rank: "本気" }],
  戌: [
    { stem: "戊", rank: "本気" },
    { stem: "丁", rank: "中気" },
    { stem: "辛", rank: "余気" },
  ],
  亥: [
    { stem: "壬", rank: "本気" },
    { stem: "甲", rank: "中気" },
  ],
};

/** 蔵干 1 つぶん（日干から見た通変星つき） */
export interface HiddenStemView {
  stem: string;
  rank: HiddenStemRank;
  element: string;
  /** 日干から見た通変星 */
  ten_god: string;
}

/** ある地支の蔵干を本気 → 中気 → 余気の順に並べる */
export function hiddenStemsOf(branch: string, dayStem: string): HiddenStemView[] {
  branchIndexOf(branch); // 知らない支をここで弾く（表の穴と打ち間違いを取り違えないため）
  const table = HIDDEN_STEMS[branch];
  if (!table) throw new FourPillarsError(`蔵干表に無い地支です: ${branch}`);
  return table.map((entry) => ({
    stem: entry.stem,
    rank: entry.rank,
    element: stemElement(entry.stem),
    ten_god: tenGod(dayStem, entry.stem),
  }));
}

// ---------------------------------------------------------------------------
// 干支どうしの関係（天干五合・六合・六沖）
// ---------------------------------------------------------------------------

/** 天干五合（甲己・乙庚・丙辛・丁壬・戊癸）＝干の index が 5 離れている */
export function isStemCombination(a: string, b: string): boolean {
  return mod(stemIndexOf(a) - stemIndexOf(b), 10) === 5;
}

/** 六合（子丑・寅亥・卯戌・辰酉・巳申・午未）＝支の index の和が 1（mod 12） */
export function isBranchHarmony(a: string, b: string): boolean {
  return mod(branchIndexOf(a) + branchIndexOf(b), 12) === 1;
}

/** 六沖（子午・丑未・寅申・卯酉・辰戌・巳亥）＝支の index が 6 離れている */
export function isBranchClash(a: string, b: string): boolean {
  return mod(branchIndexOf(a) - branchIndexOf(b), 12) === 6;
}

/** 関係の種類（三合・刑・害は初版の範囲外） */
export type RelationKind = "天干五合" | "六合" | "六沖";

/** 巡ってきた柱と命式の柱のあいだに立った関係 */
export interface PillarRelation {
  /** 動く側（流年・月運・日運・時運） */
  from: string;
  /** 命式の側（年柱・月柱・日柱・時柱） */
  to: string;
  kind: RelationKind;
  /** 「甲己」「子午」 */
  pair: string;
}

// ---------------------------------------------------------------------------
// 節（12 の節入り）
// ---------------------------------------------------------------------------

/**
 * 12 の節（中気は取らない）。index は nakko.ts の monthBranchOrder と同じ並びで、0＝立春＝寅月の頭。
 * 太陽黄経が 315° から 30° ごとに切り替わるところが、そのまま月柱の境。
 */
export const SOLAR_TERMS: readonly { name: string; longitude: number; branch: string }[] = [
  { name: "立春", longitude: 315, branch: "寅" },
  { name: "驚蟄", longitude: 345, branch: "卯" },
  { name: "清明", longitude: 15, branch: "辰" },
  { name: "立夏", longitude: 45, branch: "巳" },
  { name: "芒種", longitude: 75, branch: "午" },
  { name: "小暑", longitude: 105, branch: "未" },
  { name: "立秋", longitude: 135, branch: "申" },
  { name: "白露", longitude: 165, branch: "酉" },
  { name: "寒露", longitude: 195, branch: "戌" },
  { name: "立冬", longitude: 225, branch: "亥" },
  { name: "大雪", longitude: 255, branch: "子" },
  { name: "小寒", longitude: 285, branch: "丑" },
];

/** 節入りの前後（呼び出し側が wasm で出して渡す。日数は小数可） */
export interface SolarTermSpan {
  /** 直前の節入りからの経過日数（0 以上） */
  days_since_previous: number;
  /** 次の節入りまでの残り日数（0 より大きい） */
  days_until_next: number;
}

/** ユリウス日から節入りの前後を作る小道具（呼び出し側が節の jd を持っているとき用） */
export function solarTermSpanFromJd(
  birthJd: number,
  previousTermJd: number,
  nextTermJd: number,
): SolarTermSpan {
  return {
    days_since_previous: birthJd - previousTermJd,
    days_until_next: nextTermJd - birthJd,
  };
}

/** 節入りの前後（名前つきで返す形） */
export interface SolarTermView {
  /** 直前の節（この節から今の月柱が始まる） */
  previous: { name: string; longitude: number };
  /** 次の節（ここで月柱が変わる） */
  next: { name: string; longitude: number };
  /** 直前の節入りからの日数（小数 1 桁） */
  days_since_previous: number;
  /** 次の節入りまでの日数（小数 1 桁） */
  days_until_next: number;
}

// ---------------------------------------------------------------------------
// 時辰の境目
// ---------------------------------------------------------------------------

/**
 * 「境ぎわの生まれか」を見るときの幅（分）。
 *
 * この分数**以内**のときだけ、どちら側の境に近いかを印として返す。
 * 名前つきの規約として conventions にも載る。
 */
export const HOUR_BOUNDARY_NOTE_MINUTES = 15;

/**
 * 時辰の境ぎわの印。
 *
 * 時刻の補正（経度補正・均時差）はかけていないので、補正をかける流派なら隣の時柱になり得る ――
 * それを読む側が判断できるだけの粗さで渡す。
 *
 * ⚠ **境からの分数そのものは返さない**。時支（＝2 時間の幅）と分数を合わせると
 *    出生時刻が分単位で復元できてしまうため、印は「どちら側か」と「見た幅」だけに絞ってある。
 */
export interface HourBoundaryNote {
  /** 前の境（今の時辰の頭）に近いか、次の境に近いか */
  side: "前" | "次";
  /** 何分以内を「境ぎわ」と見たか（＝ HOUR_BOUNDARY_NOTE_MINUTES） */
  within_minutes: number;
}

/**
 * 時辰の境ぎわかどうか。時辰は 23 時を頭に 2 時間ずつ。
 * どちらの境からも離れていれば null（＝印を出さない）。
 */
export function hourBoundaryNoteOf(hour: number, minute: number): HourBoundaryNote | null {
  const order = hourBranchIndex(hour);
  const startHour = mod(23 + order * 2, 24);
  // 境からの分数はここで作って、ここで捨てる ―― 返り値には出さない
  const sinceStart = mod(hour * 60 + minute - startHour * 60, 24 * 60);
  if (sinceStart <= HOUR_BOUNDARY_NOTE_MINUTES) {
    return { side: "前", within_minutes: HOUR_BOUNDARY_NOTE_MINUTES };
  }
  if (120 - sinceStart <= HOUR_BOUNDARY_NOTE_MINUTES) {
    return { side: "次", within_minutes: HOUR_BOUNDARY_NOTE_MINUTES };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 日界の代替（23 時台生まれのときだけ）
// ---------------------------------------------------------------------------

/**
 * 23 時台の扱いは 3 通りあって、どれを採るかで日柱・時柱が変わる。
 * 既定は nakko.ts と同じ「日界 0 時」で、残り 2 つを名前つきで添える。
 *
 *  - 日界 0 時（既定）: 23 時台もその日のまま。時柱は**当日の日干**から五鼠遁した子刻
 *  - 日界 23 時（子初換日）: 23 時で日が改まる。日柱も時柱も翌日扱い
 *  - 夜子時: 日柱は当日のまま、時柱だけ**翌日の日干**から五鼠遁した子刻
 *    （23:00〜24:00 を「その日の終わりに現れる、次の日の子刻」と見る立場。
 *      日本の四柱推命では「正子説／夜子時説／23 時日界説」の三つ巴として紹介されるうちの真ん中。
 *      日柱は動かさないが時柱だけ次の日の柱を使う、というのがこの立場の要点で、
 *      同じ「夜子時」という言葉を 23 時日界の意味で使う本もあるため、ここでは上の定義で固定する）
 */
export interface DayBoundaryAlternative {
  /** 規約の名前 */
  name: string;
  /** 一行の説明 */
  note: string;
  day: Pillar;
  hour: Pillar;
}

// ---------------------------------------------------------------------------
// 柱のひとそろい
// ---------------------------------------------------------------------------

/** 命式の 1 柱 */
export interface PillarView {
  /** 年柱 / 月柱 / 日柱 / 時柱 */
  label: string;
  stem: string;
  branch: string;
  ganzhi: string;
  stem_element: string;
  stem_yin_yang: string;
  branch_element: string;
  branch_yin_yang: string;
  /** 天干の通変星。日柱の天干は自分自身なので「日主」 */
  ten_god: string;
  /** 蔵干（本気 → 中気 → 余気） */
  hidden_stems: HiddenStemView[];
  /** 蔵干の本気で代表した通変星 */
  hidden_ten_god: string;
  /** 日干から見た十二運 */
  twelve_stage: string;
  /** 日柱の旬から見て空亡か */
  is_void: boolean;
}

/** 命式（年月日時） */
export interface FourPillarsView {
  year: PillarView;
  month: PillarView;
  day: PillarView;
  hour: PillarView;
}

/** 命式を年・月・日・時の順に並べた配列（表を書くとき用） */
export function orderedPillars(view: FourPillarsView): PillarView[] {
  return [view.year, view.month, view.day, view.hour];
}

// ---------------------------------------------------------------------------
// 大運
// ---------------------------------------------------------------------------

/** 大運の 1 柱 */
export interface LuckPillar {
  /** 1〜10（月柱の次／前から数えて何番目か） */
  index: number;
  stem: string;
  branch: string;
  ganzhi: string;
  /** 天干の通変星（日干から見て） */
  ten_god: string;
  /** 地支の十二運（日干から見て） */
  twelve_stage: string;
  /** 日柱の旬から見て空亡か */
  is_void: boolean;
  /** 開始年齢（起運 ＋ 10 × (index − 1)。起運と同じ小数 1 桁）。節入りの日数が渡されていなければ null */
  start_age: number | null;
  /** 終了年齢（開始 ＋ 10）。同上 */
  end_age: number | null;
}

/** 大運の一並び（順行か逆行のどちらか） */
export interface LuckCycle {
  /** 順行 / 逆行 */
  direction: string;
  /** この向きを採る性別（陽年干の男性・陰年干の女性＝順行、という規約に当てはめた結果） */
  applies_to: string;
  /** 起運（年）。小数 1 桁まで（＝出生時刻を約 7 時間の粗さでしか含まない）。節入りの日数が無ければ null */
  start_age: number | null;
  /** 起運を月に直した値（丸めたあとの起運 × 12 を整数へ四捨五入）。同上 */
  start_months: number | null;
  /** 起運のもとになった日数（順行は次の節入りまで、逆行は前の節入りから）。同上 */
  days_to_term: number | null;
  /** 月柱の次（順行）／前（逆行）から 10 柱 */
  pillars: LuckPillar[];
}

/** 順行・逆行の両方 */
export interface LuckCycles {
  forward: LuckCycle;
  backward: LuckCycle;
  /** どちらを採るかの規約名（採用そのものは読む側に委ねる） */
  direction_rule: string;
  /** 起運の出し方 */
  start_rule: string;
}

// ---------------------------------------------------------------------------
// 規約
// ---------------------------------------------------------------------------

/** 命式に添える規約の一覧（名前で固定し、結果と一緒に返す） */
export const FOUR_PILLARS_CONVENTIONS: Readonly<Record<string, string>> = {
  day_boundary:
    "日界 0 時（23 時台もその日のまま）。23 時台生まれのときだけ「日界 23 時」「夜子時」を alternatives に添える",
  time_correction: "時刻の補正なし（経度補正も均時差もかけず、標準時のまま時辰を切る）",
  hour_boundary_note:
    `時辰の境から ${HOUR_BOUNDARY_NOTE_MINUTES} 分以内のときだけ「どちら側の境に近いか」を印として返す。` +
    "境からの分数そのものは出さない（時支と合わせると出生時刻が分単位で復元できてしまうため）",
  solar_terms: "節気は太陽黄経（立春 315°、30° ごとに月柱が替わる）。年柱は立春で切り替える",
  hidden_stems:
    "蔵干は本気・中気・余気を全部並べ、通変星は本気で代表する。月律分野表（節入り後の日数で 1 つ選ぶ表）は採らない",
  twelve_stages: "十二運は陰干逆行（陽干は長生から順行、陰干は長生から逆行）。陽生陰死方式は採らない",
  void_branches: "空亡は日柱の旬から（その旬に入らない 2 支）",
  luck_cycles:
    "大運は性別を預からないので順行・逆行の両方を返す。起運は日数 ÷ 3 ＝ 年" +
    "（流派の丸め ―― 切り上げ・切り捨て・満年齢 ―― は採らない。採るなら読む側で）",
  luck_start_precision:
    "起運の精度は 0.1 年まで（月数は起運 × 12 を整数へ四捨五入）。" +
    "0.1 年は節入りからの日数にして約 0.3 日＝出生時刻を約 7 時間の粗さでしか含まない" +
    "（時支の 2 時間より粗い）。これは流派の丸め規約ではなく、返す値の精度の上限",
  relations: "巡りと命式の関係は天干五合・六合・六沖のみ。三合・刑・害は初版の範囲外",
  scope: "名前だけを返す。通変星・十二運・蔵干・空亡・大運の意味づけは載せない",
};

/** 流年・月運・日運に添える規約 */
export const DATE_FORTUNE_CONVENTIONS: Readonly<Record<string, string>> = {
  year_pillar: "流年の年柱は立春で切り替える（暦年ではない）",
  month_pillar: "月運の月柱は節入りで切り替える（太陽黄経 30° ごと）",
  day_pillar: "日運の日柱は日界 0 時",
  hour_pillar: "時運は時刻を渡したときだけ。時辰は 23 時を頭に 2 時間ずつ、補正なし",
  reference: "通変星・十二運・空亡はすべて命式の日干（と日柱の旬）から見た値",
  relations: "命式との関係は天干五合・六合・六沖のみ。三合・刑・害は初版の範囲外",
};

// ---------------------------------------------------------------------------
// 入り口の型
// ---------------------------------------------------------------------------

/** 命式を立てるのに要るもの。wasm はここに入る前に済ませておく */
export interface FourPillarsInput {
  /** 生まれた瞬間（その土地の時計で読んだ日時） */
  moment: NakkoMoment;
  /** その瞬間の太陽黄経（度）。年柱の立春判定と月柱の節の両方に使う */
  sun_longitude: number;
  /** 節入りの前後の日数。省くと大運の起運が出せない（干支の並びだけ返る） */
  term?: SolarTermSpan;
}

/** 命式ひとそろい */
export interface FourPillarsResult {
  pillars: FourPillarsView;
  /** 日干（自分。通変星も十二運もここが基準） */
  day_master: { stem: string; element: string; yin_yang: string };
  /** 空亡（日柱の旬から） */
  void: VoidView;
  /** 時辰の境ぎわの印。どちらの境からも離れていれば null */
  hour_boundary: HourBoundaryNote | null;
  /** その瞬間の太陽黄経（度） */
  sun_longitude: number;
  /** 節入りの前後。term を渡していなければ付かない */
  solar_term?: SolarTermView;
  /** 23 時台生まれのときだけ付く、日界の代替 2 通り */
  alternatives?: DayBoundaryAlternative[];
  luck_cycles: LuckCycles;
  conventions: Record<string, string>;
}

/** 流年・月運・日運を見る日付 */
export interface DateFortuneInput {
  /** 見る日（時刻まで見るなら include_hour を立てる） */
  moment: NakkoMoment;
  /** その瞬間の太陽黄経（度） */
  sun_longitude: number;
  /** 時運（時柱）まで出すか。既定は false */
  include_hour?: boolean;
}

/** 巡ってきた 1 柱 */
export interface FortunePillar {
  /** 流年 / 月運 / 日運 / 時運 */
  label: string;
  stem: string;
  branch: string;
  ganzhi: string;
  /** 命式の日干から見た通変星 */
  ten_god: string;
  /** 命式の日干から見た十二運 */
  twelve_stage: string;
  /** 命式の日柱の旬から見て空亡か */
  is_void: boolean;
  /** 蔵干（本気 → 中気 → 余気。通変星は命式の日干から） */
  hidden_stems: HiddenStemView[];
  /** 命式の 4 柱との関係 */
  relations: PillarRelation[];
}

/** 流年・月運・日運ひとそろい */
export interface DateFortuneResult {
  /** 見た日（出生データではないのでそのまま出す） */
  date: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
    utc_offset: number;
  };
  /** 命式の日干（何を基準に読んだかの控え） */
  day_master: string;
  /** 命式の空亡 */
  void: VoidView;
  /** 流年（年柱） */
  year: FortunePillar;
  /** 月運（月柱） */
  month: FortunePillar;
  /** 日運（日柱） */
  day: FortunePillar;
  /** 時運（時柱）。include_hour を立てたときだけ */
  hour?: FortunePillar;
  /** 立った関係を全部まとめたもの（柱ごとの relations と同じ中身） */
  relations: PillarRelation[];
  conventions: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/** 命式の柱の並び（表の列の順） */
const PILLAR_LABELS = ["年柱", "月柱", "日柱", "時柱"] as const;

/** 巡りの柱の並び */
const FORTUNE_LABELS = ["流年", "月運", "日運", "時運"] as const;

/** 年月日が整数で、暦に実在するか（打ち間違いが別の日の命式として静かに返るのを防ぐ） */
function assertMoment(label: string, moment: NakkoMoment): void {
  const entries: readonly [string, number][] = [
    ["年", moment.year],
    ["月", moment.month],
    ["日", moment.day],
    ["時", moment.hour],
    ["分", moment.minute],
  ];
  for (const [name, value] of entries) {
    if (!Number.isInteger(value)) {
      throw new FourPillarsError(`${label}の${name}は整数で指定してください: ${value}`);
    }
  }
  if (moment.year < 1 || moment.year > 9999) {
    throw new FourPillarsError(`${label}の年は西暦 1〜9999 で指定してください: ${moment.year}`);
  }
  if (moment.month < 1 || moment.month > 12) {
    throw new FourPillarsError(`${label}の月は 1〜12 で指定してください: ${moment.month}`);
  }
  if (!isCalendarDay(moment.year, moment.month, moment.day)) {
    throw new FourPillarsError(
      `${label}の ${moment.year}-${pad2(moment.month)}-${pad2(moment.day)} は暦に存在しない日付です` +
        `（${moment.year}年${moment.month}月は${daysInMonth(moment.year, moment.month)}日まで）`,
    );
  }
  if (moment.hour < 0 || moment.hour > 23) {
    throw new FourPillarsError(`${label}の時は 0〜23 で指定してください: ${moment.hour}`);
  }
  if (moment.minute < 0 || moment.minute > 59) {
    throw new FourPillarsError(`${label}の分は 0〜59 で指定してください: ${moment.minute}`);
  }
  if (!Number.isFinite(moment.utcOffset) || moment.utcOffset < -14 || moment.utcOffset > 14) {
    throw new FourPillarsError(`${label}の時差は -14〜14 で指定してください: ${moment.utcOffset}`);
  }
}

/** 太陽黄経が数として読めるか */
function assertLongitude(value: number): void {
  if (!Number.isFinite(value)) {
    throw new FourPillarsError(`太陽黄経は数値で指定してください: ${value}`);
  }
}

/** 節入りの前後の日数が向きどおりか */
function assertTerm(term: SolarTermSpan): void {
  if (!Number.isFinite(term.days_since_previous) || term.days_since_previous < 0) {
    throw new FourPillarsError(
      `直前の節入りからの日数は 0 以上で指定してください: ${term.days_since_previous}`,
    );
  }
  if (!Number.isFinite(term.days_until_next) || term.days_until_next <= 0) {
    throw new FourPillarsError(
      `次の節入りまでの日数は 0 より大きく指定してください: ${term.days_until_next}`,
    );
  }
}

/** 1 柱ぶんのビューを作る */
function pillarView(
  label: string,
  pillar: Pillar,
  dayStem: string,
  voidBranches: readonly string[],
  isDayPillar: boolean,
): PillarView {
  const hidden = hiddenStemsOf(pillar.branch, dayStem);
  const honki = hidden[0] as HiddenStemView;
  return {
    label,
    stem: pillar.stem,
    branch: pillar.branch,
    ganzhi: pillar.ganzhi,
    stem_element: stemElement(pillar.stem),
    stem_yin_yang: stemYinYang(pillar.stem),
    branch_element: branchElement(pillar.branch),
    branch_yin_yang: branchYinYang(pillar.branch),
    // 日柱の天干は自分自身。通変星の表では「日主」と書くのが習わし
    ten_god: isDayPillar ? "日主" : tenGod(dayStem, pillar.stem),
    hidden_stems: hidden,
    hidden_ten_god: honki.ten_god,
    twelve_stage: twelveStage(dayStem, pillar.branch),
    is_void: voidBranches.includes(pillar.branch),
  };
}

/** 節入りの前後を名前つきにする */
function solarTermView(sunLon: number, term: SolarTermSpan): SolarTermView {
  const order = monthBranchOrder(sunLon);
  const previous = SOLAR_TERMS[order] as (typeof SOLAR_TERMS)[number];
  const next = SOLAR_TERMS[(order + 1) % 12] as (typeof SOLAR_TERMS)[number];
  return {
    previous: { name: previous.name, longitude: previous.longitude },
    next: { name: next.name, longitude: next.longitude },
    days_since_previous: trim(term.days_since_previous, 1),
    days_until_next: trim(term.days_until_next, 1),
  };
}

/** 大運の一並びを組み立てる（step は +1 が順行、−1 が逆行） */
function luckCycle(
  direction: string,
  appliesTo: string,
  monthIndex: number,
  step: 1 | -1,
  dayStem: string,
  voidBranches: readonly string[],
  days: number | null,
): LuckCycle {
  // 起運は「節入りまでの日数 ÷ 3 ＝ 年」（3 日 = 1 年、1 日 = 4 か月）。
  // ⚠ **小数 1 桁で止める** ―― これは流派の丸め規約ではなく、返す値の精度の上限。
  //    0.1 年は節入りからの日数にして 0.3 日＝約 7 時間ぶんなので、時支（2 時間）より粗い。
  //    ここを 4 桁で返すと、日数が約 26 秒の精度で逆算でき、出生時刻が分単位で復元できてしまう。
  const startAge = days === null ? null : trim(days / 3, 1);
  const pillars: LuckPillar[] = Array.from({ length: 10 }, (_unused, offset) => {
    const pillar = ganzhiOf(monthIndex + step * (offset + 1));
    const start = startAge === null ? null : trim(startAge + offset * 10);
    return {
      index: offset + 1,
      stem: pillar.stem,
      branch: pillar.branch,
      ganzhi: pillar.ganzhi,
      ten_god: tenGod(dayStem, pillar.stem),
      twelve_stage: twelveStage(dayStem, pillar.branch),
      is_void: voidBranches.includes(pillar.branch),
      start_age: start,
      end_age: start === null ? null : trim(start + 10),
    };
  });
  return {
    direction,
    applies_to: appliesTo,
    start_age: startAge,
    // 月数は**丸めたあとの起運（0.1 年）から**作る ―― 元の日数から出すと精度が戻ってしまうため。
    // 0.1 年 × 12 は 1.2 か月刻みなので、いちばん近い整数へ寄せる（四捨五入。切り上げ・切り捨てはしない）
    start_months: startAge === null ? null : Math.round(startAge * 12),
    days_to_term: days === null ? null : trim(days, 1),
    pillars,
  };
}

/**
 * 命式を立てる。
 *
 * 乱数は使わない ―― 同じ引数なら何度呼んでも同じ命式が返る。
 */
export function calculateFourPillars(input: FourPillarsInput): FourPillarsResult {
  const { moment, sun_longitude: sunLon } = input;
  assertMoment("出生日時", moment);
  assertLongitude(sunLon);
  if (input.term) assertTerm(input.term);

  const raw: FourPillars = fourPillars(moment, sunLon);
  const dayStem = raw.day.stem;
  const dayIndex = dayGanzhiIndex(moment.year, moment.month, moment.day);
  const voids = voidOf(dayIndex);

  const pillars: FourPillarsView = {
    year: pillarView(PILLAR_LABELS[0], raw.year, dayStem, voids.branches, false),
    month: pillarView(PILLAR_LABELS[1], raw.month, dayStem, voids.branches, false),
    day: pillarView(PILLAR_LABELS[2], raw.day, dayStem, voids.branches, true),
    hour: pillarView(PILLAR_LABELS[3], raw.hour, dayStem, voids.branches, false),
  };

  // 大運は月柱から前後へ。性別を預からないので両方返す
  const monthIndex = ganzhiIndexOf(raw.month.ganzhi);
  const yangYear = isYangStem(raw.year.stem);
  const luckCycles: LuckCycles = {
    forward: luckCycle(
      "順行",
      yangYear ? "男性" : "女性",
      monthIndex,
      1,
      dayStem,
      voids.branches,
      input.term ? input.term.days_until_next : null,
    ),
    backward: luckCycle(
      "逆行",
      yangYear ? "女性" : "男性",
      monthIndex,
      -1,
      dayStem,
      voids.branches,
      input.term ? input.term.days_since_previous : null,
    ),
    direction_rule:
      "陽年干（甲丙戊庚壬）の男性・陰年干（乙丁己辛癸）の女性が順行、それ以外が逆行" +
      `（この命式の年干は${raw.year.stem}＝${stemYinYang(raw.year.stem)}）`,
    start_rule:
      "順行は次の節入りまでの日数、逆行は前の節入りからの日数を 3 で割って年に直す" +
      "（小数 1 桁まで。切り上げ・切り捨て・満年齢に直すといった流派の丸めは採らない）",
  };

  const result: FourPillarsResult = {
    pillars,
    day_master: {
      stem: dayStem,
      element: stemElement(dayStem),
      yin_yang: stemYinYang(dayStem),
    },
    void: voids,
    hour_boundary: hourBoundaryNoteOf(moment.hour, moment.minute),
    sun_longitude: sunLon,
    luck_cycles: luckCycles,
    conventions: { ...FOUR_PILLARS_CONVENTIONS },
  };

  if (input.term) result.solar_term = solarTermView(sunLon, input.term);

  const alternatives = dayBoundaryAlternatives(moment);
  if (alternatives) result.alternatives = alternatives;

  return result;
}

/**
 * 23 時台生まれのときだけ返す、日界の代替 2 通り。
 *
 * 年柱・月柱は動かさない ―― 翌日の太陽黄経を持っていないので、節入りをまたぐかどうかが分からないため
 * （またぐ位置なら月柱も年柱も変わりうる。そこは読む側に注意書きで渡す）。
 */
function dayBoundaryAlternatives(moment: NakkoMoment): DayBoundaryAlternative[] | undefined {
  if (moment.hour !== 23) return undefined;

  // 翌日の日干支。日をまたぐのは暦の計算だけで足りる（JDN が 1 つ進むだけ）
  const nextDayIndex = mod(dayGanzhiIndex(moment.year, moment.month, moment.day) + 1, 60);
  const nextDay = ganzhiOf(nextDayIndex);
  // 五鼠遁: 翌日の日干から起こした子刻（甲己→甲子・乙庚→丙子・丙辛→戊子・丁壬→庚子・戊癸→壬子）
  const nextRatStem = STEMS[((nextDayIndex % 10) % 5) * 2] as string;
  const nextRat: Pillar = { stem: nextRatStem, branch: "子", ganzhi: `${nextRatStem}子` };
  const currentDay = ganzhiOf(mod(nextDayIndex - 1, 60));

  return [
    {
      name: "日界23時",
      note: "23 時で日が改まると見る（子初換日）。日柱・時柱とも翌日扱い",
      day: nextDay,
      hour: nextRat,
    },
    {
      name: "夜子時",
      note: "日柱は当日のまま、時柱だけ翌日の日干から五鼠遁した子刻",
      day: currentDay,
      hour: nextRat,
    },
  ];
}

// ---------------------------------------------------------------------------
// 流年・月運・日運
// ---------------------------------------------------------------------------

/** 巡ってきた柱と命式の 4 柱を突き合わせる */
function relationsOf(label: string, pillar: Pillar, natal: FourPillarsView): PillarRelation[] {
  const relations: PillarRelation[] = [];
  for (const target of orderedPillars(natal)) {
    if (isStemCombination(pillar.stem, target.stem)) {
      relations.push({
        from: label,
        to: target.label,
        kind: "天干五合",
        // 干の並びは五合の呼び名の順（甲己・乙庚・丙辛・丁壬・戊癸＝index の小さいほうが先）
        pair: orderedStemPair(pillar.stem, target.stem),
      });
    }
    if (isBranchHarmony(pillar.branch, target.branch)) {
      relations.push({
        from: label,
        to: target.label,
        kind: "六合",
        pair: orderedBranchPair(pillar.branch, target.branch),
      });
    }
    if (isBranchClash(pillar.branch, target.branch)) {
      relations.push({
        from: label,
        to: target.label,
        kind: "六沖",
        pair: orderedBranchPair(pillar.branch, target.branch),
      });
    }
  }
  return relations;
}

/** 「甲己」のように、干の index の小さいほうを先に並べる */
function orderedStemPair(a: string, b: string): string {
  return stemIndexOf(a) <= stemIndexOf(b) ? `${a}${b}` : `${b}${a}`;
}

/** 「子丑」「子午」のように、支の index の小さいほうを先に並べる */
function orderedBranchPair(a: string, b: string): string {
  return branchIndexOf(a) <= branchIndexOf(b) ? `${a}${b}` : `${b}${a}`;
}

/** 巡ってきた 1 柱を組み立てる */
function fortunePillar(
  label: string,
  pillar: Pillar,
  natal: FourPillarsResult,
): FortunePillar {
  const dayStem = natal.day_master.stem;
  return {
    label,
    stem: pillar.stem,
    branch: pillar.branch,
    ganzhi: pillar.ganzhi,
    ten_god: tenGod(dayStem, pillar.stem),
    twelve_stage: twelveStage(dayStem, pillar.branch),
    is_void: natal.void.branches.includes(pillar.branch),
    hidden_stems: hiddenStemsOf(pillar.branch, dayStem),
    relations: relationsOf(label, pillar, natal.pillars),
  };
}

/**
 * ある日付の流年・月運・日運（と、時刻を渡したときは時運）。
 *
 * 通変星も十二運も空亡も、すべて**命式の日干**から見た値。
 * 巡りと命式の関係は天干五合・六合・六沖の 3 つだけ（三合・刑・害は初版の範囲外）。
 */
export function calculateDateFortune(
  natal: FourPillarsResult,
  input: DateFortuneInput,
): DateFortuneResult {
  const { moment, sun_longitude: sunLon } = input;
  assertMoment("対象日", moment);
  assertLongitude(sunLon);

  const raw = fourPillars(moment, sunLon);
  const includeHour = input.include_hour === true;

  const year = fortunePillar(FORTUNE_LABELS[0], raw.year, natal);
  const month = fortunePillar(FORTUNE_LABELS[1], raw.month, natal);
  const day = fortunePillar(FORTUNE_LABELS[2], raw.day, natal);
  const hour = includeHour ? fortunePillar(FORTUNE_LABELS[3], raw.hour, natal) : undefined;

  const date: DateFortuneResult["date"] = {
    year: moment.year,
    month: moment.month,
    day: moment.day,
    utc_offset: moment.utcOffset,
  };
  if (includeHour) {
    date.hour = moment.hour;
    date.minute = moment.minute;
  }

  const result: DateFortuneResult = {
    date,
    day_master: natal.day_master.stem,
    void: natal.void,
    year,
    month,
    day,
    relations: [...year.relations, ...month.relations, ...day.relations],
    conventions: { ...DATE_FORTUNE_CONVENTIONS },
  };
  if (hour) {
    result.hour = hour;
    result.relations.push(...hour.relations);
  }
  return result;
}

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

/** 全角を 2、半角を 1 として数えた表示幅 */
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

/** 命式表の 1 行（見出し ＋ 4 列） */
function tableRow(label: string, cells: readonly string[]): string {
  return (padRight(label, 10) + cells.map((cell) => padRight(cell, 12)).join("")).trimEnd();
}

/** 蔵干を「丁/己」の形に */
function hiddenLabel(hidden: readonly HiddenStemView[]): string {
  return hidden.map((entry) => entry.stem).join("/");
}

/** 空亡の欄（当たっていなければ全角のダッシュ） */
function voidMark(isVoid: boolean): string {
  return isVoid ? "空亡" : "－";
}

/** 大運の 1 行 */
function luckPillarLine(pillar: LuckPillar): string {
  const age =
    pillar.start_age === null || pillar.end_age === null
      ? padRight("－", 14)
      : padRight(`${pillar.start_age.toFixed(1)}〜${pillar.end_age.toFixed(1)}`, 14);
  return (
    "  " +
    age +
    padRight(pillar.ganzhi, 6) +
    padRight(pillar.ten_god, 8) +
    padRight(pillar.twelve_stage, 8) +
    voidMark(pillar.is_void)
  );
}

/** 大運の見出し行と 10 柱 */
function luckCycleLines(cycle: LuckCycle): string[] {
  const head =
    cycle.start_age === null || cycle.start_months === null || cycle.days_to_term === null
      ? `大運（${cycle.direction}・${cycle.applies_to}）: 起運は不明（節入りまでの日数が渡されていません）`
      : `大運（${cycle.direction}・${cycle.applies_to}）: 起運 ${cycle.start_age.toFixed(1)} 年` +
        `（約 ${cycle.start_months} か月／もとになった日数 ${cycle.days_to_term.toFixed(1)} 日 ÷ 3）`;
  return [head, ...cycle.pillars.map(luckPillarLine)];
}

/**
 * Claude が読む用のテキスト表現。
 *
 * 頭に本が載せるかたちの命式表（年柱・月柱・日柱・時柱 × 天干・地支・蔵干・通変星・十二運・空亡）を置き、
 * そのあとに空亡・節入り・時辰・日界の代替・大運・規約を並べる。
 * 意味づけは載せない ―― 表を渡すだけで、読みは呼び出した側に委ねます。
 *
 * 出生の年月日時・時差そのものは書かない（命式・蔵干・大運は派生値なので書く）。
 */
export function formatFourPillarsText(result: FourPillarsResult): string {
  const pillars = orderedPillars(result.pillars);
  const lines = ["■ 四柱推命（命式）"];

  lines.push(tableRow("", PILLAR_LABELS));
  lines.push(tableRow("天干", pillars.map((p) => `${p.stem}(${p.stem_yin_yang}${p.stem_element})`)));
  lines.push(tableRow("通変星", pillars.map((p) => p.ten_god)));
  lines.push(tableRow("地支", pillars.map((p) => `${p.branch}(${p.branch_yin_yang}${p.branch_element})`)));
  lines.push(tableRow("蔵干", pillars.map((p) => hiddenLabel(p.hidden_stems))));
  lines.push(tableRow("蔵干通変", pillars.map((p) => p.hidden_ten_god)));
  lines.push(tableRow("十二運", pillars.map((p) => p.twelve_stage)));
  lines.push(tableRow("空亡", pillars.map((p) => voidMark(p.is_void))));

  lines.push(
    `日主: ${result.day_master.stem}（${result.day_master.yin_yang}${result.day_master.element}）` +
      `  蔵干は本気/中気/余気の順、蔵干通変は本気で代表`,
  );
  lines.push(
    `空亡（${result.pillars.day.ganzhi}日＝${result.void.decade}）: ` +
      result.void.branches.join("・"),
  );

  if (result.solar_term) {
    const term = result.solar_term;
    lines.push(
      `節入り: ${term.previous.name}から ${term.days_since_previous.toFixed(1)} 日` +
        `／次の${term.next.name}まで ${term.days_until_next.toFixed(1)} 日` +
        "（月律分野表で蔵干を絞るならこの日数で）",
    );
  }

  // 境ぎわのときだけ一言添える。何分ぎわかは書かない（出生時刻が復元できてしまうため）
  const note = result.hour_boundary;
  if (note) {
    const step = note.side === "次" ? 1 : -1;
    const neighbour = BRANCHES[
      mod(branchIndexOf(result.pillars.hour.branch) + step, 12)
    ] as string;
    const where =
      note.side === "次" ? `（次の${neighbour}刻）まで` : `（前の${neighbour}刻）から`;
    lines.push(
      `時辰の境${where} ${note.within_minutes} 分以内 ―― ` +
        "時刻補正をかける流派では隣の時柱になり得ます",
    );
  }

  if (result.alternatives) {
    lines.push("23 時台の生まれです。既定は日界 0 時。ほかの規約なら:");
    for (const alternative of result.alternatives) {
      lines.push(
        `  ${padRight(alternative.name, 12)}日柱 ${alternative.day.ganzhi}／時柱 ${alternative.hour.ganzhi}` +
          `（${alternative.note}）`,
      );
    }
    lines.push("  ※ 代替の年柱・月柱は出していません（翌日が節入りをまたぐかどうかまでは見ていないため）");
  }

  lines.push(result.luck_cycles.direction_rule);
  lines.push(...luckCycleLines(result.luck_cycles.forward));
  lines.push(...luckCycleLines(result.luck_cycles.backward));

  lines.push(
    "規約: 日界 0 時／時刻の補正なし／節気は太陽黄経／蔵干は本気・中気・余気を全列挙（月律分野表は採らない）" +
      "／十二運は陰干逆行／空亡は日柱から／大運は順逆の両方・起運は 0.1 年まで（流派の丸めは採らない）" +
      `／時辰は境から ${HOUR_BOUNDARY_NOTE_MINUTES} 分以内のときだけ印を出す（上の一文が無ければ境ぎわではない）`,
  );
  return lines.join("\n");
}

/** 巡りの 1 柱ぶんの行 */
function fortunePillarLines(pillar: FortunePillar): string[] {
  const head =
    padRight(pillar.label, 8) +
    padRight(pillar.ganzhi, 6) +
    padRight(pillar.ten_god, 8) +
    padRight(pillar.twelve_stage, 8) +
    padRight(voidMark(pillar.is_void), 6) +
    `蔵干 ${hiddenLabel(pillar.hidden_stems)}`;
  if (pillar.relations.length === 0) return [head];
  return [
    head,
    "  " + pillar.relations.map((r) => `${r.to}と${r.kind}（${r.pair}）`).join("、"),
  ];
}

/**
 * 流年・月運・日運の Claude が読む用のテキスト表現。
 *
 * 見た日付は出生データではないのでそのまま書く。意味づけはやはり載せない。
 */
export function formatDateFortuneText(result: DateFortuneResult): string {
  const date = result.date;
  const stamp =
    `${date.year}-${pad2(date.month)}-${pad2(date.day)}` +
    (date.hour === undefined ? "" : ` ${pad2(date.hour)}:${pad2(date.minute ?? 0)}`);

  const lines = [`■ 流年・月運・日運（${stamp}）`];
  lines.push(
    `日主 ${result.day_master} から見た値です（空亡は命式の日柱 ${result.void.decade}＝` +
      `${result.void.branches.join("・")} で見ています）`,
  );
  lines.push(
    padRight("", 8) + padRight("干支", 6) + padRight("通変星", 8) + padRight("十二運", 8) + "空亡",
  );

  for (const pillar of [result.year, result.month, result.day, result.hour]) {
    if (!pillar) continue;
    lines.push(...fortunePillarLines(pillar));
  }

  if (result.relations.length === 0) {
    lines.push("命式との天干五合・六合・六沖は立っていません");
  }
  lines.push(
    "規約: 流年は立春切替／月運は節入り切替／日運は日界 0 時／関係は天干五合・六合・六沖のみ" +
      "（三合・刑・害は範囲外）",
  );
  return lines.join("\n");
}
