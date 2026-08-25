/**
 * リターン（lunar_return / solar_return）。astro-mcp.ts から切り出したもので、中身は移動しただけ。
 *
 * 月・太陽どちらの帰還も runReturn 1 本で、違うのは戻る天体・期間の指定の仕方・見出しだけ。
 */
import { toolError, type ToolResult } from "../../mcp";
import {
  AstroError,
  DEFAULT_NATAL_ORB,
  DEFAULT_ORB,
  anglesOf,
  computeChartFromJd,
  crossAspects,
  dateFromJulianDay,
  formatAngles,
  formatCrossAspect,
  formatCuspLine,
  formatDegree,
  formatNatalAspect,
  formatPlanetLines,
  getHouse,
  houseSystemName,
  julianDay,
  natalAspects,
  planetName,
  type AspectPoint,
  type ComputedChart,
  type PlanetPosition,
} from "../chart";
import {
  formatLocalMoment,
  formatOffsetLabel,
  formatUtcMoment,
  momentFromUtcDate,
  monthStartJd,
} from "../calendar";
import { aspectPointsOf, engineOf, type AstroContext, type AstroTool } from "../context";
import { missingChartMessage } from "../../phrases";
import { crossUt, crossingsInRange, type ReturnKind } from "../returns";
import { getChart, type StoredChart } from "../store";
import {
  argsOf,
  optionalInteger,
  optionalNumber,
  optionalString,
  requireString,
} from "../tool-args";

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

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** リターン 1 回ぶん（瞬間とその図） */
interface ReturnMoment {
  jd: number;
  date: Date;
  chart: ComputedChart;
  /** リターン図 → ネイタル（オーブ 1° 固定） */
  aspects: ReturnType<typeof crossAspects>;
  /** リターン図の中のアスペクト（10 天体＋ASC/MC。オーブは orb 引数） */
  chartAspects: ReturnType<typeof natalAspects>;
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
    return toolError(missingChartMessage(chartId));
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
  // リターン図の中のアスペクトだけのオーブ。ネイタルへのアスペクト（1°）には効かない
  const chartOrb = optionalNumber(args, "orb", 0.5, 10) ?? DEFAULT_NATAL_ORB;
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
      // リターン図自身の ASC/MC も点に入れる（ノードは相手にも入れない）
      chartAspects: natalAspects(aspectPointsOf(returnChart, { excludeNodes: true }), chartOrb),
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
    // 個人向けの読み（ネイタルへ）が先、リターン図そのものの背景が後
    lines.push(
      `□ リターン図の中のアスペクト（メジャー5種・オーブ ${chartOrb.toFixed(1)}°・10 天体＋ASC/MC、ノード除く）`,
    );
    if (moment.chartAspects.length === 0) {
      lines.push(
        `該当なし（オーブ ${chartOrb.toFixed(1)}° の範囲にメジャーアスペクトはありません）`,
      );
    } else {
      lines.push(...moment.chartAspects.map((hit) => formatNatalAspect(hit)));
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
      chart_aspects: moment.chartAspects,
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

export const lunarReturnTool: AstroTool = {
  definition: {
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
      "(4) ネイタルの天体・ASC / MC とのアスペクト（メジャー5種・オーブ 1°）、" +
      "(5) **リターン図の中のアスペクト**（リターン図の 10 天体＋ASC / MC の総当たり。" +
      "メジャー5種、既定オーブ 5°＝orb で変えられる。ノードは除く）。\n" +
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
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "リターン図の中のアスペクトのオーブ（度）。省略すると 5°" +
            "（1 枚の図の中は広めに取るのが通例）。" +
            "**ネイタルへのアスペクト（オーブ 1°）には効かない**",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: (rawArguments, context) => runReturn("moon", rawArguments, context),
};

export const solarReturnTool: AstroTool = {
  definition: {
    name: "solar_return",
    title: "ソーラーリターン（太陽の帰還）",
    description:
      "登録済みチャートの**ネイタルの太陽**と同じ黄経に、空の太陽が戻ってくる瞬間（ソーラーリターン）を求め、" +
      "その瞬間のホロスコープ一式を返す。年に1回、誕生日の前後1日ほどの範囲でめぐってくる。\n" +
      "year を指定するとその年の1回を返す（その年の1月1日から探す）。省略すると" +
      "**現在時刻から見て次の1回**。\n" +
      "返るものは lunar_return と同じ形——リターンの瞬間、リターン図の11天体（在ハウスはリターン図自身のカスプ）、" +
      "ASC / MC とハウスカスプ、ネイタルとのアスペクト（メジャー5種・オーブ 1°）、" +
      "**リターン図の中のアスペクト**（リターン図の 10 天体＋ASC / MC の総当たり。" +
      "メジャー5種、既定オーブ 5°＝orb で変えられる。ノードは除く）。\n" +
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
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "リターン図の中のアスペクトのオーブ（度）。省略すると 5°" +
            "（1 枚の図の中は広めに取るのが通例）。" +
            "**ネイタルへのアスペクト（オーブ 1°）には効かない**",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: (rawArguments, context) => runReturn("sun", rawArguments, context),
};
