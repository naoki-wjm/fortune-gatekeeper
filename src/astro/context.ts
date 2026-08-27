/**
 * 占星術層のツールが共通で使う土台（astro-mcp.ts から切り出した共通部品）。
 *
 * ツール 1 本の形（定義＋実装）と、呼び出しの文脈（AstroContext）、
 * そして 2 科以上で使い回している小さな道具だけを置く。中身は移動しただけ。
 */
import { toolError, type ToolResult } from "../mcp";
import { anglesOf, planetName, type AspectPoint, type SwissEph } from "./chart";
import { EngineInitError } from "../internal-error";
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
 * 台帳のチャートのうち、**表に出してよいものだけ**を並べた形。
 * StoredChart から `birth`（預かっている出生データ）を抜いたものと今は同じ中身だが、
 * 「抜いたもの」ではなく「載せるものの一覧」として別に書いてある（下の publicChart の注記）。
 */
export interface PublicChart {
  label: string;
  house_system: string;
  planets: { id: number; lon: number; speed: number }[];
  cusps: number[];
  ascmc: number[];
  created: string;
  /** リターン・トランジット用の「いつもの場所」（本人が預けたときだけ） */
  default_location?: { lat: number; lng: number; label?: string };
}

/**
 * 台帳のチャートから、表に出してよい部分だけを取り出す。
 *
 * structuredContent に `...stored` を撒くところは必ずこれを通すこと。
 * **出生データは返事に出さない**が約束で、呼び出し側は登録時に自分で渡しているので
 * 読み戻す必要もない。
 *
 * ⚠ **落とす方式ではなく載せるものを列挙する方式**（2026-08-27 査読対応）。
 * もとは `birth` だけを分割代入で外す書き方だった ―― それだと、将来 StoredChart に
 * 表に出してはいけないものを足した日に、**ここを直し忘れるとそのまま表に出る**。
 * 列挙する方式なら、足したものは明示的にここへ書くまで出ない（黙って漏れる側に倒れない）。
 * 配列と入れ子も写し直す＝台帳のオブジェクトを共有しないので、返り値をいじっても台帳に響かない。
 */
export function publicChart(chart: StoredChart): PublicChart {
  const view: PublicChart = {
    label: chart.label,
    house_system: chart.house_system,
    planets: chart.planets.map((planet) => ({
      id: planet.id,
      lon: planet.lon,
      speed: planet.speed,
    })),
    cusps: [...chart.cusps],
    ascmc: [...chart.ascmc],
    created: chart.created,
  };
  if (chart.default_location) {
    const place: NonNullable<PublicChart["default_location"]> = {
      lat: chart.default_location.lat,
      lng: chart.default_location.lng,
    };
    if (chart.default_location.label !== undefined) place.label = chart.default_location.label;
    view.default_location = place;
  }
  return view;
}

export async function engineOf(context: AstroContext): Promise<SwissEph> {
  try {
    return await context.getEngine();
  } catch {
    // 詳細（wasm の言い分）は表にもログにも出さない ―― 固定文にするのは入口の catch の仕事
    throw new EngineInitError();
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
