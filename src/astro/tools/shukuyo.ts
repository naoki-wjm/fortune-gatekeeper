/**
 * 宿曜（shukuyo / shukuyo_compat）。astro-mcp.ts から切り出したもので、中身は移動しただけ。
 *
 * 天文方式一択（出生時刻の月のサイデリアル黄経 ÷ 13°20′、基準点は Lahiri 固定）。
 */
import { toolError, type ToolResult } from "../../mcp";
import {
  AYANAMSA_NAME,
  SHUKU_COUNT,
  SHUKU_SPAN,
  compatOf,
  formatCompatLines,
  formatRelation,
  formatShukuLines,
  formatShukuName,
  parseShuku,
  relationOf,
  shukuAt,
  shukuIndexOf,
  shukuOf,
  toSidereal,
  type Shuku,
  type ShukuPosition,
} from "../../shukuyo";
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
  momentFromUtcDate,
  pad,
  utcDateFromLocal,
} from "../calendar";
import {
  CALC_FLAGS,
  SIDEREAL_MODE_LAHIRI,
  dateFromJulianDay,
  julianDay,
  normalizeDegree,
  type MomentInput,
  type SwissEph,
} from "../chart";
import { engineOf, type AstroContext, type AstroTool } from "../context";
import {
  MISSING_BIRTH_MESSAGE,
  noReadingNote,
  PRINCIPLE_NO_SUMMING,
  READ_WITH_YOUR_OWN_KNOWLEDGE,
} from "../phrases";
import { crossUt } from "../returns";
import { getChart, isChartId } from "../store";
import { argsOf, optionalNumber, optionalString, requireString } from "../tool-args";

// ---------------------------------------------------------------------------
// 宿曜（二十七宿）
// ---------------------------------------------------------------------------

/** 月の天体 ID（PLANETS の並びと同じ） */
const MOON_ID = 1;

/** 1 日のうちに宿が切り替わる回数の上限（月は 1 宿に 21〜27 時間いるので、多くて 2 回） */
const MAX_SHUKU_CHANGES = 3;

/** その瞬間の月のトロピカル黄経 */
function moonLongitude(swe: SwissEph, jd: number): number {
  return normalizeDegree(swe.swe_calc_ut(jd, MOON_ID, CALC_FLAGS)[0] as number);
}

/**
 * その瞬間の月の宿（サイデリアル）。
 *
 * ⚠ **アヤナムシャの値は呼び出し側へ返さないこと**（出生の瞬間で引いたぶんは）。
 *    Lahiri は 50″/年ほどで動くので、小数 4 桁まで出すと値そのものが「生まれた年月」の目盛りになる
 *    ――出生データを返事に出さない約束に触れる。日運のように**呼び出し側が日付を指定した瞬間**の
 *    アヤナムシャは、その日付がもともと会話に出ているので返してよい。
 */
function shukuAtJd(swe: SwissEph, jd: number): { position: ShukuPosition; ayanamsa: number } {
  const ayanamsa = swe.swe_get_ayanamsa_ut(jd);
  return { position: shukuOf(toSidereal(moonLongitude(swe, jd), ayanamsa)), ayanamsa };
}

/**
 * 窓（startJd 以上 endJd 未満）の中で月が宿の境界を越える瞬間を拾う。
 *
 * 月は逆行しないので、境界は必ず前から順に 1 つずつ越える。探索は returns.ts の crossUt
 * （＝壊れた wrapper のエラーチェックを呼び出し側で検算するやつ）を借りる。
 * ⚠ `swe_mooncross_ut` が探すのは**トロピカル黄経**なので、サイデリアルの境界に
 *    アヤナムシャを足し戻してから渡す。アヤナムシャは 1 日で 4e-5° しか動かず、
 *    月足（13°/日）に直すと 0.3 秒未満なので、窓の頭の値を使い回して構わない。
 */
function moonShukuChanges(
  swe: SwissEph,
  startJd: number,
  endJd: number,
  ayanamsa: number,
): { jd: number; from: Shuku; to: Shuku }[] {
  let index = shukuIndexOf(toSidereal(moonLongitude(swe, startJd), ayanamsa));
  const changes: { jd: number; from: Shuku; to: Shuku }[] = [];
  let cursor = startJd;

  for (let guard = 0; guard < MAX_SHUKU_CHANGES; guard++) {
    const nextIndex = (index + 1) % SHUKU_COUNT;
    const targetTropical = normalizeDegree(nextIndex * SHUKU_SPAN + ayanamsa);
    const jd = crossUt(swe, "moon", targetTropical, cursor);
    if (jd >= endJd) break;
    changes.push({ jd, from: shukuAt(index), to: shukuAt(nextIndex) });
    index = nextIndex;
    cursor = jd;
  }
  return changes;
}

/** 宿曜（月は 1 日でほぼ 1 宿ぶん動く） */
const SHUKUYO_BIRTH_OPTIONS: BirthMomentOptions = {
  reason: "宿は出生時刻の月の位置で決まり、月は 1 日でほぼ 1 宿ぶん動くので",
  yearMin: -5000,
  yearMax: 5000,
};

/** 返り値に添える「このサーバーが採った規約」。名前で書くのは読む側が流派を確かめられるように */
const SHUKUYO_SYSTEM = {
  method: "astronomical",
  method_label: "天文方式（出生時刻の月のサイデリアル黄経 ÷ 13°20′）",
  ayanamsa: AYANAMSA_NAME,
  ayanamsa_id: SIDEREAL_MODE_LAHIRI,
  mansions: SHUKU_COUNT,
  span_degrees: SHUKU_SPAN,
  origin: "婁宿（Ashvini）＝サイデリアル 0°",
  calendar_note:
    "暦方式（旧暦の日付から宿を引くやり方）は採らない" +
    "（旧暦は 2033 年問題のように裁定者のいない未解決の規約を含むため）",
  note: "『宿曜経』の列挙は昴宿から始まるが、それは表の並びであって位置の起点ではない",
} as const;

const SHUKUYO_NO_READING_NOTE = noReadingNote("宿の意味・吉凶");

/** 規約の 1 行（テキストの末尾に置く） */
const SHUKUYO_SYSTEM_LINE =
  `規約: ${SHUKUYO_SYSTEM.method_label} / 基準点 ${AYANAMSA_NAME}（SE_SIDM_LAHIRI）/ ` +
  `${SHUKU_COUNT} 宿・${SHUKUYO_SYSTEM.origin} / ${SHUKUYO_SYSTEM.calendar_note}`;

/**
 * 宿曜（本命宿とその日の宿）。
 *
 * 出生データは返事に出さない ―― 出すのは派生値（宿・宿内の位置・サイデリアル黄経）だけ。
 * 出生時のアヤナムシャも出さない（値そのものが生まれた年月の目盛りになるため）。
 */
async function runShukuyo(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const resolved = await resolveBirthMoment(args, context, SHUKUYO_BIRTH_OPTIONS);
  if ("error" in resolved) return resolved.error;

  const dateOffset = optionalNumber(args, "date_utc_offset", -14, 14) ?? 0;
  const rawDate = optionalString(args, "date", 24);
  const now = context.now ? context.now() : new Date();
  const day = rawDate === undefined
    ? fortuneDayFromNow(now, dateOffset)
    : parseFortuneDate(rawDate, dateOffset);

  const swe = await engineOf(context);

  // 本命宿（アヤナムシャは受け取るだけで返さない）
  const natal = shukuAtJd(swe, julianDay(swe, resolved.moment)).position;

  // その日の宿
  const dayJd = julianDay(swe, momentFromUtcDate(day.at));
  const today = shukuAtJd(swe, dayJd);
  const relation = relationOf(natal.shuku.number - 1, today.position.shuku.number - 1);

  // その暦日（0 時〜24 時）の切り替わり
  const windowStart = utcDateFromLocal(day.date.year, day.date.month, day.date.day, 0, 0, dateOffset);
  const windowStartJd = julianDay(swe, momentFromUtcDate(windowStart));
  const changes = moonShukuChanges(swe, windowStartJd, windowStartJd + 1, today.ayanamsa);

  const dateLabel = `${day.date.year}-${pad(day.date.month)}-${pad(day.date.day)}`;
  const calendarNote = dateOffset === 0 ? "UTC の暦" : `${formatOffsetLabel(dateOffset)} の暦`;
  const heading =
    resolved.source === "chart"
      ? `チャート: ${resolved.label}（${resolved.chartId}）`
      : "出生データ: 直接指定（値は返事に出しません）";

  const lines: string[] = [
    `宿曜（天文方式・${AYANAMSA_NAME} アヤナムシャ・二十七宿）`,
    heading,
    SHUKUYO_NO_READING_NOTE,
    "",
    "■ 本命宿（出生時刻の月）",
    ...formatShukuLines(natal),
    "（月は 1 日でほぼ 1 宿ぶん動きます。宿内の位置が境界に近いときは、隣の宿も併せて見てください）",
    "",
    `■ その日の宿 ${dateLabel}（${calendarNote}）`,
    `対象の瞬間: ${formatUtcMoment(day.at)}` +
      (dateOffset === 0 ? "" : ` / ローカル ${formatLocalMoment(day.at, dateOffset)}`) +
      (day.isNow ? "（現在時刻）" : day.hasTime ? "" : "（時刻の指定が無いので 0 時で見ています）"),
    ...formatShukuLines(today.position),
    `本命宿から: ${formatRelation(relation)}`,
    `アヤナムシャ ${today.ayanamsa.toFixed(4)}°（${AYANAMSA_NAME}）`,
    "",
    `□ この日の宿の切り替わり（${calendarNote}の 0 時〜24 時）`,
  ];
  if (changes.length === 0) {
    lines.push("この 24 時間のうちに宿は変わりません（月は 1 宿に 21〜27 時間ほど留まります）");
  } else {
    for (const change of changes) {
      const at = dateFromJulianDay(change.jd);
      lines.push(
        `${dateOffset === 0 ? formatUtcMoment(at) : formatLocalMoment(at, dateOffset)} ` +
          `${change.from.name} → ${formatShukuName(change.to)}`,
      );
    }
  }
  lines.push("");
  lines.push(SHUKUYO_SYSTEM_LINE);

  const describe = (position: ShukuPosition) => ({
    shuku: position.shuku,
    sidereal_lon: position.sidereal_lon,
    degrees_in: position.degrees_in,
    position: position.position,
    degrees_to_next: position.degrees_to_next,
    prev: position.prev,
    next: position.next,
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "shukuyo",
      source: resolved.source,
      ...(resolved.source === "chart"
        ? { chart_id: resolved.chartId, label: resolved.label }
        : {}),
      system: SHUKUYO_SYSTEM,
      // 出生時のアヤナムシャは載せない（生まれた年月の目盛りになるため）
      natal: describe(natal),
      day: {
        date: dateLabel,
        utc: day.at.toISOString(),
        local: formatPlainMoment(day.at, dateOffset),
        utc_offset: dateOffset,
        is_now: day.isNow,
        has_time: day.hasTime,
        ayanamsa: today.ayanamsa,
        ...describe(today.position),
        relation,
        changes: changes.map((change) => {
          const at = dateFromJulianDay(change.jd);
          return {
            utc: at.toISOString(),
            local: formatPlainMoment(at, dateOffset),
            from: change.from,
            to: change.to,
          };
        }),
      },
    },
  };
}

/** shukuyo_compat の片側（chart_id から引いたか、宿名で渡されたか） */
interface CompatParty {
  shuku: Shuku;
  source: "chart" | "name";
  chartId?: string;
  label?: string;
  /** テキストの見出しに使う札 */
  display: string;
}

/**
 * a / b の片側を宿に直す。
 *
 * **先に台帳を chart_id として引き、載っていなければ宿名として読む**（この順に意味がある
 * ―― サンスクリット名は "hasta" のように chart_id の形と見分けが付かないので、
 * 実在する登録を優先し、無ければ名前と解釈する）。
 */
async function resolveCompatParty(
  raw: string,
  key: "a" | "b",
  context: AstroContext,
  engine: () => Promise<SwissEph>,
): Promise<CompatParty | { error: ToolResult }> {
  if (isChartId(raw)) {
    const chart = await getChart(context.kv, context.auth.user, raw);
    if (chart) {
      if (!chart.birth) {
        return {
          error: toolError(
            `${key} に指定したチャート ${raw} には` +
              MISSING_BIRTH_MESSAGE +
              "宿名を直接指定して呼ぶこともできます。",
          ),
        };
      }
      const swe = await engine();
      const moment: MomentInput = {
        year: chart.birth.year,
        month: chart.birth.month,
        day: chart.birth.day,
        hour: chart.birth.hour,
        minute: chart.birth.minute,
        utcOffset: chart.birth.utc_offset,
      };
      return {
        shuku: shukuAtJd(swe, julianDay(swe, moment)).position.shuku,
        source: "chart",
        chartId: raw,
        label: chart.label,
        display: `チャート ${chart.label}（${raw}）`,
      };
    }
  }

  // 宿名として読む（読めなければ ShukuyoError → 呼び出し側で AstroError に着替えさせる）
  const shuku = parseShuku(raw, `${key} の宿`);
  return { shuku, source: "name", display: "宿名指定" };
}

/**
 * 宿曜の相性（三九の秘法）。
 *
 * 天体計算をするのは chart_id で呼ばれた側だけ ―― 両方が宿名なら wasm には触らない。
 */
async function runShukuyoCompat(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const rawA = requireString(args, "a", 40);
  const rawB = requireString(args, "b", 40);

  // エンジンは chart_id が来たときだけ起こす（宿名だけなら天体計算は 1 回も走らない）
  const engine = () => engineOf(context);
  const partyA = await resolveCompatParty(rawA, "a", context, engine);
  if ("error" in partyA) return partyA.error;
  const partyB = await resolveCompatParty(rawB, "b", context, engine);
  if ("error" in partyB) return partyB.error;

  const compat = compatOf(partyA.shuku.number - 1, partyB.shuku.number - 1);

  const lines = [
    "宿曜の相性（三九の秘法）",
    ...formatCompatLines(compat, partyA.display, partyB.display),
    SHUKUYO_NO_READING_NOTE,
    SHUKUYO_SYSTEM_LINE,
  ];

  const describe = (party: CompatParty) => ({
    source: party.source,
    ...(party.source === "chart" ? { chart_id: party.chartId, label: party.label } : {}),
    shuku: party.shuku,
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "shukuyo_compat",
      a: describe(partyA),
      b: describe(partyB),
      a_to_b: compat.a_to_b,
      b_to_a: compat.b_to_a,
      pair: compat.pair,
      same: compat.same,
      system: SHUKUYO_SYSTEM,
    },
  };
}

export const shukuyoTool: AstroTool = {
  definition: {
    name: "shukuyo",
    title: "宿曜（本命宿とその日の宿）",
    description:
      "宿曜占星術（二十七宿）の本命宿と、指定した日の宿（日運）を計算する。\n" +
      "**天文方式**——宿は出生時刻の月のサイデリアル黄経を 13°20′ で割って決める。" +
      "基準点（アヤナムシャ）は **Lahiri** に固定（式で出るので天文暦・恒星ファイルが要らない）。" +
      "暦方式（旧暦の日付から宿を引くやり方）は**採らない**" +
      "——旧暦は 2033 年問題のように裁定者のいない未解決の規約を含むため。" +
      "27 宿（牛宿を含まない）で、サイデリアル 0° を**婁宿（Ashvini）**の始まりに置く。" +
      "『宿曜経』の列挙が昴宿から始まるのは「表の並び」であって、位置の起点ではない。\n" +
      "**chart_id か、生年月日＋出生時刻の直接指定（year / month / day / hour / minute）の" +
      "どちらか一方**で呼ぶ。月は 1 日でほぼ 1 宿ぶん動くので、**出生時刻は必須**" +
      "（時刻の分からない出生では引かない）。\n" +
      "返るのは (1) 本命宿（漢字の宿名・サンスクリット名・1〜27 の番号）と宿内の位置・両隣の宿・" +
      "前後の境界までの距離、(2) date（省略すると今日）の月の宿と、本命宿から見た三九の秘法の関係" +
      "（命・栄・衰・安・危・成・壊・友・親・業・胎＋近距離／中距離／遠距離）、" +
      "(3) その日のうちに宿が切り替わる時刻。date は**過去も未来も受ける**" +
      "（日記の日付を後から引き直すときなど）。\n" +
      "**このツールは解釈をしない**——宿の意味も吉凶もサーバーに載せていないので、" +
      READ_WITH_YOUR_OWN_KNOWLEDGE +
      "。" +
      PRINCIPLE_NO_SUMMING +
      "——並べて眺めるのはよいが、点数を足したり多数決を取ったりしない。\n" +
      "出生データそのものは返事に出さない（宿・サイデリアル黄経のような派生値だけを返す）。",
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
          description: "出生時刻の「時」（0-23、出生地の現地時刻）。宿は月の位置で決まるので必須",
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
            '日運を見る日 "YYYY-MM-DD"、時刻まで見たいときは "YYYY-MM-DD HH:MM"' +
            "（省略すると今）。過去も未来も受ける。" +
            "時刻を省いたときはその日の 0 時の月の宿を返し、切り替わり時刻を別に添える",
        },
        date_utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "date と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）。" +
            "「その日の 0 時〜24 時」の区切りもこの時差の土地の暦で見る",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runShukuyo,
};

export const shukuyoCompatTool: AstroTool = {
  definition: {
    name: "shukuyo_compat",
    title: "宿曜の相性（三九の秘法）",
    description:
      "2 つの宿の関係（三九の秘法）を計算する。\n" +
      "a / b はそれぞれ**登録済みの chart_id か、宿の名前**" +
      "（漢字「亢宿」「亢」／サンスクリット名「Swati」／1〜27 の番号）。" +
      "相手の宿名だけでも呼べるので、**相手の出生データを会話に出さずに済む**" +
      "（まず台帳を chart_id として引き、見つからなければ宿名として読む）。\n" +
      "返るのは A→B と B→A の関係（本命宿を 1 として数えた距離 1〜27 と、" +
      "命／栄／衰／安／危／成／壊／友／親／業／胎、近距離・中距離・遠距離）と、" +
      "向きによらない**組の名前**（命・栄親・友衰・安壊・危成・業胎）。" +
      "三九の秘法は向きで名前が変わる（A から見て栄なら B から見ると親）ので両方向を返す。\n" +
      "**このツールは解釈をしない**——関係の意味はサーバーに載せていないので、" +
      READ_WITH_YOUR_OWN_KNOWLEDGE +
      "。" +
      PRINCIPLE_NO_SUMMING +
      "。\n" +
      "chart_id で呼んだときも出生データは返事に出さない。",
    inputSchema: {
      type: "object",
      properties: {
        a: {
          type: "string",
          description:
            "片方（chart_id か宿名。「亢宿」「亢」「Swati」「15」のいずれの書き方でもよい）",
        },
        b: {
          type: "string",
          description: "もう片方（同じ書き方）",
        },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runShukuyoCompat,
};
