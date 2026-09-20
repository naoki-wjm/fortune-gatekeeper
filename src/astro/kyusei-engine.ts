/**
 * 九星気学の「天体グルー」＝純関数（src/kyusei.ts）にエンジンの答えを流し込む配線。
 *
 * もとは `src/astro/tools/kyusei.ts` の中に埋まっていたものを、
 * **鍵つき層の外からも同じ 1 か所を呼べるように**ここへ移しました（2026-09-20）。
 * ブラウザ用の束ね（src/browser/）も MCP の科（tools/kyusei.ts）も、星と盤を立てる道は
 * この 1 本だけ ―― 計算の正本を二重に持たない、というのがこのファイルの存在理由です。
 *
 * ここがやるのは 3 つ ―― 太陽黄経で年界・月界を切る / 前後の至を探して暦日へ丸める /
 * 盤を 1 枚ずつ組み立てる。表引きと算法は純関数の持ち場です。
 *
 * ⚠ KV にも身元にも触れません（`SwissEph` を引数で受けるだけ）。
 */
import {
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
  type CalendarDate,
  type DayStarView,
  type Dun,
  type Satsu,
  type SolsticeDay,
  type Star,
} from "../kyusei";
import {
  fourPillars,
  isBeforeRisshun,
  julianDayNumber,
  monthBranchOrder,
  sunLongitude,
  type NakkoMoment,
  type Pillar,
} from "../nakko";
import { AstroError, dateFromJulianDay, julianDay, type SwissEph } from "./chart";
import { crossUt } from "./returns";

/**
 * 至の探索の遡り幅（日）。
 *
 * 冬至も夏至も 1 年に 1 回なので、400 日戻れば必ず 1 本ずつ手前に入る
 * （回帰年 365.24 日 ＋ 余裕）。
 */
export const SOLSTICE_LOOKBACK_DAYS = 400;

/** 2 本目の至を探し始める幅（日）。1 本目の 300 日後から探せば、次の同じ至だけが窓に入る */
export const SOLSTICE_STEP_DAYS = 300;

/** 同じ至どうしの間隔として辻褄が合う長さ（日）＝回帰年 365.2422 の前後 */
export const SOLSTICE_GAP_MIN_DAYS = 364;
export const SOLSTICE_GAP_MAX_DAYS = 367;

/** 至の瞬間（UT のユリウス日）を**その土地の暦日**へ丸める（日界 0 時＝暦は現地の時計で読む） */
export function solsticeDayOf(
  kind: SolsticeDay["kind"],
  jd: number,
  utcOffset: number,
): SolsticeDay {
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
export function solsticesAround(swe: SwissEph, jd: number, utcOffset: number): SolsticeDay[] {
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
export interface NatalStars {
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
export function natalStarsAt(swe: SwissEph, moment: NakkoMoment): NatalStars {
  const lon = sunLongitude(swe, moment);
  const solarYear = isBeforeRisshun(lon, moment.month) ? moment.year - 1 : moment.year;
  const honmei = yearStar(solarYear);
  return { honmei, getsumei: monthStar(honmei, monthBranchOrder(lon)) };
}

/** 時刻が分からないときの両候補（その暦日の 0 時と 23:59） */
export interface KyuseiAlternatives {
  note: string;
  start: { local_time: string; honmei: Star; getsumei: Star };
  end: { local_time: string; honmei: Star; getsumei: Star };
}

/** 出生側の返り値（日命星は star と dun だけ＝下のコメント参照） */
export interface KyuseiBirthView {
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
 *    ⚠ ブラウザ用の束ねからもここを呼ぶ ―― 貼り付けテキストの中身を MCP とそろえるため、
 *      向こうでも落とした形のまま出す（利用者自身の入力なので隠す必要は無いが、
 *      「同じ 1 か所が同じものを返す」ほうを取っている）。
 */
export function computeKyuseiBirth(
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
export interface KyuseiBoardView {
  center: Star;
  ganzhi: string;
  branch: string;
  cells: BoardCell[];
  satsu: Satsu[];
}

/** 盤を 1 枚組み立てる（殺は破の名前が要るので kind と支を一緒に渡す） */
export function buildKyuseiBoard(
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

/** 対象日の 3 枚の盤と、日盤の遁（呼び出し側は「遁: …」の行にこれを使う） */
export interface KyuseiBoards {
  yearBoard: KyuseiBoardView;
  monthBoard: KyuseiBoardView;
  dayBoard: KyuseiBoardView;
  dayView: DayStarView;
}

/**
 * 対象日の年盤・月盤・日盤を 3 枚まとめて立てる。
 *
 * 年界（立春）と月界（節）は太陽黄経で切り、日盤の中宮は至に最も近い甲子日から数える。
 * エンジンを叩くのは `swe_calc_ut` 1 回（対象日の太陽）と `swe_solcross_ut` 4 回（冬至・夏至 2 本ずつ）。
 *
 * `targetJd`（至の探索の起点）と `targetDate`（日盤の暦日）を別に受けるのは、
 * 呼び出し側がもう持っているものを作り直さないため ―― `julianDay(swe, targetMoment)` と
 * 同じ値になる（現地の読み − 時差 ＝ UTC なので、どちらから作っても同じ瞬間を指す）。
 * 殺には本命星・月命星が要るので `natalStars` も一緒に受ける。
 */
export function computeKyuseiBoards(
  swe: SwissEph,
  targetMoment: NakkoMoment,
  targetJd: number,
  dateOffset: number,
  targetDate: CalendarDate,
  natalStars: NatalStars,
): KyuseiBoards {
  const targetSunLon = sunLongitude(swe, targetMoment);
  const pillars = fourPillars(targetMoment, targetSunLon);

  const solarYear = isBeforeRisshun(targetSunLon, targetMoment.month)
    ? targetMoment.year - 1
    : targetMoment.year;
  const yearCenter = yearStar(solarYear);
  const monthCenter = monthStar(yearCenter, monthBranchOrder(targetSunLon));
  const dayView = dayStar(targetDate, solsticesAround(swe, targetJd, dateOffset));

  return {
    yearBoard: buildKyuseiBoard("year", yearCenter, pillars.year, natalStars),
    monthBoard: buildKyuseiBoard("month", monthCenter, pillars.month, natalStars),
    dayBoard: buildKyuseiBoard("day", dayView.star, pillars.day, natalStars),
    dayView,
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
export function kyuseiBoardText(title: string, view: KyuseiBoardView): string {
  return [
    formatBoardText({ center: view.center, cells: view.cells }, title),
    formatKyuseiSatsuLine(view.satsu),
  ].join("\n");
}

/** 規約の 1 行（テキストの末尾に置く。structuredContent には KYUSEI_CONVENTIONS が丸ごと入る） */
export const KYUSEI_SYSTEM_LINE =
  "規約: 年界＝立春／月界＝節（太陽黄経）／日界＝0 時／" +
  "陽遁・陰遁＝冬至・夏至に最も近い甲子（同距離なら後）／閏遁なし／" +
  "破は八方位に丸め／時盤なし" +
  "（日盤の切り替えは流派で割れます。暦によっては日の星が違う日があります）";
