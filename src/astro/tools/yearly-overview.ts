/**
 * 年間概要（yearly_overview）。astro-mcp.ts から切り出したもので、中身は移動しただけ。
 *
 * 走査そのものは yearly.ts の純関数。ここは「どの 1 年か」を決めて日付に直すだけ。
 */
import { toolError, type ToolResult } from "../../mcp";
import {
  DEFAULT_ORB,
  anglesOf,
  dateFromJulianDay,
  formatDegree,
  houseSystemName,
  julianDay,
  planetName,
} from "../chart";
import {
  formatLocalMoment,
  formatOffsetLabel,
  formatUtcMoment,
  momentFromUtcDate,
  monthStartJd,
  pad,
} from "../calendar";
import { engineOf, type AstroContext, type AstroTool } from "../context";
import { crossUt } from "../returns";
import { getChart } from "../store";
import { argsOf, optionalInteger, optionalNumber, requireString } from "../tool-args";
import { formatYearlyText, scanYearlyRange } from "../yearly";

// ---------------------------------------------------------------------------
// 年間概要（ソーラーリターン年）
// ---------------------------------------------------------------------------

/**
 * ソーラーリターン年 1 年ぶんの天体イベント一覧。
 *
 * 走査そのものは yearly.ts の純関数（疎サンプル＋補間で Workers の CPU 予算に収めてある）。
 * ここがやるのは「どの 1 年か」を決めることと、jd を**表示時差の暦**の日付に直すことだけ。
 */
async function runYearlyOverview(
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

  const sun = chart.planets.find((planet) => planet.id === 0);
  if (!sun) {
    return toolError(
      `このチャートには${planetName(0)}の位置が入っていません。save_chart で登録し直してください。`,
    );
  }

  const year = optionalInteger(args, "year", -5000, 5000);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);
  const displayOffset = utcOffset ?? 0;

  const swe = await engineOf(context);
  const now = context.now ? context.now() : new Date();
  const nowJd = julianDay(swe, momentFromUtcDate(now));

  // year あり＝その年の 1 月 1 日から最初のリターン（solar_return と同じ起点）。
  // year 省略＝1 年前から探せば「現在を含むリターン年」の頭が取れる
  // （リターンの間隔は 365.24〜365.26 日なので、366 日前から数えた 1 回目は必ず現在以前に落ちる）
  const srJd =
    year === undefined
      ? crossUt(swe, "sun", sun.lon, nowJd - 366)
      : crossUt(swe, "sun", sun.lon, monthStartJd(swe, year, 1, displayOffset));
  const nextJd = crossUt(swe, "sun", sun.lon, srJd + 1);

  const scan = scanYearlyRange(swe, {
    startJd: srJd,
    endJd: nextJd,
    natalPlanets: chart.planets,
    cusps: chart.cusps,
    angles: anglesOf(chart),
  });

  /** jd → 表示時差の暦での Date（時刻は捨てて日付だけ使う） */
  const localDate = (jd: number): Date =>
    new Date(dateFromJulianDay(jd).getTime() + displayOffset * 3_600_000);
  const dateOf = (jd: number): string => {
    const shifted = localDate(jd);
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  };

  const startDate = dateFromJulianDay(srJd);
  const endDate = dateFromJulianDay(nextJd);
  const momentText = (date: Date): string => {
    const parts = [formatUtcMoment(date)];
    if (utcOffset !== undefined) parts.push(`ローカル ${formatLocalMoment(date, utcOffset)}`);
    return parts.join(" / ");
  };
  const calendarNote = utcOffset === undefined ? "UTC の暦" : `${formatOffsetLabel(utcOffset)} の暦`;
  const isCurrent = year === undefined;

  const lines: string[] = [
    "年間概要（ソーラーリターン年）",
    `チャート: ${chart.label}（${chartId}） / ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}）`,
    `ネイタルの${planetName(0)}: ${formatDegree(sun.lon)}`,
    `期間: ${momentText(startDate)} 〜 ${momentText(endDate)}（${scan.days} 日）`,
    `対象: ${
      isCurrent
        ? `現在（${formatUtcMoment(now)}）を含むソーラーリターン年`
        : `${year}年のソーラーリターンから 1 年`
    }`,
    `日付は ${calendarNote} で 1 日刻み。start は入った最初の日、end は外れた最初の日（Web 版の年間概要と同じ数え方）`,
    "対象天体: 逆行＝水星〜冥王星 / イングレス・トランジット＝木星〜冥王星 → " +
      `ネイタル 10 天体（ノード除く）と ASC / MC（メジャー5種・オーブ ${DEFAULT_ORB.toFixed(1)}°）`,
    "（t.＝トランジット / n.＝ネイタル）",
    "",
    ...formatYearlyText(scan, dateOf),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "yearly_overview",
      chart_id: chartId,
      label: chart.label,
      house_system: chart.house_system,
      period: {
        solar_return_year: localDate(srJd).getUTCFullYear(),
        start_utc: startDate.toISOString(),
        end_utc: endDate.toISOString(),
        start_jd: srJd,
        end_jd: nextJd,
        start_date: dateOf(srJd),
        end_date: dateOf(nextJd),
        days: scan.days,
        is_current: isCurrent,
      },
      utc_offset: displayOffset,
      orb: DEFAULT_ORB,
      resolution: "day",
      date_note:
        "start は条件を満たした最初の日、end は外れた最初の日（Web 版の年間概要と同じ数え方）",
      retrogrades: scan.retrogrades.map((period) => ({
        planet: period.planet,
        id: period.id,
        start: dateOf(period.startJd),
        end: dateOf(period.endJd),
        ...(period.clipped ? { clipped: period.clipped } : {}),
      })),
      ingresses: scan.ingresses.map((ingress) => ({
        planet: ingress.planet,
        id: ingress.id,
        date: dateOf(ingress.jd),
        sign: ingress.sign,
        sign_index: ingress.signIndex,
        retrograde: ingress.retrograde,
      })),
      angle_aspects: scan.angleAspects.map((window) => ({
        transit: window.transit,
        transit_id: window.transitId,
        angle: window.angle,
        aspect: window.aspect,
        start: dateOf(window.startJd),
        end: dateOf(window.endJd),
        exact: dateOf(window.exactJd),
        min_orb: window.minOrb,
        ...(window.clipped ? { clipped: window.clipped } : {}),
      })),
      natal_aspects: scan.natalAspects.map((window) => ({
        transit: window.transit,
        transit_id: window.transitId,
        natal: window.natal,
        natal_id: window.natalId,
        house: window.house,
        aspect: window.aspect,
        start: dateOf(window.startJd),
        end: dateOf(window.endJd),
        exact: dateOf(window.exactJd),
        min_orb: window.minOrb,
        ...(window.clipped ? { clipped: window.clipped } : {}),
      })),
      diagnostics: { ephemeris_calls: scan.ephemerisCalls },
    },
  };
}

export const yearlyOverviewTool: AstroTool = {
  definition: {
    name: "yearly_overview",
    title: "年間概要（ソーラーリターン年の天体イベント）",
    description:
      "登録済みチャートの**ソーラーリターンから次のソーラーリターンまでの 1 年**を 1 日刻みで走査し、" +
      "その年に起きる天体イベントを一覧にする。返るのは (1) 水星〜冥王星の逆行期間、" +
      "(2) 木星〜冥王星の星座イングレス（逆行で前の星座へ戻るものも含む）、" +
      "(3) 木星〜冥王星がネイタルの ASC / MC に作るメジャーアスペクトの期間、" +
      "(4) 同じくネイタルの 10 天体（ノードを除く）に作るメジャーアスペクトの期間" +
      "（メジャー5種・オーブ 1°、各期間には最接近の日も添える）。\n" +
      "year を指定するとその年のソーラーリターンから始まる 1 年。省略すると**現在を含むソーラーリターン年**" +
      "（直近のソーラーリターンから次のソーラーリターンまで）。\n" +
      "日付の解像度は 1 日。start はその状態に入った最初の日、end は外れた最初の日" +
      "（Web 版 Astro Tool の年間概要と同じ数え方）。utc_offset を渡すとその土地の暦で日付を出す。\n" +
      "速い天体（太陽・月・水星・金星・火星）のトランジットや時刻単位の精度が要るときは transit を使うこと。" +
      "このツールは解釈をしない——出た期間と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: { type: "string", description: "対象のチャート ID（list_charts で確認できる）" },
        year: {
          type: "integer",
          description:
            "ソーラーリターンの年（その年の 1 月 1 日以降に来るリターンから 1 年。省略すると現在を含むソーラーリターン年）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description: "日付に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runYearlyOverview,
};
