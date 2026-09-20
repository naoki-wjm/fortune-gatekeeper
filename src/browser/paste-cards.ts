/**
 * カードの貼り付けテキスト（Astro Tool 様式）。
 *
 * 引くのは純関数（src/draw.ts）＝ MCP と**同じ 1 か所**。
 * シャッフルも正逆も飛び出しも `crypto.getRandomValues`（src/random.ts）で決まります
 * ―― 「引いたふり」ができないように、引くのは常に機械側、という背骨はブラウザでも同じです。
 */
import { drawCards, formatDrawResult, type DrawOptions, type DrawResult } from "../draw";
import { pasteHeader } from "./paste-common";

/** 乱数の出どころ（MCP ではサーバー側の crypto、ここではブラウザの crypto） */
const SHUFFLE_SOURCE = "シャッフルはブラウザの乱数（crypto.getRandomValues）";

export interface DrawPaste {
  result: DrawResult;
  text: string;
}

/**
 * カードを引いて貼り付けテキストにする。
 *
 * 1 行目はスプレッドがあれば「デッキ / スプレッド名（N 枚）」、無ければ「デッキ / N 枚」。
 * 規約行に正逆と飛び出しの有無を書くのは、**同じ札でも読みが変わる**ところだから
 * ―― 貼られた側が「逆位置なしで引いたのか」を確かめられるようにしてある。
 */
export function pasteDraw(options: DrawOptions): DrawPaste {
  const result = drawCards(options);
  const count = result.cards.length;
  const condition = result.spread
    ? `${result.deck.name} / ${result.spread.name}（${count} 枚）`
    : `${result.deck.name} / ${count} 枚`;

  // 既定は draw.ts と同じ（どちらも省略時は true）
  const allowReversed = options.allow_reversed ?? true;
  const jumpOut = options.jump_out ?? true;
  const conventions =
    `正逆: ${allowReversed ? "あり" : "なし"} / ` +
    `飛び出し: ${jumpOut ? "あり" : "なし"} / ${SHUFFLE_SOURCE}`;

  const lines = [...pasteHeader("カード", condition, conventions), formatDrawResult(result)];
  return { result, text: lines.join("\n") };
}
