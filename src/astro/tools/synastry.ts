/**
 * 2 枚を突き合わせる読み（synastry / composite）。
 * astro-mcp.ts から切り出したもので、中身は移動しただけ。
 *
 * synastry は「2 枚の間に線を引く」、composite は「2 枚から 1 枚を作る」＝見ているものが違う。
 */
import { toolError, type ToolResult } from "../../mcp";
import {
  DEFAULT_NATAL_ORB,
  anglesOf,
  formatAngles,
  formatCuspLine,
  formatDegree,
  formatHouseOverlay,
  formatNatalAspect,
  formatPairAspect,
  formatSynastryAspect,
  getHouse,
  houseOverlay,
  houseSystemName,
  julianDay,
  natalAspects,
  planetName,
  synastryAspects,
  type MomentInput,
  type SwissEph,
} from "../chart";
import {
  buildComposite,
  compositeConventions,
  formatCompositeConventions,
  formatCompositePlanetLines,
  type CompositeChart,
  type CompositeSide,
} from "../composite";
import {
  aspectPointsOf,
  engineOf,
  missingPartyChart,
  type AstroContext,
  type AstroTool,
} from "../context";
import { getChart, type StoredChart } from "../store";
import { argsOf, optionalNumber, optionalString, requireString } from "../tool-args";

// ---------------------------------------------------------------------------
// シナストリー（2 枚の出生図の間）
// ---------------------------------------------------------------------------

/** シナストリーの末尾に置く 1 行（解釈はサーバーの仕事ではない） */
const SYNASTRY_NO_READING_NOTE =
  "（相性の良し悪しも組み合わせの意味もこのサーバーに載っていません。読みはあなた自身の知識で）";

/**
 * シナストリー（2 枚の出生図の間のアスペクトと在ハウス）。
 *
 * 天体計算はしない ―― 2 枚とも KV に入っている座標を突き合わせるだけ（get_chart と同じで
 * engineOf も通らない）。どちらも止まった図なので接近・離反は持たない。
 *
 * 出生データは返事に出さない。ここは publicChart すら撒かず、**天体の黄経も載せない**
 * ―― 出すのはアスペクトと在ハウスの派生値だけで、位置は get_chart の持ち場（返事も短く済む）。
 */
async function runSynastry(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const idA = requireString(args, "a", 32);
  const idB = requireString(args, "b", 32);
  if (idA === idB) {
    return toolError(
      "同じチャート同士です。出生図の中のアスペクトは get_chart で見てください" +
        "（synastry は別々の 2 枚を突き合わせるツールです）。",
    );
  }

  // どちらも「呼び出した人の台帳」しか引かない＝他人のチャートは存在ごと見えない
  const chartA = await getChart(context.kv, context.auth.user, idA);
  if (!chartA) return missingPartyChart("a", idA);
  const chartB = await getChart(context.kv, context.auth.user, idB);
  if (!chartB) return missingPartyChart("b", idB);

  const orb = optionalNumber(args, "orb", 0.5, 10) ?? DEFAULT_NATAL_ORB;
  // ノードはアスペクトの相手にも入れない（在ハウスの一覧には出る）
  const aspects = synastryAspects(
    aspectPointsOf(chartA, { excludeNodes: true }),
    aspectPointsOf(chartB, { excludeNodes: true }),
    orb,
  );
  const aInB = houseOverlay(chartA.planets, chartB.cusps);
  const bInA = houseOverlay(chartB.planets, chartA.cusps);

  const nameOf = (chart: StoredChart, chartId: string): string =>
    chart.label ? `${chart.label}（${chartId}）` : chartId;
  const systemOf = (chart: StoredChart): string =>
    `${houseSystemName(chart.house_system)}（${chart.house_system}）`;

  const lines: string[] = [
    "シナストリー",
    `A: ${nameOf(chartA, idA)} / B: ${nameOf(chartB, idB)}`,
    `ハウス方式: A ${systemOf(chartA)} / B ${systemOf(chartB)}`,
  ];
  if (chartA.house_system !== chartB.house_system) {
    // 在ハウスは「相手の図の方式のカスプ」で数えている＝2 枚で物差しが違うことを言い添える
    lines.push(
      "※ 2 枚でハウス方式が違います（在ハウスはそれぞれ相手の図の方式のカスプで数えています）。",
    );
  }
  lines.push("");

  lines.push(
    `■ 2 枚の間のアスペクト（メジャー5種・オーブ ${orb.toFixed(1)}°・10 天体＋ASC/MC の総当たり、ノード除く）`,
  );
  if (aspects.length === 0) {
    lines.push(`該当なし（オーブ ${orb.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    lines.push(...aspects.map((hit) => formatSynastryAspect(hit)));
  }
  lines.push("");

  lines.push("■ A の天体が B のハウスで（ノード込みの 11 天体）");
  lines.push(formatHouseOverlay(aInB));
  lines.push("");

  lines.push("■ B の天体が A のハウスで（同上）");
  lines.push(formatHouseOverlay(bInA));
  lines.push("");

  lines.push(SYNASTRY_NO_READING_NOTE);

  const describe = (chart: StoredChart, chartId: string) => ({
    chart_id: chartId,
    label: chart.label,
    house_system: chart.house_system,
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "synastry",
      a: describe(chartA, idA),
      b: describe(chartB, idB),
      orb,
      aspects,
      overlays: { a_in_b: aInB, b_in_a: bInA },
    },
  };
}

// ---------------------------------------------------------------------------
// コンポジット（中点図）
// ---------------------------------------------------------------------------

/** コンポジットの末尾に置く 1 行（解釈はサーバーの仕事ではない） */
const COMPOSITE_NO_READING_NOTE =
  "（相性の良し悪しも組み合わせの意味もこのサーバーに載っていません。読みはあなた自身の知識で）";

/** 中点図のハウスは参考程度、という通説（サーバーの言い分ではなく前提の共有） */
const COMPOSITE_HOUSE_CAVEAT =
  "※ 中点図には「立てた場所と時刻」がありません。ASC とカスプは中点 MC と 2 人の緯度から作った" +
  "仮のもので、**ハウスは参考程度**というのが通説です（芯にあるのは天体どうしのアスペクト）。";

/** 簡易方式に落ちたときの言い添え（出生データを預かっていない古い登録が混ざったとき） */
const COMPOSITE_FALLBACK_NOTE =
  "※ 出生データを預かっていないチャートが混ざっているため、ASC は 2 枚の ASC の中点・" +
  "カスプは ASC から 30° 等分の**簡易方式**で立てています" +
  "（delete_chart で消して save_chart で登録し直すと、中点 MC から立て直す既定の方式になります）。" +
  "この方式では MC が 10 カスプと一致しません。";

/**
 * 台帳のチャート 1 枚を中点図の材料に均す（出生データは jd と緯度だけ取り出してすぐ捨てる）。
 * swe が null なのは簡易方式に落ちるときだけで、そのときは jd を作る必要もない。
 */
function compositeSideOf(swe: SwissEph | null, chart: StoredChart): CompositeSide {
  const side: CompositeSide = {
    planets: chart.planets,
    cusps: chart.cusps,
    ascmc: chart.ascmc,
    houseSystem: chart.house_system,
  };
  const birth = chart.birth;
  if (swe && birth) {
    const moment: MomentInput = {
      year: birth.year,
      month: birth.month,
      day: birth.day,
      hour: birth.hour,
      minute: birth.minute,
      utcOffset: birth.utc_offset,
    };
    side.birth = { jd: julianDay(swe, moment), lat: birth.lat };
  }
  return side;
}

/**
 * コンポジット（中点図）。
 *
 * 中点法 ―― A と B の同じ天体どうしの中点を取る（ダヴィソンではない）。
 * 天体そのものは計算し直さず、台帳に入っている座標の中点を取るだけ。
 * wasm を触るのは ASC / カスプを立てる 1 か所だけで、それも 2 枚とも出生データを
 * 預かっているときの話（簡易方式に落ちるときはエンジンにすら触らない）。
 *
 * 出生データは返事に出さない。中点の座標（派生値）は出すが、**A / B それぞれの黄経**も
 * **緯度（中間緯度を含む）**も出さない ―― 片方が分かると復元できてしまうため。
 */
async function runComposite(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const idA = requireString(args, "a", 32);
  const idB = requireString(args, "b", 32);
  const idC = optionalString(args, "c", 32);
  if (idA === idB) {
    return toolError(
      "同じチャート同士です。中点図は別々の 2 枚から組み立てます" +
        "（1 枚の図そのものは get_chart で見てください）。",
    );
  }

  // どれも「呼び出した人の台帳」しか引かない＝他人のチャートは存在ごと見えない
  const chartA = await getChart(context.kv, context.auth.user, idA);
  if (!chartA) return missingPartyChart("a", idA);
  const chartB = await getChart(context.kv, context.auth.user, idB);
  if (!chartB) return missingPartyChart("b", idB);
  // c は a / b と同じ ID でもよい（本人と関係図の重なりを見る読み方があるため）
  const chartC = idC === undefined ? null : await getChart(context.kv, context.auth.user, idC);
  if (idC !== undefined && !chartC) return missingPartyChart("c", idC);

  const orb = optionalNumber(args, "orb", 0.5, 10) ?? DEFAULT_NATAL_ORB;

  // 簡易方式に落ちる図（出生データを預かっていない古い登録）ではエンジンを起こさない
  const needsEngine = chartA.birth !== undefined && chartB.birth !== undefined;
  const swe = needsEngine ? await engineOf(context) : null;
  const composite: CompositeChart = buildComposite(
    swe,
    compositeSideOf(swe, chartA),
    compositeSideOf(swe, chartB),
  );

  const angles = anglesOf(composite);
  // ノードは中点図に居ないので excludeNodes は要らないが、意図を明示して同じ札を立てておく
  const chartAspects = natalAspects(aspectPointsOf(composite, { excludeNodes: true }), orb);

  const nameOf = (chart: StoredChart, chartId: string): string =>
    chart.label ? `${chart.label}（${chartId}）` : chartId;
  const describe = (chart: StoredChart, chartId: string) => ({
    chart_id: chartId,
    label: chart.label,
    house_system: chart.house_system,
  });

  const lines: string[] = [
    "コンポジット（中点図）",
    `A: ${nameOf(chartA, idA)} / B: ${nameOf(chartB, idB)}`,
  ];
  if (chartC && idC !== undefined) lines.push(`C: ${nameOf(chartC, idC)}`);
  lines.push(
    `方式: 中点法（ダヴィソンではありません） / ハウス方式: ${houseSystemName(
      composite.houseSystem,
    )}（${composite.houseSystem}）`,
  );
  if (composite.ascMethod === "asc_midpoint_equal_houses") {
    lines.push(COMPOSITE_FALLBACK_NOTE);
  } else if (chartA.house_system !== chartB.house_system) {
    // 2 枚で方式が違うときだけ「なぜ P なのか」を言い添える
    lines.push(
      "※ 2 枚でハウス方式が違うので、中点図はプラシーダス（P）で立てています" +
        "（どちらか片方を採る理由が無いため）。",
    );
  }
  lines.push("");

  lines.push("■ 中点図の天体（カッコ内は在ハウス・10 天体／ノードは扱いません）");
  lines.push(...formatCompositePlanetLines(composite.planets, composite.cusps));
  lines.push(formatAngles(angles));
  lines.push("");

  lines.push("■ ハウスカスプ");
  lines.push(formatCuspLine(composite.cusps));
  lines.push("");

  lines.push(
    `■ 中点図の中のアスペクト（メジャー5種・オーブ ${orb.toFixed(1)}°・10 天体＋ASC/MC）`,
  );
  if (chartAspects.length === 0) {
    lines.push(`該当なし（オーブ ${orb.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    lines.push(...chartAspects.map((hit) => formatNatalAspect(hit)));
  }
  lines.push("");

  let toC: {
    aspects: ReturnType<typeof synastryAspects>;
    overlays: {
      composite_in_c: ReturnType<typeof houseOverlay>;
      c_in_composite: ReturnType<typeof houseOverlay>;
    };
  } | null = null;
  if (chartC) {
    const crossAspectsToC = synastryAspects(
      aspectPointsOf(composite, { excludeNodes: true }),
      aspectPointsOf(chartC, { excludeNodes: true }),
      orb,
    );
    const compositeInC = houseOverlay(composite.planets, chartC.cusps);
    const cInComposite = houseOverlay(chartC.planets, composite.cusps);
    toC = {
      aspects: crossAspectsToC,
      overlays: { composite_in_c: compositeInC, c_in_composite: cInComposite },
    };

    lines.push(
      `■ 中点図と C のアスペクト（メジャー5種・オーブ ${orb.toFixed(
        1,
      )}°・10 天体＋ASC/MC の総当たり、ノード除く）`,
    );
    if (crossAspectsToC.length === 0) {
      lines.push(`該当なし（オーブ ${orb.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
    } else {
      lines.push(...crossAspectsToC.map((hit) => formatPairAspect(hit, "中.", "C.")));
    }
    lines.push("");

    lines.push("■ 中点図の天体が C のハウスで（10 天体）");
    lines.push(formatHouseOverlay(compositeInC));
    lines.push("");

    lines.push("■ C の天体が中点図のハウスで（ノード込みの 11 天体）");
    lines.push(formatHouseOverlay(cInComposite));
    lines.push("");
  }

  lines.push(formatCompositeConventions(composite));
  lines.push(COMPOSITE_HOUSE_CAVEAT);
  lines.push(COMPOSITE_NO_READING_NOTE);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "composite",
      method: "midpoint",
      a: describe(chartA, idA),
      b: describe(chartB, idB),
      ...(chartC && idC !== undefined ? { c: describe(chartC, idC) } : {}),
      house_system: composite.houseSystem,
      orb,
      planets: composite.planets.map((planet) => ({
        id: planet.id,
        name: planetName(planet.id),
        lon: planet.lon,
        position: formatDegree(planet.lon),
        house: getHouse(planet.lon, composite.cusps),
      })),
      angles,
      // 保存形と同じく [0] はダミーなので、返すのは 1..12 の 12 要素だけ
      cusps: composite.cusps.slice(1, 13),
      chart_aspects: chartAspects,
      ...(toC ? { to_c: toC } : {}),
      conventions: compositeConventions(composite),
    },
  };
}

export const synastryTool: AstroTool = {
  definition: {
    name: "synastry",
    title: "シナストリー（2 枚の出生図の間のアスペクトと在ハウス）",
    description:
      "登録済みの出生図 2 枚を突き合わせ、その間のアスペクト（シナストリー）と、" +
      "互いのハウスに相手の天体がどう入るか（ハウスオーバーレイ）を計算する。\n" +
      "a / b は**どちらも呼び出した人の台帳の chart_id**（list_charts で確認できる）。" +
      "相手のぶんも先に save_chart で登録しておけば、" +
      "**相手の出生データを会話に出さずに済む**（他人の台帳のチャートは見えない）。\n" +
      "返るのは (1) A の 10 天体＋ASC / MC と B の 10 天体＋ASC / MC の総当たりアスペクト" +
      "（メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション、既定オーブ 5°＝" +
      "orb で変えられる。ノードは除く）、(2) A の天体（ノード込みの 11 天体）が B のハウスの" +
      "どこに入るか、(3) その逆＝B の天体が A のハウスのどこに入るか。\n" +
      "どちらも止まった図なので接近・離反は付かない。天体の黄経そのものは返さないので、" +
      "位置が要るときは get_chart で 1 枚ずつ読むこと" +
      "（1 枚の図の中のアスペクトも get_chart の持ち場）。\n" +
      "このツールは解釈をしない——相性の良し悪しも組み合わせの意味もサーバーに載せていないので、" +
      "読みはあなた自身の知識で。\n" +
      "出生データそのものは返事に出さない（アスペクトと在ハウスの派生値だけを返す）。",
    inputSchema: {
      type: "object",
      properties: {
        a: {
          type: "string",
          description: "片方のチャート ID（list_charts で確認できる）",
        },
        b: {
          type: "string",
          description: "もう片方のチャート ID（a とは別の ID）",
        },
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "アスペクトのオーブ（度）。省略すると 5°" +
            "（止まった図同士は広めに取るのが通例。トランジットの 1° とは別）",
        },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runSynastry,
};

export const compositeTool: AstroTool = {
  definition: {
    name: "composite",
    title: "コンポジット（2 枚の中点図）",
    description:
      "登録済みの出生図 2 枚から**コンポジット（中点図）**を組み立てる。" +
      "2 人の関係そのものを 1 枚の図として見るときのもので、" +
      "synastry（2 枚の間のアスペクト）とは見ているものが違う。\n" +
      "採るのは**中点法**——A と B の同じ天体どうしの中点を取る方式で、" +
      "**ダヴィソン法ではない**（ダヴィソンは 2 人の出生時刻・出生地の中間で図を立て直す別物）。\n" +
      "a / b は**どちらも呼び出した人の台帳の chart_id**（list_charts で確認できる）。" +
      "c を足すと**三者読み**——A×B の関係図に第三者 C がどう関わるかを見る" +
      "（c は a / b と同じ ID でもよく、そのときは本人と関係図の重なりを見ることになる）。\n" +
      "返るのは (1) 中点図の 10 天体（太陽〜冥王星。ノードは扱わない）とサイン・度数、" +
      "(2) ASC / MC と 12 ハウスカスプ、(3) 中点図の中のアスペクト" +
      "（メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション、既定オーブ 5°＝orb で変えられる。" +
      "10 天体＋ASC/MC）、(4) c があれば中点図 × C の総当たりアスペクトと、" +
      "互いのハウスに相手の天体がどう入るか（ハウスオーバーレイ）。\n" +
      "**採った規約は名前で固定して返り値にも書く**（流派で割れるところなので）——" +
      "中点は短い方の弧の真ん中（ぴったり 180° のときだけ A から黄経が増える向きに 90°）/ " +
      "ASC とカスプは中点 MC を ARMC に直し、**2 人の出生緯度の平均**で立て直す" +
      "（黄道傾斜は 2 人の出生時刻の中間時点のもの）/ " +
      "ハウス方式は 2 枚が同じならそれ、違えばプラシーダス（P）/ " +
      "出生データを預かっていない古い登録が混ざっているときだけ簡易方式" +
      "（ASC も 2 枚の ASC の中点・カスプは 30° 等分）に落ちる。\n" +
      "⚠ **中点図のハウスは参考程度**、というのが通説（中点図には「立てた場所と時刻」が無く、" +
      "ASC とカスプは 2 人の緯度の平均から作った仮のもの）。天体と天体のアスペクトのほうが芯にある。\n" +
      "このツールは解釈をしない——相性の良し悪しも組み合わせの意味もサーバーに載せていないので、" +
      "読みはあなた自身の知識で。\n" +
      "出生データそのものは返事に出さない（中点の座標という派生値だけを返し、" +
      "A / B それぞれの天体の黄経も、出生地の緯度も中間緯度も出さない）。",
    inputSchema: {
      type: "object",
      properties: {
        a: {
          type: "string",
          description: "片方のチャート ID（list_charts で確認できる）",
        },
        b: {
          type: "string",
          description: "もう片方のチャート ID（a とは別の ID）",
        },
        c: {
          type: "string",
          description:
            "三者読みで足す第三者のチャート ID（任意）。" +
            "中点図 × C のアスペクトとハウスオーバーレイが増える（a / b と同じ ID でもよい）",
        },
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "アスペクトのオーブ（度）。省略すると 5°" +
            "（止まった図なので広めに取るのが通例。トランジットの 1° とは別）",
        },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runComposite,
};
