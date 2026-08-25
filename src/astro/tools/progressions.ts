/**
 * 二次進行（progressions）。astro-mcp.ts から切り出したもので、中身は移動しただけ。
 *
 * ほかのツールと違って**出生の瞬間そのもの**が要る ―― 台帳に預かっている `birth` を使う。
 */
import { toolError, type ToolResult } from "../../mcp";
import {
  AstroError,
  DEFAULT_ORB,
  anglesOf,
  crossAspects,
  formatAngles,
  formatCrossAspect,
  formatCuspLine,
  formatDegree,
  formatPlanetLines,
  getHouse,
  houseSystemName,
  planetName,
  type AspectPoint,
  type MomentInput,
  type PlanetPosition,
} from "../chart";
import { assertCalendarDay, formatOffsetLabel, pad } from "../calendar";
import { aspectPointsOf, engineOf, type AstroContext, type AstroTool } from "../context";
import { MISSING_BIRTH_MESSAGE, missingChartMessage } from "../../phrases";
import { computeProgression, formatAge, formatArc } from "../returns";
import { getChart } from "../store";
import { argsOf, optionalInteger, optionalNumber, requireString } from "../tool-args";

// ---------------------------------------------------------------------------
// 二次進行
// ---------------------------------------------------------------------------

/**
 * 二次進行（一日一年法）。
 *
 * ほかのツールと違って**出生の瞬間そのもの**が要る ―― 計算済みの座標からは逆算できないため、
 * 台帳に預かっている出生データ（`birth`）を使う。出生データを持たない古い登録では使えないので、
 * その場合は値に触れずに「登録し直してください」とだけ返す。
 */
async function runProgressions(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(missingChartMessage(chartId));
  }
  const birth = chart.birth;
  if (!birth) {
    return toolError("このチャートには" + MISSING_BIRTH_MESSAGE);
  }
  const natalMoment: MomentInput = {
    year: birth.year,
    month: birth.month,
    day: birth.day,
    hour: birth.hour,
    minute: birth.minute,
    utcOffset: birth.utc_offset,
  };

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
  if (given === 3) {
    assertCalendarDay(year as number, month as number, day as number);
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
    natal: natalMoment,
    lat: birth.lat,
    lng: birth.lng,
    houseSystem: chart.house_system,
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
    `チャート: ${chart.label}（${chartId}）`,
    `対象日: ${dateLabel}${calendarNote} / ${formatAge(result.ageYears)}`,
    `ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}） / ソーラーアーク ${formatArc(result.solarArc)}`,
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
      // jd（＝出生の瞬間そのもの）は載せない。預かっている出生データは返事に出さないため
      chart_id: chartId,
      label: chart.label,
      target_date: dateLabel,
      is_today: isToday,
      age_years: result.ageYears,
      age_label: formatAge(result.ageYears),
      house_system: chart.house_system,
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

export const progressionsTool: AstroTool = {
  definition: {
    name: "progressions",
    title: "プログレッション（二次進行）",
    description:
      "二次進行（セカンダリー・プログレッション／一日一年法）を計算する。" +
      "出生の翌日の空を1歳、翌々日を2歳と読む技法で、進行天体・進行 ASC / MC と、" +
      "それらがネイタルに落とすアスペクト（メジャー5種・オーブ 1°）を返す。\n" +
      "chart_id で呼ぶ。**出生データ（日時・場所）を預かっているチャートが要る**——" +
      "二次進行は出生の瞬間そのものから毎回ネイタルを引き直すため。" +
      "出生データを保存しない時代に登録されたチャートでは使えないので、その旨だけを返す" +
      "（delete_chart して save_chart で登録し直せば使える）。\n" +
      "year / month / day を省略すると今日で計算する。返却テキストに出生日時・出生地そのものは出さない。\n" +
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
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runProgressions,
};
