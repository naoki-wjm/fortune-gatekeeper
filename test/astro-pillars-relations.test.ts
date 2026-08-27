/**
 * 四柱の多者盤面（pillars_relations）の配線。
 *
 * 純関数の検算は test/pillars-relations.test.ts の担当で、ここは
 * 「台帳から 2〜4 枚引いて命式を立て、盤面を組んで、出生データを漏らさずに返すか」を見る。
 * 偽 KV と偽エンジンだけで回る（wasm には触らない）。
 *
 * 見本の生年月日は**公開された日付**（ChatGPT・Claude の公開日）を借りています ――
 * 人の誕生日と紛れないように、というリポの取り決め。時刻は架空です。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import { PLANETS } from "../src/astro/chart";
import type { AuthContext, StoredChart } from "../src/astro/store";
import { calculateFourPillars, orderedPillars } from "../src/four-pillars";
import { sunLongitude, type NakkoMoment } from "../src/nakko";
import { calculatePillarsRelations, type PartyInput } from "../src/pillars-relations";
import { FakeKv } from "./stubs/fake-kv";
import { FAKE_ASCMC, FAKE_CUSPS, makeFakeEngine, type FakeEngine } from "./stubs/fake-engine";

const OWNER: AuthContext = { user: "user1", name: "オーナー", role: "owner" };

let kv: FakeKv;
let engine: FakeEngine;
let context: AstroContext;

beforeEach(() => {
  kv = new FakeKv();
  engine = makeFakeEngine();
  // 太陽を動かす（素の偽エンジンは太陽を止めているので、3 人とも同じ月柱になってしまう）
  engine.sunMotionAnchorJd = 2_459_000.5;
  context = {
    auth: OWNER,
    kv,
    getEngine: async () => engine,
    now: () => new Date("2026-08-25T02:15:00Z"),
  };
});

let nextId = 1;

/** tools/call を 1 発。result（ToolResult）を返す */
async function call(name: string, args: unknown = {}, ctx: AstroContext = context): Promise<any> {
  const response = await handleAstroMcpRequest(
    new Request("http://localhost/astro/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    ctx,
  );
  const json = JSON.parse(await response.text());
  return json.result;
}

/** 見本の出生データ 3 枚（公開日を借りた日付・時刻は架空・場所は東京とロンドン） */
const BIRTHS = [
  {
    label: "ひとりめ",
    year: 2022,
    month: 11,
    day: 30,
    hour: 10,
    minute: 0,
    utc_offset: -8,
    lat: 37.7749,
    lng: -122.4194,
  },
  {
    label: "ふたりめ",
    year: 2023,
    month: 3,
    day: 14,
    hour: 21,
    minute: 30,
    utc_offset: 9,
    lat: 35.6895,
    lng: 139.6917,
  },
  {
    label: "さんにんめ",
    year: 2024,
    month: 6,
    day: 20,
    hour: 4,
    minute: 45,
    utc_offset: 0,
    lat: 51.5074,
    lng: -0.1278,
  },
] as const;

/** 出生データの生の値（返事に混ざっていないことを見る札） */
const BIRTH_TRACES = [
  "2022",
  "2023",
  "2024",
  "37.7749",
  "-122.4194",
  "35.6895",
  "139.6917",
  "51.5074",
  "-0.1278",
];

async function saveChart(index: number): Promise<string> {
  const result = await call("save_chart", BIRTHS[index]);
  expect(result.isError).toBeUndefined();
  return result.structuredContent.chart_id as string;
}

/** 先頭から count 枚を登録する */
async function saveCharts(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) ids.push(await saveChart(index));
  return ids;
}

/** 配線と同じ道具立てで、期待する盤面を純関数から直に組む */
function expectedBoard(count: number) {
  const parties: PartyInput[] = BIRTHS.slice(0, count).map((birth) => {
    const moment: NakkoMoment = {
      year: birth.year,
      month: birth.month,
      day: birth.day,
      hour: birth.hour,
      minute: birth.minute,
      utcOffset: birth.utc_offset,
    };
    const natal = calculateFourPillars({
      moment,
      sun_longitude: sunLongitude(engine, moment),
    });
    return {
      label: birth.label,
      pillars: orderedPillars(natal.pillars),
      void: natal.void,
    };
  });
  return calculatePillarsRelations(parties);
}

/**
 * 台帳へ直に置くチャートの天体（chart.ts の PLANETS ＝ 11 天体）。
 * `parseStoredChart` は件数と ID の集合がちょうど一致することを見るので、
 * 手書きの「1 天体だけ」のレコードはもう通らない（2026-08-27 査読 I-2）。
 */
function storedPlanets(): { id: number; lon: number; speed: number }[] {
  return PLANETS.map((planet, index) => ({ id: planet.id, lon: (index * 30) % 360, speed: 1 }));
}

/**
 * 出生データを預からなかった時代の登録を台帳へ直接置く（命式が立たない図）。
 */
function putLegacyChart(chartId = "legacy01", user = "user1"): string {
  const legacy: StoredChart = {
    label: "むかしの図",
    house_system: "P",
    planets: storedPlanets(),
    cusps: [...FAKE_CUSPS],
    ascmc: [...FAKE_ASCMC],
    created: "2026-08-01T00:00:00.000Z",
  };
  kv.store.set(`chart:${user}:${chartId}`, JSON.stringify(legacy));
  return chartId;
}

// ---------------------------------------------------------------------------

describe("pillars_relations（盤面の組み立て）", () => {
  it("3 枚から命式を立てて、各人・二者間・持ち寄り・連鎖を返す", async () => {
    const ids = await saveCharts(3);
    const result = await call("pillars_relations", { charts: ids });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    const lines = text.split("\n");
    expect(lines[0]).toBe("四柱の多者盤面（子平・日界 0 時・節気は太陽黄経・時刻の補正なし）");
    expect(lines[1]).toBe(
      `並べたチャート: 1. ひとりめ（${ids[0]}） / 2. ふたりめ（${ids[1]}） / 3. さんにんめ（${ids[2]}）`,
    );
    expect(text).toContain("点数化も多数決もしていません");
    expect(text).toContain("■ 四柱の多者盤面（3 人）");
    expect(text).toContain("■ 二者間（左の柱がひとり目、右の柱がふたり目）");
    expect(text).toContain("■ 三合局（全員の地支を持ち寄って 3 支）");
    expect(text).toContain("■ 方合（全員の地支を持ち寄って 3 支）");
    expect(text).toContain("■ 空亡の連鎖（X の空亡に Y の地支が入る＝X→Y）");
    expect(text).toContain("刑・害・破は含めない／点数化も多数決もしない");

    const structured = result.structuredContent;
    expect(structured.kind).toBe("pillars_relations");
    expect(structured.charts).toEqual([
      { chart_id: ids[0], label: "ひとりめ" },
      { chart_id: ids[1], label: "ふたりめ" },
      { chart_id: ids[2], label: "さんにんめ" },
    ]);

    // 盤面は純関数の答えそのまま（＝配線が moment と太陽黄経を正しく渡している）
    const { kind, charts, ...board } = structured;
    expect(kind).toBe("pillars_relations");
    expect(charts).toHaveLength(3);
    expect(board).toEqual(JSON.parse(JSON.stringify(expectedBoard(3))));

    expect(board.parties).toHaveLength(3);
    expect(board.pairs).toHaveLength(3);
    expect(board.conventions.excluded).toEqual(["xing", "hai", "po"]);
    expect(board.conventions.scoring).toBe("none");

    // 命式が渡っている印（日柱の干支と日主）
    expect(board.parties.map((party: any) => party.pillars[2].ganzhi)).toEqual([
      "丁亥",
      "辛未",
      "乙卯",
    ]);
    expect(board.parties.map((party: any) => party.day_master.stem)).toEqual(["丁", "辛", "乙"]);
    // ふたりめが 1 人で 亥卯未 をそろえている＝「単独で成立」の別枠に落ちる
    expect(
      board.groups.filter((group: any) => group.kind === "三合").map((group: any) => group.name),
    ).toEqual(["亥卯未"]);
    expect(text).toContain("亥卯未（木局・ふたりめ 単独で成立）");
    // 空亡は ひとりめ ⇄ ふたりめ で環が閉じる
    expect(board.void_chain.cycles.map((cycle: any) => cycle.name)).toEqual(["相互"]);
    expect(text).toContain("環: 相互（ひとりめ → ふたりめ → ひとりめ）");
  });

  it("2 枚のときは三者節（三合局・方合・空亡の連鎖）を返さない", async () => {
    const ids = await saveCharts(2);
    const result = await call("pillars_relations", { charts: ids });
    expect(result.isError).toBeUndefined();

    const structured = result.structuredContent;
    expect(structured.parties).toHaveLength(2);
    expect(structured.pairs).toHaveLength(1);
    expect(structured).not.toHaveProperty("groups");
    expect(structured).not.toHaveProperty("void_chain");

    const text: string = result.content[0].text;
    expect(text).not.toContain("■ 三合局");
    expect(text).not.toContain("■ 空亡の連鎖");
  });

  it("並べる順を変えると人の番号だけが入れ替わる", async () => {
    const ids = await saveCharts(2);
    const forward = await call("pillars_relations", { charts: ids });
    const backward = await call("pillars_relations", { charts: [ids[1], ids[0]] });
    expect(forward.structuredContent.parties[0].label).toBe("ひとりめ");
    expect(backward.structuredContent.parties[0].label).toBe("ふたりめ");
    // 日主の関係は並べる順では変わらない（剋す側・生む側は五行が決める）
    expect(backward.structuredContent.pairs[0].day_master.kind).toBe(
      forward.structuredContent.pairs[0].day_master.kind,
    );
  });

  it("エンジンを叩くのは人数ぶんの太陽だけ（節入りは探さない）", async () => {
    const ids = await saveCharts(3);
    const juldaysBefore = engine.juldays.length;
    engine.crossCalls.length = 0;

    const result = await call("pillars_relations", { charts: ids });
    expect(result.isError).toBeUndefined();

    // 大運を返さないので swe_solcross_ut は 1 回も呼ばない
    expect(engine.crossCalls).toHaveLength(0);
    // 太陽黄経のために jd を 1 人 1 回だけ作る（ハウスも立てない）
    expect(engine.juldays.length - juldaysBefore).toBe(3);
    expect(engine.houseCalls.filter((entry) => entry.jd > 0)).toHaveLength(3); // save_chart のぶんだけ
  });
});

describe("pillars_relations の門番", () => {
  it("2〜4 枚。1 枚・5 枚は断る", async () => {
    const ids = await saveCharts(3);

    const one = await call("pillars_relations", { charts: [ids[0]] });
    expect(one.isError).toBe(true);
    expect(one.content[0].text).toContain("2〜4 枚");
    expect(one.content[0].text).toContain("four_pillars");

    const five = await call("pillars_relations", {
      charts: [...ids, ids[0], ids[1]],
    });
    expect(five.isError).toBe(true);
    expect(five.content[0].text).toContain("2〜4 枚");
  });

  it("4 枚までは並べられる", async () => {
    const ids = await saveCharts(3);
    const fourth = await call("save_chart", { ...BIRTHS[0], label: "よにんめ" });
    const result = await call("pillars_relations", {
      charts: [...ids, fourth.structuredContent.chart_id],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.parties).toHaveLength(4);
    expect(result.structuredContent.pairs).toHaveLength(6);
  });

  it("同じ chart_id を 2 つ入れると断る", async () => {
    const ids = await saveCharts(2);
    const result = await call("pillars_relations", { charts: [ids[0], ids[1], ids[0]] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("同じチャート");
    expect(result.content[0].text).toContain("別々のチャート");
  });

  it("配列でない・文字列でない・空文字は断る", async () => {
    const ids = await saveCharts(2);

    const notArray = await call("pillars_relations", { charts: ids[0] });
    expect(notArray.isError).toBe(true);
    expect(notArray.content[0].text).toContain("配列");

    const notString = await call("pillars_relations", { charts: [ids[0], 3] });
    expect(notString.isError).toBe(true);
    expect(notString.content[0].text).toContain("charts[1]");

    const empty = await call("pillars_relations", { charts: [ids[0], "  "] });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain("charts[1] が空です");
  });

  it("知らない chart_id は、配列の何番目かを言い添えて断る", async () => {
    const ids = await saveCharts(2);
    const result = await call("pillars_relations", { charts: [ids[0], "nosuchid"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("charts[1] に指定したチャート nosuchid");
    expect(result.content[0].text).toContain("list_charts");
  });

  it("他人の台帳のチャートは見えない", async () => {
    const ids = await saveCharts(2);
    const other: AstroContext = {
      ...context,
      auth: { user: "tomodachi", name: "ともだち", role: "friend" },
    };
    const peek = await call("pillars_relations", { charts: ids }, other);
    expect(peek.isError).toBe(true);
    expect(peek.content[0].text).toContain("charts[0] に指定したチャート");
  });

  it("出生データの無い古い登録は「登録し直してください」で断る", async () => {
    const ids = await saveCharts(2);
    const legacy = putLegacyChart();
    const result = await call("pillars_relations", { charts: [ids[0], legacy] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("charts[1] に指定したチャート");
    expect(result.content[0].text).toContain("出生データが入っていません");
    expect(result.content[0].text).toContain("save_chart で登録し直す");
  });

  it("charts は必須。未知の引数キーは弾く", async () => {
    const ids = await saveCharts(2);

    const missing = await call("pillars_relations", {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("charts");

    const typo = await call("pillars_relations", { charts: ids, orb: 5 });
    expect(typo.isError).toBe(true);
    expect(typo.content[0].text).toContain("orb");
  });
});

describe("pillars_relations と出生データ", () => {
  it("返事に出生データ（年月日・時差・緯度経度）を出さない", async () => {
    const ids = await saveCharts(3);
    const result = await call("pillars_relations", { charts: ids });
    const text: string = result.content[0].text;
    const structured = JSON.stringify(result.structuredContent);
    for (const trace of BIRTH_TRACES) {
      expect(text).not.toContain(trace);
      expect(structured).not.toContain(trace);
    }
    expect(structured).not.toContain("utc_offset");
    expect(structured).not.toContain("birth");
    // 太陽黄経も出生の瞬間を絞り込む手がかりなので返さない
    expect(structured).not.toContain("sun_longitude");
    // 大運・起運も返さない（このツールの持ち場ではない）
    expect(structured).not.toContain("luck_cycles");
    expect(structured).not.toContain("start_age");
  });

  it("tools/list に 18 本目として並ぶ（凍結した定義と同じ形）", async () => {
    const response = await handleAstroMcpRequest(
      new Request("http://localhost/astro/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      context,
    );
    const json = JSON.parse(await response.text());
    const tools: { name: string }[] = json.result.tools;
    // 並びの検査は入口のテスト（test/astro-mcp.test.ts の tools/list）に任せ、ここは名前で引く
    // （2026-08-26: 科の途中に 1 本足すたび後ろの科の並び番号が全部ずれて 4 枚割れたので、位置の直書きをやめた）
    const tool: any = tools.find((candidate) => candidate.name === "pillars_relations");
    expect(tool).toBeDefined();
    expect(tool.title).toBe("四柱の多者盤面（2〜4 人）");
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["charts"]);
    expect(tool.inputSchema.properties.charts).toMatchObject({
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 4,
    });
    expect(tool.inputSchema.required).toEqual(["charts"]);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    // 点数化しない・刑害破は採らない・合算の根拠はない、を description に書いてある
    expect(tool.description).toContain("点数化も多数決もしない");
    expect(tool.description).toContain("刑・害・破は含めない");
    expect(tool.description).toContain(
      "どれだけ体系を横断し、それらが全て同じ結果を示したとて、合算の根拠にはならない",
    );
    expect(tool.description).toContain("解釈をしない");
    expect(tool.description).toContain("出生データそのものは返事に出さない");
  });
});
