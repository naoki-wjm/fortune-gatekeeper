/**
 * 占星術層の MCP ハンドラ（`POST /mcp/<キー>`）。
 *
 * カード層（src/mcp.ts）と同じ流儀 ―― ステートレスな Streamable HTTP、JSON-RPC 2.0 単発、
 * ツールの失敗は isError。違うのは 2 点だけ:
 *   - URL の鍵で人を見分ける（誰の chart_id か、を分けるためだけの仕切り）
 *   - KV に「計算済みのチャート」を置く（**出生日時・出生地は保存しない**）
 *
 * ここも解釈層を持たない。返すのは座標と角度で、読むのは会話中の Claude。
 * wasm には触らない（エンジンは `getEngine` として外から注入される）＝ Node のテストでも回る。
 */
import {
  SERVER_NAME,
  SERVER_VERSION,
  jsonRpcError,
  jsonRpcResult,
  negotiateProtocolVersion,
  readJsonRpcRequest,
  toolError,
  type ToolResult,
} from "../mcp";
import {
  AstroError,
  DEFAULT_ORB,
  HOUSE_SYSTEM_CODES,
  anglesOf,
  computeChart,
  computeChartFromJd,
  computePlanets,
  crossAspects,
  dateFromJulianDay,
  formatAngles,
  formatCrossAspect,
  formatCuspLine,
  formatDegree,
  formatPlanetLines,
  getHouse,
  houseSystemName,
  julianDay,
  planetName,
  type AspectPoint,
  type ComputedChart,
  type MomentInput,
  type PlanetPosition,
  type SwissEph,
} from "./chart";
import {
  computeProgression,
  crossUt,
  crossingsInRange,
  formatAge,
  formatArc,
  type ReturnKind,
} from "./returns";
import {
  deleteChart,
  getChart,
  listCharts,
  lookupKey,
  newChartId,
  putChart,
  type AstroKv,
  type AuthContext,
  type StoredChart,
} from "./store";

export { lookupKey, type AstroKv, type AuthContext };

/** 占星術層の initialize に載せる注意書き（カード層とは別文） */
const ASTRO_INSTRUCTIONS =
  "ホロスコープ（西洋占星術）の天体位置を計算するサーバーです。" +
  "計算するのはサーバー、読むのは会話中のあなた——返すのは天体の黄経・ハウス・アスペクトといった" +
  "座標と角度だけで、解釈は一切しません。読み解きはあなた自身の知識で行ってください。" +
  "自分で「計算したふり」をせず、天体の位置が要る場面では必ずこのツールを呼ぶこと。\n" +
  "チャートは save_chart で一度登録すると chart_id で何度でも呼び出せます。" +
  "保存されるのは計算済みの座標（天体の黄経と速度・ハウスカスプ・ASC/MC・ラベル・ハウス方式）だけで、" +
  "**出生日時と出生地は計算に使ったあと捨てます**。" +
  "そのためハウス方式を変えて引き直したいときは、もう一度 save_chart を呼んでもらう必要があります。\n" +
  "使い分け: save_chart=出生データを登録して chart_id を得る / list_charts=登録済みの一覧 / " +
  "transit=登録したチャートに対する任意時刻（省略時は現在）の天体・在ハウス・アスペクト / " +
  "delete_chart=登録の取り消し / " +
  "lunar_return=ネイタルの月に空の月が戻る瞬間（約27.3日に1回）とその図 / " +
  "solar_return=ネイタルの太陽に空の太陽が戻る瞬間（年に1回・誕生日のころ）とその図 / " +
  "progressions=二次進行（一日一年法）。progressions だけは出生の原本が要るため、" +
  "原本を預けた本人の URL でしか動きません。";

// ---------------------------------------------------------------------------
// ツール定義
// ---------------------------------------------------------------------------

const HOUSE_SYSTEM_DESCRIPTION =
  "ハウス方式（既定 P）。P=プラシーダス / K=コッホ / W=ホールサイン / E=イコール。" +
  "出生時刻がはっきりしない場合はホールサイン（W）が無難。";

export const ASTRO_TOOLS = [
  {
    name: "save_chart",
    title: "出生図を登録する",
    description:
      "出生データからネイタルチャート（出生図）を計算し、chart_id を付けて保存する。" +
      "以後は chart_id だけでトランジットなどを引ける。\n" +
      "**保存されるのは計算結果の座標だけ**——天体の黄経と速度・ハウスカスプ・ASC/MC・ラベル・" +
      "ハウス方式のみで、出生日時と出生地は計算に使ったあと捨てる（サーバーに残らない）。" +
      "そのぶん、ハウス方式を変えて計算し直したいときは、もう一度このツールを呼ぶ必要がある。\n" +
      "日時は**出生地の現地時刻**で渡し、utc_offset にその土地の時差を書く（日本は 9）。" +
      "緯度・経度は北緯・東経が正、南緯・西経が負。\n" +
      "default_lat / default_lng は「いつもの場所」（現在の居住地など）で、" +
      "後々のリターン計算で使う。分からなければ省略してよい。",
    inputSchema: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "チャートの呼び名（一覧に出る）。本人の名前でも「わたし」「Aさん」でもよい。",
        },
        year: { type: "integer", description: "出生年（西暦）" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "出生月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "出生日（1-31）" },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "出生時刻の「時」（0-23、出生地の現地時刻）",
        },
        minute: {
          type: "integer",
          minimum: 0,
          maximum: 59,
          description: "出生時刻の「分」（0-59、出生地の現地時刻）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "出生地の UTC からの時差（時間単位。日本は 9、インドのような 30 分刻みは 5.5 のように小数で）",
        },
        lat: { type: "number", minimum: -90, maximum: 90, description: "出生地の緯度（北緯が正）" },
        lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "出生地の経度（東経が正）",
        },
        house_system: {
          type: "string",
          enum: HOUSE_SYSTEM_CODES,
          default: "P",
          description: HOUSE_SYSTEM_DESCRIPTION,
        },
        default_lat: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "「いつもの場所」の緯度（任意。リターン計算で使う）",
        },
        default_lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "「いつもの場所」の経度（任意）",
        },
        default_location_label: {
          type: "string",
          description: "「いつもの場所」の呼び名（任意。例: 東京）",
        },
      },
      required: ["label", "year", "month", "day", "hour", "minute", "utc_offset", "lat", "lng"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_charts",
    title: "登録済みチャートの一覧",
    description:
      "この URL に登録されているチャートの一覧を返す（chart_id・ラベル・ハウス方式・" +
      "「いつもの場所」・登録日時）。transit を呼ぶ前に chart_id を確かめたいときに使う。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "delete_chart",
    title: "登録済みチャートを消す",
    description:
      "chart_id を指定して登録を取り消す。消したチャートは戻せない" +
      "（出生日時・出生地を保存していないため、サーバー側で再計算できない）。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: { type: "string", description: "消すチャートの ID（list_charts で確認できる）" },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "transit",
    title: "トランジットを見る",
    description:
      "登録済みのチャートに対して、指定時刻の天体（トランジット）を計算する。" +
      "返るのは (1) トランジット天体の星座・度数・逆行、(2) それがネイタルのカスプで見て" +
      "第何ハウスに入っているか、(3) ネイタル天体および ASC / MC とのアスペクト" +
      "（メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション、オーブ 1°）。\n" +
      "日時をすべて省略すると**現在時刻（UTC）**で計算する。" +
      "特定の日を見たいときは year / month / day を指定し、必要なら hour / minute と " +
      "utc_offset（その時刻がどの時差の土地の時計か）を添える。\n" +
      "このツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        year: { type: "integer", description: "見たい日の年（省略すると現在時刻）" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "見たい日の月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "見たい日の日（1-31）" },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "見たい時刻の「時」（0-23、省略すると 0 時）",
        },
        minute: {
          type: "integer",
          minimum: 0,
          maximum: 59,
          description: "見たい時刻の「分」（0-59、省略すると 0 分）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "指定した日時がどの時差の土地の時計か（時間単位。日本時間なら 9。省略すると UTC 扱い）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "lunar_return",
    title: "ルナリターン（月の帰還）",
    description:
      "登録済みチャートの**ネイタルの月**と同じ黄経に、空の月が戻ってくる瞬間（ルナリターン）を求め、" +
      "その瞬間のホロスコープ一式を返す。約27.3日に1回めぐってくる。\n" +
      "year と month を指定すると**その月に入るリターンをすべて**返す（たいてい1回、暦月の並びによっては2回、" +
      "まれに0回）。両方省略すると**現在時刻から見て次の1回**。year と month はそろえて指定すること。\n" +
      "返るのは (1) リターンの瞬間（UTC。utc_offset を渡せばその土地の時計でも）、" +
      "(2) リターン図の11天体（星座・度数・逆行・在ハウスはリターン図自身のカスプで）、" +
      "(3) リターン図の ASC / MC とハウスカスプ、" +
      "(4) ネイタルの天体・ASC / MC とのアスペクト（メジャー5種・オーブ 1°）。\n" +
      "リターン図を立てる場所は lat / lng で指定する。省略するとチャートに登録された「いつもの場所」" +
      "（save_chart の default_lat / default_lng）を使う。どちらも無いときは場所を教えてほしい旨を返す。\n" +
      "このツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        year: {
          type: "integer",
          description: "見たい年（month とそろえて指定。省略すると現在時刻から見て次の1回）",
        },
        month: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "見たい月（1-12。year とそろえて指定）",
        },
        lat: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "リターン図を立てる場所の緯度（省略するとチャートの「いつもの場所」）",
        },
        lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "リターン図を立てる場所の経度（lat とそろえて指定）",
        },
        location_label: {
          type: "string",
          description: "その場所の呼び名（任意。例: 東京）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "表示に使う時差（時間単位。日本時間なら 9。省略すると UTC だけで表示する）。" +
            "year / month を指定したときは、暦月の区切りもこの時差の土地の暦で見る。",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "solar_return",
    title: "ソーラーリターン（太陽の帰還）",
    description:
      "登録済みチャートの**ネイタルの太陽**と同じ黄経に、空の太陽が戻ってくる瞬間（ソーラーリターン）を求め、" +
      "その瞬間のホロスコープ一式を返す。年に1回、誕生日の前後1日ほどの範囲でめぐってくる。\n" +
      "year を指定するとその年の1回を返す（その年の1月1日から探す）。省略すると" +
      "**現在時刻から見て次の1回**。\n" +
      "返るものは lunar_return と同じ形——リターンの瞬間、リターン図の11天体（在ハウスはリターン図自身のカスプ）、" +
      "ASC / MC とハウスカスプ、ネイタルとのアスペクト（メジャー5種・オーブ 1°）。\n" +
      "リターン図を立てる場所は lat / lng で指定する。省略するとチャートに登録された「いつもの場所」を使う。\n" +
      "このツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        year: {
          type: "integer",
          description: "見たい年（省略すると現在時刻から見て次の1回）",
        },
        lat: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "リターン図を立てる場所の緯度（省略するとチャートの「いつもの場所」）",
        },
        lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "リターン図を立てる場所の経度（lat とそろえて指定）",
        },
        location_label: {
          type: "string",
          description: "その場所の呼び名（任意。例: 東京）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "表示に使う時差（時間単位。日本時間なら 9。省略すると UTC だけで表示する）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "progressions",
    title: "プログレッション（二次進行）",
    description:
      "二次進行（セカンダリー・プログレッション／一日一年法）を計算する。" +
      "出生の翌日の空を1歳、翌々日を2歳と読む技法で、進行天体・進行 ASC / MC と、" +
      "それらがネイタルに落とすアスペクト（メジャー5種・オーブ 1°）を返す。\n" +
      "**このツールだけは出生の原本（日時・場所）が要るため、原本をサーバーに預けた本人の URL でしか動かない。**" +
      "chart_id は取らない——原本から毎回ネイタルを引き直すので、登録済みチャートとの取り違えが起きない。" +
      "使えない URL では、その旨だけを返す。\n" +
      "year / month / day を省略すると今日で計算する。返却テキストに出生日時・出生地そのものは出さない。\n" +
      "このツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "integer",
          description: "見たい日の年（month / day とそろえて指定。省略すると今日）",
        },
        month: { type: "integer", minimum: 1, maximum: 12, description: "見たい日の月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "見たい日の日（1-31）" },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "表示に使う時差（時間単位。日本時間なら 9）。日付を省略したときの「今日」も" +
            "この時差の土地の暦で決める（省略すると UTC）",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// ---------------------------------------------------------------------------
// 引数の検算（型と範囲だけ見る。天文学的な妥当性はエンジンに任せる）
// ---------------------------------------------------------------------------

function argsOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AstroError("arguments はオブジェクトで渡してください");
  }
  return raw as Record<string, unknown>;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AstroError(`${key} は数値で指定してください`);
  }
  if (value < min || value > max) {
    throw new AstroError(`${key} は ${min} 以上 ${max} 以下で指定してください: ${value}`);
  }
  return value;
}

function requireNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = optionalNumber(args, key, min, max);
  if (value === undefined) throw new AstroError(`${key} は必須です`);
  return value;
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = optionalNumber(args, key, min, max);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new AstroError(`${key} は整数で指定してください: ${value}`);
  return value;
}

function requireInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = optionalInteger(args, key, min, max);
  if (value === undefined) throw new AstroError(`${key} は必須です`);
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new AstroError(`${key} は文字列で指定してください`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new AstroError(`${key} は ${maxLength} 文字以内にしてください`);
  }
  return trimmed;
}

function requireString(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = optionalString(args, key, maxLength);
  if (value === undefined) throw new AstroError(`${key} は必須です（空文字は不可）`);
  return value;
}

function requireHouseSystem(args: Record<string, unknown>): string {
  const value = optionalString(args, "house_system", 4) ?? "P";
  if (!HOUSE_SYSTEM_CODES.includes(value)) {
    throw new AstroError(
      `house_system は ${HOUSE_SYSTEM_CODES.join(" / ")} のいずれかにしてください: ${value}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// 日時まわり
// ---------------------------------------------------------------------------

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** UTC の Date を「2026-08-20 02:15 UTC」に */
function formatUtcMoment(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** 時差 → 「UTC+9」「UTC+5.5」 */
function formatOffsetLabel(utcOffset: number): string {
  const sign = utcOffset >= 0 ? "+" : "-";
  const absolute = Math.abs(utcOffset);
  const label = Number.isInteger(absolute) ? String(absolute) : absolute.toFixed(1);
  return `UTC${sign}${label}`;
}

/** UTC の Date ＋ 時差を「2026-08-20 11:15（UTC+9）」に */
function formatLocalMoment(utcDate: Date, utcOffset: number): string {
  const shifted = new Date(utcDate.getTime() + utcOffset * 3_600_000);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}（${formatOffsetLabel(utcOffset)}）`
  );
}

/** Date（UTC）→ julianDay に渡せる MomentInput（時差 0） */
function momentFromUtcDate(date: Date): MomentInput {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes() + date.getUTCSeconds() / 60,
    utcOffset: 0,
  };
}

/** ローカルの暦日時から UTC の Date を作る（year < 100 でも 1900 年台に化けないように） */
function utcDateFromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  utcOffset: number,
): Date {
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, 0, 0);
  return new Date(local.getTime() - utcOffset * 3_600_000);
}

// ---------------------------------------------------------------------------
// ツール実装
// ---------------------------------------------------------------------------

export interface AstroContext {
  auth: AuthContext;
  kv: AstroKv;
  getEngine: () => Promise<SwissEph>;
  /** テストから時刻を固定するための差し込み口（既定は現在時刻） */
  now?: () => Date;
  /**
   * 出生の原本（Workers Secret の OWNER_NATAL。JSON 文字列）。
   * progressions だけがこれを見る。**中身も存在有無も、返事やログには出さない**
   * （「設定されていません」以上のことを言わない）。
   */
  ownerNatal?: string;
}

async function engineOf(context: AstroContext): Promise<SwissEph> {
  try {
    return await context.getEngine();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AstroError(`天体計算エンジンを初期化できませんでした: ${detail}`);
  }
}

/**
 * ネイタル天体＋ASC/MC を、アスペクト探索用の点に均す。
 *
 * 速度を 0 で置くのは意図的 ―― ネイタルは「止まっている図」なので、接近／離反は
 * 動いているトランジット側だけで決まる。移植元の calc.js はネイタルの速度もそのまま
 * 渡していて、同じ速度の天体同士だと接近判定が常に false になる（実害の小さい癖）。
 */
function aspectPointsOf(chart: {
  planets: readonly { id: number; lon: number }[];
  cusps: readonly number[];
  ascmc: readonly number[];
}): AspectPoint[] {
  const points: AspectPoint[] = chart.planets.map((planet) => ({
    name: planetName(planet.id),
    lon: planet.lon,
    speed: 0,
  }));
  const angles = anglesOf(chart);
  points.push({ name: "ASC", lon: angles.asc, speed: 0 });
  points.push({ name: "MC", lon: angles.mc, speed: 0 });
  return points;
}

async function runSaveChart(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);

  const label = requireString(args, "label", 60);
  const moment: MomentInput = {
    year: requireInteger(args, "year", -5000, 5000),
    month: requireInteger(args, "month", 1, 12),
    day: requireInteger(args, "day", 1, 31),
    hour: requireInteger(args, "hour", 0, 23),
    minute: requireInteger(args, "minute", 0, 59),
    utcOffset: requireNumber(args, "utc_offset", -14, 14),
  };
  const lat = requireNumber(args, "lat", -90, 90);
  const lng = requireNumber(args, "lng", -180, 180);
  const houseSystem = requireHouseSystem(args);

  const defaultLat = optionalNumber(args, "default_lat", -90, 90);
  const defaultLng = optionalNumber(args, "default_lng", -180, 180);
  const defaultLabel = optionalString(args, "default_location_label", 40);
  if ((defaultLat === undefined) !== (defaultLng === undefined)) {
    throw new AstroError("default_lat と default_lng は両方そろえて指定してください");
  }

  const swe = await engineOf(context);
  const computed = computeChart(swe, moment, { lat, lng, houseSystem });

  const stored: StoredChart = {
    label,
    house_system: houseSystem,
    planets: computed.planets,
    cusps: computed.cusps,
    ascmc: computed.ascmc,
    created: new Date().toISOString(),
  };
  if (defaultLat !== undefined && defaultLng !== undefined) {
    stored.default_location = { lat: defaultLat, lng: defaultLng };
    if (defaultLabel) stored.default_location.label = defaultLabel;
  }

  const chartId = newChartId();
  await putChart(context.kv, context.auth.user, chartId, stored);

  const angles = anglesOf(stored);
  const lines: string[] = [
    "チャートを保存しました。",
    `chart_id: ${chartId}（transit などにこの ID を渡してください）`,
    `ラベル: ${label}`,
    `ハウス方式: ${houseSystemName(houseSystem)}（${houseSystem}）`,
  ];
  if (stored.default_location) {
    const place = stored.default_location;
    const name = place.label ? `${place.label} ` : "";
    lines.push(`いつもの場所: ${name}緯度 ${place.lat} / 経度 ${place.lng}`);
  }
  lines.push("");
  lines.push("■ ネイタル天体（カッコ内は在ハウス）");
  lines.push(...formatPlanetLines(stored.planets, stored.cusps));
  lines.push("");
  lines.push(formatAngles(angles));
  lines.push("");
  lines.push("■ ハウスカスプ");
  lines.push(formatCuspLine(stored.cusps));
  lines.push("");
  lines.push("出生日時・出生地は保存していません（計算に使って捨てました）。");

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { chart_id: chartId, ...stored },
  };
}

async function runListCharts(context: AstroContext): Promise<ToolResult> {
  const charts = await listCharts(context.kv, context.auth.user);

  if (charts.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "保存済みのチャートはまだありません。\n" +
            "save_chart に出生データ（年月日・時刻・その土地の時差・緯度経度）を渡すと chart_id が発行され、" +
            "以後はその ID だけでトランジットを引けます。" +
            "出生日時・出生地はサーバーに残らず、計算済みの座標だけが保存されます。",
        },
      ],
      structuredContent: { charts },
    };
  }

  const lines: string[] = [`保存済みチャート（${charts.length}件）`];
  for (const chart of charts) {
    const parts = [
      `- ${chart.chart_id}: ${chart.label}`,
      `${houseSystemName(chart.house_system)}（${chart.house_system}）`,
    ];
    if (chart.default_location) {
      const place = chart.default_location;
      const name = place.label ? `${place.label}（${place.lat}, ${place.lng}）` : `${place.lat}, ${place.lng}`;
      parts.push(`いつもの場所: ${name}`);
    }
    parts.push(`登録 ${chart.created}`);
    lines.push(parts.join(" / "));
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { charts },
  };
}

async function runDeleteChart(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const existing = await getChart(context.kv, context.auth.user, chartId);
  const removed = existing ? await deleteChart(context.kv, context.auth.user, chartId) : false;
  if (!removed || !existing) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめてください。`,
    );
  }

  return {
    content: [{ type: "text", text: `チャート ${chartId}（${existing.label}）を削除しました。` }],
    structuredContent: { chart_id: chartId, deleted: true },
  };
}

async function runTransit(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
        "save_chart で登録してください。",
    );
  }

  const year = optionalInteger(args, "year", -5000, 5000);
  const month = optionalInteger(args, "month", 1, 12);
  const day = optionalInteger(args, "day", 1, 31);
  const hour = optionalInteger(args, "hour", 0, 23);
  const minute = optionalInteger(args, "minute", 0, 59);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);

  const hasDate =
    year !== undefined ||
    month !== undefined ||
    day !== undefined ||
    hour !== undefined ||
    minute !== undefined;

  const now = context.now ? context.now() : new Date();
  let utcDate: Date;
  let isNow = false;
  if (hasDate) {
    if (year === undefined || month === undefined || day === undefined) {
      throw new AstroError(
        "日時を指定するときは year / month / day をそろえてください" +
          "（hour・minute を省くと 0 時 0 分、utc_offset を省くと UTC 扱い）",
      );
    }
    utcDate = utcDateFromLocal(year, month, day, hour ?? 0, minute ?? 0, utcOffset ?? 0);
  } else {
    utcDate = now;
    isNow = true;
  }

  const swe = await engineOf(context);
  const jd = julianDay(swe, momentFromUtcDate(utcDate));
  const transitPlanets = computePlanets(swe, jd);

  const natalPoints = aspectPointsOf(chart);
  const transitPoints: AspectPoint[] = transitPlanets.map((planet) => ({
    name: planetName(planet.id),
    lon: planet.lon,
    speed: planet.speed,
  }));
  const aspects = crossAspects(natalPoints, transitPoints, DEFAULT_ORB);

  const angles = anglesOf(chart);
  const lines: string[] = [
    "トランジット",
    `チャート: ${chart.label}（${chartId}） / ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}）`,
  ];
  const when = [`日時: ${formatUtcMoment(utcDate)}${isNow ? "（現在時刻）" : ""}`];
  if (utcOffset !== undefined) {
    when.push(`ローカル ${formatLocalMoment(utcDate, utcOffset)}`);
  }
  lines.push(when.join(" / "));
  lines.push("");

  lines.push("■ トランジット天体（カッコ内はネイタルのカスプで見た在ハウス）");
  lines.push(...formatPlanetLines(transitPlanets, chart.cusps));
  lines.push("");

  lines.push("■ ネイタル天体（参考）");
  lines.push(...formatPlanetLines(chart.planets, chart.cusps));
  lines.push(formatAngles(angles));
  lines.push("");

  lines.push(`■ ネイタルへのアスペクト（メジャー5種・オーブ ${DEFAULT_ORB.toFixed(1)}°）`);
  if (aspects.length === 0) {
    lines.push(`該当なし（オーブ ${DEFAULT_ORB.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    // 直接 map に渡さないこと（第 2 引数の prefix に添字が飛び込む）
    lines.push(...aspects.map((hit) => formatCrossAspect(hit)));
  }

  const structuredTransit = transitPlanets.map((planet: PlanetPosition) => ({
    id: planet.id,
    name: planetName(planet.id),
    lon: planet.lon,
    speed: planet.speed,
    retrograde: planet.speed < 0,
    position: formatDegree(planet.lon),
    house: getHouse(planet.lon, chart.cusps),
  }));

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      chart_id: chartId,
      label: chart.label,
      house_system: chart.house_system,
      utc: utcDate.toISOString(),
      is_now: isNow,
      transit_planets: structuredTransit,
      aspects,
    },
  };
}

// ---------------------------------------------------------------------------
// リターン（ルナリターン・ソーラーリターン）
// ---------------------------------------------------------------------------

/** リターン図を立てる場所 */
interface ReturnPlace {
  lat: number;
  lng: number;
  label?: string;
}

/** 引数の lat / lng → 無ければチャートの「いつもの場所」→ それも無ければ丁寧に断る */
function resolvePlace(args: Record<string, unknown>, chart: StoredChart): ReturnPlace {
  const lat = optionalNumber(args, "lat", -90, 90);
  const lng = optionalNumber(args, "lng", -180, 180);
  const label = optionalString(args, "location_label", 40);

  if ((lat === undefined) !== (lng === undefined)) {
    throw new AstroError("lat と lng は両方そろえて指定してください");
  }
  if (lat !== undefined && lng !== undefined) {
    const place: ReturnPlace = { lat, lng };
    if (label) place.label = label;
    return place;
  }
  if (chart.default_location) {
    const place: ReturnPlace = {
      lat: chart.default_location.lat,
      lng: chart.default_location.lng,
    };
    const name = label ?? chart.default_location.label;
    if (name) place.label = name;
    return place;
  }
  throw new AstroError(
    "リターン図を立てる場所が分かりません。lat / lng で場所を指定するか、" +
      "save_chart で default_lat / default_lng（いつもの場所）を登録してください。",
  );
}

/** 「東京（緯度 35.6895 / 経度 139.6917）」 */
function formatPlace(place: ReturnPlace): string {
  const coordinates = `緯度 ${place.lat} / 経度 ${place.lng}`;
  return place.label ? `${place.label}（${coordinates}）` : coordinates;
}

/** その暦月の頭（0 時 0 分）の jd。utcOffset を渡すとその土地の暦での月初になる */
function monthStartJd(swe: SwissEph, year: number, month: number, utcOffset: number): number {
  return julianDay(swe, { year, month, day: 1, hour: 0, minute: 0, utcOffset });
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** リターン 1 回ぶん（瞬間とその図） */
interface ReturnMoment {
  jd: number;
  date: Date;
  chart: ComputedChart;
  aspects: ReturnType<typeof crossAspects>;
}

/**
 * ルナリターン / ソーラーリターン。中身はほぼ同じなので 1 本にまとめてある
 * （違うのは戻る天体・期間の指定の仕方・見出しだけ）。
 */
async function runReturn(
  kind: ReturnKind,
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
        "save_chart で登録してください。",
    );
  }

  const isLunar = kind === "moon";
  const targetId = isLunar ? 1 : 0;
  const targetName = planetName(targetId);
  const target = chart.planets.find((planet) => planet.id === targetId);
  if (!target) {
    return toolError(
      `このチャートには${targetName}の位置が入っていません。save_chart で登録し直してください。`,
    );
  }

  const place = resolvePlace(args, chart);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);
  const boundaryOffset = utcOffset ?? 0;
  const year = optionalInteger(args, "year", -5000, 5000);
  const month = isLunar ? optionalInteger(args, "month", 1, 12) : undefined;

  if (isLunar && (year === undefined) !== (month === undefined)) {
    throw new AstroError(
      "year と month はそろえて指定してください" +
        "（両方省略すると現在時刻から見て次のリターンを返します）",
    );
  }

  const swe = await engineOf(context);
  const now = context.now ? context.now() : new Date();
  const nowJd = julianDay(swe, momentFromUtcDate(now));
  const calendarNote = utcOffset === undefined ? "UTC の暦" : `${formatOffsetLabel(utcOffset)} の暦`;

  let jds: number[];
  let periodLabel: string;
  let isNext = false;
  if (year === undefined) {
    // 期間の指定なし ＝ 今から見て次の 1 回
    jds = [crossUt(swe, kind, target.lon, nowJd)];
    periodLabel = `${formatUtcMoment(now)}（現在）より後の次の 1 回`;
    isNext = true;
  } else if (isLunar && month !== undefined) {
    const start = monthStartJd(swe, year, month, boundaryOffset);
    const following = nextMonth(year, month);
    const end = monthStartJd(swe, following.year, following.month, boundaryOffset);
    jds = crossingsInRange(swe, kind, target.lon, start, end);
    periodLabel = `${year}年${month}月（${calendarNote}）`;
  } else {
    // ソーラーリターンはその年の 1 月 1 日から 1 回だけ探せば足りる（年に 1 回しか無い）
    jds = [crossUt(swe, kind, target.lon, monthStartJd(swe, year, 1, boundaryOffset))];
    periodLabel = `${year}年（${calendarNote}）`;
  }

  const natalPoints = aspectPointsOf(chart);
  const moments: ReturnMoment[] = jds.map((jd) => {
    const returnChart = computeChartFromJd(swe, jd, {
      lat: place.lat,
      lng: place.lng,
      houseSystem: chart.house_system,
    });
    const returnPoints: AspectPoint[] = returnChart.planets.map((planet) => ({
      name: planetName(planet.id),
      lon: planet.lon,
      speed: planet.speed,
    }));
    return {
      jd,
      date: dateFromJulianDay(jd),
      chart: returnChart,
      aspects: crossAspects(natalPoints, returnPoints, DEFAULT_ORB),
    };
  });

  const lines: string[] = [
    isLunar ? "ルナリターン（月の帰還）" : "ソーラーリターン（太陽の帰還）",
    `チャート: ${chart.label}（${chartId}） / ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}）`,
    `ネイタルの${targetName}: ${formatDegree(target.lon)}`,
    `リターン図を立てた場所: ${formatPlace(place)}`,
    isNext ? `対象: ${periodLabel}` : `対象: ${periodLabel} ― ${moments.length}件`,
  ];

  if (moments.length === 0) {
    lines.push("");
    lines.push(
      `この期間に${targetName}のリターンはありませんでした` +
        "（ルナリターンは約27.3日に1回めぐるので、暦月の並びによっては1回も入らない月があります）。" +
        "前後の月も見てみてください。",
    );
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        kind: isLunar ? "lunar_return" : "solar_return",
        chart_id: chartId,
        label: chart.label,
        house_system: chart.house_system,
        natal_target: { id: targetId, name: targetName, lon: target.lon },
        location: place,
        is_next: isNext,
        returns: [],
      },
    };
  }

  lines.push("（T.＝リターン図の天体 / N.＝ネイタル）");

  moments.forEach((moment, index) => {
    lines.push("");
    if (moments.length > 1) lines.push(`■ ${index + 1} 回目`);
    const when = [`リターンの瞬間: ${formatUtcMoment(moment.date)}`];
    if (utcOffset !== undefined) {
      when.push(`ローカル ${formatLocalMoment(moment.date, utcOffset)}`);
    }
    lines.push(when.join(" / "));
    lines.push("");
    lines.push("□ リターン図の天体（カッコ内はリターン図自身のカスプで見た在ハウス）");
    lines.push(...formatPlanetLines(moment.chart.planets, moment.chart.cusps));
    lines.push(formatAngles(anglesOf(moment.chart)));
    lines.push("□ リターン図のハウスカスプ");
    lines.push(formatCuspLine(moment.chart.cusps));
    lines.push(`□ ネイタルへのアスペクト（メジャー5種・オーブ ${DEFAULT_ORB.toFixed(1)}°）`);
    if (moment.aspects.length === 0) {
      lines.push(
        `該当なし（オーブ ${DEFAULT_ORB.toFixed(1)}° の範囲にメジャーアスペクトはありません）`,
      );
    } else {
      lines.push(...moment.aspects.map((hit) => formatCrossAspect(hit)));
    }
  });

  const returns = moments.map((moment) => {
    const angles = anglesOf(moment.chart);
    return {
      utc: moment.date.toISOString(),
      jd: moment.jd,
      planets: moment.chart.planets.map((planet: PlanetPosition) => ({
        id: planet.id,
        name: planetName(planet.id),
        lon: planet.lon,
        speed: planet.speed,
        retrograde: planet.speed < 0,
        position: formatDegree(planet.lon),
        house: getHouse(planet.lon, moment.chart.cusps),
      })),
      asc: angles.asc,
      mc: angles.mc,
      cusps: moment.chart.cusps,
      aspects: moment.aspects,
    };
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: isLunar ? "lunar_return" : "solar_return",
      chart_id: chartId,
      label: chart.label,
      house_system: chart.house_system,
      natal_target: {
        id: targetId,
        name: targetName,
        lon: target.lon,
        position: formatDegree(target.lon),
      },
      location: place,
      period: isNext ? null : isLunar ? { year, month } : { year },
      is_next: isNext,
      returns,
    },
  };
}

// ---------------------------------------------------------------------------
// 二次進行（オーナー特権）
// ---------------------------------------------------------------------------

/** Secret から読んだ出生の原本 */
interface OwnerNatal {
  user: string;
  moment: MomentInput;
  lat: number;
  lng: number;
  houseSystem: string;
}

/** 原本が読めなかったときの言い分（中身についてはこれ以上言わない） */
const BROKEN_NATAL =
  "預かっている出生の原本を読み取れませんでした（OWNER_NATAL の形式を確かめてください）。";

/**
 * Workers Secret の OWNER_NATAL（JSON 文字列）を読む。
 * **中身も、どこがどう違うかも返事に出さない** ―― 出すのは「無い」か「読めない」かだけ。
 */
function parseOwnerNatal(raw: string | undefined): OwnerNatal {
  if (raw === undefined || raw.trim().length === 0) {
    throw new AstroError(
      "このサーバーに出生の原本が預けられていないため、二次進行は計算できません。" +
        "デプロイ時に `npx wrangler secret put OWNER_NATAL` で原本を登録してください。",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AstroError(BROKEN_NATAL);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AstroError(BROKEN_NATAL);
  }
  const record = parsed as Record<string, unknown>;
  const user = record["user"];
  if (typeof user !== "string" || user.length === 0) throw new AstroError(BROKEN_NATAL);

  try {
    const houseSystem = optionalString(record, "house_system", 4) ?? "P";
    if (!HOUSE_SYSTEM_CODES.includes(houseSystem)) throw new AstroError(BROKEN_NATAL);
    return {
      user,
      moment: {
        year: requireInteger(record, "year", -5000, 5000),
        month: requireInteger(record, "month", 1, 12),
        day: requireInteger(record, "day", 1, 31),
        hour: requireInteger(record, "hour", 0, 23),
        minute: requireInteger(record, "minute", 0, 59),
        utcOffset: requireNumber(record, "utc_offset", -14, 14),
      },
      lat: requireNumber(record, "lat", -90, 90),
      lng: requireNumber(record, "lng", -180, 180),
      houseSystem,
    };
  } catch {
    // 検算器のメッセージ（「year は必須です」など）は原本の形を漏らすので、ここで丸める
    throw new AstroError(BROKEN_NATAL);
  }
}

async function runProgressions(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);

  // 門番は 3 枚 ―― (1) 鍵の役どころ (2) 原本が預けられているか (3) 原本の持ち主とこの URL の主が同じか
  if (context.auth.role !== "owner") {
    return toolError(
      "この機能は出生原本を預けた本人専用です。" +
        "二次進行は出生の日時と場所そのものが要るため、預かっている原本でしか計算できません。" +
        "transit / lunar_return / solar_return は chart_id があればお使いいただけます。",
    );
  }
  const natal = parseOwnerNatal(context.ownerNatal);
  if (natal.user !== context.auth.user) {
    return toolError(
      "この URL は出生原本の持ち主のものではありません。" +
        "progressions は原本を預けた本人だけが使えます。",
    );
  }

  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);
  const year = optionalInteger(args, "year", -5000, 5000);
  const month = optionalInteger(args, "month", 1, 12);
  const day = optionalInteger(args, "day", 1, 31);
  const given = [year, month, day].filter((value) => value !== undefined).length;
  if (given !== 0 && given !== 3) {
    throw new AstroError(
      "year / month / day はそろえて指定してください（すべて省略すると今日で計算します）",
    );
  }

  const now = context.now ? context.now() : new Date();
  const shifted = new Date(now.getTime() + (utcOffset ?? 0) * 3_600_000);
  const isToday = given === 0;
  const target = isToday
    ? {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
      }
    : { year: year as number, month: month as number, day: day as number };

  const swe = await engineOf(context);
  const result = computeProgression(swe, {
    natal: natal.moment,
    lat: natal.lat,
    lng: natal.lng,
    houseSystem: natal.houseSystem,
    target,
  });

  const natalPoints = aspectPointsOf(result.natalChart);
  const progressedPoints: AspectPoint[] = result.progressedPlanets.map((planet) => ({
    name: planetName(planet.id),
    lon: planet.lon,
    speed: planet.speed,
  }));
  const aspects = crossAspects(natalPoints, progressedPoints, DEFAULT_ORB);

  const natalAngles = anglesOf(result.natalChart);
  const dateLabel = `${target.year}-${pad(target.month)}-${pad(target.day)}`;
  const calendarNote = isToday
    ? `（今日・${utcOffset === undefined ? "UTC" : formatOffsetLabel(utcOffset)} の暦）`
    : "";

  const lines: string[] = [
    "プログレッション（二次進行・一日一年法）",
    `対象日: ${dateLabel}${calendarNote} / ${formatAge(result.ageYears)}`,
    `ハウス方式: ${houseSystemName(natal.houseSystem)}（${natal.houseSystem}） / ソーラーアーク ${formatArc(result.solarArc)}`,
    "（P.＝進行天体 / N.＝ネイタル。出生の日時・場所そのものはここには出しません）",
    "",
    "■ 進行天体（カッコ内は出生図のカスプで見た在ハウス）",
    ...formatPlanetLines(result.progressedPlanets, result.natalChart.cusps),
    "",
    "■ 進行 ASC / MC（ソーラーアークで動かした MC から ARMC 方式で立てたもの）",
    formatAngles(result.progressedAngles),
    "■ 進行図のハウスカスプ",
    formatCuspLine(result.progressedCusps),
    "",
    "■ ネイタル（参考）",
    ...formatPlanetLines(result.natalChart.planets, result.natalChart.cusps),
    formatAngles(natalAngles),
    "",
    `■ 進行天体からネイタルへのアスペクト（メジャー5種・オーブ ${DEFAULT_ORB.toFixed(1)}°）`,
  ];
  if (aspects.length === 0) {
    lines.push(`該当なし（オーブ ${DEFAULT_ORB.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    lines.push(...aspects.map((hit) => formatCrossAspect(hit, "P.")));
  }

  const describe = (planet: PlanetPosition, cusps: readonly number[]) => ({
    id: planet.id,
    name: planetName(planet.id),
    lon: planet.lon,
    speed: planet.speed,
    retrograde: planet.speed < 0,
    position: formatDegree(planet.lon),
    house: getHouse(planet.lon, cusps),
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      // jd（＝出生の瞬間そのもの）は載せない。載せると原本が復元できてしまう
      target_date: dateLabel,
      is_today: isToday,
      age_years: result.ageYears,
      age_label: formatAge(result.ageYears),
      house_system: natal.houseSystem,
      solar_arc: result.solarArc,
      progressed_planets: result.progressedPlanets.map((planet) =>
        describe(planet, result.natalChart.cusps),
      ),
      progressed_angles: {
        asc: result.progressedAngles.asc,
        mc: result.progressedAngles.mc,
        asc_position: formatDegree(result.progressedAngles.asc),
        mc_position: formatDegree(result.progressedAngles.mc),
      },
      progressed_cusps: result.progressedCusps,
      natal_planets: result.natalChart.planets.map((planet) =>
        describe(planet, result.natalChart.cusps),
      ),
      natal_angles: {
        asc: natalAngles.asc,
        mc: natalAngles.mc,
        asc_position: formatDegree(natalAngles.asc),
        mc_position: formatDegree(natalAngles.mc),
      },
      aspects,
    },
  };
}

async function callAstroTool(
  name: unknown,
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  try {
    if (name === "save_chart") return await runSaveChart(rawArguments, context);
    if (name === "list_charts") return await runListCharts(context);
    if (name === "delete_chart") return await runDeleteChart(rawArguments, context);
    if (name === "transit") return await runTransit(rawArguments, context);
    if (name === "lunar_return") return await runReturn("moon", rawArguments, context);
    if (name === "solar_return") return await runReturn("sun", rawArguments, context);
    if (name === "progressions") return await runProgressions(rawArguments, context);
    return toolError(`知らないツールです: ${String(name)}`);
  } catch (error) {
    if (error instanceof AstroError) return toolError(error.message);
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC ディスパッチ
// ---------------------------------------------------------------------------

/** POST /mcp/<キー> の本体（鍵の照合は呼び出し側＝ index.ts で済ませてある） */
export async function handleAstroMcpRequest(
  request: Request,
  context: AstroContext,
): Promise<Response> {
  const parsed = await readJsonRpcRequest(request);
  if (!parsed.ok) return parsed.response;
  const { id, method, params } = parsed.value;

  switch (method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: ASTRO_INSTRUCTIONS,
      });

    case "ping":
      return jsonRpcResult(id, {});

    case "tools/list":
      return jsonRpcResult(id, { tools: ASTRO_TOOLS });

    case "tools/call": {
      const callParams = (params ?? {}) as { name?: unknown; arguments?: unknown };
      return jsonRpcResult(id, await callAstroTool(callParams.name, callParams.arguments, context));
    }

    default:
      return jsonRpcError(id, -32601, `知らないメソッドです: ${method}`);
  }
}
