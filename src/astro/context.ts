/**
 * 占星術層のツールが共通で使う土台（astro-mcp.ts から切り出した共通部品）。
 *
 * ツール 1 本の形（定義＋実装）と、呼び出しの文脈（AstroContext）、
 * そして 2 科以上で使い回している小さな道具だけを置く。中身は移動しただけ。
 */
import { toolError, type ToolResult } from "../mcp";
import { AstroError, anglesOf, planetName, type AspectPoint, type SwissEph } from "./chart";
import { missingChartMessage } from "../phrases";
import { type AstroKv, type AuthContext, type StoredChart } from "./store";

/**
 * ツール 1 本の定義（tools/list にそのまま並ぶ形）。
 * 元は `ASTRO_TOOLS` の配列リテラルが持っていた形をそのまま型に起こしたもの。
 */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * 占術ごとのファイルが 1 本ずつ export する形（定義と実装の 2 点セット）。
 * 入口（astro-mcp.ts）はこれを歴史順に並べて ASTRO_TOOLS と名前引きの表を作る。
 */
export interface AstroTool {
  definition: ToolDefinition;
  run: (rawArguments: unknown, context: AstroContext) => Promise<ToolResult>;
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
}

/**
 * 台帳のチャートから、表に出してよい部分だけを取り出す。
 *
 * 落とすのは `birth`（預かっている出生データ）ひとつ ―― structuredContent に
 * `...stored` を撒くところは必ずこれを通すこと。**出生データは返事に出さない**が約束で、
 * 呼び出し側は登録時に自分で渡しているので読み戻す必要もない。
 */
export function publicChart(chart: StoredChart): Omit<StoredChart, "birth"> {
  const { birth: _birth, ...rest } = chart;
  return rest;
}

export async function engineOf(context: AstroContext): Promise<SwissEph> {
  try {
    return await context.getEngine();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AstroError(`天体計算エンジンを初期化できませんでした: ${detail}`);
  }
}

/**
 * 天体の並びを、アスペクト探索用の点に均す（ASC/MC は付けない）。
 *
 * 速度を 0 で置くのは意図的 ―― 「1 枚の図の中のアスペクト」は止まった図の話なので、
 * 接近／離反を持たない（natalAspects は速度を見ない）。動く側として使うときは
 * 呼び出し側で本物の速度を持つ点を組むこと（runTransit の transitPoints）。
 *
 * excludeNodes: true でノース ノード（id 11）を落とす。図の中のアスペクトは
 * events.ts と同じ方針で **ノードを相手にも動く側にも入れない**（位置は一覧に出す）。
 */
export function planetPointsOf(
  planets: readonly { id: number; lon: number }[],
  options: { excludeNodes?: boolean } = {},
): AspectPoint[] {
  const kept = options.excludeNodes ? planets.filter((planet) => planet.id !== 11) : planets;
  return kept.map((planet) => ({ name: planetName(planet.id), lon: planet.lon, speed: 0 }));
}

/**
 * ネイタル天体＋ASC/MC を、アスペクト探索用の点に均す。
 *
 * 速度を 0 で置くのは意図的 ―― ネイタルは「止まっている図」なので、接近／離反は
 * 動いているトランジット側だけで決まる。移植元の calc.js はネイタルの速度もそのまま
 * 渡していて、同じ速度の天体同士だと接近判定が常に false になる（実害の小さい癖）。
 *
 * excludeNodes の扱いは planetPointsOf と同じ（ASC/MC は常に入る）。
 */
export function aspectPointsOf(
  chart: {
    planets: readonly { id: number; lon: number }[];
    cusps: readonly number[];
    ascmc: readonly number[];
  },
  options: { excludeNodes?: boolean } = {},
): AspectPoint[] {
  const points = planetPointsOf(chart.planets, options);
  const angles = anglesOf(chart);
  points.push({ name: "ASC", lon: angles.asc, speed: 0 });
  points.push({ name: "MC", lon: angles.mc, speed: 0 });
  return points;
}

/**
 * 「a に指定したチャート … が見つかりませんでした」（どちら側の引数かを言い添える）。
 * 2 枚以上を突き合わせるツール（synastry / composite / pillars_relations）で共用。
 * key は引数名そのもの（"a" / "b" / "c" / "charts[0]" …）。
 */
export function missingPartyChart(key: string, chartId: string): ToolResult {
  return toolError(`${key} に指定した` + missingChartMessage(chartId));
}
