/**
 * 誕生日から引く占術（数秘・宿曜・四柱・九星）の共通の受付
 * ―― astro-mcp.ts から切り出した共通部品。
 *
 * 「出生の瞬間を chart_id と直接指定のどちらから取るか」と、
 * 「日運を見る日をどう決めるか」の 2 つだけを持つ。
 *
 * ⚠ 出生の側の断り文には**渡された値を書かない**（2026-08-27 査読 I-1）。日運の側＝`parseFortuneDate`
 *    は検索の対象日なので今までどおり値を出す。
 */
import { toolError, type ToolResult } from "../mcp";
import { AstroError, type MomentInput } from "./chart";
import { assertBirthCalendarDay, assertCalendarDay, utcDateFromLocal } from "./calendar";
import { type AstroContext } from "./context";
import { MISSING_BIRTH_MESSAGE, missingChartMessage } from "../phrases";
import { getChart } from "./store";
import { optionalBirthInteger, optionalBirthNumber, optionalString } from "./tool-args";

/** 出生の瞬間と、その出どころ（返事の見出しに使う。値そのものは出さない） */
export interface BirthMoment {
  moment: MomentInput;
  /** chart=台帳が預かっているぶん / direct=呼び出しで直接指定されたぶん */
  source: "chart" | "direct";
  chartId?: string;
  label?: string;
  /**
   * 出生時刻が分かっているか。
   * timeOptional のツールで hour を省かれたときだけ false（moment には仮の 12 時が入っている）。
   */
  timeKnown: boolean;
}

/** 出生の瞬間の取り方をツールごとに変えるところ（断り文と、直接指定で受ける年の範囲） */
export interface BirthMomentOptions {
  /** 断り文に挟む理由（なぜ時刻まで要るのか／何が出生の日時で決まるのか） */
  reason: string;
  /** 直接指定で受ける年の下限・上限 */
  yearMin: number;
  yearMax: number;
  /**
   * 出生時刻を任意にする（既定は必須）。
   *
   * true のときは year / month / day の 3 つだけで受け、hour / minute が無ければ
   * **その日の 12 時**を仮の瞬間に置く（`timeKnown` に false を立てるので、
   * 呼び出し側は「時刻で答えが変わるか」を自分で確かめられる）。
   */
  timeOptional?: boolean;
}

/** 出生の 12 時（時刻不明のときに置く仮の瞬間。日の真ん中なので前後に丸め幅が等しい） */
export const BIRTH_NOON_HOUR = 12;

/** 「どちらか一方を指定してください」の断り文（時刻が任意かどうかで挙げる引数が変わる） */
export function missingBirthSourceMessage(options: BirthMomentOptions): string {
  if (options.timeOptional) {
    return (
      "chart_id か year / month / day を指定してください" +
      "（登録済みのチャートから引くなら chart_id、登録せずに一度だけ見るなら生年月日。" +
      "出生時刻 hour / minute は分かれば添えてください）"
    );
  }
  return (
    "chart_id か year / month / day / hour / minute を指定してください" +
    "（登録済みのチャートから引くなら chart_id、登録せずに一度だけ見るなら生年月日と出生時刻）"
  );
}

/** 「そろえて指定してください」の断り文（同上） */
export function missingBirthFieldsMessage(options: BirthMomentOptions): string {
  if (options.timeOptional) {
    return (
      "生年月日は year / month / day の 3 つをそろえて指定してください" +
      `（${options.reason}）。` +
      `出生時刻（hour / minute）は任意で、省くとその日の ${BIRTH_NOON_HOUR} 時で見ます` +
      "（立春・節入りの当日の生まれのときだけ時刻で星が変わるので、両方の候補を添えます）。" +
      "utc_offset も省略でき、そのときは UTC 扱いです"
    );
  }
  return (
    "生年月日と出生時刻は year / month / day / hour / minute の 5 つをそろえて指定してください" +
    `（${options.reason}、` +
    "時刻の分からない出生では引けません。utc_offset だけは省略でき、そのときは UTC 扱いです）"
  );
}

/**
 * 出生の瞬間（時刻まで）をどこから取るかを決める。宿曜と四柱推命の共通の入り口。
 *
 * calculate_numerology の resolveNumerologyBirth と同じ規則（chart_id か直接指定のどちらか一方）だが、
 * **時刻まで要る**のが違い ―― 宿も時柱も出生時刻で変わるので、時刻不明の出生は受けない。
 * 「なぜ時刻が要るのか」だけツールごとに違うので options.reason で差し替える。
 *
 * 例外は `options.timeOptional`（九星気学）―― 星は年・月・日で決まるので時刻不明でも引ける。
 * その場合だけ hour / minute を省いてよく、省かれたら 12 時を仮に置いて `timeKnown` を false にする。
 */
export async function resolveBirthMoment(
  args: Record<string, unknown>,
  context: AstroContext,
  options: BirthMomentOptions,
): Promise<BirthMoment | { error: ToolResult }> {
  const chartId = optionalString(args, "chart_id", 32);
  // 出生の 6 つは「値を書き返さない」ほうで受ける（範囲外の打ち間違いも出生日の候補には違いない）
  const year = optionalBirthInteger(args, "year", options.yearMin, options.yearMax);
  const month = optionalBirthInteger(args, "month", 1, 12);
  const day = optionalBirthInteger(args, "day", 1, 31);
  const hour = optionalBirthInteger(args, "hour", 0, 23);
  const minute = optionalBirthInteger(args, "minute", 0, 59);
  const utcOffset = optionalBirthNumber(args, "utc_offset", -14, 14);
  const givenBirth = [year, month, day, hour, minute, utcOffset].filter(
    (value) => value !== undefined,
  ).length;

  if (chartId !== undefined && givenBirth > 0) {
    throw new AstroError(
      "chart_id と出生データ（year / month / day / hour / minute / utc_offset）は、" +
        "どちらか一方にしてください" +
        "（登録済みのチャートから引くなら chart_id、登録せずに一度だけ見るなら生年月日と時刻）",
    );
  }

  if (chartId === undefined) {
    if (givenBirth === 0) {
      throw new AstroError(missingBirthSourceMessage(options));
    }
    if (year === undefined || month === undefined || day === undefined) {
      throw new AstroError(missingBirthFieldsMessage(options));
    }
    if (!options.timeOptional && (hour === undefined || minute === undefined)) {
      throw new AstroError(missingBirthFieldsMessage(options));
    }
    assertBirthCalendarDay(year, month, day);
    return {
      moment: {
        year,
        month,
        day,
        // 時刻任意のツールで hour が無いときだけ、日の真ん中（12 時）を仮に置く
        hour: hour ?? BIRTH_NOON_HOUR,
        minute: minute ?? 0,
        utcOffset: utcOffset ?? 0,
      },
      source: "direct",
      timeKnown: hour !== undefined,
    };
  }

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return {
      error: toolError(missingChartMessage(chartId)),
    };
  }
  const birth = chart.birth;
  if (!birth) {
    return {
      error: toolError("このチャートには" + MISSING_BIRTH_MESSAGE),
    };
  }
  return {
    moment: {
      year: birth.year,
      month: birth.month,
      day: birth.day,
      hour: birth.hour,
      minute: birth.minute,
      utcOffset: birth.utc_offset,
    },
    source: "chart",
    chartId,
    label: chart.label,
    // 台帳は時刻まで預かっている（save_chart が hour / minute を必須にしている）
    timeKnown: true,
  };
}

/**
 * 日運を見る瞬間（date / date_utc_offset から決めたもの）。
 * 宿曜と四柱推命で共用する（どちらも「date は省略すると今、時刻を省けばその日の 0 時」の流儀）。
 */
export interface FortuneDay {
  /** 見る瞬間（UTC） */
  at: Date;
  /** その瞬間を含む暦日（date_utc_offset の暦） */
  date: { year: number; month: number; day: number };
  /** 時刻まで指定されたか（date に時刻が無ければ 0 時で見る） */
  hasTime: boolean;
  /** date を省いて「今」になったか */
  isNow: boolean;
  utcOffset: number;
}

/** "YYYY-MM-DD" または "YYYY-MM-DD HH:MM"（区切りは半角空白でも T でもよい） */
export function parseFortuneDate(raw: string, utcOffset: number): FortuneDay {
  const matched = /^(-?\d{1,5})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(raw);
  if (!matched) {
    throw new AstroError(
      `date は "YYYY-MM-DD" か "YYYY-MM-DD HH:MM" の形で指定してください` +
        `（例: 2026-08-22 / 2026-08-22 08:30）: ${raw}`,
    );
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new AstroError(`date の月日が暦の範囲を外れています（月は 1〜12、日は 1〜31）: ${raw}`);
  }
  assertCalendarDay(year, month, day);

  const hasTime = matched[4] !== undefined;
  const hour = hasTime ? Number(matched[4]) : 0;
  const minute = hasTime ? Number(matched[5]) : 0;
  if (hour > 23 || minute > 59) {
    throw new AstroError(`date の時刻が範囲を外れています（時は 0〜23、分は 0〜59）: ${raw}`);
  }

  return {
    at: utcDateFromLocal(year, month, day, hour, minute, utcOffset),
    date: { year, month, day },
    hasTime,
    isNow: false,
    utcOffset,
  };
}

/** date を省いたとき＝「今」。暦日は date_utc_offset の土地の暦で決める */
export function fortuneDayFromNow(now: Date, utcOffset: number): FortuneDay {
  const shifted = new Date(now.getTime() + utcOffset * 3_600_000);
  return {
    at: now,
    date: {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    },
    hasTime: true,
    isNow: true,
    utcOffset,
  };
}
