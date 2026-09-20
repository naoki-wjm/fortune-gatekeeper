/**
 * サビアン度数の貼り付けテキスト（Astro Tool 様式）。
 *
 * 度数の切り上げは純関数（src/sabian.ts）の持ち場。ここは天体の札を横に並べるだけです。
 * **シンボルの文言は載せません** ―― 広く知られた体系なので、読みは受け取った側の知識に委ねます。
 */
import { formatDegree } from "../astro/chart";
import { SABIAN_CONVENTION, sabianDegreeOf, type SabianDegree } from "../sabian";
import { pasteHeader } from "./paste-common";

/** 規約の 1 行（丸め方と、シンボルを持たないこと） */
export const SABIAN_CONVENTION_LINE =
  `${SABIAN_CONVENTION.rounding_label} / シンボルの文言は載せない`;

/** 1 天体ぶんの入力（札と黄経。ASC / MC のような感受点でもよい） */
export interface SabianEntry {
  label: string;
  lon: number;
}

export interface SabianPaste {
  result: (SabianEntry & { sabian: SabianDegree })[];
  text: string;
}

/**
 * 天体の黄経をサビアン度数に直して並べる。
 *
 * 1 行は `太陽 牡牛座 14°30′ → 牡牛座 15 度（通し 45）` ――
 * **元の度分を残したまま**サビアンを添えるのは、切り上げで 1 ずれて見えるのが
 * 規約のせいだと貼られた側が確かめられるようにするため。
 */
export function pasteSabian(entries: readonly SabianEntry[]): SabianPaste {
  const result = entries.map((entry) => ({ ...entry, sabian: sabianDegreeOf(entry.lon) }));
  const lines = [
    ...pasteHeader("サビアン度数", `${result.length} 天体`, SABIAN_CONVENTION_LINE),
    ...result.map(
      (entry) =>
        `${entry.label} ${formatDegree(entry.lon)} → ${entry.sabian.label}` +
        `（通し ${entry.sabian.serial}）`,
    ),
  ];
  return { result, text: lines.join("\n") };
}
