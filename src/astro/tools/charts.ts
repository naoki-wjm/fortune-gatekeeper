/**
 * チャートの台帳まわり（save_chart / list_charts / get_chart / delete_chart /
 * update_default_location）。astro-mcp.ts から切り出したもので、中身は移動しただけ。
 *
 * 出生データ（`birth`）を預かるのはここ ―― どの返事にも出さない約束は publicChart が守る。
 */
import { toolError, type ToolResult } from "../../mcp";
import {
  AstroError,
  DEFAULT_NATAL_ORB,
  HOUSE_SYSTEM_CODES,
  anglesOf,
  computeChart,
  formatAngles,
  formatCuspLine,
  formatDegree,
  formatNatalAspect,
  formatPlanetLines,
  getHouse,
  houseSystemName,
  natalAspects,
  planetName,
  type MomentInput,
  type PlanetPosition,
} from "../chart";
import { assertCalendarDay } from "../calendar";
import {
  aspectPointsOf,
  engineOf,
  publicChart,
  type AstroContext,
  type AstroTool,
} from "../context";
import { missingChartMessage } from "../phrases";
import {
  createChart,
  deleteChart,
  getChart,
  listCharts,
  putChart,
  type StoredChart,
} from "../store";
import {
  argsOf,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireHouseSystem,
  requireInteger,
  requireNumber,
  requireString,
} from "../tool-args";

const HOUSE_SYSTEM_DESCRIPTION =
  "ハウス方式（既定 P）。P=プラシーダス / K=コッホ / W=ホールサイン / E=イコール。" +
  "出生時刻がはっきりしない場合はホールサイン（W）が無難。";

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
  assertCalendarDay(moment.year, moment.month, moment.day);
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
    // 出生データはこの台帳が預かる（返事には出さない。publicChart で落としてから返す）
    birth: {
      year: moment.year,
      month: moment.month,
      day: moment.day,
      hour: moment.hour,
      minute: moment.minute,
      utc_offset: moment.utcOffset,
      lat,
      lng,
    },
    created: new Date().toISOString(),
  };
  if (defaultLat !== undefined && defaultLng !== undefined) {
    stored.default_location = { lat: defaultLat, lng: defaultLng };
    if (defaultLabel) stored.default_location.label = defaultLabel;
  }

  // ID は空きを確かめてから発行する（衝突すると他人の図・自分の古い図を黙って上書きしてしまう）
  const chartId = await createChart(context.kv, context.auth.user, stored);

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
  lines.push(
    "出生データ（日時・時差・緯度経度）はこのチャートに預かりました。返事には出しません。delete_chart で消えます。",
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { chart_id: chartId, ...publicChart(stored) },
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
            "出生データは計算済みの座標と一緒にこの鍵の台帳に預かります" +
            "（鍵を持つ人だけが使え、返事には出さず、delete_chart で消えます）。",
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
    // 値そのものは出さず、あるかないかだけ（無ければ progressions などが使えない）
    parts.push(
      chart.has_birth
        ? "出生データ: あり"
        : "出生データ: なし（登録し直すと progressions などが使えます）",
    );
    parts.push(`登録 ${chart.created}`);
    lines.push(parts.join(" / "));
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { charts },
  };
}

/**
 * 保存済みチャートの読み直し。
 *
 * 天体計算はしない ―― KV に入っている座標をそのまま整形するだけなので wasm を呼ばない
 * （engineOf も通らない）。save_chart の返り値では見えないもの、すなわち
 * **出生図の中のアスペクト**を足すのがこのツールの持ち場。
 */
async function runGetChart(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(missingChartMessage(chartId));
  }

  const orb = optionalNumber(args, "orb", 0.5, 10) ?? DEFAULT_NATAL_ORB;
  // ノードはアスペクトの相手にも入れない（位置は下の天体一覧に出る）
  const aspects = natalAspects(aspectPointsOf(chart, { excludeNodes: true }), orb);

  const angles = anglesOf(chart);
  const lines: string[] = [
    "出生図（ネイタル）",
    `チャート: ${chart.label}（${chartId}） / ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}） / 登録 ${chart.created}`,
  ];
  if (chart.default_location) {
    const place = chart.default_location;
    const name = place.label ? `${place.label}（${place.lat}, ${place.lng}）` : `${place.lat}, ${place.lng}`;
    lines.push(`いつもの場所: ${name}`);
  }
  lines.push("");

  lines.push("■ ネイタル天体（カッコ内は在ハウス）");
  lines.push(...formatPlanetLines(chart.planets, chart.cusps));
  lines.push(formatAngles(angles));
  lines.push("");

  lines.push("■ ハウスカスプ");
  lines.push(formatCuspLine(chart.cusps));
  lines.push("");

  lines.push(
    `■ ネイタル内アスペクト（メジャー5種・オーブ ${orb.toFixed(1)}°・10 天体＋ASC/MC、ノード除く）`,
  );
  if (aspects.length === 0) {
    lines.push(`該当なし（オーブ ${orb.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    lines.push(...aspects.map((hit) => formatNatalAspect(hit)));
  }

  const structuredPlanets = chart.planets.map((planet: PlanetPosition) => ({
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
      created: chart.created,
      ...(chart.default_location ? { default_location: chart.default_location } : {}),
      planets: structuredPlanets,
      angles,
      // 保存形は [0] がダミーなので、返すのは 1..12 の 12 要素だけ
      cusps: chart.cusps.slice(1, 13),
      orb,
      natal_aspects: aspects,
    },
  };
}

async function runDeleteChart(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const existing = await getChart(context.kv, context.auth.user, chartId);
  const removed = existing ? await deleteChart(context.kv, context.auth.user, chartId) : false;
  if (!removed || !existing) {
    // 消そうとして無かった人に save_chart を勧めるのは筋違いなので、ここだけ短い断りにする
    return toolError(`チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめてください。`);
  }

  // 出生データを預かっていた図だけ、それも消えたと言い添える（無かった図に言うと嘘になる）
  const removedBirth = existing.birth !== undefined;
  const text =
    `チャート ${chartId}（${existing.label}）を削除しました。` +
    (removedBirth ? "預かっていた出生データも一緒に消えました。" : "");

  return {
    content: [{ type: "text", text }],
    structuredContent: { chart_id: chartId, deleted: true, birth_removed: removedBirth },
  };
}

/**
 * 「いつもの場所」だけの差し替え。
 *
 * 出生地とは別の覚え書きなので、出生データにも計算済みの座標（planets / cusps / ascmc）にも
 * label / house_system / created にも触らず、default_location だけを置き換える（または消す）。
 * 再計算も要らない。
 */
async function runUpdateDefaultLocation(
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(missingChartMessage(chartId));
  }

  const clear = optionalBoolean(args, "clear") ?? false;
  const lat = optionalNumber(args, "lat", -90, 90);
  const lng = optionalNumber(args, "lng", -180, 180);
  const label = optionalString(args, "location_label", 40);

  if (clear) {
    if (lat !== undefined || lng !== undefined || label !== undefined) {
      throw new AstroError(
        "clear と場所の指定は同時にできません" +
          "（消すなら clear: true だけ、差し替えるなら lat / lng を指定してください）",
      );
    }
    delete chart.default_location;
  } else {
    if ((lat === undefined) !== (lng === undefined)) {
      throw new AstroError("lat と lng は両方そろえて指定してください");
    }
    if (lat === undefined || lng === undefined) {
      throw new AstroError(
        "新しい「いつもの場所」を lat / lng で指定してください" +
          "（登録を消したいときは clear: true）",
      );
    }
    const place: { lat: number; lng: number; label?: string } = { lat, lng };
    if (label) place.label = label;
    chart.default_location = place;
  }

  await putChart(context.kv, context.auth.user, chartId, chart);

  const place = chart.default_location;
  const lines = [`チャート ${chartId}（${chart.label}）の「いつもの場所」を更新しました。`];
  if (place) {
    const name = place.label ? `${place.label} ` : "";
    lines.push(`いつもの場所: ${name}緯度 ${place.lat} / 経度 ${place.lng}`);
  } else {
    lines.push("いつもの場所: 未設定（リターンは呼び出し時に場所を指定してください）");
  }
  lines.push("保存済みの計算結果（天体・カスプ・ASC/MC）はそのままです。");

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { chart_id: chartId, default_location: place ?? null },
  };
}

export const saveChartTool: AstroTool = {
  definition: {
    name: "save_chart",
    title: "出生図を登録する",
    description:
      "出生データからネイタルチャート（出生図）を計算し、chart_id を付けて保存する。" +
      "以後は chart_id だけでトランジットなどを引ける。\n" +
      "保存されるのは計算結果の座標（天体の黄経と速度・ハウスカスプ・ASC/MC・ラベル・ハウス方式）と、" +
      "**渡された出生データそのもの**（年月日・時刻・時差・緯度経度）。" +
      "出生データは誕生日から引く占術と progressions のために預かるもので、" +
      "この鍵の台帳にだけ入り、**どのツールの返事にも出さない**（delete_chart で消える）。\n" +
      "ハウス方式を変えて計算し直したいときは、delete_chart で消してからもう一度このツールを呼ぶ" +
      "（同じ chart_id への上書き登録は無い）。\n" +
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
  run: runSaveChart,
};

export const listChartsTool: AstroTool = {
  definition: {
    name: "list_charts",
    title: "登録済みチャートの一覧",
    description:
      "この URL に登録されているチャートの一覧を返す（chart_id・ラベル・ハウス方式・" +
      "「いつもの場所」・出生データを預かっているか・登録日時）。" +
      "transit を呼ぶ前に chart_id を確かめたいときに使う。" +
      "出生データは「あり / なし」だけを返し、値そのものは出さない。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: (_rawArguments, context) => runListCharts(context),
};

export const getChartTool: AstroTool = {
  definition: {
    name: "get_chart",
    title: "出生図を読み直す",
    description:
      "save_chart で登録したネイタルチャート（出生図）を chart_id から読み直す。" +
      "返るのは (1) ネイタル天体の星座・度数・逆行と在ハウス、(2) ASC / MC とハウスカスプ、" +
      "(3) **出生図の中のアスペクト**（ネイタル内アスペクト。10 天体＋ASC / MC の総当たり、" +
      "メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション）。\n" +
      "保存済みの座標を読むだけで計算し直さないので、ハウス方式を変えたいときは " +
      "delete_chart してから save_chart で登録し直すこと。" +
      "預かっている出生データはここには出さない（値を読み戻す口は無い）。\n" +
      "ネイタルの読み直し・出生図そのものを話題にするときはこれ（transit は「今の空」用）。\n" +
      "このツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "ネイタル内アスペクトのオーブ（度）。省略すると 5°" +
            "（出生図は広めに取るのが通例。トランジットの 1° とは別）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runGetChart,
};

export const deleteChartTool: AstroTool = {
  definition: {
    name: "delete_chart",
    title: "登録済みチャートを消す",
    description:
      "chart_id を指定して登録を取り消す。計算済みの座標も、預かっている出生データも" +
      "一緒に消える（戻せないので、必要ならもう一度 save_chart で登録し直すこと）。",
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
  run: runDeleteChart,
};

export const updateDefaultLocationTool: AstroTool = {
  definition: {
    name: "update_default_location",
    title: "いつもの場所を差し替える",
    description:
      "登録済みチャートの「いつもの場所」（リターン計算で使う土地）だけを差し替える。" +
      "**出生データの再入力は不要で、保存済みの計算結果（天体・カスプ・ASC/MC）には一切触れない**——" +
      "「いつもの場所」は出生データとは無関係の覚え書きなので、差し替えても図は変わらない。\n" +
      "引っ越したとき、あるいはリターンをこれから別の土地で立てたくなったときに使う。" +
      "lat と lng は両方そろえて指定すること。\n" +
      "clear: true にすると「いつもの場所」を削除する" +
      "（以後、lunar_return / solar_return は呼び出しのたびに lat / lng の指定が必要になる）。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        lat: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "新しい「いつもの場所」の緯度（北緯が正。lng とそろえて指定）",
        },
        lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "新しい「いつもの場所」の経度（東経が正。lat とそろえて指定）",
        },
        location_label: {
          type: "string",
          description: "その場所の呼び名（任意。例: 東京）",
        },
        clear: {
          type: "boolean",
          default: false,
          description:
            "true にすると「いつもの場所」を削除する（lat / lng と同時には指定できない）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  run: runUpdateDefaultLocation,
};
