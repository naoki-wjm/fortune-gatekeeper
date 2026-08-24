/**
 * 四柱の多者盤面（2〜4 人）の純関数。
 *
 * 背骨は four-pillars.ts と同じ ―― 乱数は 1 ビットも無く、**サーバーの仕事は「表引きの機械化」だけ**。
 * 2〜4 人の命式を横に並べ、日主・地支・空亡のつながりを名前で拾って返します。
 * 点数化も多数決も相性の良し悪しも載せません（合の数を数えて「相性 8 点」にするのは読む側の仕事ですらなく、
 * この鯖の持ち場の外）。読むのは呼び出した側の Claude です。
 *
 * 命式そのものは立てません ―― 立てるのは four-pillars.ts の `calculateFourPillars` で、
 * ここへは**その結果（4 柱の干支と空亡）だけ**が入ってきます。つまり wasm にも暦にも触りません。
 *
 * 表は借りられるものを借りています ――
 * 六合・六沖・天干五合は four-pillars.ts の判定関数、五行の生剋は nakko.ts の `relationOf`、
 * 地支の五行は nakko.ts の `branchElement`。ここで新しく持つのは**三合局と方合の 3 支の組だけ**です。
 *
 * 出生データそのものは扱いません（入ってくるのは干支＝派生値だけ）。
 */
import {
  branchYinYang,
  isBranchClash,
  isBranchHarmony,
  isStemCombination,
  stemElement,
  stemYinYang,
} from "./four-pillars";
import { BRANCHES, STEMS, branchElement, relationOf } from "./nakko";

/** 引数の形が受け付けられなかったときの言い分 */
export class PillarsRelationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PillarsRelationsError";
  }
}

/** 盤面に並べられる人数（下限・上限） */
export const MIN_PARTIES = 2;
export const MAX_PARTIES = 4;

/** 1 人ぶんの柱の数（年・月・日・時） */
const PILLAR_COUNT = 4;

/** 4 柱のうち日柱の位置（年・月・日・時 の 3 つ目） */
const DAY_PILLAR_INDEX = 2;

// ---------------------------------------------------------------------------
// 入り口の型（four-pillars.ts の返り値がそのまま通る形）
// ---------------------------------------------------------------------------

/** 1 柱ぶん（four-pillars.ts の PillarView がそのまま代入できる） */
export interface PartyPillarInput {
  /** 年柱 / 月柱 / 日柱 / 時柱 */
  label: string;
  stem: string;
  branch: string;
  ganzhi: string;
}

/** 盤面に並べる 1 人ぶん */
export interface PartyInput {
  /** 表示名（台帳のラベルなど。人を見分けるためだけの札） */
  label: string;
  /** **年・月・日・時の順**に 4 柱 */
  pillars: readonly PartyPillarInput[];
  /** 空亡（日柱の旬から。four-pillars.ts の VoidView がそのまま代入できる） */
  void: { decade: string; branches: readonly string[] };
}

// ---------------------------------------------------------------------------
// 返り値の型
// ---------------------------------------------------------------------------

/** 人を指す札（index は 1 始まり＝渡された順） */
export interface PartyRef {
  index: number;
  label: string;
}

/** 盤面に並んだ 1 人 */
export interface PartyView extends PartyRef {
  /** 日主（日柱の天干） */
  day_master: { stem: string; element: string; yin_yang: string };
  /** 年・月・日・時の順に 4 柱 */
  pillars: {
    label: string;
    stem: string;
    branch: string;
    ganzhi: string;
    branch_element: string;
    branch_yin_yang: string;
  }[];
  /** 空亡（2 支） */
  void: { decade: string; branches: string[] };
}

/** 日主どうしの五行の関係 */
export type DayMasterKind = "比和" | "相生" | "相剋";

/** 日主どうし（五行の関係＋天干五合） */
export interface DayMasterView {
  /** A の日主 / B の日主 */
  a: { stem: string; element: string };
  b: { stem: string; element: string };
  kind: DayMasterKind;
  /** 生む側・剋す側（比和なら null） */
  from: PartyRef | null;
  /** 生まれる側・剋される側（比和なら null） */
  to: PartyRef | null;
  /** 天干五合（「丁壬」など）。立っていなければ null */
  stem_combination: string | null;
}

/** 地支どうしの関係の種類（刑・害・破は持たない） */
export type BranchRelationKind = "六合" | "六沖" | "半合" | "同一支";

/** 一方の 1 柱 × 他方の 1 柱に立った関係 */
export interface BranchHit {
  kind: BranchRelationKind;
  /** 左（ペアの A 側）の柱 */
  a: { pillar: string; branch: string };
  /** 右（ペアの B 側）の柱 */
  b: { pillar: string; branch: string };
  /** 「寅亥」（支の index の小さいほうが先。同一支なら同じ字が 2 つ） */
  pair: string;
  /** 半合のときだけ、どの三合局の 2 支か（「亥卯未」） */
  group?: string;
  /** 半合のときだけ、その局の五行 */
  element?: string;
}

/** 「X の空亡に Y の地支が入る」1 件（X→Y の向き） */
export interface VoidHit {
  /** 空亡の持ち主 */
  owner: PartyRef;
  /** 地支が入る側 */
  target: PartyRef;
  /** 持ち主の空亡（2 支） */
  void_branches: string[];
  /** 入った柱（相手のどの柱でも見る） */
  hits: { pillar: string; branch: string }[];
}

/** 二者間ひとそろい */
export interface PairView {
  a: PartyRef;
  b: PartyRef;
  day_master: DayMasterView;
  /** 一方の各柱 × 他方の各柱の総当たり（立ったものだけ） */
  branches: BranchHit[];
  /** 双方向（立った向きだけ。最大 2 件） */
  voids: VoidHit[];
}

/** 持ち寄りの局の種類 */
export type GroupKind = "三合" | "方合";

/** 三合局・方合が 1 つ揃ったところ */
export interface GroupView {
  kind: GroupKind;
  /** 「亥卯未」 */
  name: string;
  /** 局の五行 */
  element: string;
  /** 単独（1 人で 3 支そろえている）か、持ち寄り（合同）か */
  formation: "単独" | "合同";
  /** 1 人で 3 支ぜんぶ出している人（合同なら空） */
  solo_parties: PartyRef[];
  /** 3 支それぞれを誰のどの柱が出しているか */
  branches: { branch: string; sources: { party: PartyRef; pillar: string }[] }[];
  /** 3 支のどれかを出している人（重複なし・渡された順） */
  parties: PartyRef[];
}

/** 空亡の有向辺（X の空亡に Y の地支が入る＝X→Y） */
export interface VoidEdge {
  from: PartyRef;
  to: PartyRef;
  /** 入った支（重複なし） */
  branches: string[];
}

/** 有向辺が閉じた環 */
export interface VoidCycle {
  /** 「相互」（2 人）／「三すくみ」（3 人）／「四すくみ」（4 人） */
  name: string;
  /** 環の順（末尾から先頭へ戻る） */
  parties: PartyRef[];
}

/** 空亡の連鎖（3 人以上のときだけ） */
export interface VoidChainView {
  edges: VoidEdge[];
  cycles: VoidCycle[];
}

/** 盤面ひとそろい */
export interface PillarsRelationsResult {
  parties: PartyView[];
  /** 全ペア（渡された順に i < j） */
  pairs: PairView[];
  /** 三合局・方合。**3 人以上のときだけ**（2 人ならペアの半合で足りる） */
  groups?: GroupView[];
  /** 空亡の連鎖。**3 人以上のときだけ** */
  void_chain?: VoidChainView;
  conventions: Record<string, string | string[]>;
}

// ---------------------------------------------------------------------------
// 台帳（三合局・方合）
// ---------------------------------------------------------------------------

/**
 * 三合局。**真ん中が旺支**（子午卯酉）になる並びで書いてあるので、局の五行は
 * `branchElement(真ん中)` で引ける ―― 五行の表を写し取らずに済む。
 * 支の index で見ると {r, r+4, r+8}（申子辰＝8/0/4、寅午戌＝2/6/10、亥卯未＝11/3/7、巳酉丑＝5/9/1）。
 */
const SANHE_GROUPS: readonly (readonly [string, string, string])[] = [
  ["申", "子", "辰"],
  ["寅", "午", "戌"],
  ["亥", "卯", "未"],
  ["巳", "酉", "丑"],
];

/**
 * 方合（方位の三会）。こちらは支が 3 つ並び（寅卯辰・巳午未・申酉戌・亥子丑）で、
 * やはり真ん中が旺支なので局の五行は `branchElement(真ん中)` で引ける。
 */
const FANGHE_GROUPS: readonly (readonly [string, string, string])[] = [
  ["寅", "卯", "辰"],
  ["巳", "午", "未"],
  ["申", "酉", "戌"],
  ["亥", "子", "丑"],
];

/** 環の長さ → 呼び名（2 人で閉じれば相互、3 人なら三すくみ） */
const CYCLE_NAMES: Readonly<Record<number, string>> = {
  2: "相互",
  3: "三すくみ",
  4: "四すくみ",
};

/**
 * 六親（nakko.ts の言葉）→ 日主どうしの関係。A を「我」として見たときの読み替え。
 * 兄弟＝比和／子孫＝A が B を生む／父母＝B が A を生む／妻財＝A が B を剋す／官鬼＝B が A を剋す。
 */
const DAY_MASTER_BY_RELATION: Readonly<
  Record<string, { kind: DayMasterKind; direction: "a_to_b" | "b_to_a" | null }>
> = {
  兄弟: { kind: "比和", direction: null },
  子孫: { kind: "相生", direction: "a_to_b" },
  父母: { kind: "相生", direction: "b_to_a" },
  妻財: { kind: "相剋", direction: "a_to_b" },
  官鬼: { kind: "相剋", direction: "b_to_a" },
};

// ---------------------------------------------------------------------------
// 規約（名前で固定して返り値にも書く）
// ---------------------------------------------------------------------------

/**
 * 採った規約。値が配列のものは「見る関係の一覧」で、載っていないものは**見ていない**という意味。
 * 刑・害・破を `excluded` に名前で書いてあるのは、「拾い忘れ」と「採らない」を読む側が区別できるように。
 */
export const PILLARS_RELATIONS_CONVENTIONS: Readonly<Record<string, string | string[]>> = {
  day_boundary: "midnight",
  night_zi: "not_used",
  void: "from_day_pillar",
  void_targets: "any_pillar_branch",
  day_master_relations: ["biwa", "xiangsheng", "xiangke", "tiangan_wuhe"],
  branch_relations: ["liuhe", "liuchong", "banhe", "same"],
  banhe: "any_two_of_sanhe",
  group_relations: ["sanhe", "fanghe"],
  group_scope: "all_parties_pooled",
  excluded: ["xing", "hai", "po"],
  scoring: "none",
};

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

/** 支の index（知らない支はここで弾く） */
function branchOrder(branch: string): number {
  const index = BRANCHES.indexOf(branch);
  if (index < 0) throw new PillarsRelationsError(`知らない地支です: ${branch}`);
  return index;
}

/** 「子丑」のように、支の index の小さいほうを先に並べる */
function orderedBranchPair(a: string, b: string): string {
  return branchOrder(a) <= branchOrder(b) ? `${a}${b}` : `${b}${a}`;
}

/** 「甲己」のように、干の index の小さいほうを先に並べる */
function orderedStemPair(a: string, b: string): string {
  return STEMS.indexOf(a) <= STEMS.indexOf(b) ? `${a}${b}` : `${b}${a}`;
}

/** 局の名前（「亥卯未」）と五行（真ん中＝旺支の五行） */
function groupNameOf(branches: readonly [string, string, string]): string {
  return branches.join("");
}

function groupElementOf(branches: readonly [string, string, string]): string {
  return branchElement(branches[1]);
}

/** 2 支が同じ三合局に入っていれば、その局を返す（半合の判定。同じ支どうしは半合にしない） */
function sanheGroupOf(a: string, b: string): readonly [string, string, string] | null {
  if (a === b) return null;
  for (const group of SANHE_GROUPS) {
    if (group.includes(a) && group.includes(b)) return group;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 検算（渡された盤面の形）
// ---------------------------------------------------------------------------

function assertParties(parties: readonly PartyInput[]): void {
  if (!Array.isArray(parties)) {
    throw new PillarsRelationsError("盤面に並べる人は配列で渡してください");
  }
  if (parties.length < MIN_PARTIES || parties.length > MAX_PARTIES) {
    throw new PillarsRelationsError(
      `盤面に並べられるのは ${MIN_PARTIES}〜${MAX_PARTIES} 人です: ${parties.length} 人`,
    );
  }
  parties.forEach((party, index) => {
    const where = `${index + 1} 人目`;
    if (typeof party?.label !== "string" || party.label.trim().length === 0) {
      throw new PillarsRelationsError(`${where}の表示名が空です`);
    }
    if (!Array.isArray(party.pillars) || party.pillars.length !== PILLAR_COUNT) {
      throw new PillarsRelationsError(
        `${where}の柱は年・月・日・時の ${PILLAR_COUNT} 本そろえて渡してください`,
      );
    }
    for (const pillar of party.pillars) {
      if (typeof pillar?.label !== "string" || pillar.label.length === 0) {
        throw new PillarsRelationsError(`${where}の柱名が空です`);
      }
      if (STEMS.indexOf(pillar.stem) < 0) {
        throw new PillarsRelationsError(`${where}の天干が読めません: ${pillar.stem}`);
      }
      branchOrder(pillar.branch);
    }
    if (!Array.isArray(party.void?.branches) || party.void.branches.length !== 2) {
      throw new PillarsRelationsError(`${where}の空亡は 2 支そろえて渡してください`);
    }
    for (const branch of party.void.branches) branchOrder(branch);
  });
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/** 人の札（index は 1 始まり） */
function refOf(parties: readonly PartyInput[], index: number): PartyRef {
  return { index: index + 1, label: (parties[index] as PartyInput).label };
}

/** 日柱（＝日主の出どころ） */
function dayPillarOf(party: PartyInput): PartyPillarInput {
  return party.pillars[DAY_PILLAR_INDEX] as PartyPillarInput;
}

function partyView(parties: readonly PartyInput[], index: number): PartyView {
  const party = parties[index] as PartyInput;
  const dayStem = dayPillarOf(party).stem;
  return {
    ...refOf(parties, index),
    day_master: {
      stem: dayStem,
      element: stemElement(dayStem),
      yin_yang: stemYinYang(dayStem),
    },
    pillars: party.pillars.map((pillar) => ({
      label: pillar.label,
      stem: pillar.stem,
      branch: pillar.branch,
      ganzhi: pillar.ganzhi,
      branch_element: branchElement(pillar.branch),
      branch_yin_yang: branchYinYang(pillar.branch),
    })),
    void: { decade: party.void.decade, branches: [...party.void.branches] },
  };
}

/** 日主どうし（五行の関係＋天干五合） */
function dayMasterView(
  a: PartyInput,
  b: PartyInput,
  refA: PartyRef,
  refB: PartyRef,
): DayMasterView {
  const stemA = dayPillarOf(a).stem;
  const stemB = dayPillarOf(b).stem;
  const elementA = stemElement(stemA);
  const elementB = stemElement(stemB);
  // 五行の生剋そのものは nakko.ts の relationOf に任せる（相生相剋の表を写し取らないため）
  const relation = relationOf(elementA, elementB);
  const read = DAY_MASTER_BY_RELATION[relation];
  if (!read) throw new PillarsRelationsError(`五行の組が読めません: ${relation}`);
  return {
    a: { stem: stemA, element: elementA },
    b: { stem: stemB, element: elementB },
    kind: read.kind,
    from: read.direction === null ? null : read.direction === "a_to_b" ? refA : refB,
    to: read.direction === null ? null : read.direction === "a_to_b" ? refB : refA,
    stem_combination: isStemCombination(stemA, stemB) ? orderedStemPair(stemA, stemB) : null,
  };
}

/**
 * 一方の各柱 × 他方の各柱の総当たり。
 *
 * 六合・六沖・半合・同一支をそれぞれ独立に見る（実際の十二支ではどれか 1 つしか立たないが、
 * 「立ったものを全部並べる」形にしておくほうが、表を足したときに取りこぼさない）。
 */
function branchHits(a: PartyInput, b: PartyInput): BranchHit[] {
  const hits: BranchHit[] = [];
  for (const left of a.pillars) {
    for (const right of b.pillars) {
      const where = {
        a: { pillar: left.label, branch: left.branch },
        b: { pillar: right.label, branch: right.branch },
        pair: orderedBranchPair(left.branch, right.branch),
      };
      if (isBranchHarmony(left.branch, right.branch)) hits.push({ kind: "六合", ...where });
      if (isBranchClash(left.branch, right.branch)) hits.push({ kind: "六沖", ...where });
      const group = sanheGroupOf(left.branch, right.branch);
      if (group) {
        hits.push({
          kind: "半合",
          ...where,
          group: groupNameOf(group),
          element: groupElementOf(group),
        });
      }
      if (left.branch === right.branch) hits.push({ kind: "同一支", ...where });
    }
  }
  return hits;
}

/** 「owner の空亡に target の地支が入る」1 件。入っていなければ null */
function voidHitOf(
  owner: PartyInput,
  target: PartyInput,
  ownerRef: PartyRef,
  targetRef: PartyRef,
): VoidHit | null {
  const voids = owner.void.branches;
  const hits = target.pillars
    .filter((pillar) => voids.includes(pillar.branch))
    .map((pillar) => ({ pillar: pillar.label, branch: pillar.branch }));
  if (hits.length === 0) return null;
  return { owner: ownerRef, target: targetRef, void_branches: [...voids], hits };
}

/** 3 支ぜんぶが盤面にそろっている局を拾う */
function groupsOf(
  parties: readonly PartyInput[],
  kind: GroupKind,
  table: readonly (readonly [string, string, string])[],
): GroupView[] {
  const found: GroupView[] = [];
  for (const group of table) {
    const branches = group.map((branch) => ({
      branch,
      sources: parties.flatMap((party, index) =>
        party.pillars
          .filter((pillar) => pillar.branch === branch)
          .map((pillar) => ({ party: refOf(parties, index), pillar: pillar.label })),
      ),
    }));
    if (branches.some((entry) => entry.sources.length === 0)) continue;

    // 1 人で 3 支ぜんぶ出している人は「単独で成立」の別枠（誰が出したかは下の branches に正直に残る）
    const solo = parties
      .map((party, index) => ({ party, index }))
      .filter(({ party }) =>
        group.every((branch) => party.pillars.some((pillar) => pillar.branch === branch)),
      )
      .map(({ index }) => refOf(parties, index));

    const contributors = parties
      .map((party, index) => ({ party, index }))
      .filter(({ party }) =>
        group.some((branch) => party.pillars.some((pillar) => pillar.branch === branch)),
      )
      .map(({ index }) => refOf(parties, index));

    found.push({
      kind,
      name: groupNameOf(group),
      element: groupElementOf(group),
      formation: solo.length > 0 ? "単独" : "合同",
      solo_parties: solo,
      branches,
      parties: contributors,
    });
  }
  return found;
}

/**
 * 有向辺の環をぜんぶ拾う（node は高々 4 つなので素朴な深さ優先で足りる）。
 *
 * 環の起点は「その環でいちばん小さい index」に固定する ―― A→B→A と B→A→B を
 * 同じ 1 本として数えるため。向きの違う環（A→B→C→A と A→C→B→A）は別物なので両方返す。
 */
function findCycles(size: number, edge: readonly boolean[][]): number[][] {
  const cycles: number[][] = [];
  const path: number[] = [];
  const walk = (start: number, node: number): void => {
    path.push(node);
    for (let next = start; next < size; next++) {
      if (!(edge[node] as boolean[])[next]) continue;
      if (next === start) {
        if (path.length >= 2) cycles.push([...path]);
        continue;
      }
      if (path.includes(next)) continue;
      walk(start, next);
    }
    path.pop();
  };
  for (let start = 0; start < size; start++) walk(start, start);
  return cycles;
}

/** 空亡の連鎖（有向辺と、閉じた環） */
function voidChainOf(parties: readonly PartyInput[]): VoidChainView {
  const size = parties.length;
  const edges: VoidEdge[] = [];
  const matrix: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  for (let owner = 0; owner < size; owner++) {
    for (let target = 0; target < size; target++) {
      if (owner === target) continue; // 自分の空亡に自分の地支が入るのは命式の中の話（four_pillars の持ち場）
      const hit = voidHitOf(
        parties[owner] as PartyInput,
        parties[target] as PartyInput,
        refOf(parties, owner),
        refOf(parties, target),
      );
      if (!hit) continue;
      edges.push({
        from: hit.owner,
        to: hit.target,
        branches: [...new Set(hit.hits.map((entry) => entry.branch))],
      });
      (matrix[owner] as boolean[])[target] = true;
    }
  }

  const cycles: VoidCycle[] = findCycles(size, matrix).map((cycle) => ({
    name: CYCLE_NAMES[cycle.length] ?? `${cycle.length} 人の環`,
    parties: cycle.map((index) => refOf(parties, index)),
  }));

  return { edges, cycles };
}

/**
 * 多者盤面を組み立てる。
 *
 * 乱数は使わない ―― 同じ命式を渡せば何度呼んでも同じ盤面が返る。
 * 点数も順位も付けない（合の数を数えて多い順に並べる、といったことはしない）。
 */
export function calculatePillarsRelations(
  parties: readonly PartyInput[],
): PillarsRelationsResult {
  assertParties(parties);

  const pairs: PairView[] = [];
  for (let i = 0; i < parties.length; i++) {
    for (let j = i + 1; j < parties.length; j++) {
      const a = parties[i] as PartyInput;
      const b = parties[j] as PartyInput;
      const refA = refOf(parties, i);
      const refB = refOf(parties, j);
      const voids: VoidHit[] = [];
      const forward = voidHitOf(a, b, refA, refB);
      if (forward) voids.push(forward);
      const backward = voidHitOf(b, a, refB, refA);
      if (backward) voids.push(backward);
      pairs.push({
        a: refA,
        b: refB,
        day_master: dayMasterView(a, b, refA, refB),
        branches: branchHits(a, b),
        voids,
      });
    }
  }

  const result: PillarsRelationsResult = {
    parties: parties.map((_unused, index) => partyView(parties, index)),
    pairs,
    conventions: { ...PILLARS_RELATIONS_CONVENTIONS },
  };

  // 持ち寄りと連鎖は 3 人以上のときだけ（2 人なら二者間の半合と空亡で言い尽くされている）
  if (parties.length >= 3) {
    result.groups = [
      ...groupsOf(parties, "三合", SANHE_GROUPS),
      ...groupsOf(parties, "方合", FANGHE_GROUPS),
    ];
    result.void_chain = voidChainOf(parties);
  }

  return result;
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** 「1. わーさん」 */
function nameOf(ref: PartyRef): string {
  return `${ref.index}. ${ref.label}`;
}

/** 1 人ぶんの並び */
function partyLine(party: PartyView): string {
  const pillars = party.pillars
    .map((pillar) => `${pillar.label} ${pillar.ganzhi}`)
    .join(" / ");
  return (
    `${nameOf(party)}  日主 ${party.day_master.stem}` +
    `（${party.day_master.yin_yang}${party.day_master.element}）  ` +
    `${pillars}  空亡 ${party.void.branches.join("・")}（${party.void.decade}）`
  );
}

/** 日主の 1 行 */
function dayMasterLine(pair: PairView): string {
  const view = pair.day_master;
  const head =
    `日主: ${pair.a.label} ${view.a.stem}（${view.a.element}）` +
    ` / ${pair.b.label} ${view.b.stem}（${view.b.element}）＝ ${view.kind}`;
  const arrow =
    view.from && view.to
      ? `（${view.from.label} が ${view.to.label} を${view.kind === "相生" ? "生む" : "剋す"}）`
      : "";
  const combination = view.stem_combination ? `／天干五合（${view.stem_combination}）` : "";
  return head + arrow + combination;
}

/** 地支の 1 行（左が A の柱・右が B の柱） */
function branchLine(hit: BranchHit): string {
  const tail = hit.group ? `（${hit.pair}・${hit.group}${hit.element}局の 2 支）` : `（${hit.pair}）`;
  return `  ${hit.a.pillar} ${hit.a.branch} × ${hit.b.pillar} ${hit.b.branch} ＝ ${hit.kind}${tail}`;
}

/** 空亡の 1 行 */
function voidLine(hit: VoidHit): string {
  const where = hit.hits.map((entry) => `${entry.pillar} ${entry.branch}`).join("・");
  return `  ${hit.owner.label} の空亡（${hit.void_branches.join("・")}）に ${hit.target.label} の ${where}`;
}

/** 局の 1 行 */
function groupLine(group: GroupView): string {
  const who =
    group.formation === "単独"
      ? `${group.solo_parties.map((party) => party.label).join("・")} 単独で成立`
      : "持ち寄りで成立";
  const sources = group.branches
    .map(
      (entry) =>
        `${entry.branch}＝` +
        entry.sources.map((source) => `${source.party.label}${source.pillar}`).join("・"),
    )
    .join(" / ");
  return `  ${group.name}（${group.element}局・${who}）: ${sources}`;
}

/**
 * Claude が読む用のテキスト表現。
 *
 * 命式の表そのものは four_pillars の持ち場なので、ここは 1 人 1 行の要約と、
 * 二者間・持ち寄り・空亡の連鎖だけを並べる。意味づけは載せない。
 */
export function formatPillarsRelationsText(result: PillarsRelationsResult): string {
  const lines = [`■ 四柱の多者盤面（${result.parties.length} 人）`];
  lines.push(...result.parties.map(partyLine));

  lines.push("");
  lines.push("■ 二者間（左の柱がひとり目、右の柱がふたり目）");
  for (const pair of result.pairs) {
    lines.push(`● ${nameOf(pair.a)} × ${nameOf(pair.b)}`);
    lines.push(`  ${dayMasterLine(pair)}`);
    if (pair.branches.length === 0) {
      lines.push("  地支: 六合・六沖・半合・同一支は立っていません");
    } else {
      lines.push(...pair.branches.map(branchLine));
    }
    if (pair.voids.length === 0) {
      lines.push("  空亡: どちらの空亡にも相手の地支は入っていません");
    } else {
      lines.push(...pair.voids.map(voidLine));
    }
  }

  if (result.groups) {
    for (const kind of ["三合", "方合"] as const) {
      const groups = result.groups.filter((group) => group.kind === kind);
      const heading =
        kind === "三合"
          ? "■ 三合局（全員の地支を持ち寄って 3 支）"
          : "■ 方合（全員の地支を持ち寄って 3 支）";
      lines.push("");
      lines.push(heading);
      if (groups.length === 0) {
        lines.push("  そろっている局はありません");
        continue;
      }
      // 持ち寄りを先に、単独で成立している局はそのあとに（別枠として読めるように）
      lines.push(...groups.filter((group) => group.formation === "合同").map(groupLine));
      lines.push(...groups.filter((group) => group.formation === "単独").map(groupLine));
    }
  }

  if (result.void_chain) {
    lines.push("");
    lines.push("■ 空亡の連鎖（X の空亡に Y の地支が入る＝X→Y）");
    if (result.void_chain.edges.length === 0) {
      lines.push("  互いの空亡に入る地支はありません");
    } else {
      for (const edge of result.void_chain.edges) {
        lines.push(`  ${edge.from.label} → ${edge.to.label}（${edge.branches.join("・")}）`);
      }
      for (const cycle of result.void_chain.cycles) {
        const loop = [...cycle.parties, cycle.parties[0] as PartyRef]
          .map((party) => party.label)
          .join(" → ");
        lines.push(`  環: ${cycle.name}（${loop}）`);
      }
      if (result.void_chain.cycles.length === 0) lines.push("  環（相互・三すくみ）は閉じていません");
    }
  }

  lines.push("");
  lines.push(
    "規約: 日界 0 時（夜子時は採らない）／空亡は日柱の旬から・相手のどの柱の地支も見る" +
      "／地支は六合・六沖・半合（三合の 2 支）・同一支／持ち寄りは三合局と方合" +
      "／刑・害・破は含めない／点数化も多数決もしない",
  );
  return lines.join("\n");
}
