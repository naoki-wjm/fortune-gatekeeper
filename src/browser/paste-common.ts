/**
 * 貼り付けテキストの共通部品（Astro Tool 様式の見出しと日時の札）。
 *
 * divination（静的サイト）が LLM に貼るテキストの形を、Astro Tool（astro-viewer）の
 * コピー用テキストにそろえるための道具です ――
 *
 *   1 行目  `【種別】入力条件`
 *   2 行目  `規約: …`（名前で。流派が割れるところを読む側が確かめられるように）
 *   空行
 *   以降    1 行 1 項目・まとまりは `■ 節`
 *
 * **中身（何を出すか）は MCP の返事と同じ、見た目だけ Astro Tool と同じ**、が約束です。
 * 貼り付けテキストは利用者自身の入力なので、MCP の「出生データの値を返事に出さない」約束は
 * ここには掛かりません（ブラウザの中で完結し、貼るかどうかを決めるのは利用者自身）。
 */
import { dateFromJulianDay } from "../astro/chart";
import type { NakkoMoment } from "../nakko";

/** 2 桁ゼロ詰め（日付・時刻の札づくり用） */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 時差 → 表示の札。
 *
 * Astro Tool の `tzLabelOf` と同じ規則で、**名前が付くのは JST だけ**、あとは UTC±n。
 * 半端な時差（インドの 5.5 など）も「UTC+5.5」と小数のまま書く（Astro Tool の tzLabelOf と字面をそろえる）
 * ―― 小数のままだと時計の読みに見えないため（Astro Tool は小数のままだが、
 * こちらは誕生日系で 30 分・45 分の時差を扱うので、分に直すほうを採った）。
 */
export function tzLabel(utcOffset: number): string {
  if (utcOffset === 9) return "JST";
  return `UTC${utcOffset >= 0 ? "+" : ""}${utcOffset}`;
}

/** 暦日だけの札（`1990-05-15`） */
export function dateLabelOf(date: { year: number; month: number; day: number }): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/**
 * 瞬間の札（`1990-05-15 12:30 JST`）。
 *
 * `time: false` を渡すと時刻を伏せて `1990-05-15 JST（時刻不明）` になる
 * ―― 九星のように**出生時刻が任意**の占術で、時刻を仮に置いていることを黙らせないため。
 */
export function momentLabel(moment: NakkoMoment, options: { time?: boolean } = {}): string {
  const date = dateLabelOf(moment);
  const zone = tzLabel(moment.utcOffset);
  if (options.time === false) return `${date} ${zone}（時刻不明）`;
  return `${date} ${pad(moment.hour)}:${pad(moment.minute)} ${zone}`;
}

/** 「その土地の暦で見ている」の札（`JST の暦`）。対象日の見出しに添える */
export function calendarLabel(utcOffset: number): string {
  return `${tzLabel(utcOffset)} の暦`;
}

/** ユリウス日（UT）→ その土地の時計の札（`2026-08-22 18:19 JST`）。宿の切り替わり時刻などに */
export function jdLocalLabel(jd: number, utcOffset: number): string {
  const local = dateFromJulianDay(jd + utcOffset / 24);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} ${tzLabel(utcOffset)}`
  );
}

/**
 * 見出しの 2 行＋空行。
 *
 * ここだけは必ず通す ―― 1 行目と 2 行目の形が占術ごとにばらつくと、
 * 貼られた側（LLM）が「これは何の表か・どの流派か」を毎回読み直すことになるため。
 */
export function pasteHeader(kind: string, condition: string, conventions: string): string[] {
  return [`【${kind}】${condition}`, `規約: ${conventions}`, ""];
}

/** `規約: …` の 1 行から「規約: 」を剥がす（MCP 側の定数をそのまま使い回すため） */
export function conventionsOf(systemLine: string): string {
  return systemLine.replace(/^規約:\s*/, "");
}
