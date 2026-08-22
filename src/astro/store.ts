/**
 * 占星術層の台帳（KV）。
 *
 * 3 種類しか置かない:
 *   key:<キー文字列>        → { user, name, role }        … 誰の URL か
 *   email:<SHA-256 の hex>  → { user, name, role }        … 誰の Cloudflare Access アカウントか
 *                                                          （OAuth の口 POST /astro/mcp 用。
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

/**
 * キー台帳の中身。
 *
 * ⚠ role は**今のところ挙動を分けていません**（2026-08-22、progressions が chart_id 方式に
 *    なって owner 特権が無くなったため）。既存の鍵レコードとの互換と、将来の友だちキーの
 *    ために型と検算だけ残してあります。
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
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

/** URL に載る鍵の形（これ以外は KV を引く前に弾く。鍵そのものはどこにも出さない） */
const KEY_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

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
 * 台帳のレコード（`key:<鍵>` も `email:<ハッシュ>` も同じ形）を検算して AuthContext にする。
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

/**
 * URL の鍵を台帳と照合する。
 * 見つからなければ null（**呼び出し側は鍵の中身をレスポンスにもログにも出さないこと**）。
 */
export async function lookupKey(kv: AstroKv, key: string): Promise<AuthContext | null> {
  if (!KEY_PATTERN.test(key)) return null;

  const raw = await kv.get(`key:${key}`);
  if (raw === null) return null;

  return parseAuthRecord(raw);
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
 * 鍵のときと同じレコード（`{user, name, role}`）を `email:<ハッシュ>` に置いてあり、
 * `user` が同じなら鍵で入っても OAuth で入っても同じチャート台帳になります。
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

export async function getChart(
  kv: AstroKv,
  user: string,
  chartId: string,
): Promise<StoredChart | null> {
  if (!isChartId(chartId)) return null;
  const raw = await kv.get(chartKey(user, chartId));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as StoredChart;
  } catch {
    return null;
  }
}

export async function deleteChart(kv: AstroKv, user: string, chartId: string): Promise<boolean> {
  if (!isChartId(chartId)) return false;
  const key = chartKey(user, chartId);
  const raw = await kv.get(key);
  if (raw === null) return false;
  await kv.delete(key);
  return true;
}

/** その人のチャート一覧（古い順）。件数はたかが知れているので 1 件ずつ引く */
export async function listCharts(kv: AstroKv, user: string): Promise<ChartSummary[]> {
  const prefix = chartPrefix(user);
  const listed = await kv.list({ prefix });

  const summaries: ChartSummary[] = [];
  for (const entry of listed.keys) {
    const chartId = entry.name.slice(prefix.length);
    if (chartId.length === 0) continue;
    const chart = await getChart(kv, user, chartId);
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

  summaries.sort((a, b) => a.created.localeCompare(b.created));
  return summaries;
}
