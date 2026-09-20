/**
 * 数秘術の貼り付けテキスト（Astro Tool 様式）。
 *
 * 算法は純関数（src/numerology.ts）＝ MCP の科（tools/numerology.ts）と**同じ 1 か所**。
 * 乱数も天体計算も使わないので、エンジンは要りません。
 */
import {
  DEFAULT_MASTERS,
  calculateNumerology,
  formatNumerologyText,
  type MastersOption,
  type NumerologyResult,
  type TargetDate,
} from "../numerology";
import { dateLabelOf, pasteHeader } from "./paste-common";

/** 規約の 1 行（マスターの扱いだけ引数で動くので、残りはここに固定して持つ） */
const NUMEROLOGY_CONVENTION_HEAD = "ピタゴラス式 / 生年月日ベース";
const NUMEROLOGY_CONVENTION_TAIL = "パーソナルイヤーは暦年起点";

/** マスターの札（既定のときだけ「（既定）」と断る＝読む側が選び直せるように） */
function mastersLabel(masters: MastersOption): string {
  const numbers = masters === "11_22" ? "11・22" : "11・22・33";
  return masters === DEFAULT_MASTERS ? `マスター ${numbers}（既定）` : `マスター ${numbers}`;
}

export interface NumerologyPasteOptions {
  /** パーソナルイヤー／マンス／デイの基準日（省くとブラウザの「今日」） */
  target?: TargetDate;
  masters?: MastersOption;
}

export interface NumerologyPaste {
  result: NumerologyResult;
  text: string;
}

/** ブラウザの時計で読んだ今日（時差を受けないのは、見ている人の暦がそのまま基準日でよいため） */
function today(): TargetDate {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * 数秘術の貼り付けテキスト。
 *
 * 本文（`formatNumerologyText`）の末尾にも規約の行が付くが、それは**純関数が持っている**もので、
 * 2 行目の規約行とは持ち主が違う ―― どちらも名前で書いてあるので、そのまま重ねて出す。
 */
export function pasteNumerology(
  birth: { year: number; month: number; day: number },
  options: NumerologyPasteOptions = {},
): NumerologyPaste {
  const masters = options.masters ?? DEFAULT_MASTERS;
  const target = options.target ?? today();
  const result = calculateNumerology({ ...birth, target, masters });

  const lines = [
    ...pasteHeader(
      "数秘術",
      dateLabelOf(birth),
      `${NUMEROLOGY_CONVENTION_HEAD} / ${mastersLabel(masters)} / ${NUMEROLOGY_CONVENTION_TAIL}`,
    ),
    formatNumerologyText(result),
  ];

  return { result, text: lines.join("\n") };
}
