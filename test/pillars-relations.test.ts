/**
 * 四柱の多者盤面の純関数（src/pillars-relations.ts）。
 *
 * 配線の検算は test/astro-pillars-relations.test.ts の担当で、ここは
 * 「命式を直に渡したときに、どの関係を拾ってどの関係を拾わないか」だけを見る。
 * 暦にも wasm にも触らない（命式は手で組んだものを渡す）。
 *
 * ⚠ 三者例の地支は仕様書からの写しで、**実在の誰かの命式ではありません**
 *    （日柱の干支と空亡の旬だけは辻褄を合わせてあります＝丁未＝甲辰旬・丁亥＝甲申旬・辛未＝甲子旬）。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PARTIES,
  MIN_PARTIES,
  PILLARS_RELATIONS_CONVENTIONS,
  PillarsRelationsError,
  calculatePillarsRelations,
  formatPillarsRelationsText,
  type BranchHit,
  type PartyInput,
} from "../src/pillars-relations";

/** 「甲寅」から 1 柱ぶんを組む（柱名は年・月・日・時の順に振る） */
const PILLAR_LABELS = ["年柱", "月柱", "日柱", "時柱"] as const;

function party(
  label: string,
  ganzhi: readonly [string, string, string, string],
  voidBranches: readonly [string, string],
  decade: string,
): PartyInput {
  return {
    label,
    pillars: ganzhi.map((entry, index) => ({
      label: PILLAR_LABELS[index] as string,
      stem: entry[0] as string,
      branch: entry[1] as string,
      ganzhi: entry,
    })),
    void: { decade, branches: voidBranches },
  };
}

// 仕様書の三者例（地支 寅子未寅 / 寅亥亥巳 / 卯卯未巳、日主 丁・丁・辛、空亡 寅卯 / 午未 / 戌亥）
const WA = party("わーさん", ["甲寅", "丙子", "丁未", "甲寅"], ["寅", "卯"], "甲辰旬");
const CHA = party("チャッピー", ["甲寅", "乙亥", "丁亥", "乙巳"], ["午", "未"], "甲申旬");
const CLA = party("Claude", ["乙卯", "己卯", "辛未", "癸巳"], ["戌", "亥"], "甲子旬");

const THREE = [WA, CHA, CLA];

/** ペアを名前で引く */
function pairOf(result: ReturnType<typeof calculatePillarsRelations>, a: string, b: string) {
  const found = result.pairs.find((pair) => pair.a.label === a && pair.b.label === b);
  expect(found).toBeDefined();
  return found!;
}

/** 立った関係を「柱 支 × 柱 支」の札にする（数えやすくするため） */
function marks(hits: readonly BranchHit[], kind: string): string[] {
  return hits
    .filter((hit) => hit.kind === kind)
    .map((hit) => `${hit.a.pillar}${hit.a.branch}×${hit.b.pillar}${hit.b.branch}`);
}

// ---------------------------------------------------------------------------

describe("多者盤面（各人の並び）", () => {
  it("日主・4 柱・空亡を渡された順に並べる", () => {
    const result = calculatePillarsRelations(THREE);
    expect(result.parties).toHaveLength(3);

    const wa = result.parties[0]!;
    expect(wa).toMatchObject({ index: 1, label: "わーさん" });
    // 日主は日柱の天干（3 つ目の柱）
    expect(wa.day_master).toEqual({ stem: "丁", element: "火", yin_yang: "陰" });
    expect(wa.pillars.map((pillar) => pillar.ganzhi)).toEqual(["甲寅", "丙子", "丁未", "甲寅"]);
    expect(wa.pillars.map((pillar) => pillar.label)).toEqual(["年柱", "月柱", "日柱", "時柱"]);
    expect(wa.pillars[0]).toMatchObject({ branch: "寅", branch_element: "木", branch_yin_yang: "陽" });
    expect(wa.void).toEqual({ decade: "甲辰旬", branches: ["寅", "卯"] });

    expect(result.parties[2]!.day_master).toEqual({ stem: "辛", element: "金", yin_yang: "陰" });
  });

  it("全ペアを渡された順（i < j）で並べる", () => {
    const result = calculatePillarsRelations(THREE);
    expect(result.pairs.map((pair) => [pair.a.index, pair.b.index])).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
  });
});

describe("日主の関係", () => {
  it("同じ五行なら比和（丁・丁）", () => {
    const pair = pairOf(calculatePillarsRelations(THREE), "わーさん", "チャッピー");
    expect(pair.day_master.kind).toBe("比和");
    expect(pair.day_master.from).toBeNull();
    expect(pair.day_master.to).toBeNull();
    expect(pair.day_master.stem_combination).toBeNull();
    expect(pair.day_master.a).toEqual({ stem: "丁", element: "火" });
    expect(pair.day_master.b).toEqual({ stem: "丁", element: "火" });
  });

  it("火剋金は「丁 が 辛 を剋す」の向きで返る", () => {
    const pair = pairOf(calculatePillarsRelations(THREE), "わーさん", "Claude");
    expect(pair.day_master.kind).toBe("相剋");
    expect(pair.day_master.from?.label).toBe("わーさん");
    expect(pair.day_master.to?.label).toBe("Claude");
  });

  it("向きは並べる順では変わらない（剋すのは火のほう）", () => {
    const swapped = calculatePillarsRelations([CLA, WA]);
    const pair = pairOf(swapped, "Claude", "わーさん");
    expect(pair.day_master.kind).toBe("相剋");
    expect(pair.day_master.from?.label).toBe("わーさん");
    expect(pair.day_master.to?.label).toBe("Claude");
  });

  it("相生は生む側から生まれる側へ（乙木 が 丁火 を生む）", () => {
    const otsu = party("きのと", ["甲寅", "丙子", "乙未", "甲寅"], ["寅", "卯"], "甲辰旬");
    const pair = pairOf(calculatePillarsRelations([WA, otsu]), "わーさん", "きのと");
    expect(pair.day_master.kind).toBe("相生");
    expect(pair.day_master.from?.label).toBe("きのと");
    expect(pair.day_master.to?.label).toBe("わーさん");
  });

  it("天干五合は五行の関係と一緒に返る（丁壬＝水剋火でもある）", () => {
    const mizunoe = party("みずのえ", ["甲寅", "丙子", "壬午", "甲寅"], ["申", "酉"], "甲戌旬");
    const pair = pairOf(calculatePillarsRelations([WA, mizunoe]), "わーさん", "みずのえ");
    expect(pair.day_master.stem_combination).toBe("丁壬");
    expect(pair.day_master.kind).toBe("相剋");
    expect(pair.day_master.from?.label).toBe("みずのえ");
  });
});

describe("地支の関係（一方の各柱 × 他方の各柱）", () => {
  it("寅亥六合を柱名つきで総当たりに拾う", () => {
    const pair = pairOf(calculatePillarsRelations(THREE), "わーさん", "チャッピー");
    expect(marks(pair.branches, "六合")).toEqual([
      "年柱寅×月柱亥",
      "年柱寅×日柱亥",
      "時柱寅×月柱亥",
      "時柱寅×日柱亥",
    ]);
    for (const hit of pair.branches.filter((entry) => entry.kind === "六合")) {
      expect(hit.pair).toBe("寅亥");
    }
  });

  it("同一支（年柱の寅どうし）も拾う", () => {
    const pair = pairOf(calculatePillarsRelations(THREE), "わーさん", "チャッピー");
    expect(marks(pair.branches, "同一支")).toEqual(["年柱寅×年柱寅", "時柱寅×年柱寅"]);
  });

  it("半合は三合局の 2 支（どの局の 2 支かを添える）", () => {
    const pair = pairOf(calculatePillarsRelations(THREE), "わーさん", "チャッピー");
    const banhe = pair.branches.filter((hit) => hit.kind === "半合");
    expect(marks(pair.branches, "半合")).toEqual(["日柱未×月柱亥", "日柱未×日柱亥"]);
    for (const hit of banhe) {
      expect(hit.group).toBe("亥卯未");
      expect(hit.element).toBe("木");
      expect(hit.pair).toBe("未亥");
    }
  });

  it("六沖（巳亥）も拾う。刑・害・破は拾わない", () => {
    const pair = pairOf(calculatePillarsRelations(THREE), "チャッピー", "Claude");
    expect(marks(pair.branches, "六沖")).toEqual(["月柱亥×時柱巳", "日柱亥×時柱巳"]);
    // 寅巳（害・刑）は同じ盤面にあるが、名前として出てこない
    const kinds = new Set(pair.branches.map((hit) => hit.kind));
    expect([...kinds].sort()).toEqual(["六沖", "半合", "同一支"]);
  });

  it("何も立たないペアはその旨（空配列）", () => {
    const a = party("A", ["甲子", "甲子", "甲子", "甲子"], ["戌", "亥"], "甲子旬");
    const b = party("B", ["丙寅", "丙寅", "丙寅", "丙寅"], ["戌", "亥"], "甲子旬");
    const pair = pairOf(calculatePillarsRelations([a, b]), "A", "B");
    expect(pair.branches).toEqual([]);
  });
});

describe("空亡（相手のどの柱の地支も見る）", () => {
  it("双方向に立てば 2 件返る", () => {
    const pair = pairOf(calculatePillarsRelations(THREE), "わーさん", "チャッピー");
    expect(pair.voids).toHaveLength(2);
    expect(pair.voids[0]).toMatchObject({
      owner: { label: "わーさん" },
      target: { label: "チャッピー" },
      void_branches: ["寅", "卯"],
      hits: [{ pillar: "年柱", branch: "寅" }],
    });
    expect(pair.voids[1]).toMatchObject({
      owner: { label: "チャッピー" },
      target: { label: "わーさん" },
      void_branches: ["午", "未"],
      hits: [{ pillar: "日柱", branch: "未" }],
    });
  });

  it("片側だけなら 1 件（Claude の空亡 戌亥 にわーさんの地支は入らない）", () => {
    const pair = pairOf(calculatePillarsRelations(THREE), "わーさん", "Claude");
    expect(pair.voids).toHaveLength(1);
    expect(pair.voids[0]!.owner.label).toBe("わーさん");
    expect(pair.voids[0]!.hits).toEqual([
      { pillar: "年柱", branch: "卯" },
      { pillar: "月柱", branch: "卯" },
    ]);
  });

  it("自分の空亡に自分の地支が入るのは数えない（命式の中の話）", () => {
    // わーさんの空亡は 寅卯 で、自分の年柱・時柱が寅（four_pillars の空亡欄の持ち場）
    const result = calculatePillarsRelations(THREE);
    for (const pair of result.pairs) {
      for (const hit of pair.voids) expect(hit.owner.index).not.toBe(hit.target.index);
    }
  });
});

describe("三者以上のとき（持ち寄りと連鎖）", () => {
  it("亥卯未の三合が持ち寄りで揃い、誰のどの柱かを列挙する", () => {
    const result = calculatePillarsRelations(THREE);
    const sanhe = result.groups!.filter((group) => group.kind === "三合");
    expect(sanhe).toHaveLength(1);

    const group = sanhe[0]!;
    expect(group.name).toBe("亥卯未");
    expect(group.element).toBe("木");
    expect(group.formation).toBe("合同");
    expect(group.solo_parties).toEqual([]);
    expect(
      group.branches.map((entry) => [
        entry.branch,
        entry.sources.map((source) => `${source.party.label}${source.pillar}`),
      ]),
    ).toEqual([
      ["亥", ["チャッピー月柱", "チャッピー日柱"]],
      ["卯", ["Claude年柱", "Claude月柱"]],
      ["未", ["わーさん日柱", "Claude日柱"]],
    ]);
    expect(group.parties.map((party) => party.label)).toEqual([
      "わーさん",
      "チャッピー",
      "Claude",
    ]);
  });

  it("揃わない局は出さない（方合は 1 つも立たない）", () => {
    const result = calculatePillarsRelations(THREE);
    expect(result.groups!.filter((group) => group.kind === "方合")).toEqual([]);
  });

  it("1 人で 3 支そろえている局は「単独で成立」の別枠", () => {
    const solo = party("ひとりで", ["甲寅", "庚午", "甲戌", "丙子"], ["申", "酉"], "甲戌旬");
    const result = calculatePillarsRelations([solo, CHA, CLA]);
    const fire = result.groups!.find((group) => group.name === "寅午戌")!;
    expect(fire.formation).toBe("単独");
    expect(fire.solo_parties.map((entry) => entry.label)).toEqual(["ひとりで"]);
    // 誰が出したかは正直に残る（チャッピーの年柱の寅も列挙される）
    const tora = fire.branches.find((entry) => entry.branch === "寅")!;
    expect(tora.sources.map((source) => `${source.party.label}${source.pillar}`)).toEqual([
      "ひとりで年柱",
      "チャッピー年柱",
    ]);
  });

  it("方合も同じ要領で拾う（亥子丑）", () => {
    const a = party("A", ["乙亥", "乙亥", "乙亥", "乙亥"], ["申", "酉"], "甲戌旬");
    const b = party("B", ["甲子", "甲子", "甲子", "甲子"], ["戌", "亥"], "甲子旬");
    const c = party("C", ["乙丑", "乙丑", "乙丑", "乙丑"], ["戌", "亥"], "甲子旬");
    const result = calculatePillarsRelations([a, b, c]);
    const fanghe = result.groups!.filter((group) => group.kind === "方合");
    expect(fanghe).toHaveLength(1);
    expect(fanghe[0]!.name).toBe("亥子丑");
    expect(fanghe[0]!.element).toBe("水");
    expect(fanghe[0]!.formation).toBe("合同");
  });

  it("空亡の有向辺を並べ、環になっていれば名前で返す", () => {
    const result = calculatePillarsRelations(THREE);
    const chain = result.void_chain!;
    expect(
      chain.edges.map((edge) => `${edge.from.label}→${edge.to.label}(${edge.branches.join("")})`),
    ).toEqual([
      "わーさん→チャッピー(寅)",
      "わーさん→Claude(卯)",
      "チャッピー→わーさん(未)",
      "チャッピー→Claude(未)",
      "Claude→チャッピー(亥)",
    ]);

    // 三人とも「誰かの空亡に自分の地支が入っている」＝入ってくる辺が 1 本以上ある
    const targets = new Set(chain.edges.map((edge) => edge.to.label));
    expect(targets).toEqual(new Set(["わーさん", "チャッピー", "Claude"]));

    const names = chain.cycles.map((cycle) => cycle.name);
    expect(names).toContain("三すくみ");
    const three = chain.cycles.find((cycle) => cycle.name === "三すくみ")!;
    expect(three.parties.map((entry) => entry.label)).toEqual([
      "わーさん",
      "Claude",
      "チャッピー",
    ]);
    // 2 人で閉じた環は「相互」
    expect(names.filter((name) => name === "相互")).toHaveLength(2);
  });

  it("環が閉じていなければ環は空（辺だけ返る）", () => {
    // A の空亡に B の地支が入るだけの一方通行
    const a = party("A", ["甲子", "甲子", "甲子", "甲子"], ["戌", "亥"], "甲子旬");
    const b = party("B", ["乙亥", "乙亥", "乙亥", "乙亥"], ["申", "酉"], "甲戌旬");
    const c = party("C", ["甲寅", "甲寅", "甲寅", "甲寅"], ["子", "丑"], "甲寅旬");
    const chain = calculatePillarsRelations([a, b, c]).void_chain!;
    expect(chain.edges.map((edge) => `${edge.from.label}→${edge.to.label}`)).toEqual([
      "A→B",
      "C→A",
    ]);
    expect(chain.cycles).toEqual([]);
  });
});

describe("2 人のとき", () => {
  it("三者節（三合局・方合・空亡の連鎖）は出さない", () => {
    const result = calculatePillarsRelations([WA, CHA]);
    expect(result.groups).toBeUndefined();
    expect(result.void_chain).toBeUndefined();
    expect(result.pairs).toHaveLength(1);

    // 節そのものが出ない（規約の 1 行にだけ「三合局と方合」の名前が残る）
    const text = formatPillarsRelationsText(result);
    expect(text).not.toContain("■ 三合局");
    expect(text).not.toContain("■ 方合");
    expect(text).not.toContain("■ 空亡の連鎖");
  });
});

describe("規約と門番", () => {
  it("刑・害・破は「採らない」と名前で書く。点数化もしない", () => {
    const result = calculatePillarsRelations(THREE);
    expect(result.conventions).toEqual({ ...PILLARS_RELATIONS_CONVENTIONS });
    expect(result.conventions.excluded).toEqual(["xing", "hai", "po"]);
    expect(result.conventions.scoring).toBe("none");
    expect(result.conventions.day_boundary).toBe("midnight");
    expect(result.conventions.night_zi).toBe("not_used");
    expect(result.conventions.void).toBe("from_day_pillar");
    expect(result.conventions.branch_relations).toEqual(["liuhe", "liuchong", "banhe", "same"]);
    expect(result.conventions.group_relations).toEqual(["sanhe", "fanghe"]);
  });

  it("人数は 2〜4 人（1 人・5 人は断る）", () => {
    expect(MIN_PARTIES).toBe(2);
    expect(MAX_PARTIES).toBe(4);
    expect(() => calculatePillarsRelations([WA])).toThrow(PillarsRelationsError);
    expect(() => calculatePillarsRelations([WA, CHA, CLA, WA, CHA])).toThrow(/2〜4 人/);
  });

  it("柱が 4 本そろっていない・知らない干支は断る", () => {
    const broken: PartyInput = {
      label: "こわれ",
      pillars: [{ label: "年柱", stem: "甲", branch: "寅", ganzhi: "甲寅" }],
      void: { decade: "甲子旬", branches: ["戌", "亥"] },
    };
    expect(() => calculatePillarsRelations([WA, broken])).toThrow(/4 本/);

    const unknown: PartyInput = {
      label: "しらない",
      pillars: [
        { label: "年柱", stem: "甲", branch: "犬", ganzhi: "甲犬" },
        { label: "月柱", stem: "丙", branch: "子", ganzhi: "丙子" },
        { label: "日柱", stem: "丁", branch: "未", ganzhi: "丁未" },
        { label: "時柱", stem: "甲", branch: "寅", ganzhi: "甲寅" },
      ],
      void: { decade: "甲辰旬", branches: ["寅", "卯"] },
    };
    expect(() => calculatePillarsRelations([WA, unknown])).toThrow(/知らない地支/);
  });

  it("空亡は 2 支そろっていないと断る", () => {
    const broken: PartyInput = {
      label: "こわれ",
      pillars: WA.pillars,
      void: { decade: "甲子旬", branches: ["戌"] },
    };
    expect(() => calculatePillarsRelations([WA, broken])).toThrow(/2 支/);
  });
});

describe("テキスト整形", () => {
  it("人・二者間・持ち寄り・連鎖・規約を並べる", () => {
    const text = formatPillarsRelationsText(calculatePillarsRelations(THREE));
    expect(text).toContain("■ 四柱の多者盤面（3 人）");
    expect(text).toContain(
      "1. わーさん  日主 丁（陰火）  年柱 甲寅 / 月柱 丙子 / 日柱 丁未 / 時柱 甲寅  空亡 寅・卯（甲辰旬）",
    );
    expect(text).toContain("■ 二者間（左の柱がひとり目、右の柱がふたり目）");
    expect(text).toContain("● 1. わーさん × 2. チャッピー");
    expect(text).toContain("日主: わーさん 丁（火） / チャッピー 丁（火）＝ 比和");
    expect(text).toContain("日主: わーさん 丁（火） / Claude 辛（金）＝ 相剋（わーさん が Claude を剋す）");
    expect(text).toContain("年柱 寅 × 月柱 亥 ＝ 六合（寅亥）");
    expect(text).toContain("日柱 未 × 月柱 亥 ＝ 半合（未亥・亥卯未木局の 2 支）");
    expect(text).toContain("わーさん の空亡（寅・卯）に チャッピー の 年柱 寅");
    expect(text).toContain("■ 三合局（全員の地支を持ち寄って 3 支）");
    expect(text).toContain("亥卯未（木局・持ち寄りで成立）: 亥＝チャッピー月柱・チャッピー日柱");
    expect(text).toContain("■ 方合（全員の地支を持ち寄って 3 支）");
    expect(text).toContain("そろっている局はありません");
    expect(text).toContain("■ 空亡の連鎖（X の空亡に Y の地支が入る＝X→Y）");
    expect(text).toContain("環: 三すくみ（わーさん → Claude → チャッピー → わーさん）");
    expect(text).toContain("刑・害・破は含めない／点数化も多数決もしない");
  });

  it("単独で成立した局は持ち寄りのあとに並ぶ", () => {
    const solo = party("ひとりで", ["甲寅", "庚午", "甲戌", "丙子"], ["申", "酉"], "甲戌旬");
    const text = formatPillarsRelationsText(calculatePillarsRelations([solo, CHA, CLA]));
    expect(text).toContain("寅午戌（火局・ひとりで 単独で成立）");
  });
});
