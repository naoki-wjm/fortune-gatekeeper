/**
 * 占星術層の台帳（KV）。
 *
 * 2 種類しか置かない:
 *   email:<SHA-256 の hex>  → { user, name, role }        … 誰の Cloudflare Access アカウントか
 *                                                          （唯一の入口 POST /astro/mcp 用。
 *                                                            メールの生の文字列は置かない）
 *   chart:<user>:<chart_id> → 計算済みチャート             … 何を計算したか
 *
 * ⚠ **出生データはこの台帳が預かります**（2026-08-22 改定）。計算済みの座標に加えて、
 *    出生の年月日・時刻・時差・緯度経度を chart レコードの `birth` に入れて持ちます。
 *    誕生日系の占術（数秘術・宿曜・四柱推命など）を chart_id から引けるようにするための改めで、
 *    約束はこの 3 つ:
 *      - 使えるのはその鍵を持つ人だけ（chart: の前置きで人ごとに仕切ってある）
 *      - **返事には出さない**。どのツールの返却テキストにも structuredContent にも出生データを載せない
 *        （呼び出し側は登録時に自分で渡しているので、読み戻す必要がない）
 *      - delete_chart で座標もろとも消える
 *    リターン計算用の「いつもの場所」は出生地とは別の覚え書きで、本人が明示的に預けたものです。
 *    ⚠ 出生データを持たない古い登録（原本を捨てていた時代のもの）もあるので、`birth` は optional。
 */
import { cryptoRandom, type RandomSource } from "../random";
import { AstroError } from "./chart";

/**
 * 許可台帳の中身。
 *
 * ⚠ role は**今のところ挙動を分けていません**（2026-08-22、progressions が chart_id 方式に
 *    なって owner 特権が無くなったため）。既存のレコードとの互換と、将来の友だちのために
 *    型と検算だけ残してあります。
 */
export type Role = "owner" | "friend";

export interface AuthContext {
  user: string;
  name: string;
  role: Role;
}

/** チャート台帳の中身（計算済みの座標＋預かった出生データ。jd は入れない） */
export interface StoredChart {
  label: string;
  house_system: string;
  planets: { id: number; lon: number; speed: number }[];
  /** [0] はダミー、1..12 がカスプ */
  cusps: number[];
  /** [0]=ASC, [1]=MC, … */
  ascmc: number[];
  /** リターン・トランジット用の「いつもの場所」（本人が預けた場合のみ） */
  default_location?: { lat: number; lng: number; label?: string };
  /**
   * 出生データ（2026-08-22 以降の登録には必ず入ります。それより前の登録には入っていません）。
   * ⚠ **返事には出さない値**です。表に出すときは publicChart で落としてから返してください。
   */
  birth?: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    utc_offset: number;
    lat: number;
    lng: number;
  };
  /** 保存時刻（ISO 8601） */
  created: string;
}

/** 一覧に出す 1 件分 */
export interface ChartSummary {
  chart_id: string;
  label: string;
  house_system: string;
  default_location?: { lat: number; lng: number; label?: string };
  /** 出生データを預かっているか（値そのものは出さず、あるかないかだけ） */
  has_birth: boolean;
  created: string;
}

/**
 * このモジュールが使う KV の口（@cloudflare/workers-types の KVNamespace の部分集合）。
 * テストでは同じ形の偽 KV を渡す。
 */
export interface AstroKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * 本物の KV は 1 回の list で全部を返すとは限らない（既定 1,000 件・上限 1,000 件で打ち切り、
   * `list_complete: false` と `cursor` が返る）。チャートが 1,000 枚を超えることはまず無いが、
   * 「返ってきたぶんだけ」で一覧を作ると**黙って一部が消える**ので、続きがある間は cursor で回す。
   */
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete?: boolean; cursor?: string }>;
}

/** chart_id に使う文字（0/o/1/l のような紛らわしい字は外す） */
const CHART_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const CHART_ID_LENGTH = 8;
const CHART_ID_PATTERN = /^[a-z0-9]{4,16}$/;

/** 空き ID を探す試行回数（これだけ引いて全部埋まっていたら諦める） */
const MAX_ID_ATTEMPTS = 8;

/** 新しい chart_id（サーバー側の乱数で引く。カード側と同じ random.ts を使う） */
export function newChartId(random: RandomSource = cryptoRandom): string {
  let id = "";
  for (let i = 0; i < CHART_ID_LENGTH; i++) {
    id += CHART_ID_ALPHABET[random.int(CHART_ID_ALPHABET.length)];
  }
  return id;
}

/** 見た目が chart_id かどうか（KV を引く前の門番） */
export function isChartId(value: string): boolean {
  return CHART_ID_PATTERN.test(value);
}

/**
 * 台帳のレコード（`email:<ハッシュ>` の中身）を検算して AuthContext にする。
 * 壊れていたら null（＝載っていないのと同じ扱い）。
 */
function parseAuthRecord(raw: string): AuthContext | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  const user = record["user"];
  const role = record["role"];
  if (typeof user !== "string" || user.length === 0 || user.includes(":")) return null;
  if (role !== "owner" && role !== "friend") return null;

  const name = typeof record["name"] === "string" && record["name"].length > 0 ? record["name"] : user;
  return { user, name, role };
}

/** メールの正規化（前後の空白を落として小文字に）。ハッシュも照合もこの形で揃える */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * メールアドレスの合言葉（SHA-256 の hex 小文字）。
 *
 * 台帳の鍵名を `email:<ハッシュ>` にしてあるのは、**メールの生の文字列を KV にも会話にも残さない**ため。
 * 登録するときは `npm run email-hash -- <メール>` でこの値だけを取り出して使います。
 */
export async function hashEmail(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeEmail(email));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * OAuth（Cloudflare Access）を通ってきた人のメールを台帳と照合する。
 * レコード（`{user, name, role}`）は `email:<ハッシュ>` に置いてあり、`user` がその人の
 * チャート台帳（`chart:<user>:…`）の仕切りになります。
 *
 * 見つからなければ null（**呼び出し側はメールの生の文字列をレスポンスにもログにも出さないこと**）。
 */
export async function lookupEmail(kv: AstroKv, email: string): Promise<AuthContext | null> {
  const normalized = normalizeEmail(email);
  if (normalized.length === 0 || !normalized.includes("@")) return null;

  const raw = await kv.get(`email:${await hashEmail(normalized)}`);
  if (raw === null) return null;

  return parseAuthRecord(raw);
}

function chartKey(user: string, chartId: string): string {
  return `chart:${user}:${chartId}`;
}

function chartPrefix(user: string): string {
  return `chart:${user}:`;
}

export async function putChart(
  kv: AstroKv,
  user: string,
  chartId: string,
  chart: StoredChart,
): Promise<void> {
  await kv.put(chartKey(user, chartId), JSON.stringify(chart));
}

/**
 * 空いている chart_id を引いて保存する（save_chart の入口はこちらを使う）。
 *
 * `newChartId` は 32 文字 8 桁＝約 1.1 兆通りなので衝突はまず起きないが、
 * 起きたときに**他人の図でも自分の古い図でも黙って上書きしてしまう**のが困る。
 * put の前に get で空きを確かめ、埋まっていたら引き直す。
 * KV は結果整合なので「直前に書いた ID が見えない」ことは有り得るが、
 * その窓は数秒で、同じ 8 桁を同じ数秒に引く確率と重なる目はまず無い。
 */
export async function createChart(
  kv: AstroKv,
  user: string,
  chart: StoredChart,
  random: RandomSource = cryptoRandom,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const chartId = newChartId(random);
    if ((await kv.get(chartKey(user, chartId))) !== null) continue;
    await putChart(kv, user, chartId, chart);
    return chartId;
  }
  throw new Error(
    `chart_id を ${MAX_ID_ATTEMPTS} 回引いても空きが見つかりませんでした（時間をおいてもう一度お試しください）`,
  );
}

// ---------------------------------------------------------------------------
// 読み出しの検算（2026-08-27 査読対応）
// ---------------------------------------------------------------------------

/**
 * 台帳から読んだ値が StoredChart の形をしているかを確かめ、**知っているフィールドだけを写した
 * 新しいオブジェクト**を組み立てて返す（壊れていたら null）。
 *
 * `JSON.parse` の結果をそのまま型キャストで通していたのを改めたもの。狙いは 2 つ:
 *   - 手で書き換えた台帳・古い版の書き込み・途中で切れた JSON が、そのまま計算に流れ込まないこと
 *     （壊れた値は「NaN の座標」や「undefined の参照」になって、遠くの配線で意味の分からない
 *       例外になる。入口で断って「登録し直して」と言うほうが早い）
 *   - **知らないフィールドを落とすこと**＝二重の防波堤。台帳に何か余計なものが混ざっていても、
 *     publicChart（載せるものを列挙する方式）とここの 2 枚で表には出られない
 *
 * `undefined` は「無い」、それ以外の値（null を含む）は「あるのに壊れている」として扱う。
 * とくに `birth` は、あるのに一部が欠けていたら**レコードごと壊れ扱い**にする
 * ―― 中途半端な出生データで誕生日系の占術を回すと、黙って別人の結果が出てしまうため。
 */
function finiteNumberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberInRange(value: unknown, min: number, max: number): number | null {
  const parsed = finiteNumberOf(value);
  if (parsed === null || parsed < min || parsed > max) return null;
  return parsed;
}

function integerInRange(value: unknown, min: number, max: number): number | null {
  const parsed = numberInRange(value, min, max);
  if (parsed === null || !Number.isInteger(parsed)) return null;
  return parsed;
}

/** 有限数だけの配列か（長さは呼び出し側で見る） */
function finiteNumberArray(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length < length) return null;
  const numbers: number[] = [];
  for (const entry of value) {
    const parsed = finiteNumberOf(entry);
    if (parsed === null) return null;
    numbers.push(parsed);
  }
  return numbers;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parsePlanets(value: unknown): StoredChart["planets"] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const planets: StoredChart["planets"] = [];
  for (const entry of value) {
    const record = recordOf(entry);
    if (record === null) return null;
    const id = integerInRange(record["id"], -1000, 1000);
    const lon = finiteNumberOf(record["lon"]);
    const speed = finiteNumberOf(record["speed"]);
    if (id === null || lon === null || speed === null) return null;
    planets.push({ id, lon, speed });
  }
  return planets;
}

function parseDefaultLocation(value: unknown): StoredChart["default_location"] | null {
  const record = recordOf(value);
  if (record === null) return null;
  const lat = numberInRange(record["lat"], -90, 90);
  const lng = numberInRange(record["lng"], -180, 180);
  if (lat === null || lng === null) return null;
  const place: NonNullable<StoredChart["default_location"]> = { lat, lng };
  // 呼び名は飾りなので、文字列のときだけ採る（無くても壊れ扱いにはしない）
  if (typeof record["label"] === "string" && record["label"].length > 0) {
    place.label = record["label"];
  }
  return place;
}

/** 出生データ。範囲は save_chart の受け付けと同じにそろえてある */
function parseBirth(value: unknown): StoredChart["birth"] | null {
  const record = recordOf(value);
  if (record === null) return null;
  const year = integerInRange(record["year"], -5000, 5000);
  const month = integerInRange(record["month"], 1, 12);
  const day = integerInRange(record["day"], 1, 31);
  const hour = integerInRange(record["hour"], 0, 23);
  const minute = integerInRange(record["minute"], 0, 59);
  const utcOffset = numberInRange(record["utc_offset"], -14, 14);
  const lat = numberInRange(record["lat"], -90, 90);
  const lng = numberInRange(record["lng"], -180, 180);
  if (
    year === null ||
    month === null ||
    day === null ||
    hour === null ||
    minute === null ||
    utcOffset === null ||
    lat === null ||
    lng === null
  ) {
    return null;
  }
  return { year, month, day, hour, minute, utc_offset: utcOffset, lat, lng };
}

export function parseStoredChart(raw: unknown): StoredChart | null {
  const record = recordOf(raw);
  if (record === null) return null;

  // ラベルは 60 文字まで（save_chart の受け付けと同じ）。**空文字は通す** ――
  // 台帳を手で書き換えた「ラベルの無い図」は壊れているわけではなく、
  // 表示側にも chart_id だけを見出しにする道がある（synastry の見出し）。
  // 消して登録し直させるほどのことではないので、ここでは断らない。
  const label = record["label"];
  if (typeof label !== "string" || label.length > 60) return null;

  const houseSystem = record["house_system"];
  if (typeof houseSystem !== "string" || houseSystem.length !== 1) return null;

  const created = record["created"];
  if (typeof created !== "string" || created.length === 0) return null;

  const planets = parsePlanets(record["planets"]);
  if (planets === null) return null;

  // カスプは [0] がダミー＋1..12 でちょうど 13 個、ascmc は [0]=ASC / [1]=MC が要る
  const cusps = finiteNumberArray(record["cusps"], 13);
  if (cusps === null || cusps.length !== 13) return null;
  const ascmc = finiteNumberArray(record["ascmc"], 2);
  if (ascmc === null) return null;

  const chart: StoredChart = {
    label,
    house_system: houseSystem,
    planets,
    cusps,
    ascmc,
    created,
  };

  if (record["default_location"] !== undefined) {
    const place = parseDefaultLocation(record["default_location"]);
    if (place === null) return null;
    chart.default_location = place;
  }

  if (record["birth"] !== undefined) {
    const birth = parseBirth(record["birth"]);
    if (birth === null) return null;
    chart.birth = birth;
  }

  return chart;
}

/**
 * 壊れたレコードの言い分。**chart_id 以外は絶対に書かない**
 * （中身が壊れているということは、何が入っているか分からないということでもある）。
 */
export function brokenChartMessage(chartId: string): string {
  return (
    `チャート ${chartId} の台帳レコードが壊れていて読めません。` +
    "delete_chart で消してから save_chart で登録し直してください"
  );
}

/**
 * 台帳から 1 枚読む。
 *
 * 見つからなければ null、**壊れていたら AstroError**（JSON として読めない場合も同じ）。
 * 「無い」と「壊れている」を分けるのは、案内が違うため ―― 前者は chart_id の打ち間違い、
 * 後者は delete_chart してからの登録し直しで直る。
 */
export async function getChart(
  kv: AstroKv,
  user: string,
  chartId: string,
): Promise<StoredChart | null> {
  if (!isChartId(chartId)) return null;
  const raw = await kv.get(chartKey(user, chartId));
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AstroError(brokenChartMessage(chartId));
  }
  const chart = parseStoredChart(parsed);
  if (chart === null) throw new AstroError(brokenChartMessage(chartId));
  return chart;
}

export async function deleteChart(kv: AstroKv, user: string, chartId: string): Promise<boolean> {
  if (!isChartId(chartId)) return false;
  const key = chartKey(user, chartId);
  const raw = await kv.get(key);
  if (raw === null) return false;
  await kv.delete(key);
  return true;
}

/** list_charts の返り値。壊れて読めなかった登録は一覧から外し、ID だけ添えて知らせる */
export interface ChartListing {
  charts: ChartSummary[];
  /** 台帳レコードが壊れていて読めなかった chart_id（登録し直しの案内に使う） */
  broken: string[];
}

/**
 * その人のチャート一覧（古い順）。件数はたかが知れているので 1 件ずつ引く。
 *
 * 壊れた 1 枚で一覧そのものが読めなくなると、消すための chart_id さえ分からなくなるので、
 * ここだけは AstroError を握って `broken` に積む（他のツールは throw のまま）。
 * KV の list は続きがある間 cursor で回す。
 */
export async function listCharts(kv: AstroKv, user: string): Promise<ChartListing> {
  const prefix = chartPrefix(user);

  const summaries: ChartSummary[] = [];
  const broken: string[] = [];
  let cursor: string | undefined;

  for (;;) {
    const listed = await kv.list(cursor === undefined ? { prefix } : { prefix, cursor });
    for (const entry of listed.keys) {
      const chartId = entry.name.slice(prefix.length);
      if (chartId.length === 0) continue;

      let chart: StoredChart | null;
      try {
        chart = await getChart(kv, user, chartId);
      } catch (error) {
        if (error instanceof AstroError) {
          broken.push(chartId);
          continue;
        }
        throw error;
      }
      if (!chart) continue;

      const summary: ChartSummary = {
        chart_id: chartId,
        label: chart.label,
        house_system: chart.house_system,
        has_birth: chart.birth !== undefined,
        created: chart.created,
      };
      if (chart.default_location) summary.default_location = chart.default_location;
      summaries.push(summary);
    }

    // 続きがあるときだけもう一周（cursor が無ければそこで打ち切り＝無限ループにしない）
    if (listed.list_complete === false && typeof listed.cursor === "string" && listed.cursor.length > 0) {
      cursor = listed.cursor;
      continue;
    }
    break;
  }

  summaries.sort((a, b) => a.created.localeCompare(b.created));
  return { charts: summaries, broken };
}
