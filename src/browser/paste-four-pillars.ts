/**
 * 四柱推命の貼り付けテキスト（Astro Tool 様式）。
 *
 * 命式を立てるのは `src/astro/four-pillars-engine.ts`＝ MCP の科（tools/four-pillars.ts）と
 * **同じ 1 か所**で、ここがやるのは見出しと規約行を被せることだけです。
 */
import type { DateFortuneResult, FourPillarsResult } from "../four-pillars";
import { formatDateFortuneText, formatFourPillarsText } from "../four-pillars";
import { computeDateFortune, computeFourPillarsNatal } from "../astro/four-pillars-engine";
import type { SwissEph } from "../astro/chart";
import type { NakkoMoment } from "../nakko";
import { calendarLabel, dateLabelOf, momentLabel, pasteHeader } from "./paste-common";

/**
 * 規約の 1 行。
 *
 * MCP 側は description の中に散らして書いているので（定数になっていない）、
 * こちらは名前だけを拾い直して 1 本の定数にしてある ――
 * 流派が割れるのは 日界・節気の取り方・時刻補正・大運の向き・月律分野表の 5 つ。
 */
export const FOUR_PILLARS_CONVENTION_LINE =
  "子平 / 日界 0 時 / 節気は太陽黄経 / 時刻の補正なし / 大運は順行・逆行の両方 / " +
  "月律分野表は採らない";

/** 対象日（流年・月運・日運を見る日）。`includeHour` を立てると時運も出る */
export interface FourPillarsPasteTarget {
  moment: NakkoMoment;
  includeHour: boolean;
}

export interface FourPillarsPasteOptions {
  target?: FourPillarsPasteTarget;
}

export interface FourPillarsPaste {
  /** 純関数の返り値そのもの（＝ MCP の structuredContent と同じ形） */
  result: { natal: FourPillarsResult; date_fortune?: DateFortuneResult };
  text: string;
}

/**
 * 命式（と、`target` を渡したときは流年・月運・日運）の貼り付けテキスト。
 *
 * 既定は最小構成＝出生側の命式だけ。対象日は渡されたときだけ節が増える。
 * 純関数のエラー（`FourPillarsError`）はそのまま投げる ―― 表示するのはブラウザ側の仕事で、
 * MCP のように「値を隠す言い換え」に着せ替える必要が無いため（利用者自身の入力）。
 */
export function pasteFourPillars(
  swe: SwissEph,
  birth: NakkoMoment,
  options: FourPillarsPasteOptions = {},
): FourPillarsPaste {
  const natal = computeFourPillarsNatal(swe, birth);
  const lines = [
    ...pasteHeader("四柱推命", momentLabel(birth), FOUR_PILLARS_CONVENTION_LINE),
    formatFourPillarsText(natal),
  ];

  const target = options.target;
  if (!target) return { result: { natal }, text: lines.join("\n") };

  const fortune = computeDateFortune(swe, natal, target.moment, target.includeHour);
  lines.push(
    "",
    `■ 対象日 ${dateLabelOf(target.moment)}（${calendarLabel(target.moment.utcOffset)}）`,
  );
  if (!target.includeHour) {
    // MCP と同じ言い方（向こうは「対象の瞬間」の行の尻尾に付く）
    lines.push("（時刻の指定が無いので 0 時で見ています＝時運は出しません）");
  }
  lines.push(formatDateFortuneText(fortune));

  return { result: { natal, date_fortune: fortune }, text: lines.join("\n") };
}
