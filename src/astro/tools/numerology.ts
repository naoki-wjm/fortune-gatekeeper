/**
 * 数秘術（calculate_numerology）。astro-mcp.ts から切り出したもので、中身は移動しただけ。
 *
 * 算法は純関数（src/numerology.ts）。ここがやるのは生年月日の出どころを決めることだけ。
 */
import { toolError, type ToolResult } from "../../mcp";
import {
  DEFAULT_MASTERS,
  MASTERS_OPTIONS,
  NumerologyError,
  calculateNumerology,
  formatNumerologyText,
  type NumerologyResult,
} from "../../numerology";
import { AstroError } from "../chart";
import { assertCalendarDay } from "../calendar";
import { type AstroContext, type AstroTool } from "../context";
import { getChart } from "../store";
import {
  argsOf,
  optionalInteger,
  optionalNumber,
  optionalString,
  requireMasters,
} from "../tool-args";

// ---------------------------------------------------------------------------
// 数秘術（誕生日から引く占術の 1 本目）
// ---------------------------------------------------------------------------

/** 数秘術に渡す生年月日と、その出どころ（返事の見出しと印に使う） */
interface NumerologyBirth {
  year: number;
  month: number;
  day: number;
  /** chart=台帳が預かっているぶん / direct=呼び出しで直接指定されたぶん */
  source: "chart" | "direct";
  /** source が chart のときだけ入る */
  chartId?: string;
  label?: string;
}

/**
 * 生年月日をどこから取るかを決める。
 *
 * **chart_id か year / month / day のどちらか一方**で、両方来たら断る（どちらを見るか勝手に決めない）。
 * 直接指定のときだけ暦の検算をここでする ―― 呼び出した側が打った値なので日付を出して断ってよい。
 * 預かっているぶんは登録時に検算済みで、こちらは値を返事に出さない約束がある。
 *
 * 見つからない・出生データが無いといった「断り」は toolError をそのまま包んで返す
 * （呼び出し側で `"error" in …` を見て素通しする）。
 */
async function resolveNumerologyBirth(
  args: Record<string, unknown>,
  context: AstroContext,
): Promise<NumerologyBirth | { error: ToolResult }> {
  const chartId = optionalString(args, "chart_id", 32);
  const year = optionalInteger(args, "year", 1, 9999);
  const month = optionalInteger(args, "month", 1, 12);
  const day = optionalInteger(args, "day", 1, 31);
  const givenBirth = [year, month, day].filter((value) => value !== undefined).length;

  if (chartId !== undefined && givenBirth > 0) {
    throw new AstroError(
      "chart_id と生年月日（year / month / day）は、どちらか一方にしてください" +
        "（登録済みのチャートから引くなら chart_id、登録せずに一度だけ見るなら生年月日）",
    );
  }

  if (chartId === undefined) {
    if (givenBirth === 0) {
      throw new AstroError(
        "chart_id か year / month / day を指定してください" +
          "（登録済みのチャートから引くなら chart_id、登録せずに一度だけ見るなら生年月日）",
      );
    }
    if (givenBirth !== 3) {
      throw new AstroError(
        "生年月日は year / month / day の 3 つをそろえて指定してください",
      );
    }
    assertCalendarDay(year as number, month as number, day as number);
    return {
      year: year as number,
      month: month as number,
      day: day as number,
      source: "direct",
    };
  }

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return {
      error: toolError(
        `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
          "save_chart で登録してください。",
      ),
    };
  }
  const birth = chart.birth;
  if (!birth) {
    return {
      error: toolError(
        "このチャートには出生データが入っていません（出生データを保存しない時代の登録です）。" +
          "delete_chart で消して save_chart で登録し直すと使えます。",
      ),
    };
  }
  return {
    year: birth.year,
    month: birth.month,
    day: birth.day,
    source: "chart",
    chartId,
    label: chart.label,
  };
}

/**
 * 数秘術を計算する（誕生日から引く占術の 1 本目）。
 *
 * 算法は純関数（src/numerology.ts）で、ここがやるのは**生年月日の出どころ**を決めることだけ ――
 * 台帳が預かっている出生データ（chart_id）か、呼び出しでの直接指定（year / month / day）。
 * 出生データを返事に出さない約束はどちらでも同じで、途中式に出るのは
 * 還元したあとの値と「生まれた日」（＝バースデーナンバー）だけ。年と月の生の数字は出ない。
 */
async function runCalculateNumerology(
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const resolved = await resolveNumerologyBirth(args, context);
  if ("error" in resolved) return resolved.error;

  const masters = requireMasters(args);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);
  const year = optionalInteger(args, "target_year", 1, 9999);
  const month = optionalInteger(args, "target_month", 1, 12);
  const day = optionalInteger(args, "target_day", 1, 31);
  const given = [year, month, day].filter((value) => value !== undefined).length;
  if (given !== 0 && given !== 3) {
    throw new AstroError(
      "基準日は target_year / target_month / target_day を 3 つそろえて指定してください" +
        "（3 つとも省くと今日で見ます）",
    );
  }
  if (given === 3) {
    assertCalendarDay(year as number, month as number, day as number);
  }

  // 基準日を省いたときだけ「今日」を決める（時差はそのためだけに使う）
  const now = context.now ? context.now() : new Date();
  const shifted = new Date(now.getTime() + (utcOffset ?? 0) * 3_600_000);
  const target =
    given === 3
      ? { year: year as number, month: month as number, day: day as number }
      : {
          year: shifted.getUTCFullYear(),
          month: shifted.getUTCMonth() + 1,
          day: shifted.getUTCDate(),
        };

  let result: NumerologyResult;
  try {
    result = calculateNumerology({
      year: resolved.year,
      month: resolved.month,
      day: resolved.day,
      target,
      masters,
    });
  } catch (error) {
    // 純関数の言い分には生年月日の値が混じり得るので、そのままは返さない
    if (error instanceof NumerologyError) {
      throw new AstroError(
        "その生年月日からは数秘術を計算できませんでした" +
          "（数秘術は西暦 1〜9999 年の生年月日で計算します。値は返事に出しません）。",
      );
    }
    throw error;
  }

  // 見出しの 1 行。直接指定のときは「どこから来た数か」だけを言い、生年月日の値は書かない
  const heading =
    resolved.source === "chart"
      ? `チャート: ${resolved.label}（${resolved.chartId}）`
      : "生年月日: 直接指定（値は返事に出しません）";

  return {
    content: [{ type: "text", text: `${heading}\n${formatNumerologyText(result)}` }],
    structuredContent:
      resolved.source === "chart"
        ? { source: resolved.source, chart_id: resolved.chartId, label: resolved.label, ...result }
        : { source: resolved.source, ...result },
  };
}

export const calculateNumerologyTool: AstroTool = {
  definition: {
    name: "calculate_numerology",
    title: "数秘術（生年月日から）",
    description:
      "生年月日から数秘術（ピタゴラス式）を計算する。" +
      "**登録済みチャートの chart_id か、生年月日の直接指定（year / month / day）のどちらか一方**で呼ぶ" +
      "——chart_id なら台帳が預かっている出生データを使うので生年月日を渡し直さなくてよく、" +
      "直接指定は登録せずに一度だけ見るときに使う。\n" +
      "数秘術は誕生日を使うので公開のカード層には置いていない。この鍵つきの入口だけにある。\n" +
      "乱数は使わない——ここでのサーバーの仕事は規約を固定すること。" +
      "ライフパスは流派（還元の規約）によって同じ生年月日から違う数が出る" +
      "（1986-12-29 は 11 にも 2 にもなる）ため、単一の答えではなく" +
      "名前つきの 4 経路と途中式を返す——" +
      "full_sum=全桁をまとめて足し最後の和でマスターを保持 / " +
      "component_reduce=年・月・日を 1 桁まで還元してから足す / " +
      "component_keep=年・月・日を還元するときマスターは保持して足す / " +
      "no_master=マスターを認めず 1 桁まで還元。\n" +
      "ほかにバースデーナンバー、アティチュードナンバー（サンナンバー＝月＋日）、" +
      "パーソナルイヤー／マンス／デイ（暦年起点＝1 月 1 日で切り替わる）も返す。" +
      "名前数秘（表現数・魂数など）・ピナクル・チャレンジは範囲外。\n" +
      "**出生データそのものは返事に出さない**（直接指定で呼んだときも同じ。" +
      "生まれた日だけはバースデーナンバーとして数字で出る。年と月は還元したあとの値しか出ない）。" +
      "chart_id で呼ぶとき、出生データを預かっていないチャート（保存しない時代の登録）では使えないので、" +
      "その旨だけを返す（delete_chart して save_chart で登録し直せば使える）。\n" +
      "このツールは解釈をしない——どの経路で読むかは呼び出した側" +
      "（あるいは占われる本人の流派）で決めること。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description:
            "対象のチャート ID（list_charts で確認できる）。" +
            "year / month / day とはどちらか一方だけを指定する",
        },
        year: {
          type: "integer",
          minimum: 1,
          maximum: 9999,
          description:
            "生年月日の年（西暦）。登録せずに一度だけ見るときの直接指定で、" +
            "year / month / day は 3 つそろえて指定する（chart_id とは併用できない）",
        },
        month: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "生年月日の月（1-12）",
        },
        day: {
          type: "integer",
          minimum: 1,
          maximum: 31,
          description: "生年月日の日（1-31）。暦に存在しない日付（2026-02-31 など）は断る",
        },
        target_year: {
          type: "integer",
          minimum: 1,
          maximum: 9999,
          description:
            "パーソナルイヤー／マンス／デイを見る基準日の年。" +
            "target_year / target_month / target_day は 3 つそろえて指定する。" +
            "3 つとも省略すると今日で見る。",
        },
        target_month: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "基準日の月（1-12）",
        },
        target_day: {
          type: "integer",
          minimum: 1,
          maximum: 31,
          description: "基準日の日（1-31）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "基準日を省いたとき「今日」をどの土地の暦で決めるか（時間単位。日本時間なら 9。" +
            "省略すると UTC）。target_* を指定したときは使わない",
        },
        masters: {
          type: "string",
          enum: MASTERS_OPTIONS,
          default: DEFAULT_MASTERS,
          description:
            "マスターナンバーとして扱う数（既定 11_22_33）。" +
            "11_22 にすると 33 を認めず 6 まで還元する。",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run: runCalculateNumerology,
};
