/**
 * 占星術層の台帳（KV）。
 *
 * 2 種類しか置かない:
 *   key:<キー文字列>        → { user, name, role }        … 誰の URL か
 *   chart:<user>:<chart_id> → 計算済みチャート             … 何を計算したか
 *
 * ⚠ **原本レス**が背骨。出生日時・出生地は計算に使って捨て、残すのは天体の黄経・速度・
 *    カスプ・ASC/MC といった「もう出てしまった座標」だけ。ここから誕生日は復元できない
 *    （太陽の度数から日付は概ね割れるが、年も時刻も場所も戻らない）。
 *    リターン計算用の「いつもの場所」だけは例外で、本人が明示的に預けたものを持つ。
 */
import { cryptoRandom, type RandomSource } from "../random";

/** キー台帳の中身 */
export type Role = "owner" | "friend";

export interface AuthContext {
  user: string;
  name: string;
  role: Role;
}

/** チャート台帳の中身（保存するのはこれだけ。出生日時・出生地・jd は入れない） */
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
  /** 保存時刻（ISO 8601） */
  created: string;
}

/** 一覧に出す 1 件分 */
export interface ChartSummary {
  chart_id: string;
  label: string;
  house_system: string;
  default_location?: { lat: number; lng: number; label?: string };
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
 * URL の鍵を台帳と照合する。
 * 見つからなければ null（**呼び出し側は鍵の中身をレスポンスにもログにも出さないこと**）。
 */
export async function lookupKey(kv: AstroKv, key: string): Promise<AuthContext | null> {
  if (!KEY_PATTERN.test(key)) return null;

  const raw = await kv.get(`key:${key}`);
  if (raw === null) return null;

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
      created: chart.created,
    };
    if (chart.default_location) summary.default_location = chart.default_location;
    summaries.push(summary);
  }

  summaries.sort((a, b) => a.created.localeCompare(b.created));
  return summaries;
}
