/**
 * 日時まわりの道具（astro-mcp.ts から切り出した共通部品）。
 *
 * 暦の実在検算・UTC とローカルの往復・表示の整形と、暦月の頭の jd。
 * 文言も丸め方も元のまま ―― 置き場所だけを移した。
 */
import { AstroError, julianDay, type MomentInput, type SwissEph } from "./chart";

// ---------------------------------------------------------------------------
// 日時まわり
// ---------------------------------------------------------------------------

export function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** 各月の日数（[0] は 1 月。2 月だけうるう年で伸びる） */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** グレゴリオ暦のうるう年（4 で割り切れ、100 で割り切れない、または 400 で割り切れる） */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** その月の日数（swe_julday はグレゴリオ暦固定＝GREGORIAN で呼んでいるので暦もそれに合わせる） */
export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] as number;
}

/** その年月日が暦に実在するか（月は 1〜12 で検算済みという前提） */
export function isCalendarDay(year: number, month: number, day: number): boolean {
  return day >= 1 && day <= daysInMonth(year, month);
}

/**
 * 実在しない暦日を弾く。
 *
 * 日の範囲（1〜31）だけでは 2026-02-31 が通ってしまい、`swe_julday` はそれを黙って
 * 3 月 3 日に繰り上げる ―― 打ち間違いが「別の日の図」として静かに返ってくるのが困る。
 * ⚠ 呼ぶ相手を選ぶこと: **検索の対象日**にだけ使う（メッセージに日付が出る）。
 *    出生の年月日には使わない ―― 利用者が渡した引数であっても、値を出さない
 *    `assertBirthCalendarDay` のほうを使う（2026-08-27 査読 I-1）。
 */
export function assertCalendarDay(year: number, month: number, day: number): void {
  if (isCalendarDay(year, month, day)) return;
  throw new AstroError(
    `${year}-${pad(month)}-${pad(day)} は暦に存在しない日付です` +
      `（${year}年${month}月は${daysInMonth(year, month)}日まで）`,
  );
}

/**
 * 出生の年月日の実在検算の断り文（**値を含まない固定文**）。
 *
 * 出生データは「返事（テキスト・structuredContent・**エラー文**）に出さない」が鯖の約束なので、
 * 打ち間違いをそのまま書き返すと、その 1 行で原本が会話ログに残ってしまう
 * ―― 打ち間違いの日付も出生日の候補には違いない。
 */
export const BIRTH_CALENDAR_DAY_MESSAGE =
  "出生の年月日が暦に存在しない組み合わせです（月は 1〜12、日はその月の日数まで）。" +
  "値は返事に出しませんので、渡した年月日を手元で確かめてください";

/**
 * 実在しない**出生の**暦日を弾く（`assertCalendarDay` の値を出さない版）。
 *
 * 見ているものは `assertCalendarDay` と同じで、違うのは断り文だけ。
 * 検索の対象日（transit の year/month/day、`date`、moon_calendar の start）は
 * 出生データではないので、そちらは今までどおり値を出すほうを使う
 * ―― どの日を見に行ったのかが分からないと、打ち間違いの直しようがないため。
 */
export function assertBirthCalendarDay(year: number, month: number, day: number): void {
  if (isCalendarDay(year, month, day)) return;
  throw new AstroError(BIRTH_CALENDAR_DAY_MESSAGE);
}

/** UTC の Date を「2026-08-20 02:15 UTC」に */
export function formatUtcMoment(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** 時差 → 「UTC+9」「UTC+5.5」 */
export function formatOffsetLabel(utcOffset: number): string {
  const sign = utcOffset >= 0 ? "+" : "-";
  const absolute = Math.abs(utcOffset);
  const label = Number.isInteger(absolute) ? String(absolute) : absolute.toFixed(1);
  return `UTC${sign}${label}`;
}

/** UTC の Date ＋ 時差を「2026-08-20 11:15」に（時差の札は付けない） */
export function formatPlainMoment(utcDate: Date, utcOffset: number): string {
  const shifted = new Date(utcDate.getTime() + utcOffset * 3_600_000);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/** UTC の Date ＋ 時差を「2026-08-20 11:15（UTC+9）」に */
export function formatLocalMoment(utcDate: Date, utcOffset: number): string {
  return `${formatPlainMoment(utcDate, utcOffset)}（${formatOffsetLabel(utcOffset)}）`;
}

/** 「YYYY-MM-DD」だけの開始日（transit_events の start）。月日の範囲もここで弾く */
export function parseStartDate(raw: string): { year: number; month: number; day: number } {
  const matched = /^(-?\d{1,5})-(\d{2})-(\d{2})$/.exec(raw);
  if (!matched) {
    throw new AstroError(
      `start は "YYYY-MM-DD" の形で指定してください（例: 2026-08-20）: ${raw}`,
    );
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new AstroError(`start の月日が暦の範囲を外れています（月は 1〜12、日は 1〜31）: ${raw}`);
  }
  assertCalendarDay(year, month, day);
  return { year, month, day };
}

/** Date（UTC）→ julianDay に渡せる MomentInput（時差 0） */
export function momentFromUtcDate(date: Date): MomentInput {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes() + date.getUTCSeconds() / 60,
    utcOffset: 0,
  };
}

/** ローカルの暦日時から UTC の Date を作る（year < 100 でも 1900 年台に化けないように） */
export function utcDateFromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  utcOffset: number,
): Date {
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, 0, 0);
  return new Date(local.getTime() - utcOffset * 3_600_000);
}

/** その瞬間を utcOffset の暦で見た日の 0 時（UTC の Date で返す） */
export function startOfLocalDay(now: Date, utcOffset: number): Date {
  const shifted = new Date(now.getTime() + utcOffset * 3_600_000);
  return utcDateFromLocal(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    0,
    0,
    utcOffset,
  );
}

/** その暦月の頭（0 時 0 分）の jd。utcOffset を渡すとその土地の暦での月初になる */
export function monthStartJd(swe: SwissEph, year: number, month: number, utcOffset: number): number {
  return julianDay(swe, { year, month, day: 1, hour: 0, minute: 0, utcOffset });
}
