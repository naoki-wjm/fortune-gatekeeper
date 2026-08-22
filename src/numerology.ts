/**
 * 数秘術（ピタゴラス式・生年月日ベース）の純関数。
 *
 * 背骨は draw.ts・iching.ts・geomancy.ts と同じ ―― 計算するのはサーバー、読むのは呼び出した側の Claude。
 * ただしここには乱数が 1 ビットも無い。**サーバーの仕事は「規約を固定すること」だけ**です。
 *
 * ライフパスは流派（還元の規約）が違うと、同じ生年月日から違う数が出ます。
 * 1986-12-29 は 11 にも 2 にもなり、実際に別々の LLM が別の数を答えました ―― それがこのツールの理由。
 * そこでここでは**単一の答えを出さず**、名前つきの 4 経路と途中式を並べて返します。
 * どの経路で読むかは会話の中で決めてください（意味づけも占断もここには載せません）。
 *
 * 途中式（steps）には**生まれ年と生まれ月の生の数字を書きません**。還元したあとの値だけで組み立てます
 * （鍵つきの層から呼ばれたときに、出生データが会話ログへこぼれないように）。
 * 日はバースデーナンバーとしてもともと表に出る数なので、そのまま書きます。
 * 基準日（パーソナルイヤーなどの対象日）は出生データではないので、こちらも全部書きます。
 *
 * 暦の検算（2 月 31 日を通さない）は納甲と同じ道具を借りています ―― 写しを増やさないため。
 */
import { daysInMonth, isCalendarDay } from "./nakko";

/** 引数の形が受け付けられなかったときの言い分 */
export class NumerologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NumerologyError";
  }
}

/** マスターナンバーの取り方（11/22/33 を認めるか、33 を認めないか） */
export type MastersOption = "11_22_33" | "11_22";

/** masters 引数に使える値（ツール定義の enum もこれを見る） */
export const MASTERS_OPTIONS: readonly MastersOption[] = ["11_22_33", "11_22"];

/** masters を省いたときの規約（33 まで認める） */
export const DEFAULT_MASTERS: MastersOption = "11_22_33";

/** 還元規約のプリセット名（この 4 つで固定。並び順もこのまま返す） */
export type PresetKey = "full_sum" | "component_reduce" | "component_keep" | "no_master";

/** プリセットの並び（返り値の presets のキー順もこれ） */
export const PRESET_KEYS: readonly PresetKey[] = [
  "full_sum",
  "component_reduce",
  "component_keep",
  "no_master",
];

/** プリセットの一行説明（返り値の conventions にそのまま載る） */
export const PRESET_NOTES: Record<PresetKey, string> = {
  full_sum: "生年月日の全桁をまとめて足し、最後の和でマスターナンバーを保持する",
  component_reduce: "年・月・日をそれぞれ 1 桁まで還元してから足し、最後の和でマスターナンバーを保持する",
  component_keep: "年・月・日をそれぞれ還元するとき、マスターナンバーは保持したまま足す",
  no_master: "マスターナンバーを認めず、全桁の和を 1 桁まで還元する",
};

/** 1 つの経路の答え */
export interface PathResult {
  /** その経路で出た数（マスターならマスターのまま） */
  value: number;
  /** マスターのときの還元先（11→2・22→4・33→6）。マスターでなければ value と同じ */
  reduced: number;
  is_master: boolean;
  /** 途中式。生まれ年・生まれ月の生の数字は入れない */
  steps: string;
}

/** 4 経路ぶんの答えと、割れているかどうか */
export interface MultiPath {
  presets: Record<PresetKey, PathResult>;
  /** 4 経路の value がすべて同じか */
  agree: boolean;
  /** 出た value の重複なし一覧（出現順） */
  values: number[];
}

/** バースデーナンバー（経路で割れないので 1 本だけ） */
export interface BirthdayNumber {
  /** 生まれた日（この数だけは生のまま出す） */
  day: number;
  value: number;
  reduced: number;
  is_master: boolean;
  steps: string;
}

/** 基準日（パーソナルイヤーなどを見る日） */
export interface TargetDate {
  year: number;
  month: number;
  day: number;
}

export interface NumerologyInput {
  year: number;
  month: number;
  day: number;
  target: TargetDate;
  masters?: MastersOption;
}

export interface NumerologyResult {
  life_path: MultiPath;
  birthday: BirthdayNumber;
  attitude: MultiPath;
  personal_year: { year: number } & MultiPath;
  personal_month: { year: number; month: number } & MultiPath;
  personal_day: { year: number; month: number; day: number } & MultiPath;
  conventions: {
    masters: number[];
    /** パーソナルイヤーの起点。暦年（1/1 で切り替わる）で固定 */
    personal_year_start: "calendar";
    presets: Record<PresetKey, string>;
    note: string;
  };
}

/** 返り値の末尾に添える、このツールの守備範囲 */
const SCOPE_NOTE =
  "生年月日ベースのピタゴラス式。名前数秘・ピナクル・チャレンジは v1 の範囲外";

// ---------------------------------------------------------------------------
// 数の操作
// ---------------------------------------------------------------------------

/** 十進の各桁の和（38 → 11） */
export function digitSum(value: number): number {
  return String(value)
    .split("")
    .reduce((sum, digit) => sum + Number(digit), 0);
}

/**
 * 1 桁になるまで（またはマスターナンバーに当たるまで）桁の和を取り続ける。
 * masters が空なら 1〜9 まで落とす。
 */
export function reduceNumber(value: number, masters: readonly number[]): number {
  let current = value;
  while (current > 9 && !masters.includes(current)) {
    current = digitSum(current);
  }
  return current;
}

/** 還元の道のりを文字列にする（38 → 3+8 = 11）。1 段も還元しないなら数そのもの */
function reductionChain(start: number, masters: readonly number[]): { value: number; chain: string } {
  let value = start;
  const parts = [String(start)];
  while (value > 9 && !masters.includes(value)) {
    const digits = String(value).split("");
    const next = digits.reduce((sum, digit) => sum + Number(digit), 0);
    parts.push(`${digits.join("+")} = ${next}`);
    value = next;
  }
  return { value, chain: parts.join(" → ") };
}

/** マスターに当たって止まったときの但し書き。マスターを認めない経路は「マスター無し」 */
function stopNote(value: number, masters: readonly number[]): string {
  if (masters.length === 0) return "（マスター無し）";
  return masters.includes(value) ? "（マスター、保持）" : "";
}

/** 数とその還元先から 1 経路ぶんの答えを作る */
function pathResult(value: number, masters: readonly number[], steps: string): PathResult {
  const isMaster = masters.includes(value);
  return {
    value,
    reduced: isMaster ? reduceNumber(value, []) : value,
    is_master: isMaster,
    steps,
  };
}

/** 4 経路をまとめ、割れているかどうかを見る */
function multiPath(presets: Record<PresetKey, PathResult>): MultiPath {
  const values: number[] = [];
  for (const key of PRESET_KEYS) {
    const value = presets[key].value;
    if (!values.includes(value)) values.push(value);
  }
  return { presets, agree: values.length === 1, values };
}

/** 合算のもとになる 1 項（表示名と、還元前の生の数） */
interface Component {
  /** 途中式に出す名前（年・月・日・基準年） */
  label: string;
  /** 還元前の数。full_sum ではこの桁を、component_* では還元した値を使う */
  value: number;
}

/**
 * 「いくつかの数を足して還元する」形の 4 経路をまとめて組み立てる。
 *
 * ライフパス（年・月・日）・アティチュード（月・日）・パーソナルイヤー（月・日・基準年）が
 * すべてこの形なので、規約の違いはここ 1 箇所に閉じ込めてある。
 *
 * fullLabel は full_sum / no_master の途中式の頭に置く言葉（「全桁の合計」など）。
 */
function multiFromComponents(
  components: readonly Component[],
  masters: readonly number[],
  fullLabel: string,
): MultiPath {
  // 全桁の合計は、各項の桁の和を足したものと同じ（0 埋めの有無に左右されない）
  const fullTotal = components.reduce((sum, part) => sum + digitSum(part.value), 0);

  const withMaster = reductionChain(fullTotal, masters);
  const withoutMaster = reductionChain(fullTotal, []);

  /** 年・月・日を個別に還元してから足す経路（還元のときマスターを認めるかを切り替える） */
  const componentPath = (partMasters: readonly number[]): PathResult => {
    const reducedParts = components.map((part) => reduceNumber(part.value, partMasters));
    const sum = reducedParts.reduce((total, part) => total + part, 0);
    const chain = reductionChain(sum, masters);
    const written = components
      .map((part, index) => `${part.label} ${reducedParts[index]}`)
      .join(" ＋ ");
    return pathResult(
      chain.value,
      masters,
      `${written} = ${chain.chain}${stopNote(chain.value, masters)}`,
    );
  };

  return multiPath({
    full_sum: pathResult(
      withMaster.value,
      masters,
      `${fullLabel} ${withMaster.chain}${stopNote(withMaster.value, masters)}`,
    ),
    component_reduce: componentPath([]),
    component_keep: componentPath(masters),
    no_master: pathResult(withoutMaster.value, [], `${fullLabel} ${withoutMaster.chain}（マスター無し）`),
  });
}

/**
 * 「前の段の答えに 1 つ足して還元する」形の 4 経路（パーソナルマンス・パーソナルデイ）。
 * 経路ごとに前の段の値が違うので、プリセットの筋をそのまま引き継ぐ。
 */
function multiFromBase(
  base: MultiPath,
  baseLabel: string,
  addend: number,
  addendLabel: string,
  masters: readonly number[],
): MultiPath {
  const build = (key: PresetKey): PathResult => {
    // マスターを認めない経路は、この段でも認めない
    const pathMasters = key === "no_master" ? [] : masters;
    const from = base.presets[key].value;
    const chain = reductionChain(from + addend, pathMasters);
    return pathResult(
      chain.value,
      pathMasters,
      `${baseLabel} ${from} ＋ ${addendLabel} ${addend} = ${chain.chain}` +
        stopNote(chain.value, pathMasters),
    );
  };

  return multiPath({
    full_sum: build("full_sum"),
    component_reduce: build("component_reduce"),
    component_keep: build("component_keep"),
    no_master: build("no_master"),
  });
}

/** マスターナンバーの規約（名前 → 数の並び） */
function mastersOf(option: MastersOption): number[] {
  return option === "11_22" ? [11, 22] : [11, 22, 33];
}

// ---------------------------------------------------------------------------
// 入り口
// ---------------------------------------------------------------------------

/** 年月日が整数で、暦に実在するか（打ち間違いが別の日の答えとして静かに返るのを防ぐ） */
function assertDate(label: string, year: number, month: number, day: number): void {
  for (const [name, value] of [
    ["年", year],
    ["月", month],
    ["日", day],
  ] as const) {
    if (!Number.isInteger(value)) {
      throw new NumerologyError(`${label}の${name}は整数で指定してください: ${value}`);
    }
  }
  if (year < 1 || year > 9999) {
    throw new NumerologyError(`${label}の年は西暦 1〜9999 で指定してください: ${year}`);
  }
  if (month < 1 || month > 12) {
    throw new NumerologyError(`${label}の月は 1〜12 で指定してください: ${month}`);
  }
  if (!isCalendarDay(year, month, day)) {
    throw new NumerologyError(
      `${label}の ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} は` +
        `暦に存在しない日付です（${year}年${month}月は${daysInMonth(year, month)}日まで）`,
    );
  }
}

/**
 * 生年月日と基準日から、数秘術の数を計算する。
 *
 * 乱数は使わない ―― 同じ引数なら何度呼んでも同じ答えが返る。
 */
export function calculateNumerology(input: NumerologyInput): NumerologyResult {
  const { year, month, day, target } = input;
  assertDate("生年月日", year, month, day);
  assertDate("基準日", target.year, target.month, target.day);

  const option = input.masters ?? DEFAULT_MASTERS;
  if (!MASTERS_OPTIONS.includes(option)) {
    throw new NumerologyError(`masters は ${MASTERS_OPTIONS.join(" / ")} のどちらかです: ${option}`);
  }
  const masters = mastersOf(option);

  const lifePath = multiFromComponents(
    [
      { label: "年", value: year },
      { label: "月", value: month },
      { label: "日", value: day },
    ],
    masters,
    "全桁の合計",
  );

  const birthdayChain = reductionChain(day, masters);
  const birthdayPath = pathResult(
    birthdayChain.value,
    masters,
    `日 ${birthdayChain.chain}${stopNote(birthdayChain.value, masters)}`,
  );

  const attitude = multiFromComponents(
    [
      { label: "月", value: month },
      { label: "日", value: day },
    ],
    masters,
    "月日の合計",
  );

  const personalYear = multiFromComponents(
    [
      { label: "月", value: month },
      { label: "日", value: day },
      { label: "基準年", value: target.year },
    ],
    masters,
    `月日と ${target.year} の全桁の合計`,
  );

  const personalMonth = multiFromBase(
    personalYear,
    "パーソナルイヤー",
    target.month,
    "基準月",
    masters,
  );

  const personalDay = multiFromBase(
    personalMonth,
    "パーソナルマンス",
    target.day,
    "基準日",
    masters,
  );

  return {
    life_path: lifePath,
    birthday: { day, ...birthdayPath },
    attitude,
    personal_year: { year: target.year, ...personalYear },
    personal_month: { year: target.year, month: target.month, ...personalMonth },
    personal_day: { year: target.year, month: target.month, day: target.day, ...personalDay },
    conventions: {
      masters: [...masters],
      personal_year_start: "calendar",
      presets: { ...PRESET_NOTES },
      note: SCOPE_NOTE,
    },
  };
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 11 (→2) / 5 のような表示（マスターのときだけ還元先を添える） */
function valueLabel(path: PathResult | BirthdayNumber): string {
  return path.is_master ? `${path.value} (→${path.reduced})` : String(path.value);
}

/**
 * 4 経路ぶんの行。
 * 一致していれば 1 行に畳み、割れているときだけ経路ごとの途中式を並べる。
 */
function multiLines(label: string, multi: MultiPath): string[] {
  const first = multi.presets[PRESET_KEYS[0] as PresetKey];
  if (multi.agree) return [`${label}: ${valueLabel(first)}（4 経路一致）`];

  const lines = [`${label}: ${multi.values.join(" / ")} ← 経路で割れています`];
  for (const key of PRESET_KEYS) {
    const path = multi.presets[key];
    lines.push(`  ${key.padEnd(17)}${valueLabel(path).padEnd(9)}${path.steps}`);
  }
  return lines;
}

/**
 * Claude が読む用のテキスト表現。
 *
 * 意味は載せない ―― 数と途中式と採った規約だけ渡して、読みは呼び出した側に委ねます。
 */
export function formatNumerologyText(result: NumerologyResult): string {
  const target = result.personal_day;
  const birthday = result.birthday;

  const lines = ["■ 数秘術（生年月日ベース・ピタゴラス式）"];
  lines.push(...multiLines("ライフパス", result.life_path));
  lines.push(
    birthday.value === birthday.day
      ? `バースデー: ${birthday.day}`
      : `バースデー: ${birthday.day} → ${valueLabel(birthday)}`,
  );
  lines.push(...multiLines("アティチュード（サンナンバー）", result.attitude));
  lines.push(...multiLines(`パーソナルイヤー ${result.personal_year.year}`, result.personal_year));
  lines.push(
    ...multiLines(
      `パーソナルマンス ${target.year}-${pad2(target.month)}`,
      result.personal_month,
    ),
  );
  lines.push(
    ...multiLines(
      `パーソナルデイ ${target.year}-${pad2(target.month)}-${pad2(target.day)}`,
      result.personal_day,
    ),
  );
  lines.push(
    `規約: マスター ${result.conventions.masters.join("/")}、` +
      "パーソナルイヤーは暦年起点（1/1 で切り替わる）。" +
      "名前数秘・ピナクル・チャレンジは範囲外",
  );
  return lines.join("\n");
}
