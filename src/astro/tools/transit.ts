/**
 * トランジット（transit / transit_events）。astro-mcp.ts から切り出したもので、中身は移動しただけ。
 *
 * 一点を見る顕微鏡が transit、期間を分単位で並べるのが transit_events。
 */
import { toolError, type ToolResult } from "../../mcp";
import {
  AstroError,
  DEFAULT_NATAL_ORB,
  DEFAULT_ORB,
  anglesOf,
  computePlanets,
  crossAspects,
  dateFromJulianDay,
  formatAngles,
  formatCrossAspect,
  formatDegree,
  formatNatalAspect,
  formatPlanetLines,
  getHouse,
  houseSystemName,
  julianDay,
  natalAspects,
  planetName,
  type AspectPoint,
  type PlanetPosition,
} from "../chart";
import {
  assertCalendarDay,
  formatLocalMoment,
  formatOffsetLabel,
  formatPlainMoment,
  formatUtcMoment,
  momentFromUtcDate,
  pad,
  parseStartDate,
  startOfLocalDay,
  utcDateFromLocal,
} from "../calendar";
import {
  aspectPointsOf,
  engineOf,
  planetPointsOf,
  type AstroContext,
  type AstroTool,
} from "../context";
import {
  BODY_SET_LABEL,
  MAX_DAYS,
  TICK_MINUTES,
  assertDaysInRange,
  formatEventsText,
  scanTransitEvents,
} from "../events";
import { getChart } from "../store";
import {
  argsOf,
  optionalInteger,
  optionalNumber,
  optionalString,
  requireBodySet,
  requireString,
} from "../tool-args";

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
  // 空の中のアスペクトだけのオーブ。ネイタルへのアスペクト（DEFAULT_ORB＝1°）には効かない
  const chartOrb = optionalNumber(args, "orb", 0.5, 10) ?? DEFAULT_NATAL_ORB;

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
    // Date も swe_julday も 2 月 31 日を黙って翌月へ繰り上げるので、その前に断る
    assertCalendarDay(year, month, day);
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
  // 空の中のアスペクト（トランジット天体同士）。transit は空側の ASC/MC を立てないので天体だけ
  const chartAspects = natalAspects(
    planetPointsOf(transitPlanets, { excludeNodes: true }),
    chartOrb,
  );

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
  lines.push("");

  // 個人向けの読み（ネイタルへ）が先、その日の空そのものの背景が後
  lines.push(
    `■ 空の中のアスペクト（トランジット天体同士・メジャー5種・オーブ ${chartOrb.toFixed(1)}°・ノード除く）`,
  );
  if (chartAspects.length === 0) {
    lines.push(`該当なし（オーブ ${chartOrb.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    lines.push(...chartAspects.map((hit) => formatNatalAspect(hit)));
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
      chart_aspects: chartAspects,
    },
  };
}

// ---------------------------------------------------------------------------
// 期間内のトランジットイベント（時刻つき）
// ---------------------------------------------------------------------------

/**
 * 数日〜1 か月ぶんのトランジットを**分単位の時刻つき**で並べる。
 *
 * 走査そのものは events.ts の純関数（疎サンプル＋3 次エルミート補間＋10 分刻み＋二分法）。
 * ここがやるのは「どの期間か」を決めることと、jd を**表示時差の時計**に直すことだけ。
 * 年間概要（1 日刻み）の隣に置く道具で、一点を見る顕微鏡は transit のまま。
 */
async function runTransitEvents(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
        "save_chart で登録してください。",
    );
  }

  const start = optionalString(args, "start", 12);
  const days = optionalInteger(args, "days", 1, MAX_DAYS.outer) ?? 7;
  const bodies = requireBodySet(args);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14) ?? 0;
  // 期間の上限は**天体計算より先に**弾く（走査側でも見ているが、ここで止めれば wasm にも触らない）
  assertDaysInRange(days, bodies);

  const swe = await engineOf(context);
  const startMoment =
    start === undefined
      ? momentFromUtcDate(startOfLocalDay(context.now ? context.now() : new Date(), utcOffset))
      : { ...parseStartDate(start), hour: 0, minute: 0, utcOffset };
  const startJd = julianDay(swe, startMoment);

  const scan = scanTransitEvents(swe, {
    startJd,
    days,
    bodies,
    natalPlanets: chart.planets,
    cusps: chart.cusps,
    angles: anglesOf(chart),
  });

  /** jd → 表示時差の時計で「MM-DD HH:mm」（年は見出しに出してあるので行では省く） */
  const when = (jd: number): string => {
    const shifted = new Date(dateFromJulianDay(jd).getTime() + utcOffset * 3_600_000);
    return (
      `${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
      `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
    );
  };
  const isoOf = (jd: number): string => dateFromJulianDay(jd).toISOString();

  const startDate = dateFromJulianDay(scan.startJd);
  const endDate = dateFromJulianDay(scan.endJd);
  const exacts = scan.windows.reduce((total, window) => total + window.exact.length, 0);

  const lines: string[] = [
    "トランジットイベント（時刻つき）",
    `チャート: ${chart.label}（${chartId}） / ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}）`,
    `期間: ${formatLocalMoment(startDate, utcOffset)} 〜 ${formatLocalMoment(endDate, utcOffset)}` +
      `（${days} 日、UTC では ${formatPlainMoment(startDate, 0)} 〜 ${formatPlainMoment(endDate, 0)}）`,
    `動く側: ${BODY_SET_LABEL[bodies]}、相手: ネイタル 10 天体（ノード除く）と ASC / MC、` +
      `メジャー5種・オーブ ${DEFAULT_ORB.toFixed(1)}°`,
    `時刻は ${formatOffsetLabel(utcOffset)}、分単位（細かさ ${TICK_MINUTES} 分刻み＋二分法）`,
    "",
    ...formatEventsText(scan, when),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "transit_events",
      chart_id: chartId,
      label: chart.label,
      house_system: chart.house_system,
      period: {
        start_utc: startDate.toISOString(),
        end_utc: endDate.toISOString(),
        start_local: formatPlainMoment(startDate, utcOffset),
        end_local: formatPlainMoment(endDate, utcOffset),
        days,
      },
      utc_offset: utcOffset,
      bodies,
      orb: DEFAULT_ORB,
      tick_minutes: TICK_MINUTES,
      windows: scan.windows.map((window) => ({
        transit: window.transit,
        transit_id: window.transitId,
        target: {
          kind: window.target.kind,
          name: window.target.name,
          id: window.target.id,
          house: window.target.house,
        },
        aspect: window.aspect,
        entering: window.entering === null ? null : isoOf(window.entering),
        exact: window.exact.map(isoOf),
        leaving: window.leaving === null ? null : isoOf(window.leaving),
        min_orb: window.minOrb,
        min_orb_at: isoOf(window.minOrbAt),
        applying_at_start: window.applyingAtStart,
        ...(window.clipped ? { clipped: window.clipped } : {}),
      })),
      stations: scan.stations.map((station) => ({
        transit: station.name,
        id: station.id,
        at: isoOf(station.jd),
        to: station.to,
        lon: station.lon,
        position: formatDegree(station.lon),
      })),
      ingresses: scan.ingresses.map((ingress) => ({
        transit: ingress.name,
        id: ingress.id,
        at: isoOf(ingress.jd),
        sign: ingress.sign,
        sign_index: ingress.signIndex,
        retrograde: ingress.retrograde,
      })),
      counts: {
        windows: scan.windows.length,
        exacts,
        stations: scan.stations.length,
        ingresses: scan.ingresses.length,
      },
      diagnostics: { ephemeris_calls: scan.ephemerisCalls },
    },
  };
}

export const transitTool: AstroTool = {
  definition: {
    name: "transit",
    title: "トランジットを見る",
    description:
      "登録済みのチャートに対して、指定時刻の天体（トランジット）を計算する。" +
      "返るのは (1) トランジット天体の星座・度数・逆行、(2) それがネイタルのカスプで見て" +
      "第何ハウスに入っているか、(3) ネイタル天体および ASC / MC とのアスペクト" +
      "（メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション、オーブ 1°）、" +
      "(4) **空の中のアスペクト**（トランジット天体同士。10 天体の総当たり、メジャー5種、" +
      "既定オーブ 5°＝orb で変えられる。ノードは除く）。\n" +
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
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "空の中のアスペクト（トランジット天体同士）のオーブ（度）。省略すると 5°" +
            "（1 枚の図の中は広めに取るのが通例）。" +
            "**ネイタルへのアスペクト（オーブ 1°）には効かない**",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runTransit,
};

export const transitEventsTool: AstroTool = {
  definition: {
    name: "transit_events",
    title: "期間内のトランジットイベント（時刻つき）",
    description:
      "登録済みチャートに対して、指定した期間（既定は今日から 7 日間）に起きるトランジットのイベントを" +
      "**時刻つき（分単位）**で時系列に並べる。返るのは (1) トランジット天体がネイタルの 10 天体（ノード除く）と " +
      "ASC / MC に作るメジャーアスペクト（合・セクスタイル・スクエア・トライン・オポジション、オーブ 1°）の" +
      "**入った時刻（entering）・ぴったりの時刻（exact）・外れた時刻（leaving）**と最小オーブ、" +
      "(2) 留（逆行の始まり・終わり）の時刻、(3) 星座イングレスの時刻。\n" +
      "bodies で動く側の天体を選ぶ: all＝太陽〜冥王星の 10 天体（最長 31 日）／no_moon＝月を除く（最長 93 日）／" +
      "outer＝木星〜冥王星（最長 366 日）。月は 1 か月に 60 本ほどアスペクトを作るので、長い期間は no_moon か outer で。\n" +
      'start は "YYYY-MM-DD"（utc_offset の暦でその日の 0 時から）。省略すると utc_offset の暦での今日。\n' +
      "1 年を日単位で俯瞰するなら yearly_overview、ある一瞬の配置を見るなら transit。" +
      "このツールは解釈をしない——出た時刻と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: { type: "string", description: "対象のチャート ID（list_charts で確認できる）" },
        start: {
          type: "string",
          pattern: "^-?\\d{1,5}-\\d{2}-\\d{2}$",
          description: '開始日 "YYYY-MM-DD"（utc_offset の暦。省略すると今日）',
        },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 366,
          description: "日数（省略すると 7。上限は bodies による: all 31 / no_moon 93 / outer 366）",
        },
        bodies: {
          type: "string",
          enum: ["all", "no_moon", "outer"],
          default: "all",
          description: "動く側の天体の組",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description: "暦と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runTransitEvents,
};
