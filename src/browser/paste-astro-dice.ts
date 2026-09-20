/**
 * アストロダイスの貼り付けテキスト（Astro Tool 様式）。
 *
 * 振るのは純関数（src/astro-dice.ts）＝ MCP と**同じ 1 か所**。
 * 返るのは 天体 × 星座 × ハウス の名前と記号だけで、意味は載せません
 * ―― 広く知られた組み合わせなので、読みは受け取った側の知識に委ねます。
 */
import {
  formatAstroDiceText,
  rollAstroDice,
  type AstroDiceRoll,
} from "../astro-dice";
import { pasteHeader } from "./paste-common";

/** 規約の 1 行（面の数と、名前だけしか載せないこと） */
export const ASTRO_DICE_CONVENTION_LINE =
  "天体 12（10 天体＋ノース／サウスノード）・星座 12・ハウス 12 / 名前と記号だけ";

export interface AstroDicePaste {
  result: AstroDiceRoll[];
  text: string;
}

/** アストロダイスを振って貼り付けテキストにする（count は 1〜3 組。省くと 1 組） */
export function pasteAstroDice(count: number = 1): AstroDicePaste {
  const result = rollAstroDice(count);
  const lines = [
    ...pasteHeader("アストロダイス", `${result.length} 組`, ASTRO_DICE_CONVENTION_LINE),
    formatAstroDiceText(result),
  ];
  return { result, text: lines.join("\n") };
}
