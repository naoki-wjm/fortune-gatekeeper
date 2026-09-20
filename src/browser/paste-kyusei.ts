/**
 * 九星気学の貼り付けテキスト（Astro Tool 様式）。
 *
 * 星と盤を立てるのは `src/astro/kyusei-engine.ts`＝ MCP の科（tools/kyusei.ts）と
 * **同じ 1 か所**で、ここがやるのは見出しと規約行を被せることだけです。
 * 出生側の日命星が star と dun だけなのも engine の持ち場の決めごと
 * ―― 中身を MCP とそろえるため、ブラウザでも落とした形のまま出します。
 */
import {
  KYUSEI_SYSTEM_LINE,
  computeKyuseiBirth,
  computeKyuseiBoards,
  kyuseiBoardText,
  type KyuseiBirthView,
  type KyuseiBoards,
  type NatalStars,
} from "../astro/kyusei-engine";
import { julianDay, type SwissEph } from "../astro/chart";
import type { NakkoMoment } from "../nakko";
import {
  calendarLabel,
  conventionsOf,
  dateLabelOf,
  momentLabel,
  pasteHeader,
} from "./paste-common";

/** 対象日（年盤・月盤・日盤を見る日） */
export interface KyuseiPasteTarget {
  moment: NakkoMoment;
}

export interface KyuseiPasteOptions {
  /** 出生時刻が分かっているか（既定は true）。false のとき立春・節入り当日なら両候補の注記が付く */
  timeKnown?: boolean;
  target?: KyuseiPasteTarget;
}

export interface KyuseiPaste {
  result: { birth: KyuseiBirthView; boards?: KyuseiBoards };
  text: string;
}

/** 本命星・月命星・日命星の 1 行（MCP と同文） */
function birthLine(birth: KyuseiBirthView): string {
  return (
    `本命星: ${birth.honmei.name} / 月命星: ${birth.getsumei.name} / ` +
    `日命星: ${birth.nichimei.star.name}（${birth.nichimei.dun}）`
  );
}

/**
 * 立春・節入り当日で時刻が分からないときの注記（MCP と同文）。
 * 動いた星だけを並べる ―― 本命星と月命星の両方が動く日もあれば、月命星だけの日もある。
 */
function alternativesLine(birth: KyuseiBirthView): string | null {
  const alternatives = birth.alternatives;
  if (!alternatives) return null;

  const candidates: string[] = [];
  if (alternatives.start.honmei.number !== alternatives.end.honmei.number) {
    candidates.push(`本命星は ${alternatives.start.honmei.name} か ${alternatives.end.honmei.name}`);
  }
  if (alternatives.start.getsumei.number !== alternatives.end.getsumei.number) {
    candidates.push(
      `月命星は ${alternatives.start.getsumei.name} か ${alternatives.end.getsumei.name}`,
    );
  }
  return (
    `※ 立春／節入りの当日の生まれで出生時刻が無いため、${candidates.join("、")} のどちらか。` +
    "hour / minute を付けると確定します"
  );
}

/**
 * 三星（と、`target` を渡したときは年盤・月盤・日盤）の貼り付けテキスト。
 *
 * 既定は最小構成＝出生側の三星だけ。盤は対象日を渡されたときだけ増える。
 */
export function pasteKyusei(
  swe: SwissEph,
  birth: NakkoMoment,
  options: KyuseiPasteOptions = {},
): KyuseiPaste {
  const timeKnown = options.timeKnown ?? true;
  const view = computeKyuseiBirth(swe, birth, timeKnown);

  const lines = [
    ...pasteHeader(
      "九星気学",
      momentLabel(birth, { time: timeKnown }),
      conventionsOf(KYUSEI_SYSTEM_LINE),
    ),
    "■ 本命星・月命星・日命星",
    birthLine(view),
  ];
  const note = alternativesLine(view);
  if (note) lines.push(note);

  const target = options.target;
  if (!target) return { result: { birth: view }, text: lines.join("\n") };

  const natalStars: NatalStars = { honmei: view.honmei.number, getsumei: view.getsumei.number };
  const boards = computeKyuseiBoards(
    swe,
    target.moment,
    julianDay(swe, target.moment),
    target.moment.utcOffset,
    { year: target.moment.year, month: target.moment.month, day: target.moment.day },
    natalStars,
  );
  const { yearBoard, monthBoard, dayBoard, dayView } = boards;
  const switchLabel =
    `${dayView.switch.kind === "winter" ? "冬至" : "夏至"}に最も近い甲子 ` +
    `${dateLabelOf(dayView.switch)} から ` +
    `${dayView.days_since_switch} 日（切り替え当日が 0）`;

  lines.push(
    "",
    `■ 対象日 ${dateLabelOf(target.moment)}（${calendarLabel(target.moment.utcOffset)}）`,
    "",
    kyuseiBoardText(`年盤 ${yearBoard.ganzhi}年`, yearBoard),
    "",
    kyuseiBoardText(`月盤 ${monthBoard.ganzhi}月`, monthBoard),
    "",
    kyuseiBoardText(`日盤 ${dayBoard.ganzhi}日`, dayBoard),
    `遁: ${dayView.dun}（${switchLabel}）`,
  );

  return { result: { birth: view, boards }, text: lines.join("\n") };
}
