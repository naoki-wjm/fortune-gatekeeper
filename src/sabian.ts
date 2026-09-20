/**
 * サビアン度数（黄経 → 「牡牛座 15 度」）の純関数。
 *
 * **シンボルの文言は持ちません** ―― サビアンは広く知られた体系なので、
 * このサーバーの他の既知体系（タロット・ルーン・宿曜・四柱）と同じ扱いで**度数の名前だけ**を返し、
 * 「〜のシンボルは…」の読みは受け取った側の知識に委ねます。
 * 日本語訳の文言そのものに権利の問題があるのも、載せない理由の 1 つです。
 *
 * 規約は**切り上げ**の 1 つだけ ―― 0°00′〜0°59′ が 1 度、29°00′〜29°59′ が 30 度。
 * サビアンは「その度数の『中』にいる」という数え方をするので、度数の通し番号は
 * 星座内の度数を切り捨ててから 1 を足した値になります（切り捨てて 0〜29 にする流儀ではない）。
 *
 * 乱数も出生データも天体計算も使いません（黄経の数値を 1 つ受けるだけ）。
 */
import { SIGNS, normalizeDegree } from "./astro/chart";

/** 1 星座ぶんの度数 */
const DEGREES_PER_SIGN = 30;

/** サビアン度数 1 つぶん */
export interface SabianDegree {
  /** 星座（0 = 牡羊座） */
  sign_index: number;
  /** 星座の日本語名（`SIGNS` と同じ札） */
  sign: string;
  /** 星座の中の度数（1〜30）。切り上げ規約なので 0 度は存在しない */
  degree: number;
  /** 牡羊座 1 度を 1 とした通し番号（1〜360） */
  serial: number;
  /** 「牡牛座 15 度」 */
  label: string;
}

/** このサーバーが採った規約（名前で固定して返す＝鯖の憲法 第 2 条） */
export const SABIAN_CONVENTION = {
  rounding: "ceil",
  rounding_label: "切り上げ＝0°00′〜0°59′ が 1 度",
  symbols: "載せない（既知の体系なので読む側の知識で）",
} as const;

/**
 * 黄経（度）→ サビアン度数。
 *
 * 負の値も 360 以上の値も `normalizeDegree` で 0 以上 360 未満に畳んでから見ます
 * （−1 は 359 と同じ＝魚座 30 度）。
 */
export function sabianDegreeOf(lon: number): SabianDegree {
  const normalized = normalizeDegree(lon);
  const signIndex = Math.floor(normalized / DEGREES_PER_SIGN);
  const degree = Math.floor(normalized % DEGREES_PER_SIGN) + 1;
  const sign = SIGNS[signIndex] as string;
  return {
    sign_index: signIndex,
    sign,
    degree,
    serial: signIndex * DEGREES_PER_SIGN + degree,
    label: `${sign} ${degree} 度`,
  };
}
