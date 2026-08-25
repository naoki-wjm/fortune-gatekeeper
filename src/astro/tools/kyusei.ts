/**
 * 九星気学（kyusei）。astro-mcp.ts から切り出したもので、中身は移動しただけ。
 *
 * 算法は純関数（src/kyusei.ts）。ここは至の暦日と太陽黄経を出し、
 * 出生側から `switch`・`days_since_switch` を落とす配線。
 */
import { type ToolResult } from "../../mcp";
import {
  KYUSEI_CONVENTIONS,
  KyuseiError,
  board,
  dayStar,
  formatBoardText,
  formatSatsuText,
  monthStar,
  satsu,
  starOf,
  yearStar,
  type BoardCell,
  type BoardKind,
  type DayStarView,
  type Dun,
  type Satsu,
  type SolsticeDay,
  type Star,
} from "../../kyusei";
import {
  fourPillars,
  isBeforeRisshun,
  julianDayNumber,
  momentFromDate,
  monthBranchOrder,
  sunLongitude,
  type NakkoMoment,
  type Pillar,
} from "../../nakko";
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
} from "../calendar";
import { AstroError, dateFromJulianDay, julianDay, type SwissEph } from "../chart";
import { engineOf, type AstroContext, type AstroTool } from "../context";
import {
  noReadingNote,
  PRINCIPLE_CONVENTIONS_ARE_NAMED,
  PRINCIPLE_NO_SUMMING,
  READ_WITH_YOUR_OWN_KNOWLEDGE,
} from "../phrases";
import { crossUt } from "../returns";
import { argsOf, optionalNumber, optionalString } from "../tool-args";

// ---------------------------------------------------------------------------
// 九星気学
// ---------------------------------------------------------------------------

/** 九星気学（星は年と月と日で決まる＝出生時刻は任意。年の範囲は四柱と同じ） */
const KYUSEI_BIRTH_OPTIONS: BirthMomentOptions = {
  reason: "本命星は立春で切った年、月命星は節で切った月、日命星は暦日で決まるので",
  yearMin: 1,
  yearMax: 9999,
  timeOptional: true,
};

/**
 * 至の探索の遡り幅（日）。
 *
 * 冬至も夏至も 1 年に 1 回なので、400 日戻れば必ず 1 本ずつ手前に入る
 * （回帰年 365.24 日 ＋ 余裕）。
 */
const SOLSTICE_LOOKBACK_DAYS = 400;

/** 2 本目の至を探し始める幅（日）。1 本目の 300 日後から探せば、次の同じ至だけが窓に入る */
const SOLSTICE_STEP_DAYS = 300;

/** 同じ至どうしの間隔として辻褄が合う長さ（日）＝回帰年 365.2422 の前後 */
const SOLSTICE_GAP_MIN_DAYS = 364;
const SOLSTICE_GAP_MAX_DAYS = 367;

/** 至の瞬間（UT のユリウス日）を**その土地の暦日**へ丸める（日界 0 時＝暦は現地の時計で読む） */
function solsticeDayOf(kind: SolsticeDay["kind"], jd: number, utcOffset: number): SolsticeDay {
  const local = dateFromJulianDay(jd + utcOffset / 24);
  return {
    kind,
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

/**
 * 対象日の前後を挟む冬至・夏至を 4 つ（冬 2・夏 2）。
 *
 * 九星の日盤は「至に最も近い甲子日」で陽遁・陰遁が切り替わるので、
 * 純関数（kyusei.ts の `dayStar`）に渡す至の一覧をここで作る。
 * 探索は 400 日戻ってから 1 本目、その 300 日後から 2 本目 ―― 冬・夏それぞれ 2 本ずつで、
 * **対象日より前に 2 本以上・後に 1 本以上**が必ず入る並びになる
 * （1 本目は対象日の 400〜35 日前、2 本目はその 365 日後なので対象日の 147 日後より先）。
 *
 * ⚠ `swe_solcross_ut` は wrapper のエラーチェックが壊れている（returns.ts の crossUt 参照）ので、
 *    crossUt が「開始 jd より後か」を見たうえで、ここでも**同じ至どうしの間隔**を検算する。
 *    断り文に jd を出さない（出生の瞬間そのものになり得るため）。
 */
function solsticesAround(swe: SwissEph, jd: number, utcOffset: number): SolsticeDay[] {
  const kinds: readonly (readonly [SolsticeDay["kind"], number])[] = [
    ["winter", 270],
    ["summer", 90],
  ];
  const found: SolsticeDay[] = [];

  for (const [kind, longitude] of kinds) {
    const first = crossUt(swe, "sun", longitude, jd - SOLSTICE_LOOKBACK_DAYS);
    const second = crossUt(swe, "sun", longitude, first + SOLSTICE_STEP_DAYS);
    const gap = second - first;
    if (gap < SOLSTICE_GAP_MIN_DAYS || gap > SOLSTICE_GAP_MAX_DAYS) {
      throw new AstroError(
        "冬至・夏至を計算できませんでした" +
          "（天体計算が 1 年の間隔として辻褄の合う答えを返しませんでした）。" +
          "しばらく置いてからもう一度呼んでください。",
      );
    }
    found.push(solsticeDayOf(kind, first, utcOffset), solsticeDayOf(kind, second, utcOffset));
  }

  // 純関数は「古い順・冬と夏が交互」でしか受け取らない
  return found.sort(
    (left, right) =>
      julianDayNumber(left.year, left.month, left.day) -
      julianDayNumber(right.year, right.month, right.day),
  );
}

/** 本命星・月命星（立春で切った年の星と、節で切った月の星） */
interface NatalStars {
  honmei: number;
  getsumei: number;
}

/**
 * その瞬間の本命星・月命星。
 *
 * 年界も月界も太陽黄経で切る（暦の節入り表は引かない）＝ 四柱推命の年柱・月柱と同じ物差し。
 * 時刻を差し替えて呼べるようにしてあるのは、**立春・節入りの当日の生まれ**で
 * 「0 時と 23:59 で星が変わるか」を確かめるため。
 */
function natalStarsAt(swe: SwissEph, moment: NakkoMoment): NatalStars {
  const lon = sunLongitude(swe, moment);
  const solarYear = isBeforeRisshun(lon, moment.month) ? moment.year - 1 : moment.year;
  const honmei = yearStar(solarYear);
  return { honmei, getsumei: monthStar(honmei, monthBranchOrder(lon)) };
}

/** 時刻が分からないときの両候補（その暦日の 0 時と 23:59） */
interface KyuseiAlternatives {
  note: string;
  start: { local_time: string; honmei: Star; getsumei: Star };
  end: { local_time: string; honmei: Star; getsumei: Star };
}

/** 出生側の返り値（日命星は star と dun だけ＝下のコメント参照） */
interface KyuseiBirthView {
  honmei: Star;
  getsumei: Star;
  nichimei: { star: Star; dun: Dun };
  alternatives?: KyuseiAlternatives;
}

/**
 * 出生側の三星（本命星・月命星・日命星）。
 *
 * ⚠ 日命星は **star と dun だけ**を返し、切り替えの甲子日（`switch`）と経過日数
 *    （`days_since_switch`）は落とす ―― この 2 つが揃うと**出生日そのものが復元できる**ため
 *    （純関数は全部返してくるので、落とすのはこの配線の仕事。kyusei.ts の冒頭コメント参照）。
 *    星（9 通り）と遁（2 通り）だけなら日付には戻らない。
 */
function computeKyuseiBirth(
  swe: SwissEph,
  moment: NakkoMoment,
  timeKnown: boolean,
): KyuseiBirthView {
  const stars = natalStarsAt(swe, moment);
  const nichimei = dayStar(
    { year: moment.year, month: moment.month, day: moment.day },
    solsticesAround(swe, julianDay(swe, moment), moment.utcOffset),
  );
  const view: KyuseiBirthView = {
    honmei: starOf(stars.honmei),
    getsumei: starOf(stars.getsumei),
    nichimei: { star: starOf(nichimei.star), dun: nichimei.dun },
  };
  if (timeKnown) return view;

  // 時刻不明のときだけ、その暦日の端と端で星が動くかを見る（動くのは立春・節入りの当日だけ）
  const start = natalStarsAt(swe, { ...moment, hour: 0, minute: 0 });
  const end = natalStarsAt(swe, { ...moment, hour: 23, minute: 59 });
  if (start.honmei === end.honmei && start.getsumei === end.getsumei) return view;

  view.alternatives = {
    note:
      "立春／節入りの当日の生まれで出生時刻が分からないため、時刻によって星が変わります" +
      "（hour / minute を付けると確定します）",
    start: { local_time: "00:00", honmei: starOf(start.honmei), getsumei: starOf(start.getsumei) },
    end: { local_time: "23:59", honmei: starOf(end.honmei), getsumei: starOf(end.getsumei) },
  };
  return view;
}

/** 盤 1 枚ぶんの返り値（中宮・その盤の干支・9 升・立った殺） */
interface KyuseiBoardView {
  center: Star;
  ganzhi: string;
  branch: string;
  cells: BoardCell[];
  satsu: Satsu[];
}

/** 盤を 1 枚組み立てる（殺は破の名前が要るので kind と支を一緒に渡す） */
function buildKyuseiBoard(
  kind: BoardKind,
  centerStar: number,
  pillar: Pillar,
  stars: NatalStars,
): KyuseiBoardView {
  const target = board(centerStar);
  return {
    center: target.center,
    ganzhi: pillar.ganzhi,
    branch: pillar.branch,
    cells: target.cells,
    satsu: satsu(target, {
      kind,
      branch: pillar.branch,
      honmei: stars.honmei,
      getsumei: stars.getsumei,
    }),
  };
}

/**
 * 殺の行。
 *
 * `formatSatsuText` は殺が 1 つも立たないときだけ「殺: なし」と見出しごと返すので、
 * そこで見出しを二重にしないための薄皮（破は必ず立つので、実際にはまず通らない道）。
 */
function formatKyuseiSatsuLine(list: readonly Satsu[]): string {
  const text = formatSatsuText(list);
  return text.startsWith("殺") ? text : `殺: ${text}`;
}

/** 盤 1 枚ぶんのテキスト（3×3 の升目＋殺の行） */
function kyuseiBoardText(title: string, view: KyuseiBoardView): string {
  return [
    formatBoardText({ center: view.center, cells: view.cells }, title),
    formatKyuseiSatsuLine(view.satsu),
  ].join("\n");
}

const KYUSEI_NO_READING_NOTE = noReadingNote("九星・殺・方位の意味と吉方位");

/** 規約の 1 行（テキストの末尾に置く。structuredContent には KYUSEI_CONVENTIONS が丸ごと入る） */
const KYUSEI_SYSTEM_LINE =
  "規約: 年界＝立春／月界＝節（太陽黄経）／日界＝0 時／" +
  "陽遁・陰遁＝冬至・夏至に最も近い甲子（同距離なら後）／閏遁なし／" +
  "破は八方位に丸め／時盤なし" +
  "（日盤の切り替えは流派で割れます。暦によっては日の星が違う日があります）";

/**
 * 九星気学（本命星・月命星・日命星と、指定日の年盤・月盤・日盤）。
 *
 * 算法は純関数（src/kyusei.ts）で、ここがやるのは 4 つだけ ――
 * 出生の瞬間の出どころを決める / wasm で太陽黄経と前後の至を出す / 見る日を決める /
 * **出生側から `switch`・`days_since_switch` を落とす**。
 * エンジンを叩くのは `swe_calc_ut` 2〜4 回（出生と対象日の太陽、時刻不明ならその日の端 2 つ）と
 * `swe_solcross_ut` 8 回（出生側と対象日側で冬至・夏至を 2 本ずつ）。
 *
 * 出生データは返事に出さない ―― 出すのは派生値（星・遁・盤・殺）だけ。
 */
async function runKyusei(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const resolved = await resolveBirthMoment(args, context, KYUSEI_BIRTH_OPTIONS);
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
  let birth: KyuseiBirthView;
  try {
    birth = computeKyuseiBirth(swe, birthMoment, resolved.timeKnown);
  } catch (error) {
    // 純関数の言い分には出生データの値が混じり得るので、そのままは返さない
    if (error instanceof KyuseiError) {
      throw new AstroError(
        "その出生データからは九星を出せませんでした" +
          "（九星気学は西暦 1〜9999 年の生年月日で見ます。値は返事に出しません）。",
      );
    }
    throw error;
  }
  const natalStars: NatalStars = { honmei: birth.honmei.number, getsumei: birth.getsumei.number };

  // 対象日は「その土地の時計の読み」で見る（日盤の日界 0 時も、至を丸める暦もここで決まる）
  const targetMoment = momentFromDate(day.at, dateOffset);
  const targetJd = julianDay(swe, momentFromUtcDate(day.at));
  const targetSunLon = sunLongitude(swe, targetMoment);
  const pillars = fourPillars(targetMoment, targetSunLon);

  let yearBoard: KyuseiBoardView;
  let monthBoard: KyuseiBoardView;
  let dayBoard: KyuseiBoardView;
  let dayView: DayStarView;
  try {
    const solarYear = isBeforeRisshun(targetSunLon, targetMoment.month)
      ? targetMoment.year - 1
      : targetMoment.year;
    const yearCenter = yearStar(solarYear);
    const monthCenter = monthStar(yearCenter, monthBranchOrder(targetSunLon));
    dayView = dayStar(day.date, solsticesAround(swe, targetJd, dateOffset));
    yearBoard = buildKyuseiBoard("year", yearCenter, pillars.year, natalStars);
    monthBoard = buildKyuseiBoard("month", monthCenter, pillars.month, natalStars);
    dayBoard = buildKyuseiBoard("day", dayView.star, pillars.day, natalStars);
  } catch (error) {
    // こちらの言い分に出るのは**呼び出した側が打った日付**なので、そのまま返してよい
    if (error instanceof KyuseiError) throw new AstroError(error.message);
    throw error;
  }

  const dateLabel = `${day.date.year}-${pad(day.date.month)}-${pad(day.date.day)}`;
  const calendarNote = dateOffset === 0 ? "UTC の暦" : `${formatOffsetLabel(dateOffset)} の暦`;
  const heading =
    resolved.source === "chart"
      ? `チャート: ${resolved.label}（${resolved.chartId}）`
      : "出生データ: 直接指定（値は返事に出しません）";
  const switchLabel =
    `${dayView.switch.kind === "winter" ? "冬至" : "夏至"}に最も近い甲子 ` +
    `${dayView.switch.year}-${pad(dayView.switch.month)}-${pad(dayView.switch.day)} から ` +
    `${dayView.days_since_switch} 日（切り替え当日が 0）`;

  const lines: string[] = [
    "九星気学（年界 立春・月界 節・日界 0 時・陽遁陰遁は至に最も近い甲子）",
    heading,
    KYUSEI_NO_READING_NOTE,
    "",
    "■ 本命星・月命星・日命星",
    `本命星: ${birth.honmei.name} / 月命星: ${birth.getsumei.name} / ` +
      `日命星: ${birth.nichimei.star.name}（${birth.nichimei.dun}）`,
  ];
  const alternatives = birth.alternatives;
  if (alternatives) {
    const candidates: string[] = [];
    if (alternatives.start.honmei.number !== alternatives.end.honmei.number) {
      candidates.push(`本命星は ${alternatives.start.honmei.name} か ${alternatives.end.honmei.name}`);
    }
    if (alternatives.start.getsumei.number !== alternatives.end.getsumei.number) {
      candidates.push(
        `月命星は ${alternatives.start.getsumei.name} か ${alternatives.end.getsumei.name}`,
      );
    }
    lines.push(
      `※ 立春／節入りの当日の生まれで出生時刻が無いため、${candidates.join("、")} のどちらか。` +
        "hour / minute を付けると確定します",
    );
  }

  lines.push(
    "",
    `■ 対象日 ${dateLabel}（${calendarNote}）`,
    `対象の瞬間: ${formatUtcMoment(day.at)}` +
      (dateOffset === 0 ? "" : ` / ローカル ${formatLocalMoment(day.at, dateOffset)}`) +
      (day.isNow
        ? "（現在時刻）"
        : day.hasTime
          ? ""
          : "（時刻の指定が無いので 0 時で見ています）"),
    "",
    kyuseiBoardText(`年盤 ${yearBoard.ganzhi}年`, yearBoard),
    "",
    kyuseiBoardText(`月盤 ${monthBoard.ganzhi}月`, monthBoard),
    "",
    kyuseiBoardText(`日盤 ${dayBoard.ganzhi}日`, dayBoard),
    `遁: ${dayView.dun}（${switchLabel}）`,
    "",
    KYUSEI_SYSTEM_LINE,
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "kyusei",
      source: resolved.source,
      ...(resolved.source === "chart"
        ? { chart_id: resolved.chartId, label: resolved.label }
        : {}),
      birth,
      date: {
        date: dateLabel,
        utc: day.at.toISOString(),
        local: formatPlainMoment(day.at, dateOffset),
        utc_offset: dateOffset,
        is_now: day.isNow,
        has_time: day.hasTime,
        year: yearBoard,
        month: monthBoard,
        day: {
          ...dayBoard,
          dun: dayView.dun,
          switch: dayView.switch,
          days_since_switch: dayView.days_since_switch,
        },
      },
      conventions: KYUSEI_CONVENTIONS,
    },
  };
}

export const kyuseiTool: AstroTool = {
  definition: {
    name: "kyusei",
    title: "九星気学（本命星・月命星・日命星と年盤・月盤・日盤）",
    description:
      "九星気学の本命星・月命星・日命星と、指定した日の年盤・月盤・日盤を計算する。\n" +
      "**chart_id か、生年月日の直接指定（year / month / day）のどちらか一方**で呼ぶ。" +
      "**出生時刻は任意**——hour / minute が無くても本命星・月命星は出る" +
      "（時刻の分からない出生でも引ける。省いたときはその日の 12 時を仮に置いている）。" +
      "ただし**立春・節入りの当日**に生まれた人は時刻で星が変わるので、" +
      "そのときだけ両方の候補を alternatives に添える（hour / minute を付ければ確定する）。\n" +
      "返るのは (1) 本命星（立春で切った年）・月命星（節で切った月）・日命星（陽遁／陰遁）、" +
      "(2) date（省略すると今）の年盤・月盤・日盤" +
      "（後天定位に中宮からの差を配ったもの。9 宮は 北・北東・東・南東・南・南西・西・北西・中宮 の順、" +
      "図は南を上・東を左に描く）と、各盤に立つ殺 9 種" +
      "（五黄殺・暗剣殺・歳破／月破／日破・本命殺・本命的殺・月命殺・月命的殺）。" +
      "date は**過去も未来も受ける**。\n" +
      PRINCIPLE_CONVENTIONS_ARE_NAMED +
      "年界は立春（節分までは 1 つ前の年の星）/ 月界は節（太陽黄経 30° ごと）/ 日界は 0 時 / " +
      "陽遁・陰遁は**冬至・夏至に最も近い甲子日**で切り替え（前後が同距離なら後の甲子）/ " +
      "**閏遁は置かない**（切り替えの間隔が 240 日になる期間もそのまま続ける）/ " +
      "破は支の対冲を**八方位に丸めた**もの（四隅の宮では 60° のうち 30° だけが実際の破に当たる）/ " +
      "**時盤は持たない**。" +
      "⚠ **日盤の切り替えは流派で割れる**ので、暦によっては日の星がこのサーバーと違う日がある。\n" +
      "**このツールは解釈をしない**——吉方位も凶方位も相性も、九星や殺の意味もサーバーに載せていない" +
      "（「五黄殺」「歳破」は計算上の名前で、吉凶の言葉は 1 語も足していない）。" +
      READ_WITH_YOUR_OWN_KNOWLEDGE +
      "。" +
      PRINCIPLE_NO_SUMMING +
      "——並べて眺めるのはよいが、点数を足したり多数決を取ったりしない。\n" +
      "九星気学も誕生日を使うので公開のカード層には置いていない。この鍵つきの入口だけにある。" +
      "出生データそのものは返事に出さない（星・盤・殺のような派生値だけを返す）。",
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
            "year / month / day は 3 つそろえて指定する（chart_id とは併用できない）",
        },
        month: { type: "integer", minimum: 1, maximum: 12, description: "出生月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "出生日（1-31）" },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description:
            "出生時刻の「時」（0-23、出生地の現地時刻）。**任意**——" +
            "省くとその日の 12 時で見る（立春・節入りの当日の生まれのときだけ星が変わるので、" +
            "そのときは両方の候補を添える）",
        },
        minute: {
          type: "integer",
          minimum: 0,
          maximum: 59,
          description: "出生時刻の「分」（0-59、出生地の現地時刻）。任意",
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
            '年盤・月盤・日盤を見る日 "YYYY-MM-DD"、時刻まで決めたいときは "YYYY-MM-DD HH:MM"' +
            "（省略すると今）。過去も未来も受ける。時盤は無いので、時刻は月界・日界の境の判定にだけ効く",
        },
        date_utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "date と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）。" +
            "日盤の日界（0 時）も陽遁・陰遁の切り替えの甲子日も、この時差の土地の暦で見る",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runKyusei,
};
