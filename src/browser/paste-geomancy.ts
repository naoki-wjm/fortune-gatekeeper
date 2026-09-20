/**
 * ジオマンシーの貼り付けテキスト（Astro Tool 様式）。
 *
 * シールドチャートを立てるのは純関数（src/geomancy.ts）＝ MCP と**同じ 1 か所**。
 * 乱数を引くのは母卦 4 つぶんの 16 ビットだけで、娘・姪・証人・裁判官・和解者は
 * そこから完全に導出されます（＝乱数の量が答えの量より少ない、というのがこの占術の形）。
 */
import { castGeomancy, formatShieldChartText, type ShieldChart } from "../geomancy";
import { pasteHeader } from "./paste-common";

/** 規約の 1 行（どこまでが乱数で、どこからが導出かを名前で書く） */
export const GEOMANCY_CONVENTION_LINE =
  "乱数は母卦 4 つ（16 ビット）だけ / 娘・姪・証人・裁判官・和解者は導出 / 図形はラテン名";

export interface GeomancyPaste {
  result: ShieldChart;
  text: string;
}

/** シールドチャートを立てて貼り付けテキストにする（引数なし＝いつも同じ一式） */
export function pasteGeomancy(): GeomancyPaste {
  const result = castGeomancy();
  const lines = [
    ...pasteHeader("ジオマンシー", "シールドチャート", GEOMANCY_CONVENTION_LINE),
    formatShieldChartText(result),
  ];
  return { result, text: lines.join("\n") };
}
