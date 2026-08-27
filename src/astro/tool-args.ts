/**
 * 占星術層のツール引数の検算（astro-mcp.ts から切り出した共通部品）。
 *
 * 型と範囲だけを見て、天文学的な妥当性はエンジンに任せる ―― という持ち場は元のまま。
 * 断り文（AstroError のメッセージ）も受ける範囲も動かしていない。
 */
import { AstroError, HOUSE_SYSTEM_CODES } from "./chart";
import { type BodySet } from "./events";
import { DEFAULT_MASTERS, MASTERS_OPTIONS, type MastersOption } from "../numerology";
import { MAX_PARTIES, MIN_PARTIES } from "../pillars-relations";

// ---------------------------------------------------------------------------
// 引数の検算（型と範囲だけ見る。天文学的な妥当性はエンジンに任せる）
// ---------------------------------------------------------------------------

export function argsOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AstroError("arguments はオブジェクトで渡してください");
  }
  return raw as Record<string, unknown>;
}

/**
 * 断り文の末尾に**来た値を書き添えるか**（2026-08-27 査読 I-1）。
 *
 * 既定は "show" ―― 対象日・オーブ・日数のような引数は、何を渡したかが分からないと直しようがない。
 * 出生データの引数（year / month / day / hour / minute / utc_offset / lat / lng）だけは "hide"。
 * 鯖の約束は「返事（テキスト・structuredContent・**エラー文**）に出生データそのものを出さない」で、
 * 範囲を外した打ち間違いもまた出生データの候補には違いないため。
 */
type ValueEcho = "show" | "hide";

/** 断り文の末尾（値を出す／出さない） */
function echoTail(echo: ValueEcho, value: unknown): string {
  return echo === "show" ? `: ${String(value)}` : "（値は返事に出しません）";
}

function numberArg(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  echo: ValueEcho,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    // 型違いは値を書いていない（もともと書いていなかった）ので echo を見る必要が無い
    throw new AstroError(`${key} は数値で指定してください`);
  }
  if (value < min || value > max) {
    throw new AstroError(
      `${key} は ${min} 以上 ${max} 以下で指定してください${echoTail(echo, value)}`,
    );
  }
  return value;
}

function integerArg(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  echo: ValueEcho,
): number | undefined {
  const value = numberArg(args, key, min, max, echo);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new AstroError(`${key} は整数で指定してください${echoTail(echo, value)}`);
  }
  return value;
}

export function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  return numberArg(args, key, min, max, "show");
}

export function requireNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = optionalNumber(args, key, min, max);
  if (value === undefined) throw new AstroError(`${key} は必須です`);
  return value;
}

export function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  return integerArg(args, key, min, max, "show");
}

export function requireInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = optionalInteger(args, key, min, max);
  if (value === undefined) throw new AstroError(`${key} は必須です`);
  return value;
}

// ---------------------------------------------------------------------------
// 出生データの引数（断り文に値を書かない版。2026-08-27 査読 I-1）
// ---------------------------------------------------------------------------

/**
 * 出生データの数値引数（utc_offset / lat / lng）。範囲外でも**値を書き返さない**。
 * 受け付ける範囲そのものは断り文に出す ―― それは呼び出し側が渡した値ではないため。
 */
export function optionalBirthNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  return numberArg(args, key, min, max, "hide");
}

export function requireBirthNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = optionalBirthNumber(args, key, min, max);
  if (value === undefined) throw new AstroError(`${key} は必須です`);
  return value;
}

/** 出生データの整数引数（year / month / day / hour / minute）。同上 */
export function optionalBirthInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  return integerArg(args, key, min, max, "hide");
}

export function requireBirthInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = optionalBirthInteger(args, key, min, max);
  if (value === undefined) throw new AstroError(`${key} は必須です`);
  return value;
}

export function optionalString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new AstroError(`${key} は文字列で指定してください`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new AstroError(`${key} は ${maxLength} 文字以内にしてください`);
  }
  return trimmed;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new AstroError(`${key} は true / false で指定してください`);
  return value;
}

export function requireString(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = optionalString(args, key, maxLength);
  if (value === undefined) throw new AstroError(`${key} は必須です（空文字は不可）`);
  return value;
}

const BODY_SETS: readonly BodySet[] = ["all", "no_moon", "outer"];

/** transit_events の bodies（動く側の天体の組）。既定は all */
export function requireBodySet(args: Record<string, unknown>): BodySet {
  const value = optionalString(args, "bodies", 12) ?? "all";
  if (!BODY_SETS.includes(value as BodySet)) {
    throw new AstroError(
      `bodies は ${BODY_SETS.join(" / ")} のいずれかにしてください: ${value}` +
        `（all＝太陽〜冥王星の 10 天体 / no_moon＝月を除く 9 天体 / outer＝木星〜冥王星）`,
    );
  }
  return value as BodySet;
}

/** calculate_numerology の masters（マスターナンバーの規約）。既定は 11_22_33 */
export function requireMasters(args: Record<string, unknown>): MastersOption {
  const value = optionalString(args, "masters", 16) ?? DEFAULT_MASTERS;
  if (!MASTERS_OPTIONS.includes(value as MastersOption)) {
    throw new AstroError(
      `masters は ${MASTERS_OPTIONS.join(" / ")} のどちらかです: ${value}`,
    );
  }
  return value as MastersOption;
}

/**
 * chart_id の配列（pillars_relations の charts）。長さ・型・重複をここで弾く。
 *
 * 台帳を引く前に重複を落としておく ―― 同じ人を 2 回並べた盤面は
 * 「自分の空亡に自分の地支が入る」を人と人の関係として数えてしまい、意味が変わるため。
 */
export function requireChartIds(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    throw new AstroError(
      `${key} は chart_id の配列で指定してください（${MIN_PARTIES}〜${MAX_PARTIES} 枚）`,
    );
  }
  if (value.length < MIN_PARTIES || value.length > MAX_PARTIES) {
    throw new AstroError(
      `${key} は ${MIN_PARTIES}〜${MAX_PARTIES} 枚で指定してください: ${value.length} 枚` +
        `（1 枚なら four_pillars、2 枚以上の盤面がこのツールの持ち場です）`,
    );
  }
  const ids = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new AstroError(`${key}[${index}] は文字列（chart_id）で指定してください`);
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) throw new AstroError(`${key}[${index}] が空です`);
    if (trimmed.length > 32) {
      throw new AstroError(`${key}[${index}] は 32 文字以内にしてください`);
    }
    return trimmed;
  });
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new AstroError(
      `${key} に同じチャート ${duplicate} が 2 つ入っています` +
        "（盤面に並べるのは別々のチャートです）",
    );
  }
  return ids;
}

export function requireHouseSystem(args: Record<string, unknown>): string {
  const value = optionalString(args, "house_system", 4) ?? "P";
  if (!HOUSE_SYSTEM_CODES.includes(value)) {
    throw new AstroError(
      `house_system は ${HOUSE_SYSTEM_CODES.join(" / ")} のいずれかにしてください: ${value}`,
    );
  }
  return value;
}
