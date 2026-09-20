/**
 * 四柱推命（four_pillars / pillars_relations）。
 * astro-mcp.ts から切り出したもので、中身は移動しただけ。
 *
 * 算法は純関数（src/four-pillars.ts・src/pillars-relations.ts・src/nakko.ts）。
 * ここは出生の瞬間の出どころ・太陽黄経・節入りの帯・見る日を決めるだけ。
 */
import { toolError, type ToolResult } from "../../mcp";
import {
  FourPillarsError,
  calculateFourPillars,
  formatDateFortuneText,
  formatFourPillarsText,
  orderedPillars,
  type DateFortuneResult,
  type FourPillarsResult,
} from "../../four-pillars";
import { computeDateFortune, computeFourPillarsNatal } from "../four-pillars-engine";
import { momentFromDate, sunLongitude, type NakkoMoment } from "../../nakko";
import {
  MAX_PARTIES,
  MIN_PARTIES,
  PillarsRelationsError,
  calculatePillarsRelations,
  formatPillarsRelationsText,
  type PartyInput,
  type PillarsRelationsResult,
} from "../../pillars-relations";
import {
  fortuneDayFromNow,
  parseFortuneDate,
  resolveBirthMoment,
  type BirthMomentOptions,
} from "../birth-moment";
import {
  formatLocalMoment,
  formatOffsetLabel,
  formatPlainMoment,
  formatUtcMoment,
  pad,
} from "../calendar";
import { AstroError } from "../chart";
import {
  engineOf,
  missingPartyChart,
  type AstroContext,
  type AstroTool,
} from "../context";
import {
  MISSING_BIRTH_MESSAGE,
  noReadingNote,
  PRINCIPLE_CONVENTIONS_ARE_NAMED,
  PRINCIPLE_NO_SUMMING,
  READ_WITH_YOUR_OWN_KNOWLEDGE,
} from "../../phrases";
import { getChart, type StoredChart } from "../store";
import { argsOf, optionalNumber, optionalString, requireChartIds } from "../tool-args";

// ---------------------------------------------------------------------------
// 四柱推命（子平）
// ---------------------------------------------------------------------------

/** 四柱推命（時柱は 2 時間ごと。純関数が西暦 1〜9999 でしか立てないので範囲もそろえる） */
const FOUR_PILLARS_BIRTH_OPTIONS: BirthMomentOptions = {
  reason: "時柱は出生時刻の 2 時間ごとの区切りで決まるので",
  yearMin: 1,
  yearMax: 9999,
};

const FOUR_PILLARS_NO_READING_NOTE = noReadingNote("通変星・十二運・蔵干・空亡・大運の意味");

/**
 * 四柱推命（命式と、指定日の流年・月運・日運）。
 *
 * 算法は純関数（src/four-pillars.ts と src/nakko.ts）で、ここがやるのは 3 つだけ ――
 * 出生の瞬間の出どころを決める / wasm で太陽黄経と前後の節入りを出す / 見る日を決める。
 * エンジンを叩くのは `swe_calc_ut` 2 回（出生と対象日の太陽）と `swe_solcross_ut` 2 回だけ。
 *
 * 出生データは返事に出さない ―― 出すのは派生値（干支・蔵干・十二運・空亡・大運）だけ。
 * jd も出生の瞬間そのものなので、テキストにも structuredContent にも混ぜない。
 */
async function runFourPillars(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const resolved = await resolveBirthMoment(args, context, FOUR_PILLARS_BIRTH_OPTIONS);
  if ("error" in resolved) return resolved.error;

  const dateOffset = optionalNumber(args, "date_utc_offset", -14, 14) ?? 0;
  const rawDate = optionalString(args, "date", 24);
  const now = context.now ? context.now() : new Date();
  const day = rawDate === undefined
    ? fortuneDayFromNow(now, dateOffset)
    : parseFortuneDate(rawDate, dateOffset);

  const swe = await engineOf(context);

  // MomentInput と NakkoMoment は同じ形（現地の時計の読み＋時差）
  const birthMoment: NakkoMoment = resolved.moment;

  let natal: FourPillarsResult;
  try {
    natal = computeFourPillarsNatal(swe, birthMoment);
  } catch (error) {
    // 純関数の言い分には出生データの値が混じり得るので、そのままは返さない
    if (error instanceof FourPillarsError) {
      throw new AstroError(
        "その出生データからは命式を立てられませんでした" +
          "（四柱推命は西暦 1〜9999 年の生年月日で立てます。値は返事に出しません）。",
      );
    }
    throw error;
  }

  // 対象日は「その土地の時計の読み」で見る（日運の日界 0 時も時運の 2 時間区切りもここで決まる）
  const targetMoment = momentFromDate(day.at, dateOffset);

  let fortune: DateFortuneResult;
  try {
    fortune = computeDateFortune(swe, natal, targetMoment, day.hasTime);
  } catch (error) {
    // こちらの言い分に出るのは**呼び出した側が打った日付**なので、そのまま返してよい
    if (error instanceof FourPillarsError) throw new AstroError(error.message);
    throw error;
  }

  const dateLabel = `${day.date.year}-${pad(day.date.month)}-${pad(day.date.day)}`;
  const calendarNote = dateOffset === 0 ? "UTC の暦" : `${formatOffsetLabel(dateOffset)} の暦`;
  const heading =
    resolved.source === "chart"
      ? `チャート: ${resolved.label}（${resolved.chartId}）`
      : "出生データ: 直接指定（値は返事に出しません）";

  const lines: string[] = [
    "四柱推命（子平・日界 0 時・節気は太陽黄経・時刻の補正なし）",
    heading,
    FOUR_PILLARS_NO_READING_NOTE,
    "",
    formatFourPillarsText(natal),
    "",
    `■ 対象日 ${dateLabel}（${calendarNote}）`,
    `対象の瞬間: ${formatUtcMoment(day.at)}` +
      (dateOffset === 0 ? "" : ` / ローカル ${formatLocalMoment(day.at, dateOffset)}`) +
      (day.isNow
        ? "（現在時刻）"
        : day.hasTime
          ? ""
          : "（時刻の指定が無いので 0 時で見ています＝時運は出しません）"),
    formatDateFortuneText(fortune),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "four_pillars",
      source: resolved.source,
      ...(resolved.source === "chart"
        ? { chart_id: resolved.chartId, label: resolved.label }
        : {}),
      natal,
      target: {
        date: dateLabel,
        utc: day.at.toISOString(),
        local: formatPlainMoment(day.at, dateOffset),
        utc_offset: dateOffset,
        is_now: day.isNow,
        has_time: day.hasTime,
      },
      date_fortune: fortune,
    },
  };
}

// ---------------------------------------------------------------------------
// 四柱の多者盤面
// ---------------------------------------------------------------------------

const PILLARS_RELATIONS_NO_READING_NOTE =
  "関係の名前を並べるだけで、点数化も多数決もしていません。" + noReadingNote("相性の良し悪し");

/**
 * 四柱の多者盤面（2〜4 人）。
 *
 * 命式は four_pillars とまったく同じ経路（`sunLongitude` → `calculateFourPillars`）で 1 人ずつ立て、
 * 盤面の表引きは純関数（src/pillars-relations.ts）に渡す。エンジンを叩くのは
 * 人数ぶんの `swe_calc_ut`（太陽）だけ ―― 大運を返さないので**節入りは探さない**
 * （`swe_solcross_ut` を人数 × 2 回ぶん節約している。起運はこの盤面に出てこない）。
 *
 * 出生データは返事に出さない ―― 出すのは派生値（干支・空亡と、そのつながりの名前）だけ。
 * 太陽黄経も出生の瞬間を絞り込む手がかりなので、返り値には混ぜない。
 */
async function runPillarsRelations(
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const ids = requireChartIds(args, "charts");

  // どれも「呼び出した人の台帳」しか引かない＝他人のチャートは存在ごと見えない
  const charts: StoredChart[] = [];
  for (const [index, chartId] of ids.entries()) {
    const chart = await getChart(context.kv, context.auth.user, chartId);
    if (!chart) return missingPartyChart(`charts[${index}]`, chartId);
    if (!chart.birth) {
      // four_pillars と同じ案内（時柱が要るので、座標だけの古い登録では命式が立たない）
      return toolError(
        `charts[${index}] に指定したチャート ${chartId} には` + MISSING_BIRTH_MESSAGE,
      );
    }
    charts.push(chart);
  }

  const swe = await engineOf(context);
  const parties: PartyInput[] = charts.map((chart, index) => {
    const birth = chart.birth as NonNullable<StoredChart["birth"]>;
    // MomentInput と NakkoMoment は同じ形（現地の時計の読み＋時差）
    const moment: NakkoMoment = {
      year: birth.year,
      month: birth.month,
      day: birth.day,
      hour: birth.hour,
      minute: birth.minute,
      utcOffset: birth.utc_offset,
    };
    const sunLon = sunLongitude(swe, moment);
    let natal: FourPillarsResult;
    try {
      natal = calculateFourPillars({ moment, sun_longitude: sunLon });
    } catch (error) {
      // 純関数の言い分には出生データの値が混じり得るので、そのままは返さない
      if (error instanceof FourPillarsError) {
        throw new AstroError(
          `charts[${index}] に指定したチャートの出生データからは命式を立てられませんでした` +
            "（四柱推命は西暦 1〜9999 年の生年月日で立てます。値は返事に出しません）。",
        );
      }
      throw error;
    }
    return {
      // ラベルが空の登録でも人が見分けられるように chart_id で代える
      label: chart.label || (ids[index] as string),
      pillars: orderedPillars(natal.pillars),
      void: natal.void,
    };
  });

  let board: PillarsRelationsResult;
  try {
    board = calculatePillarsRelations(parties);
  } catch (error) {
    // こちらの言い分に出るのは人数と干支だけ（出生データは含まれない）ので、そのまま返してよい
    if (error instanceof PillarsRelationsError) throw new AstroError(error.message);
    throw error;
  }

  const roster = board.parties
    .map((party, index) => `${party.index}. ${party.label}（${ids[index]}）`)
    .join(" / ");

  const lines: string[] = [
    "四柱の多者盤面（子平・日界 0 時・節気は太陽黄経・時刻の補正なし）",
    `並べたチャート: ${roster}`,
    PILLARS_RELATIONS_NO_READING_NOTE,
    "",
    formatPillarsRelationsText(board),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "pillars_relations",
      charts: ids.map((chartId, index) => ({
        chart_id: chartId,
        label: (charts[index] as StoredChart).label,
      })),
      ...board,
    },
  };
}

export const fourPillarsTool: AstroTool = {
  definition: {
    name: "four_pillars",
    title: "四柱推命（命式と流年・月運・日運）",
    description:
      "四柱推命（子平）の命式と、指定した日の流年・月運・日運を計算する。\n" +
      "**chart_id か、生年月日＋出生時刻の直接指定（year / month / day / hour / minute）の" +
      "どちらか一方**で呼ぶ。時柱は 2 時間ごとの区切りで決まるので**出生時刻は必須**" +
      "（時刻の分からない出生では引かない）。\n" +
      "返るのは (1) 命式（年柱・月柱・日柱・時柱の干支と五行・陰陽、日干から見た通変星と十二運、" +
      "蔵干＝本気／中気／余気、空亡）、(2) 日主・空亡・節入りからの日数・大運（順行と逆行を 10 柱ずつ）、" +
      "(3) date（省略すると今）の流年・月運・日運と、命式との天干五合・六合・六沖。" +
      "date に時刻を付ければ時運（時柱）も出し、日付だけなら年・月・日の三柱で見る。" +
      "date は**過去も未来も受ける**。\n" +
      PRINCIPLE_CONVENTIONS_ARE_NAMED +
      "日界は 0 時（23 時台生まれのときだけ「日界 23 時」「夜子時」の 2 通りを alternatives に添える）/ " +
      "時刻の補正なし（経度補正も均時差もかけない。時辰の境から 15 分以内のときだけ印を出し、" +
      "境からの分数そのものは出さない）/ " +
      "節気は太陽黄経（立春 315°、30° ごとに月柱が替わる。年柱も立春で切り替える）/ " +
      "蔵干は本気・中気・余気を全部並べ、通変星は本気で代表する" +
      "（月律分野表は採らない。代わりに節入りからの日数を返すので、その表で絞りたければ読む側で絞れる）/ " +
      "十二運は陰干逆行（陽生陰死方式は採らない）/ 空亡は日柱の旬から / " +
      "大運は性別を預からないので順行・逆行の両方を返し、起運（日数 ÷ 3）は" +
      "切り上げ・満年齢といった流派の丸めを採らない" +
      "（返す精度は 0.1 年まで＝出生時刻を約 7 時間の粗さでしか含まない）/ " +
      "巡りと命式の関係は天干五合・六合・六沖のみ（三合・刑・害は範囲外）。\n" +
      "**このツールは解釈をしない**——通変星も十二運も蔵干も大運も名前を並べるだけで、" +
      "格局・用神・強弱・吉凶はサーバーに載せていない。" +
      READ_WITH_YOUR_OWN_KNOWLEDGE +
      "。" +
      PRINCIPLE_NO_SUMMING +
      "——並べて眺めるのはよいが、点数を足したり多数決を取ったりしない。\n" +
      "出生データそのものは返事に出さない（命式・蔵干・大運のような派生値だけを返す）。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description:
            "対象のチャート ID（list_charts で確認できる）。" +
            "生年月日の直接指定とはどちらか一方だけを指定する",
        },
        year: {
          type: "integer",
          minimum: 1,
          maximum: 9999,
          description:
            "出生年（西暦）。登録せずに一度だけ見るときの直接指定で、" +
            "year / month / day / hour / minute は 5 つそろえて指定する（chart_id とは併用できない）",
        },
        month: { type: "integer", minimum: 1, maximum: 12, description: "出生月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "出生日（1-31）" },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description:
            "出生時刻の「時」（0-23、出生地の現地時刻）。時柱を立てるので必須。" +
            "23 時台のときは日界の代替（日界 23 時・夜子時）も添える",
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
            "出生地の UTC からの時差（時間単位。日本は 9。省略すると UTC 扱い）。" +
            "直接指定のときだけ使う（chart_id では預かっている時差を使う）",
        },
        date: {
          type: "string",
          pattern: "^-?\\d{1,5}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2})?$",
          description:
            '流年・月運・日運を見る日 "YYYY-MM-DD"、時運（時柱）まで見たいときは' +
            ' "YYYY-MM-DD HH:MM"（省略すると今）。過去も未来も受ける',
        },
        date_utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "date と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）。" +
            "日運の日界（0 時）もこの時差の土地の暦で見る",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runFourPillars,
};

export const pillarsRelationsTool: AstroTool = {
  definition: {
    name: "pillars_relations",
    title: "四柱の多者盤面（2〜4 人）",
    description:
      "登録済みの出生図 2〜4 枚から四柱推命の命式を立てて横に並べ、" +
      "**日主・地支・空亡のつながりを表引きで**拾う。\n" +
      "ひとりぶんの命式そのもの（通変星・十二運・蔵干・大運・流年）は four_pillars の持ち場で、" +
      "こちらが返すのは**人と人のあいだに立つ関係だけ**。\n" +
      "charts は**呼び出した人の台帳の chart_id の配列**（2〜4 枚。list_charts で確認できる）。" +
      "同じ ID を 2 つ入れることはできない。時柱を立てるので、" +
      "出生データを預かっていない古い登録では引けない（登録し直しを案内する）。\n" +
      "返るのは (1) 各人の日主（天干・五行・陰陽）と 4 柱の干支・空亡、" +
      "(2) 全ペアぶん ―― 日主の関係（比和／相生／相剋。どちらがどちらを生む・剋すかつき、" +
      "天干五合が立てばそれも）と、**一方の各柱 × 他方の各柱の総当たり**で立つ地支の関係" +
      "（六合・六沖・半合＝三合の 2 支・同一支）、" +
      "「X の空亡に Y のどの柱の地支が入るか」を双方向で、" +
      "(3) **3 人以上なら**全員の地支を持ち寄って揃う三合局・方合" +
      "（誰のどの柱がどの支を出しているかつき。1 人で 3 支そろえている局は「単独で成立」と別枠）と、" +
      "空亡の有向辺の連鎖（環が閉じていれば「相互」「三すくみ」と名前で）。\n" +
      PRINCIPLE_CONVENTIONS_ARE_NAMED +
      "日界 0 時（23 時台生まれの「夜子時」は採らず、既定の 1 通りだけで並べる）/ " +
      "空亡は日柱の旬から取り、相手のどの柱の地支も見る / " +
      "半合は三合局の 3 支のうち 2 支（旺支を含まない組も同じ半合として数える）/ " +
      "**刑・害・破は含めない**（拾い忘れではなく採らないという意味で、conventions の excluded に名前を書く）。\n" +
      "**このツールは解釈をしない**——関係の名前を並べるだけで、**点数化も多数決もしない**" +
      "（合の数を数えて相性の点にしたり、凶の札を足し合わせたりはサーバーの持ち場ではない）。" +
      READ_WITH_YOUR_OWN_KNOWLEDGE +
      "。" +
      PRINCIPLE_NO_SUMMING +
      "。\n" +
      "出生データそのものは返事に出さない（命式＝干支のような派生値だけを返す）。",
    inputSchema: {
      type: "object",
      properties: {
        charts: {
          type: "array",
          items: { type: "string" },
          minItems: MIN_PARTIES,
          maxItems: MAX_PARTIES,
          description:
            "横に並べるチャート ID の配列（2〜4 枚。list_charts で確認できる）。" +
            "同じ ID を 2 つ入れることはできない",
        },
      },
      required: ["charts"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runPillarsRelations,
};
