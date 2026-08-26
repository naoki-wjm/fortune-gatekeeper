/**
 * ネイタルに重ねた月の暦（natal_moon_calendar）。
 *
 * 公開層の `moon_calendar`（空の月の暦＝誰が呼んでも同じ答え）に、**登録済みチャートの上を
 * 月がどう通るか**を重ねた 1 枚。個人のチャートを引くので置き場はこちら（鍵つき層）で、
 * 空の暦の部分は公開層の計算をそのまま呼ぶ ―― 同じものを 2 通りに計算しない。
 *
 * 重ねるのは 3 つだけ:
 *
 *   - **ハウス入り** … 月がネイタルのカスプを跨ぐ瞬間。星座入りと同じ作法で
 *     `crossUt`（swe_mooncross_ut の検算つき）の一発計算。カスプは登録時のハウス方式のもの。
 *   - **ネイタルへの exact** … 月 × ネイタル 10 天体（ノードは入れない）＋ASC/MC の
 *     メジャー 5 種。**オーブは取らない**（暦なので「いつぴったりか」だけ）。
 *     相手は止まっているので、目標は「ネイタルの黄経 ± アスペクト角」という**動かない黄経**に
 *     なる ―― 公開層の月の格子（6 時間＋3 次エルミート補間）と同じ手順で跨ぎを拾い、
 *     二分法で分単位に詰める。
 *   - **個人朔望** … 月 × ネイタル太陽・ネイタル月の 0/90/180/270。空の朔望（月と空の太陽）の
 *     相手をネイタルに置き換えたもの。0 と 180 は上の合・衝と同じ瞬間になるが、
 *     **上弦／下弦は角度の向きがあって初めて言える**ので別枠に置いて重複を許す。
 *     `relative_to: natal_moon` の 0° はルナリターンそのもの（同じ瞬間になることを real テストで検算）。
 *
 * ⚠ 月の格子はこの科で**もう一度**取る（公開層の `scanMoonCalendar` は格子を返さないため）。
 *    62 日でも 6 時間おきに 250 回ほどの `swe_calc_ut` で、公開層の計算には 1 バイトも触らない。
 *
 * 出生データ（年月日時・時差・緯度経度）は返さない ―― 出すのはハウス入りとアスペクトの
 * 時刻・ハウス番号・星座と度数、つまり get_chart が既に返している座標から出る派生値だけ。
 * 解釈もしない（月がハウスに入ることの意味も、個人朔望の読み方も載せない）。
 */
import { toolError, type ToolResult } from "../../mcp";
import {
  ASPECTS,
  CALC_FLAGS,
  getHouse,
  houseSystemName,
  normalizeDegree,
  signIndex,
  type SwissEph,
} from "../chart";
import { positionAt, type BodySample } from "../events";
import { crossUt } from "../returns";
import { aspectPointsOf, engineOf, type AstroContext, type AstroTool } from "../context";
import {
  MOON_CALENDAR_DEFAULT_DAYS,
  MOON_CALENDAR_DEFAULT_UTC_OFFSET,
  MOON_CALENDAR_MAX_DAYS,
  MOON_CALENDAR_MIN_DAYS,
  MOON_STEP,
  VOC_BODY_SETS,
  buildMoonCalendar,
  degreeInSign,
  findCrossings,
  formatMoonCalendarText,
  formatMoonMoment,
  moonCalendarStartJd,
  parseMoonCalendarArguments,
  scanMoonCalendar,
  signNameOf,
  unwrapLongitudes,
} from "../../moon-calendar";
import {
  PRINCIPLE_CONVENTIONS_ARE_NAMED,
  PRINCIPLE_NO_SUMMING,
  READ_WITH_YOUR_OWN_KNOWLEDGE,
  missingChartMessage,
  noReadingNote,
} from "../../phrases";
import { getChart } from "../store";
import { argsOf, requireString } from "../tool-args";

// ---------------------------------------------------------------------------
// 台帳と定数
// ---------------------------------------------------------------------------

/** 月の id（SE_MOON） */
const MOON_ID = 1;

/** 格子を期間の前後に伸ばす袖（日）。findCrossings が端の外側も 1 目盛り見るので 1 日で足りる */
const GRID_MARGIN_DAYS = 1;

/**
 * 1 本のカスプを月が跨ぐ回数の上限（壊れたエンジンで無限に回らないための止め木）。
 * 月が同じ黄経に戻るのは 27.32 日おきなので、62 日なら最大 3 回。
 */
const MAX_HOUSE_CROSSINGS = 4;

/**
 * 月と相手の黄経差が取りうる「メジャーアスペクトの離角」8 通り
 * （60/90/120 は前後 2 か所ずつあるので、目標は 8 つ・アスペクトは 5 種）。
 * 表は持たず **chart.ts の ASPECTS から導く** ―― 採るアスペクトの正本は 1 か所だけにしておく。
 */
const ASPECT_OFFSETS: readonly { offset: number; aspect: (typeof ASPECTS)[number] }[] =
  ASPECTS.flatMap((aspect) =>
    aspect.angle === 0 || aspect.angle === 180
      ? [{ offset: aspect.angle, aspect }]
      : [
          { offset: aspect.angle, aspect },
          { offset: 360 - aspect.angle, aspect },
        ],
  );

/** 個人朔望の 4 相（月がネイタルの一点から見て何度離れたか） */
const PERSONAL_PHASE_TARGETS = [
  { angle: 0, kind: "new_moon_equivalent", label: "新月相当" },
  { angle: 90, kind: "first_quarter_equivalent", label: "上弦相当" },
  { angle: 180, kind: "full_moon_equivalent", label: "満月相当" },
  { angle: 270, kind: "last_quarter_equivalent", label: "下弦相当" },
] as const;

type PersonalPhaseKind = (typeof PERSONAL_PHASE_TARGETS)[number]["kind"];

/** 個人朔望の相手（ネイタルの太陽・月） */
const PERSONAL_PHASE_ANCHORS = [
  { id: 0, relativeTo: "natal_sun", label: "ネイタル太陽", short: "太陽" },
  { id: 1, relativeTo: "natal_moon", label: "ネイタル月", short: "月" },
] as const;

type PersonalPhaseAnchor = (typeof PERSONAL_PHASE_ANCHORS)[number]["relativeTo"];

// ---------------------------------------------------------------------------
// 返り値の形（個人層のぶんだけ。空の暦の部分は公開層の型そのまま）
// ---------------------------------------------------------------------------

export interface NatalHouseIngress {
  time: string;
  house: number;
  from_house: number;
}

export interface NatalMoonAspect {
  time: string;
  target: string;
  aspect: string;
  angle: number;
  moon_sign: string;
  moon_degree: number;
}

export interface PersonalPhase {
  kind: PersonalPhaseKind;
  relative_to: PersonalPhaseAnchor;
  time: string;
  moon_sign: string;
  moon_degree: number;
}

// ---------------------------------------------------------------------------
// 月の格子（公開層と同じ 6 時間刻み・3 次エルミート補間）
// ---------------------------------------------------------------------------

/**
 * 月だけの格子。相手（ネイタルの天体・カスプ）は**動かない**ので、
 * 公開層の `sampleGrids` と違って月 1 天体ぶんで足りる。
 */
function moonGrid(swe: SwissEph, gridStartJd: number, spanDays: number): BodySample {
  const sample: BodySample = { lon: [], speed: [] };
  // 最後の点が spanDays の先に出るように +2（補間には区間の右端が要る）
  const points = Math.floor(spanDays / MOON_STEP) + 2;
  for (let index = 0; index < points; index++) {
    const result = swe.swe_calc_ut(gridStartJd + index * MOON_STEP, MOON_ID, CALC_FLAGS);
    sample.lon.push(result[0] as number);
    sample.speed.push(result[3] as number);
  }
  unwrapLongitudes(sample.lon);
  return sample;
}

// ---------------------------------------------------------------------------
// ハウス入り・ネイタルへの exact・個人朔望
// ---------------------------------------------------------------------------

interface HouseIngressHit {
  jd: number;
  house: number;
}

/**
 * 月がネイタルのカスプを跨ぐ瞬間。
 *
 * カスプは黄経の順に並んでいるので、**カスプ i を跨いだら入るのは i ハウス**で、
 * 出てきたのは必ずその 1 つ前のハウス（月は順行しかしない）。
 */
function houseIngresses(
  swe: SwissEph,
  cusps: readonly number[],
  fromJd: number,
  toJd: number,
): HouseIngressHit[] {
  const hits: HouseIngressHit[] = [];
  for (let house = 1; house <= 12; house++) {
    const cusp = cusps[house];
    if (typeof cusp !== "number" || !Number.isFinite(cusp)) continue;
    let cursor = fromJd;
    for (let guard = 0; guard < MAX_HOUSE_CROSSINGS; guard++) {
      // 星座入りと同じ作法（壊れた wrapper の返り値は crossUt が検算する）
      const jd = crossUt(swe, "moon", normalizeDegree(cusp), cursor);
      if (jd >= toJd) break;
      hits.push({ jd, house });
      // 同じカスプに戻るのは 27.32 日後なので、+1 日から探し直せば同じ瞬間は拾い直さない
      cursor = jd + 1;
    }
  }
  hits.sort((left, right) => left.jd - right.jd);
  return hits;
}

interface AspectHit {
  jd: number;
  target: string;
  aspect: (typeof ASPECTS)[number];
  /** その瞬間の月の黄経＝「ネイタルの黄経 ± アスペクト角」そのもの（定義から出る値） */
  moonLon: number;
}

interface PersonalPhaseHit {
  jd: number;
  kind: PersonalPhaseKind;
  relativeTo: PersonalPhaseAnchor;
  label: string;
  anchorLabel: string;
  anchorShort: string;
  angle: number;
  moonLon: number;
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

interface TimelineLine {
  jd: number;
  /** 同じ時刻に並んだときの順番（ハウス入り → exact → 個人朔望） */
  rank: number;
  text: string;
}

function positionLabel(moonLon: number): string {
  return `${signNameOf(signIndex(moonLon))} ${degreeInSign(moonLon).toFixed(2)}°`;
}

// ---------------------------------------------------------------------------
// ツール本体
// ---------------------------------------------------------------------------

async function runNatalMoonCalendar(
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(missingChartMessage(chartId));
  }

  // 残りの引数は公開層と同じ検算器で（天体計算より先に全部弾く）
  const now = context.now ? context.now() : new Date();
  const request = parseMoonCalendarArguments(args, now);

  const swe = await engineOf(context);

  // ── 空の暦（公開層そのまま。計算を二重化しない） ──────────────────────────
  const startJd = moonCalendarStartJd(swe, request);
  const scan = scanMoonCalendar(swe, startJd, request.days, request.vocBodies);
  const sky = buildMoonCalendar(swe, scan, request);

  // ── 個人層 ────────────────────────────────────────────────────────────────
  const { windowStartJd, windowEndJd } = scan;
  const when = (jd: number): string => formatMoonMoment(jd, request.utcOffset);

  const gridStartJd = windowStartJd - GRID_MARGIN_DAYS;
  const grid = moonGrid(swe, gridStartJd, request.days + GRID_MARGIN_DAYS * 2);
  const moonLonAt = (jd: number): number => positionAt(grid, MOON_STEP, jd - gridStartJd).lon;

  const houseHits = houseIngresses(swe, chart.cusps, windowStartJd, windowEndJd);

  // 相手は 10 天体（ノードは入れない）＋ASC/MC。止まっているので目標は動かない黄経になる
  const aspectHits: AspectHit[] = [];
  for (const point of aspectPointsOf(chart, { excludeNodes: true })) {
    for (const { offset, aspect } of ASPECT_OFFSETS) {
      const targetLon = normalizeDegree(point.lon + offset);
      for (const jd of findCrossings(moonLonAt, targetLon, windowStartJd, windowEndJd)) {
        aspectHits.push({ jd, target: point.name, aspect, moonLon: targetLon });
      }
    }
  }
  aspectHits.sort((left, right) => left.jd - right.jd);

  const personalHits: PersonalPhaseHit[] = [];
  for (const anchor of PERSONAL_PHASE_ANCHORS) {
    const natal = chart.planets.find((planet) => planet.id === anchor.id);
    // 古い登録に天体が欠けていることがある（そのぶんは静かに落とす＝断る話ではない）
    if (!natal) continue;
    for (const phase of PERSONAL_PHASE_TARGETS) {
      const targetLon = normalizeDegree(natal.lon + phase.angle);
      for (const jd of findCrossings(moonLonAt, targetLon, windowStartJd, windowEndJd)) {
        personalHits.push({
          jd,
          kind: phase.kind,
          relativeTo: anchor.relativeTo,
          label: phase.label,
          anchorLabel: anchor.label,
          anchorShort: anchor.short,
          angle: phase.angle,
          moonLon: targetLon,
        });
      }
    }
  }
  personalHits.sort((left, right) => left.jd - right.jd);

  // ── 返り値の組み立て ──────────────────────────────────────────────────────
  const houseIngressList: NatalHouseIngress[] = houseHits.map((hit) => ({
    time: when(hit.jd),
    house: hit.house,
    from_house: hit.house === 1 ? 12 : hit.house - 1,
  }));

  const natalAspects: NatalMoonAspect[] = aspectHits.map((hit) => ({
    time: when(hit.jd),
    target: hit.target,
    aspect: hit.aspect.name,
    angle: hit.aspect.angle,
    moon_sign: signNameOf(signIndex(hit.moonLon)),
    moon_degree: degreeInSign(hit.moonLon),
  }));

  const personalPhases: PersonalPhase[] = personalHits.map((hit) => ({
    kind: hit.kind,
    relative_to: hit.relativeTo,
    time: when(hit.jd),
    moon_sign: signNameOf(signIndex(hit.moonLon)),
    moon_degree: degreeInSign(hit.moonLon),
  }));

  // ── テキスト（空の暦の後ろに個人層を時系列で足す） ────────────────────────
  const lines: TimelineLine[] = [];
  houseHits.forEach((hit, index) => {
    const entry = houseIngressList[index] as NatalHouseIngress;
    lines.push({
      jd: hit.jd,
      rank: 0,
      text: `${entry.time}  t.月 → n.${entry.house}H 入り（${entry.from_house}H → ${entry.house}H）`,
    });
  });
  aspectHits.forEach((hit, index) => {
    const entry = natalAspects[index] as NatalMoonAspect;
    lines.push({
      jd: hit.jd,
      rank: 1,
      text:
        `${entry.time}  t.月 ${hit.aspect.symbol} n.${entry.target}  ` +
        `exact（${positionLabel(hit.moonLon)}）`,
    });
  });
  personalHits.forEach((hit) => {
    // ネイタル月との合はルナリターンそのもの（lunar_return が返す瞬間と同じ）
    const note = hit.relativeTo === "natal_moon" && hit.angle === 0 ? "＝ルナリターン" : "";
    lines.push({
      jd: hit.jd,
      rank: 2,
      text:
        `${when(hit.jd)}  ［${hit.anchorLabel}の${hit.label}${note}］` +
        `t.月 − n.${hit.anchorShort} ${hit.angle}°` +
        `（${positionLabel(hit.moonLon)}）`,
    });
  });
  lines.sort((left, right) => left.jd - right.jd || left.rank - right.rank);

  const startHouse = getHouse(scan.moonLonAtStart, chart.cusps);
  const natalLines = [
    `■ ネイタルに重ねた月（チャート: ${chart.label}（${chartId}） / ` +
      `ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}））`,
    `（t.＝空の月 / n.＝ネイタル。開始時点の月は n.${startHouse}H に居ます）`,
    ...(lines.length > 0
      ? lines.map((line) => line.text)
      : ["（この期間にネイタルへのイベントはありません）"]),
    "",
    `■ 件数 ハウス入り ${houseIngressList.length} / ネイタルへの exact ${natalAspects.length} / ` +
      `個人朔望 ${personalPhases.length}`,
    "規約: ハウスは登録時のハウス方式のカスプ／ネイタルへのアスペクトは exact の瞬間だけ" +
      "（オーブは取らない）／相手はネイタルの 10 天体＋ASC・MC（ノードは入れない）／" +
      "個人朔望はネイタル太陽とネイタル月に対する 0・90・180・270°" +
      "（0 と 180 は上の合・衝と同じ瞬間ですが、上弦／下弦は向きがあって初めて言えるので別に並べます）",
    noReadingNote("ハウス入り・アスペクト・個人朔望の意味"),
  ];

  return {
    content: [{ type: "text", text: `${formatMoonCalendarText(scan, sky)}\n\n${natalLines.join("\n")}` }],
    structuredContent: {
      kind: "natal_moon_calendar",
      chart_id: chartId,
      label: chart.label,
      house_system: chart.house_system,
      range: sky.range,
      moon_at_start: { ...sky.moon_at_start, house: startHouse },
      phases: sky.phases,
      ingresses: sky.ingresses,
      void_of_course: sky.void_of_course,
      eclipses: sky.eclipses,
      house_ingresses: houseIngressList,
      natal_aspects: natalAspects,
      personal_phases: personalPhases,
      conventions: {
        ...sky.conventions,
        houses: chart.house_system,
        natal_aspects: "exact_only_no_orb",
        natal_targets: "10_planets_asc_mc_no_nodes",
        personal_phases: "moon_to_natal_sun_and_moon",
      },
    },
  };
}

export const natalMoonCalendarTool: AstroTool = {
  definition: {
    name: "natal_moon_calendar",
    title: "ネイタルに重ねた月の暦",
    description:
      "**登録済みチャートの上を月がどう通るか**を期間でまとめて返す。" +
      "公開の moon_calendar（空の月の暦＝新月・上弦・満月・下弦、月の星座入り、ボイドタイム、食）を" +
      "そのまま含み、そこに個人の層を 3 つ重ねる。\n" +
      "重ねるのは (1) **ハウス入り**＝月がネイタルのカスプを跨ぐ瞬間（期間の頭でどのハウスに居るかも）、" +
      "(2) **ネイタルへの exact**＝月とネイタルの 10 天体（ノードは除く）・ASC / MC が" +
      "メジャー5種（合・セクスタイル・スクエア・トライン・オポジション）を作る**ぴったりの瞬間**、" +
      "(3) **個人朔望**＝ネイタルの太陽・月から見た月の 0 / 90 / 180 / 270°" +
      "（new_moon_equivalent / first_quarter_equivalent / full_moon_equivalent / " +
      "last_quarter_equivalent。ネイタル月との 0° はルナリターンと同じ瞬間）。\n" +
      PRINCIPLE_CONVENTIONS_ARE_NAMED +
      "ハウスは登録時のハウス方式のカスプ / ネイタルへのアスペクトは**オーブを取らず exact だけ**" +
      "（暦なので「いつぴったりか」だけを返す。窓の始まりと終わりが要るなら transit_events のほう） / " +
      "個人朔望はネイタル太陽とネイタル月の 2 つに対してだけ / " +
      "ボイドの規約と食の扱いは moon_calendar と同じ（返り値の conventions に名前で入る）。\n" +
      "⚠ ボイドの定義は流派で割れる（相手天体の範囲・オーブの有無・「その星座を出るまで」か" +
      "「次のアスペクトまで」か）。このサーバーは 1 通りだけを採る。\n" +
      "空だけを見たいとき（誕生日を使わないとき）は moon_calendar、" +
      "今この瞬間の配置は transit、期間内の窓（entering・exact・leaving）は transit_events。\n" +
      "このツールは解釈をしない——月がそのハウスに入ることの意味も、個人朔望の読み方も" +
      "サーバーに載せていないので、" +
      READ_WITH_YOUR_OWN_KNOWLEDGE +
      "。\n" +
      "出生データそのものは返事に出さない（時刻・ハウス番号・星座と度数という派生値だけを返す）。\n" +
      "⚠ " +
      PRINCIPLE_NO_SUMMING +
      "。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        start: {
          type: "string",
          description:
            '期間の頭を "YYYY-MM-DD" で（例: 2026-08-25）。その日の 0 時から数える。' +
            "省略すると utc_offset の暦での今日。",
        },
        days: {
          type: "integer",
          minimum: MOON_CALENDAR_MIN_DAYS,
          maximum: MOON_CALENDAR_MAX_DAYS,
          default: MOON_CALENDAR_DEFAULT_DAYS,
          description:
            `何日ぶん見るか（既定 ${MOON_CALENDAR_DEFAULT_DAYS}・` +
            `最大 ${MOON_CALENDAR_MAX_DAYS} ＝ 2 朔望月ぶん）。`,
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          default: MOON_CALENDAR_DEFAULT_UTC_OFFSET,
          description:
            `どの土地の時計で読むか（既定 ${MOON_CALENDAR_DEFAULT_UTC_OFFSET}＝日本時間）。` +
            "返す時刻はすべてこの時差の現地時刻で、+09:00 のような札が付く。",
        },
        voc_bodies: {
          type: "string",
          enum: VOC_BODY_SETS,
          default: "modern",
          description:
            "ボイド判定の相手天体（既定 modern）。modern＝太陽・水星〜冥王星の 9 天体 / " +
            "traditional＝太陽・水星〜土星の 7 天体（近代以降に見つかった 3 つを外す流派）。",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runNatalMoonCalendar,
};
