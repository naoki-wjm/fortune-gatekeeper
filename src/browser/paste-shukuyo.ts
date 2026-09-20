/**
 * 宿曜の貼り付けテキスト（Astro Tool 様式）。
 *
 * 宿を出すのは `src/astro/shukuyo-engine.ts`＝ MCP の科（tools/shukuyo.ts）と
 * **同じ 1 か所**で、ここがやるのは見出しと規約行を被せることだけです。
 *
 * ⚠ 呼ぶ前に `prepareEngine`（＝`swe_set_sid_mode(Lahiri)`）を通しておくこと。
 *    通し忘れると既定の Fagan-Bradley で計算され、宿が 1 つずれることがあります。
 */
import {
  SHUKUYO_SYSTEM_LINE,
  moonShukuChanges,
  shukuAtJd,
} from "../astro/shukuyo-engine";
import {
  AYANAMSA_NAME,
  compatOf,
  formatCompatLines,
  formatRelation,
  formatShukuLines,
  formatShukuName,
  relationOf,
  shukuAt,
  type ShukuCompat,
  type ShukuPosition,
  type Relation,
} from "../shukuyo";
import { julianDay, type SwissEph } from "../astro/chart";
import type { NakkoMoment } from "../nakko";
import {
  calendarLabel,
  conventionsOf,
  dateLabelOf,
  jdLocalLabel,
  momentLabel,
  pasteHeader,
} from "./paste-common";

/** 相性の規約行は宿曜の規約に「三九の秘法」を足したもの（関係の名前の出どころ） */
const COMPAT_CONVENTION_SUFFIX = " / 三九の秘法";

/** 見る日（日運） */
export interface ShukuyoPasteDate {
  moment: NakkoMoment;
}

export interface ShukuyoPasteOptions {
  date?: ShukuyoPasteDate;
}

/** 日運ひとそろい（その瞬間の宿・本命宿から見た関係・アヤナムシャ・その日の切り替わり） */
export interface ShukuyoPasteDay {
  date: string;
  utc_offset: number;
  ayanamsa: number;
  position: ShukuPosition;
  relation: Relation;
  changes: { jd: number; from: { name: string }; to: { name: string } }[];
}

export interface ShukuyoPaste {
  result: { natal: ShukuPosition; day?: ShukuyoPasteDay };
  text: string;
}

/**
 * 本命宿（と、`date` を渡したときはその日の宿）の貼り付けテキスト。
 *
 * 既定は最小構成＝本命宿だけ。日運は渡されたときだけ節が増える。
 * ⚠ 出生時のアヤナムシャは MCP と同じく出さない ―― 値そのものが生まれた年月の目盛りになるので、
 *    「貼る前に見返す」ときに余計な桁を持ち出さないほうに倒している。
 */
export function pasteShukuyo(
  swe: SwissEph,
  birth: NakkoMoment,
  options: ShukuyoPasteOptions = {},
): ShukuyoPaste {
  const natal = shukuAtJd(swe, julianDay(swe, birth)).position;

  const lines = [
    ...pasteHeader("宿曜", momentLabel(birth), conventionsOf(SHUKUYO_SYSTEM_LINE)),
    "■ 本命宿（出生時刻の月）",
    ...formatShukuLines(natal),
    "（月は 1 日でほぼ 1 宿ぶん動きます。宿内の位置が境界に近いときは、隣の宿も併せて見てください）",
  ];

  const date = options.date;
  if (!date) return { result: { natal }, text: lines.join("\n") };

  const moment = date.moment;
  const today = shukuAtJd(swe, julianDay(swe, moment));
  const relation = relationOf(natal.shuku.number - 1, today.position.shuku.number - 1);

  // その暦日（現地の 0 時〜24 時）の切り替わり
  const windowStartJd = julianDay(swe, { ...moment, hour: 0, minute: 0 });
  const changes = moonShukuChanges(swe, windowStartJd, windowStartJd + 1, today.ayanamsa);

  const calendar = calendarLabel(moment.utcOffset);
  lines.push(
    "",
    `■ その日の宿 ${dateLabelOf(moment)}（${calendar}）`,
    ...formatShukuLines(today.position),
    `本命宿から: ${formatRelation(relation)}`,
    `アヤナムシャ ${today.ayanamsa.toFixed(4)}°（${AYANAMSA_NAME}）`,
    "",
    `□ この日の宿の切り替わり（${calendar}の 0 時〜24 時）`,
  );
  if (changes.length === 0) {
    lines.push("この 24 時間のうちに宿は変わりません（月は 1 宿に 21〜27 時間ほど留まります）");
  } else {
    for (const change of changes) {
      lines.push(
        `${jdLocalLabel(change.jd, moment.utcOffset)} ` +
          `${change.from.name} → ${formatShukuName(change.to)}`,
      );
    }
  }

  return {
    result: {
      natal,
      day: {
        date: dateLabelOf(moment),
        utc_offset: moment.utcOffset,
        ayanamsa: today.ayanamsa,
        position: today.position,
        relation,
        changes,
      },
    },
    text: lines.join("\n"),
  };
}

/** 相性の片側。`index` は **0 起点**（`shukuOf(...).shuku.number - 1`＝婁宿が 0） */
export interface ShukuyoCompatParty {
  label: string;
  index: number;
}

export interface ShukuyoCompatPaste {
  result: ShukuCompat;
  text: string;
}

/**
 * 2 つの宿の関係（三九の秘法）の貼り付けテキスト。
 *
 * 宿の番号だけを受けるので、**相手の出生データを持ち出さずに済む**
 * （MCP の shukuyo_compat が宿名で呼べるのと同じ理屈）。
 */
export function pasteShukuyoCompat(
  a: ShukuyoCompatParty,
  b: ShukuyoCompatParty,
): ShukuyoCompatPaste {
  const compat = compatOf(a.index, b.index);
  const condition =
    `${a.label}（${shukuAt(a.index).name}） × ${b.label}（${shukuAt(b.index).name}）`;

  const lines = [
    ...pasteHeader(
      "宿曜・相性",
      condition,
      conventionsOf(SHUKUYO_SYSTEM_LINE) + COMPAT_CONVENTION_SUFFIX,
    ),
    ...formatCompatLines(compat, a.label, b.label),
  ];

  return { result: compat, text: lines.join("\n") };
}
