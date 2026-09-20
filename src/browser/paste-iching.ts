/**
 * 易占（＋納甲）の貼り付けテキスト（Astro Tool 様式）。
 *
 * 卦を立てるのは純関数（src/iching.ts）、納甲は src/nakko.ts ＝ MCP（src/mcp.ts）と
 * **同じ 1 か所**。乱数はブラウザの `crypto.getRandomValues`（src/random.ts）で引きます
 * ―― 「引いたふり」ができないように、振るのは常に機械側、という背骨はブラウザでも同じです。
 */
import { castHexagram, formatCastResult, type CastResult } from "../iching";
import { buildNakko, formatNakkoText, sunLongitude, type NakkoMoment, type NakkoView } from "../nakko";
import type { SwissEph } from "../astro/chart";
import { momentLabel, pasteHeader } from "./paste-common";

/** 規約の 1 行（易の本体ぶん）。何を出して何を出さないかを名前で書く */
export const ICHING_CONVENTION_LINE = "本卦・変爻・之卦・互卦 / 卦辞・爻辞は載せない";

/** 納甲を付けたときに足す規約（四柱と八宮・六親・六獣の流派） */
export const NAKKO_CONVENTION_SUFFIX =
  " / 納甲: 四柱＝日界 0 時・八宮は本宮から爻を順に返す算法・六親は宮の五行・" +
  "六獣は日干から・伏神なし";

/** 納甲を付けるときに要るもの（立卦の瞬間と、その瞬間の太陽黄経を出すエンジン） */
export interface HexagramPasteNakko {
  swe: SwissEph;
  moment: NakkoMoment;
}

export interface HexagramPasteOptions {
  /** 立て方（coins / yarrow / abridged。省くと擲銭法） */
  method?: string;
  nakko?: HexagramPasteNakko;
}

export interface HexagramPaste {
  result: CastResult & { nakko?: NakkoView };
  text: string;
}

/**
 * 卦を立てて貼り付けテキストにする。
 *
 * 既定は最小構成＝易の本文だけ。納甲は `nakko` を渡したときだけ節が増える。
 * 1 行目に立卦の日時が入るのも納甲ありのときだけ（納甲は日時で決まるため）。
 */
export function pasteHexagram(options: HexagramPasteOptions = {}): HexagramPaste {
  const result = castHexagram(options.method === undefined ? {} : { method: options.method });
  const nakkoOptions = options.nakko;

  if (!nakkoOptions) {
    const lines = [
      ...pasteHeader("易占", result.method.name, ICHING_CONVENTION_LINE),
      formatCastResult(result),
    ];
    return { result, text: lines.join("\n") };
  }

  const { swe, moment } = nakkoOptions;
  const nakko = buildNakko(result, moment, sunLongitude(swe, moment));
  const lines = [
    ...pasteHeader(
      "易占",
      `${result.method.name} ${momentLabel(moment)}`,
      ICHING_CONVENTION_LINE + NAKKO_CONVENTION_SUFFIX,
    ),
    formatCastResult(result),
    "",
    formatNakkoText(result, nakko),
  ];

  return { result: { ...result, nakko }, text: lines.join("\n") };
}
