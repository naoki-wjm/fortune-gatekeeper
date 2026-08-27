/**
 * 逆引きホロスコープ ―― 「太陽が牡羊座・月が蟹座」のような**配置のほうを先に決めて**、
 * その配置になる日を年代範囲から逆に引く。
 *
 * 位置づけは moon-calendar.ts と同じ「公開層の計算モジュール」。**乱数なし・個人データなし**
 * （誕生日も場所も受けない＝誰が呼んでも同じ答え）なので、公開の入口 `POST /mcp` に置いてある。
 * 鍵つきの入口 `/astro/mcp` にはカード層まるごとの同居（スーパーセット化）で自動的に載る。
 *
 * ここも解釈は一切持たない ―― 返すのは日付と時刻の範囲と星座の名前だけ。「その配置の人は」の
 * たぐいは 1 文字も書かない（読むのは呼び出した側の LLM）。
 *
 * 移植元は astro-viewer の `reverse/reverse.js`（ブラウザ版）。あちらは**6 時間刻みの総当たり**で、
 * 10 年ぶん走るのに数秒かかる。Workers に総当たりは持ち込めないので、作りを入れ替えてある:
 *
 *  - **太陽と月の窓は一発計算**。`swe_solcross_ut` / `swe_mooncross_ut`（returns.ts の `crossUt`
 *    経由＝壊れたエラーチェックの検算つき）で「その星座に入る瞬間／出る瞬間」を直に取る。
 *    太陽は年に 1 回・月は 27.3 日に 1 回しか入らないので、30 年でも太陽 62 回・月 800 回で済む。
 *  - **ほかの天体は疎サンプル＋3 次エルミート補間**（events.ts の `positionAt` を借用）。
 *    刻みは events.ts が本物の wasm と突き合わせて決めた値と同じ（水星〜火星 1 日・木星〜冥王星 4 日）。
 *    補間の上を刻みの 1/24（1〜4 時間）で歩いて星座の出入りを拾い、境目は二分法で詰める
 *    ―― 二分法の途中では wasm を 1 度も呼ばない。
 *  - **絞ってから次を見る**。条件は「安く絞れる順」（太陽 → 外惑星 → 木星土星 → 火星金星水星 → 月）に
 *    処理し、**前の条件で残った区間の内側だけ**を次の天体で見る。太陽が 1 本あれば残るのは 1/12 なので、
 *    後ろの天体の天体計算はそのぶんだけになる。
 *
 * ⚠ サンプルの刻みより短い「行って戻る」（星座の境のすぐ内側で留になる形）は取りこぼしうる。
 *    拾えるかどうかを決めているのは**補間の上を歩く刻み**（`FINE_TICKS_PER_STEP` ＝ サンプルの 1/24
 *    ＝水星〜火星で 1 時間・木星〜冥王星で 4 時間）で、それより短い出入りは格子の目をすり抜けうる
 *    （太陽と月は一発計算なのでこの穴は無い）。この穴は黙っていないで**返り値と説明文にも書く**
 *    ―― `REVERSE_LIMITATIONS`（conventions.limitations）とテキストの ⚠ 行が正文。2026-08-27 査読対応。
 *
 *    実物での当たり: 1800〜2200 年に「星座の境のすぐ内側で留になる」形は実際にあり、いちばん浅いのは
 *    1970-01-04 の水星（水瓶座に 0.0024° だけ入って戻る＝**7.65 時間**）。1 時間の格子には十分かかる
 *    ので実測でも拾えている（test/reverse-horoscope-real.test.ts）。穴に落ちるには留が境から
 *    3e-5° 以内という、この 400 年には 1 度も無い浅さが要る ―― 原理として残るだけの穴、という位置づけ。
 */
import {
  AstroError,
  CALC_FLAGS,
  SIGNS,
  dateFromJulianDay,
  julianDay,
  normalizeDegree,
  planetName,
  signIndex,
  type SwissEph,
} from "./astro/chart";
import { formatOffsetLabel, pad } from "./astro/calendar";
import { positionAt, wrap180, type BodySample } from "./astro/events";
import { crossUt } from "./astro/returns";
// 時刻の整形と黄経の均しは月まわりの暦と同じものを借りる（同じ層・同じ書式なので二重に持たない）
import { formatMoonMoment, unwrapLongitudes } from "./moon-calendar";
import { noReadingNote } from "./phrases";

// ---------------------------------------------------------------------------
// 台帳と定数
// ---------------------------------------------------------------------------

/**
 * 条件に使える 10 天体（ノードは持たない＝星座で語る対象にしない）。
 *
 * - `sampleStep` … 疎サンプルの刻み（日）。**0 は「一発計算」**（太陽と月）の印。
 *   値は events.ts が本物の wasm と突き合わせて決めたものと同じ（水星〜火星 1 日・木星〜冥王星 4 日）。
 * - `order` … 条件を交差させる順。小さいほど先＝**安く絞れる側**から見る。
 *   太陽は一発計算でほぼ只のうえ必ず 1/12 に絞れるので先頭、月は窓が短くて数が多いので最後。
 *   外惑星は「その年代にその星座に居るか居ないか」がはっきりしていて、外れていれば一撃で空になる。
 *
 * 並びそのものは呼ぶ側に見せる順（太陽 → 月 → 水星 …）。処理の順は `order` で別に持つ。
 */
const REVERSE_BODIES = [
  { key: "sun", id: 0, sampleStep: 0, order: 0 },
  { key: "moon", id: 1, sampleStep: 0, order: 9 },
  { key: "mercury", id: 2, sampleStep: 1, order: 8 },
  { key: "venus", id: 3, sampleStep: 1, order: 7 },
  { key: "mars", id: 4, sampleStep: 1, order: 6 },
  { key: "jupiter", id: 5, sampleStep: 4, order: 5 },
  { key: "saturn", id: 6, sampleStep: 4, order: 4 },
  { key: "uranus", id: 7, sampleStep: 4, order: 3 },
  { key: "neptune", id: 8, sampleStep: 4, order: 2 },
  { key: "pluto", id: 9, sampleStep: 4, order: 1 },
] as const;

export type ReverseBodyKey = (typeof REVERSE_BODIES)[number]["key"];

/** 引数 `body` に書ける名前（この並びがそのまま inputSchema の enum に出る） */
export const REVERSE_BODY_KEYS: readonly string[] = REVERSE_BODIES.map((body) => body.key);

/** 星座の英語名（`sign` は日本語と英語の両方を受ける。0 = aries） */
export const SIGN_KEYS: readonly string[] = [
  "aries",
  "taurus",
  "gemini",
  "cancer",
  "leo",
  "virgo",
  "libra",
  "scorpio",
  "sagittarius",
  "capricorn",
  "aquarius",
  "pisces",
];

/** `sign` に書ける名前ぜんぶ（日本語 12 ＋ 英語 12）。inputSchema の enum にそのまま出る */
export const REVERSE_SIGN_NAMES: readonly string[] = [...SIGNS, ...SIGN_KEYS];

/** 条件の重み。required だけで候補日が決まり、optional は「成り立っているか」を添えるだけ */
export const REVERSE_PRIORITIES = ["required", "optional"] as const;
export type ReversePriority = (typeof REVERSE_PRIORITIES)[number];

/** 年の下限・上限（Moshier モードが安心して使える範囲の内側に取ってある） */
export const REVERSE_MIN_YEAR = 1800;
export const REVERSE_MAX_YEAR = 2200;

/** 一度に見られる年数（両端を含む暦年の本数） */
export const REVERSE_MAX_SPAN_YEARS = 30;

/**
 * required が **1 本だけ**のときに一度に見られる年数。
 *
 * 条件が 1 本しかないと「前の条件で残った区間の内側だけを次の天体で見る」という絞りが効かず、
 * 範囲まるごとを疎サンプルで舐めることになる ―― 実測でいちばん重いのがこの形
 * （水星だけ・30 年で天体計算 4,445 回・手元の Node で 251ms＝Workers 実機なら 0.5〜1.3 秒）。
 * 10 年で切ると 1,859 回・101ms（Workers 実機で 0.2〜0.5 秒）まで下がる。
 * 認証の無い入口に置く以上、いちばん重い形は短く切っておく。2026-08-27 査読対応。
 */
export const REVERSE_MAX_SPAN_YEARS_SINGLE = 10;

/** 条件の本数の上限（10 天体しかないので、これ以上は必ず重複） */
const MAX_CONDITIONS = REVERSE_BODIES.length;

/** 返す候補日の上限。超えたぶんは切り、総数と truncated を添える */
export const MAX_CANDIDATES = 60;

/** utc_offset の既定（moon_calendar・cast_hexagram と同じ流儀＝日本時間） */
export const REVERSE_DEFAULT_UTC_OFFSET = 9;

/**
 * 疎サンプルの上を歩く細かい刻み ―― 刻みの 1/24（1 日刻みなら 1 時間・4 日刻みなら 4 時間）。
 * ここでは wasm を呼ばない（補間だけ）ので、細かくしても天体計算の回数は増えない。
 */
const FINE_TICKS_PER_STEP = 24;

/**
 * 1 日刻みの天体（水星・金星・火星）の当たりを付ける粗い刻み（日）と、そのときの余白（度）。
 * 余白ぶん広く拾うので、粗い走査の帯は本当の窓を必ず含む。
 */
const COARSE_STEP_DAYS = 4;
const COARSE_MARGIN_DEG = 3;

/** 星座の出入りの境目を詰める二分法の回数。1 時間の区間を 18 回割れば 0.02 秒以下 */
const MEMBERSHIP_BISECTIONS = 18;

/** 太陽の窓を探し始める位置（日）。1 年より前から始めれば「範囲の頭で進行中の窓」も捕まる */
const SUN_LOOK_BACK_DAYS = 370;

/** 月の窓を探し始める位置（日）。月が 1 つの星座に居るのは最長 2.6 日なので 28 日で足りる */
const MOON_LOOK_BACK_DAYS = 28;

/**
 * 入口を見つけたあと、出口を探し始めるまでに進める日数（＝その星座に必ず居る長さの下限）。
 * 太陽が 1 つの星座に居るのは最短 29.4 日・月は最短 1.95 日なので、これだけ進めても出口は跨がない。
 * 出たあと同じ星座へ戻るまでも太陽は約 334 日・月は約 24.7 日空くので、次の入口も飛ばさない。
 * moon-calendar.ts の `moonIngresses` が「1 日進めてから探す」のと同じ用心
 * ―― **同じ瞬間を二度拾わない**ため（境目ちょうどから探すと、丸めの埃で自分自身が返りうる）。
 */
const SUN_MIN_STAY_DAYS = 28;
const MOON_MIN_STAY_DAYS = 1.9;

/** 窓を数える輪の止め木（壊れたエンジンで無限に回らないように）。太陽は年に 1 回・月は 27.3 日に 1 回 */
const SUN_WINDOW_PERIOD = 300;
const MOON_WINDOW_PERIOD = 27;

/** 暦日に切るときの「区間の終わりちょうど」を前の日に落とすための埃（約 0.1 ミリ秒） */
const DAY_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// 返り値の形
// ---------------------------------------------------------------------------

/** 読み取り済みの 1 条件（星座は番号で持つ） */
export interface ReverseCondition {
  body: ReverseBodyKey;
  signIndex: number;
  priority: ReversePriority;
}

/** 引数を読み取った結果 */
export interface ReverseHoroscopeRequest {
  conditions: ReverseCondition[];
  yearFrom: number;
  yearTo: number;
  utcOffset: number;
}

/** 時刻の区間（ユリウス日。start ≤ end） */
export interface Interval {
  start: number;
  end: number;
}

/** 候補日に添える、その日の正午（現地）の天体の星座 */
export interface ReversePosition {
  body: string;
  name: string;
  sign: string;
  retrograde: boolean;
}

export interface ReverseTimeRange {
  start: string;
  end: string;
}

export interface ReverseCandidate {
  /** 現地の暦日（"2000-04-06"） */
  date: string;
  /** その日はまる 1 日ぶん条件が成り立っているか */
  all_day: boolean;
  /** 条件が成り立っている時刻の範囲（現地時刻・分単位）。all_day のときは 1 日ぶんが 1 本 */
  time_ranges: ReverseTimeRange[];
  /** 成り立った条件の数（required の本数 ＋ 成り立った optional の本数） */
  match_count: number;
  /** その日のうちに成り立っている optional の body（key） */
  matched_optional: string[];
  /** 成り立たなかった optional の body（key） */
  unmatched_optional: string[];
  /** その日の**現地正午**の 10 天体の星座（条件に無い天体も。度数は返さない） */
  positions: ReversePosition[];
}

/** 分かっている取りこぼし（英語の短い名前＋日本語の説明文。conventions.limitations に入る） */
export interface ReverseLimitation {
  name: string;
  note: string;
}

/**
 * この探し方に残っている穴。**黙っていないで返り値に載せる**ためのもの（2026-08-27 査読対応）。
 *
 * 数字（1 時間・4 時間）はサンプルの刻み ÷ `FINE_TICKS_PER_STEP` そのもの
 * ―― 水星〜火星は 1 日 ÷ 24、木星〜冥王星は 4 日 ÷ 24。刻みを変えたらここも直すこと。
 */
export const REVERSE_LIMITATIONS: readonly ReverseLimitation[] = [
  {
    name: "short_sign_reentry_near_station",
    note:
      "留が星座の境のすぐ内側で起きる短い出入りは拾えないことがあります" +
      "（水星〜火星で 1 時間未満・木星〜冥王星で 4 時間未満）。" +
      "太陽と月は通過の一発計算なので、この穴はありません",
  },
  {
    name: "no_candidates_is_not_proof",
    note: "候補なし＝必ず該当なし、ではありません（上の取りこぼしのぶん）",
  },
];

/** テキストの「規約:」行の次に出す 1 行（正文は REVERSE_LIMITATIONS と同じ中身） */
const APPROXIMATION_NOTE =
  "⚠ 近似探索です——留が星座の境のすぐ内側で起きる短い出入り" +
  "（水星〜火星で 1 時間未満・木星〜冥王星で 4 時間未満）は拾えないことがあります。" +
  "候補なし＝必ず該当なし、ではありません";

export interface ReverseConventions {
  zodiac: "tropical";
  ephemeris: "moshier";
  sign_boundaries: "every_30_degrees";
  candidate_day: "any_instant_in_the_local_calendar_day_meets_all_required";
  sun_windows: "swe_solcross_ut";
  moon_windows: "swe_mooncross_ut";
  other_bodies: "sparse_samples_with_cubic_hermite";
  positions_at: "local_noon";
  utc_offset: number;
  /** 分かっている取りこぼし（`REVERSE_LIMITATIONS`） */
  limitations: ReverseLimitation[];
}

export interface ReverseHoroscopeResult {
  range: {
    year_from: number;
    year_to: number;
    years: number;
    utc_offset: number;
  };
  conditions: {
    body: string;
    name: string;
    sign: string;
    priority: ReversePriority;
  }[];
  /** 見つかった候補日の総数（切る前） */
  total: number;
  /** 上限で切ったか */
  truncated: boolean;
  candidates: ReverseCandidate[];
  conventions: ReverseConventions;
}

// ---------------------------------------------------------------------------
// 引数の検算
// ---------------------------------------------------------------------------

function bodyOf(key: string): (typeof REVERSE_BODIES)[number] | undefined {
  return REVERSE_BODIES.find((body) => body.key === key);
}

/** 断り文に相手の文字列を写すときの長さの上限（文字数） */
const MAX_ECHO_CHARS = 80;

/**
 * 断り文に載せる「渡された名前」を切りそろえる。
 *
 * 綴り違いを黙って無視しないために相手の文字列を写して返しているが、認証の無い入口なので
 * **写す量には蓋をしておく**（長い文字列をそのまま反射させない。2026-08-27 査読対応）。
 * 切るのは**コードポイント単位**＝絵文字や漢字が真っ二つにならないように。
 */
function echoed(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= MAX_ECHO_CHARS) return value;
  return `${characters.slice(0, MAX_ECHO_CHARS).join("")}…`;
}

/** body の名前を読む。英語の小文字（sun / moon …）と日本語の天体名（太陽・月 …）の両方を受ける */
export function parseReverseBody(raw: unknown): ReverseBodyKey {
  if (typeof raw !== "string") {
    throw new AstroError(
      `conditions[].body は天体の名前で指定してください（${REVERSE_BODY_KEYS.join(" / ")}）`,
    );
  }
  const trimmed = raw.trim();
  const byKey = bodyOf(trimmed.toLowerCase());
  if (byKey) return byKey.key;

  // 返り値に出るのは日本語の天体名なので、それをそのまま渡されても受ける
  const byName = REVERSE_BODIES.find((body) => planetName(body.id) === trimmed);
  if (byName) return byName.key;

  throw new AstroError(
    `知らない天体です: ${echoed(trimmed)}（使えるのは ${REVERSE_BODY_KEYS.join(" / ")}` +
      "。ノードやアングルは条件に使えません）",
  );
}

/** sign の名前を読む。日本語（牡羊座 …）と英語の小文字（aries …）の両方を受ける */
export function parseReverseSign(raw: unknown): number {
  if (typeof raw !== "string") {
    throw new AstroError(
      `conditions[].sign は星座の名前で指定してください（${SIGNS.join(" / ")}` +
        ` または ${SIGN_KEYS.join(" / ")}）`,
    );
  }
  const trimmed = raw.trim();
  const japanese = SIGNS.indexOf(trimmed);
  if (japanese >= 0) return japanese;
  const english = SIGN_KEYS.indexOf(trimmed.toLowerCase());
  if (english >= 0) return english;

  throw new AstroError(
    `知らない星座です: ${echoed(trimmed)}（使えるのは ${SIGNS.join(" / ")}` +
      ` または ${SIGN_KEYS.join(" / ")}）`,
  );
}

function parseYear(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (value === undefined || value === null) {
    throw new AstroError(`${key} は必須です（西暦の整数。year_from と year_to の両方を指定してください）`);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AstroError(`${key} は西暦の整数で指定してください: ${echoed(JSON.stringify(value))}`);
  }
  if (value < REVERSE_MIN_YEAR || value > REVERSE_MAX_YEAR) {
    throw new AstroError(
      `${key} は ${REVERSE_MIN_YEAR} 以上 ${REVERSE_MAX_YEAR} 以下で指定してください: ${value}`,
    );
  }
  return value;
}

/** 1 条件を読む（未知のキーもここで断る＝綴り違いを黙って無視しない） */
function parseCondition(raw: unknown, index: number): ReverseCondition {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AstroError(
      `conditions[${index}] は { body, sign, priority? } のオブジェクトで指定してください`,
    );
  }
  const entry = raw as Record<string, unknown>;
  const strays = Object.keys(entry).filter((key) => !["body", "sign", "priority"].includes(key));
  if (strays.length > 0) {
    throw new AstroError(
      `conditions[${index}] に未知のキーがあります: ${echoed(strays.join(", "))}（使えるのは body / sign / priority）`,
    );
  }

  const rawPriority = entry["priority"];
  let priority: ReversePriority = "required";
  if (rawPriority !== undefined && rawPriority !== null) {
    if (
      typeof rawPriority !== "string" ||
      !REVERSE_PRIORITIES.includes(rawPriority as ReversePriority)
    ) {
      throw new AstroError(
        `conditions[${index}].priority は ${REVERSE_PRIORITIES.join(" / ")} のどちらかで指定してください: ` +
          echoed(String(rawPriority)),
      );
    }
    priority = rawPriority as ReversePriority;
  }

  return { body: parseReverseBody(entry["body"]), signIndex: parseReverseSign(entry["sign"]), priority };
}

/**
 * reverse_horoscope の引数を読み取る。
 * 天体計算より先に全部弾く ―― 断るだけなら wasm に触らずに済む。
 */
export function parseReverseHoroscopeArguments(raw: unknown): ReverseHoroscopeRequest {
  const args = (raw ?? {}) as Record<string, unknown>;

  const rawConditions = args["conditions"];
  if (!Array.isArray(rawConditions)) {
    throw new AstroError(
      "conditions は条件の配列で指定してください" +
        '（例: [{ "body": "sun", "sign": "牡羊座" }, { "body": "moon", "sign": "cancer" }]）',
    );
  }
  if (rawConditions.length === 0) {
    throw new AstroError("conditions が空です（少なくとも 1 本は指定してください）");
  }
  if (rawConditions.length > MAX_CONDITIONS) {
    throw new AstroError(
      `conditions は ${MAX_CONDITIONS} 本までです（天体は 10 個しかありません）: ${rawConditions.length} 本`,
    );
  }

  const conditions: ReverseCondition[] = [];
  for (const [index, entry] of rawConditions.entries()) {
    const condition = parseCondition(entry, index);
    const duplicated = conditions.find((other) => other.body === condition.body);
    if (duplicated) {
      throw new AstroError(
        `同じ天体を 2 回指定しています: ${planetName(bodyOf(condition.body)?.id ?? -1)}` +
          "（1 つの天体が同時に 2 つの星座に居ることはありません）",
      );
    }
    conditions.push(condition);
  }

  const requiredCount = conditions.filter((condition) => condition.priority === "required").length;
  if (requiredCount === 0) {
    throw new AstroError(
      "required の条件が 1 本もありません（optional は候補日を決めないので、" +
        "少なくとも 1 本は required にしてください）",
    );
  }

  const yearFrom = parseYear(args, "year_from");
  const yearTo = parseYear(args, "year_to");
  if (yearTo < yearFrom) {
    throw new AstroError(`year_to は year_from 以上で指定してください: ${yearFrom} 〜 ${yearTo}`);
  }
  const years = yearTo - yearFrom + 1;
  if (years > REVERSE_MAX_SPAN_YEARS) {
    throw new AstroError(
      `一度に見られるのは ${REVERSE_MAX_SPAN_YEARS} 年ぶんまでです（指定: ${years} 年）。` +
        "範囲を分けて呼んでください。",
    );
  }
  // required が 1 本だけの形は絞りが効かず、いちばん重い（REVERSE_MAX_SPAN_YEARS_SINGLE の項）。
  // 断り文は固定文＋数字だけ（渡された文字列は 1 つも写さない）
  if (requiredCount === 1 && years > REVERSE_MAX_SPAN_YEARS_SINGLE) {
    throw new AstroError(
      `required の条件が 1 本だけのときは ${REVERSE_MAX_SPAN_YEARS_SINGLE} 年ぶんまでです` +
        `（指定: ${years} 年）。required をもう 1 本足すと ${REVERSE_MAX_SPAN_YEARS} 年ぶんまで見られます` +
        "（条件が増えるほど探索は軽くなります）。範囲を分けて呼んでも構いません。",
    );
  }

  const rawOffset = args["utc_offset"];
  let utcOffset = REVERSE_DEFAULT_UTC_OFFSET;
  if (rawOffset !== undefined && rawOffset !== null) {
    if (typeof rawOffset !== "number" || !Number.isFinite(rawOffset)) {
      throw new AstroError("utc_offset は数値で指定してください（例: 9 / 5.5 / -3）");
    }
    if (rawOffset < -14 || rawOffset > 14) {
      throw new AstroError(`utc_offset は -14 以上 14 以下で指定してください: ${rawOffset}`);
    }
    utcOffset = rawOffset;
  }

  return { conditions, yearFrom, yearTo, utcOffset };
}

// ---------------------------------------------------------------------------
// 窓（その天体がその星座に居る区間）
// ---------------------------------------------------------------------------

interface WindowResult {
  windows: Interval[];
  /** 使った天体計算の回数（CPU の目安を測る覚え書き） */
  calls: number;
}

/**
 * 太陽・月の窓を**一発計算**で。星座の入口（30°×index）と出口（次の星座の入口）を
 * `crossUt` で交互に取り、渡された区間の内側に切って返す。
 *
 * 太陽も月も黄経は必ず増える向きにしか進まない（逆行しない）ので、
 * 「入口の次に出口が来る」と決め打ちできる。
 */
function crossWindows(
  swe: SwissEph,
  kind: "sun" | "moon",
  signIdx: number,
  intervals: readonly Interval[],
): WindowResult {
  const lower = signIdx * 30;
  const upper = normalizeDegree((signIdx + 1) * 30);
  const lookBack = kind === "sun" ? SUN_LOOK_BACK_DAYS : MOON_LOOK_BACK_DAYS;
  const period = kind === "sun" ? SUN_WINDOW_PERIOD : MOON_WINDOW_PERIOD;
  const minStay = kind === "sun" ? SUN_MIN_STAY_DAYS : MOON_MIN_STAY_DAYS;

  const windows: Interval[] = [];
  let calls = 0;

  for (const interval of intervals) {
    const guard = Math.ceil((interval.end - interval.start + lookBack) / period) + 3;
    let cursor = interval.start - lookBack;
    for (let step = 0; step < guard; step++) {
      const enter = crossUt(swe, kind, lower, cursor);
      calls++;
      if (enter >= interval.end) break;
      // 出口は「必ずその星座に居る長さ」だけ進めてから探す（入口ちょうどから探さない）
      const exit = crossUt(swe, kind, upper, enter + minStay);
      calls++;
      if (exit > interval.start) {
        windows.push({
          start: Math.max(enter, interval.start),
          end: Math.min(exit, interval.end),
        });
      }
      cursor = exit + minStay;
    }
  }

  return { windows, calls };
}

/** 二分法で「星座に入る／出る」瞬間を詰める（補間の上を歩くので wasm は呼ばない） */
function bisectMembership(
  inside: (jd: number) => boolean,
  lowJd: number,
  highJd: number,
  insideAtLow: boolean,
): number {
  let low = lowJd;
  let high = highJd;
  for (let step = 0; step < MEMBERSHIP_BISECTIONS; step++) {
    const middle = (low + high) / 2;
    if (inside(middle) === insideAtLow) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/**
 * 太陽・月以外の窓を**疎サンプル＋補間**で。
 *
 * 区間ごとに刻みぶんの位置と速度を取り（ここだけが wasm）、あいだは 3 次エルミート補間。
 * 補間の上を刻みの 1/24 で歩いて星座の出入りを拾い、境目は二分法で詰める。
 *
 * `margin` は星座の前後に足す余白（度）。0 なら星座そのもの、正の値なら「その星座の近く」＝
 * **必ず本当の窓を含む広めの窓**になる（当たりを付けるための粗い走査で使う）。
 */
function scanWindows(
  swe: SwissEph,
  bodyId: number,
  signIdx: number,
  step: number,
  intervals: readonly Interval[],
  margin: number,
): WindowResult {
  const windows: Interval[] = [];
  const tick = step / FINE_TICKS_PER_STEP;
  // 星座の真ん中からの隔たりで見る（0°/360° の継ぎ目をまたぐ星座も同じ式で扱える）
  const center = signIdx * 30 + 15;
  const half = 15 + margin;
  let calls = 0;

  for (const interval of intervals) {
    const span = interval.end - interval.start;
    // 最後の点が区間の尻より先に出るように +1（補間には区間の右端が要る）
    const points = Math.max(1, Math.ceil(span / step)) + 1;
    const sample: BodySample = { lon: [], speed: [] };
    for (let index = 0; index < points; index++) {
      const result = swe.swe_calc_ut(interval.start + index * step, bodyId, CALC_FLAGS);
      sample.lon.push(result[0] as number);
      sample.speed.push(result[3] as number);
      calls++;
    }
    unwrapLongitudes(sample.lon);

    const inside = (jd: number): boolean => {
      const delta = wrap180(positionAt(sample, step, jd - interval.start).lon - center);
      // 上の境は含めない（margin 0 なら signIndex とちょうど同じ切り方になる）
      return delta >= -half && delta < half;
    };

    const ticks = Math.max(1, Math.ceil(span / tick));
    let previousJd = interval.start;
    let previousIn = inside(interval.start);
    let openedAt = interval.start;

    for (let index = 1; index <= ticks; index++) {
      const jd = index === ticks ? interval.end : interval.start + index * tick;
      const currentIn = inside(jd);
      if (currentIn !== previousIn) {
        const boundary = bisectMembership(inside, previousJd, jd, previousIn);
        if (currentIn) openedAt = boundary;
        else windows.push({ start: openedAt, end: boundary });
      }
      previousJd = jd;
      previousIn = currentIn;
    }
    if (previousIn) windows.push({ start: openedAt, end: interval.end });
  }

  return { windows, calls };
}

/**
 * 太陽・月以外の窓。1 日刻みの天体（水星・金星・火星）は**二段構え**にする。
 *
 * 30 年ぶんを 1 日刻みで舐めると天体計算が 1 万回を超える（手元の Node で 0.6 秒）ので、
 * まず 4 日刻み＋前後 3° の余白で「その星座の近くに居る帯」を拾い、**その帯の内側だけ**を
 * 1 日刻みで詰め直す。余白のぶん帯は本当の窓より必ず広いので、取りこぼしは増えない
 * （3° は水星でも 1.4 日ぶんの動きがあり、補間の誤差 ―― events.ts の実測で 1.6e-4° ―― の
 * 桁とは比べものにならない）。
 */
function sampledWindows(
  swe: SwissEph,
  bodyId: number,
  signIdx: number,
  step: number,
  intervals: readonly Interval[],
): WindowResult {
  if (step >= COARSE_STEP_DAYS) {
    return scanWindows(swe, bodyId, signIdx, step, intervals, 0);
  }
  const coarse = scanWindows(swe, bodyId, signIdx, COARSE_STEP_DAYS, intervals, COARSE_MARGIN_DEG);
  const fine = scanWindows(swe, bodyId, signIdx, step, coarse.windows, 0);
  return { windows: fine.windows, calls: coarse.calls + fine.calls };
}

/** 1 条件ぶんの窓（渡された区間の内側に切って返す） */
function windowsOf(
  swe: SwissEph,
  condition: ReverseCondition,
  intervals: readonly Interval[],
): WindowResult {
  if (intervals.length === 0) return { windows: [], calls: 0 };
  const body = bodyOf(condition.body);
  if (!body) throw new AstroError(`知らない天体です: ${condition.body}`);

  if (body.sampleStep === 0) {
    return crossWindows(swe, body.key === "sun" ? "sun" : "moon", condition.signIndex, intervals);
  }
  return sampledWindows(swe, body.id, condition.signIndex, body.sampleStep, intervals);
}

// ---------------------------------------------------------------------------
// 走査
// ---------------------------------------------------------------------------

export interface ReverseScan {
  rangeStartJd: number;
  rangeEndJd: number;
  /** required が全部そろっている区間（昇順・重ならない） */
  intervals: Interval[];
  /** optional の body（key）→ その条件も一緒に成り立っている区間 */
  optionalWindows: Map<string, Interval[]>;
  /** 天体計算（swe_calc_ut / swe_*cross_ut）を呼んだ回数 */
  ephemerisCalls: number;
}

/** 範囲の頭（year_from の 1 月 1 日 0 時・現地）と尻（year_to の翌年の 1 月 1 日 0 時） */
export function reverseRangeJd(swe: SwissEph, request: ReverseHoroscopeRequest): Interval {
  const at = (year: number): number =>
    julianDay(swe, { year, month: 1, day: 1, hour: 0, minute: 0, utcOffset: request.utcOffset });
  return { start: at(request.yearFrom), end: at(request.yearTo + 1) };
}

/**
 * 条件を「安く絞れる順」に交差させていく。ここは jd のまま返し、暦日に落とすのは組み立て側。
 */
export function scanReverseHoroscope(
  swe: SwissEph,
  request: ReverseHoroscopeRequest,
): ReverseScan {
  const range = reverseRangeJd(swe, request);
  const ordered = [...request.conditions].sort(
    (left, right) => (bodyOf(left.body)?.order ?? 0) - (bodyOf(right.body)?.order ?? 0),
  );

  let intervals: Interval[] = [{ start: range.start, end: range.end }];
  let ephemerisCalls = 0;

  for (const condition of ordered) {
    if (condition.priority !== "required") continue;
    if (intervals.length === 0) break;
    const found = windowsOf(swe, condition, intervals);
    ephemerisCalls += found.calls;
    // windowsOf は渡した区間の内側に切って返すので、そのまま次の条件の入力になる
    intervals = found.windows;
  }

  const optionalWindows = new Map<string, Interval[]>();
  for (const condition of ordered) {
    if (condition.priority !== "optional") continue;
    const found = windowsOf(swe, condition, intervals);
    ephemerisCalls += found.calls;
    optionalWindows.set(condition.body, found.windows);
  }

  return {
    rangeStartJd: range.start,
    rangeEndJd: range.end,
    intervals,
    optionalWindows,
    ephemerisCalls,
  };
}

// ---------------------------------------------------------------------------
// 暦日に切る
// ---------------------------------------------------------------------------

/** その瞬間が「現地の何日目（ユリウス日番号）」か */
export function localDayNumber(jd: number, utcOffset: number): number {
  return Math.floor(jd + utcOffset / 24 + 0.5);
}

/** 現地の日番号 → その日の 0 時（UT のユリウス日） */
export function localDayStartJd(dayNumber: number, utcOffset: number): number {
  return dayNumber - 0.5 - utcOffset / 24;
}

/** 現地の日番号 → "2000-04-06"（日番号はユリウス日番号そのものなので、時差を混ぜずに暦へ戻せる） */
export function localDateText(dayNumber: number): string {
  const date = dateFromJulianDay(dayNumber - 0.5);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 区間の列を現地の暦日ごとに切り分ける（日番号 → その日の中の区間） */
export function splitByLocalDay(
  intervals: readonly Interval[],
  utcOffset: number,
): Map<number, Interval[]> {
  const byDay = new Map<number, Interval[]>();
  for (const interval of intervals) {
    const first = localDayNumber(interval.start, utcOffset);
    // 区間の終わりがちょうど 0 時のときに翌日を数えないよう、埃ぶんだけ手前で見る
    const last = localDayNumber(Math.max(interval.start, interval.end - DAY_EPSILON), utcOffset);
    for (let day = first; day <= last; day++) {
      const start = Math.max(interval.start, localDayStartJd(day, utcOffset));
      const end = Math.min(interval.end, localDayStartJd(day + 1, utcOffset));
      if (end <= start) continue;
      const list = byDay.get(day);
      if (list) list.push({ start, end });
      else byDay.set(day, [{ start, end }]);
    }
  }
  return byDay;
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/** その日の正午（現地）の 10 天体の星座。度数は返さない（星座名と逆行の印だけ） */
function positionsAtNoon(swe: SwissEph, dayNumber: number, utcOffset: number): ReversePosition[] {
  const noonJd = localDayStartJd(dayNumber, utcOffset) + 0.5;
  return REVERSE_BODIES.map((body) => {
    const result = swe.swe_calc_ut(noonJd, body.id, CALC_FLAGS);
    return {
      body: body.key,
      name: planetName(body.id),
      sign: SIGNS[signIndex(result[0] as number)] as string,
      retrograde: (result[3] as number) < 0,
    };
  });
}

/**
 * 走査の結果を返り値の形に組み立てる。
 *
 * 並びは**成り立った条件の数の多い順 → 日付順**（astro-viewer と同じ考え）。
 * 正午の天体を引くのは**切ったあとの候補だけ**なので、何千日見つかっても天体計算は 60 日ぶんで済む。
 */
export function buildReverseHoroscope(
  swe: SwissEph,
  scan: ReverseScan,
  request: ReverseHoroscopeRequest,
): ReverseHoroscopeResult {
  const { utcOffset } = request;
  const when = (jd: number): string => formatMoonMoment(jd, utcOffset);

  const requiredCount = request.conditions.filter(
    (condition) => condition.priority === "required",
  ).length;
  const optionalKeys = request.conditions
    .filter((condition) => condition.priority === "optional")
    .map((condition) => condition.body);

  // optional は「その暦日のどこかで一緒に成り立っているか」を日の集合で見る
  const optionalDays = new Map<string, Set<number>>();
  for (const [key, windows] of scan.optionalWindows) {
    optionalDays.set(key, new Set(splitByLocalDay(windows, utcOffset).keys()));
  }

  const byDay = splitByLocalDay(scan.intervals, utcOffset);
  const days = [...byDay.keys()].sort((left, right) => left - right);

  interface Draft {
    day: number;
    ranges: Interval[];
    matched: string[];
    unmatched: string[];
  }
  const drafts: Draft[] = days.map((day) => {
    const matched = optionalKeys.filter((key) => optionalDays.get(key)?.has(day) === true);
    return {
      day,
      ranges: (byDay.get(day) as Interval[]).sort((left, right) => left.start - right.start),
      matched,
      unmatched: optionalKeys.filter((key) => !matched.includes(key)),
    };
  });

  drafts.sort(
    (left, right) => right.matched.length - left.matched.length || left.day - right.day,
  );

  const total = drafts.length;
  const truncated = total > MAX_CANDIDATES;
  const kept = truncated ? drafts.slice(0, MAX_CANDIDATES) : drafts;

  const candidates: ReverseCandidate[] = kept.map((draft) => {
    const dayStart = localDayStartJd(draft.day, utcOffset);
    const dayEnd = localDayStartJd(draft.day + 1, utcOffset);
    // 分に丸めて返すので、30 秒ぶん足りないだけの区間は「終日」と言ってよい
    const allDay =
      draft.ranges.length === 1 &&
      (draft.ranges[0] as Interval).start <= dayStart + 30 / 86_400 &&
      (draft.ranges[0] as Interval).end >= dayEnd - 30 / 86_400;

    return {
      date: localDateText(draft.day),
      all_day: allDay,
      time_ranges: draft.ranges.map((range) => ({ start: when(range.start), end: when(range.end) })),
      match_count: requiredCount + draft.matched.length,
      matched_optional: draft.matched,
      unmatched_optional: draft.unmatched,
      positions: positionsAtNoon(swe, draft.day, utcOffset),
    };
  });

  return {
    range: {
      year_from: request.yearFrom,
      year_to: request.yearTo,
      years: request.yearTo - request.yearFrom + 1,
      utc_offset: utcOffset,
    },
    conditions: request.conditions.map((condition) => ({
      body: condition.body,
      name: planetName(bodyOf(condition.body)?.id ?? -1),
      sign: SIGNS[condition.signIndex] as string,
      priority: condition.priority,
    })),
    total,
    truncated,
    candidates,
    conventions: {
      zodiac: "tropical",
      ephemeris: "moshier",
      sign_boundaries: "every_30_degrees",
      candidate_day: "any_instant_in_the_local_calendar_day_meets_all_required",
      sun_windows: "swe_solcross_ut",
      moon_windows: "swe_mooncross_ut",
      other_bodies: "sparse_samples_with_cubic_hermite",
      positions_at: "local_noon",
      utc_offset: utcOffset,
      // 分かっている取りこぼしも規約と一緒に返す（読む側が「候補なし」を早合点しないように）
      limitations: REVERSE_LIMITATIONS.map((limitation) => ({ ...limitation })),
    },
  };
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

const PRIORITY_LABEL: Record<ReversePriority, string> = {
  required: "必須",
  optional: "できれば",
};

/** "2000-04-06 09:12+09:00" → "09:12"（日付と時差は行の頭と見出しに出ているので落とす） */
function clockOf(moment: string): string {
  return (moment.split(" ")[1] ?? "").slice(0, 5);
}

/** 1 日の中の時刻の範囲。日の尻ちょうどで終わるものは 24:00 と書く（翌日の 00:00 と読ませない） */
function rangeText(range: ReverseTimeRange, date: string): string {
  const start = clockOf(range.start);
  const end = range.end.startsWith(date) ? clockOf(range.end) : "24:00";
  return `${start}〜${end}`;
}

/** 「太陽 牡羊座 / 月 蟹座 / 水星 牡羊座R / …」（R＝逆行） */
function positionsText(positions: readonly ReversePosition[]): string {
  return positions
    .map((position) => `${position.name} ${position.sign}${position.retrograde ? "R" : ""}`)
    .join(" / ");
}

export function formatReverseHoroscopeText(result: ReverseHoroscopeResult): string {
  const conditions = result.conditions
    .map((condition) => `${condition.name} ${condition.sign}（${PRIORITY_LABEL[condition.priority]}）`)
    .join(" / ");
  const totalConditions = result.conditions.length;

  const header = [
    "逆引きホロスコープ（その配置になる日の候補）",
    `条件: ${conditions}`,
    `範囲: ${result.range.year_from}〜${result.range.year_to} 年（${result.range.years} 年ぶん・` +
      `暦日は ${formatOffsetLabel(result.range.utc_offset)}）`,
    result.truncated
      ? `候補: ${result.total} 日（一致の多い順→日付順に ${result.candidates.length} 日だけ載せています）`
      : `候補: ${result.total} 日`,
  ];

  const body: string[] = [];
  if (result.candidates.length === 0) {
    body.push("（この年代に、条件がそろう日はありませんでした）");
  }
  for (const candidate of result.candidates) {
    const time = candidate.all_day
      ? "終日"
      : candidate.time_ranges.map((range) => rangeText(range, candidate.date)).join(", ");
    const optional =
      candidate.matched_optional.length > 0
        ? `／できれば: ${candidate.matched_optional.join(", ")}`
        : "";
    body.push(
      `${candidate.date}  ${time}  一致 ${candidate.match_count}/${totalConditions}${optional}`,
    );
    body.push(`  正午の空: ${positionsText(candidate.positions)}`);
  }

  const footer = [
    "規約: トロピカル・Moshier／星座の境は黄経 30° 刻み／" +
      "候補日＝その暦日のどこかの瞬間で必須条件が全部そろう日／" +
      "太陽と月の窓は swe_solcross_ut・swe_mooncross_ut の一発計算、" +
      "ほかの天体は疎サンプル＋3 次エルミート補間／" +
      "「正午の空」はその日の現地正午の星座（R＝逆行）で、条件が成り立つ時刻とは別ものです",
    // 規約の次に、分かっている取りこぼしを 1 行（conventions.limitations と同じ中身）
    APPROXIMATION_NOTE,
  ];
  if (result.truncated) {
    footer.push(
      `※ 候補が ${result.total} 日あります。条件を足す（月や水星のように足の速い天体ほどよく絞れます）か、` +
        "年代の範囲を狭めると絞れます。",
    );
  }
  if (result.candidates.length === 0) {
    footer.push(
      "※ 条件を緩める（priority を optional にする）か、年代の範囲を変えてみてください。" +
        "外惑星（天王星・海王星・冥王星）を指定しているときは、" +
        "その天体がその星座に居る年代でないと 1 日も見つかりません。",
    );
  }
  footer.push(noReadingNote("その配置の意味・日の吉凶"));

  return [...header, "", ...body, "", ...footer].join("\n");
}

/** 引数の読み取り済みリクエスト → 返り値とテキスト（配線側はこれだけ呼べばよい） */
export function reverseHoroscope(
  swe: SwissEph,
  request: ReverseHoroscopeRequest,
): { result: ReverseHoroscopeResult; text: string; scan: ReverseScan } {
  const scan = scanReverseHoroscope(swe, request);
  const result = buildReverseHoroscope(swe, scan, request);
  return { result, text: formatReverseHoroscopeText(result), scan };
}
