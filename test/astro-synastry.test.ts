/**
 * シナストリー（synastry）の配線。
 *
 * 純関数の検算は test/astro-chart-synastry.test.ts の担当で、ここは
 * 「台帳から 2 枚引いて突き合わせ、出生データを漏らさずに返すか」を見る。
 * 偽 KV と偽エンジンだけで回る（wasm には触らない）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import type { AuthContext, StoredChart } from "../src/astro/store";
import { FakeKv } from "./stubs/fake-kv";
import {
  FAKE_ASCMC,
  FAKE_CUSPS,
  makeFakeEngine,
  type FakeEngine,
} from "./stubs/fake-engine";

const OWNER: AuthContext = { user: "user1", name: "オーナー", role: "owner" };

let kv: FakeKv;
let engine: FakeEngine;
let context: AstroContext;

beforeEach(() => {
  kv = new FakeKv();
  engine = makeFakeEngine();
  context = {
    auth: OWNER,
    kv,
    getEngine: async () => engine,
    now: () => new Date("2026-08-20T02:15:00Z"),
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

/** 標準の出生データ（1990-06-15 12:00 UTC・東京） */
const BIRTH = {
  label: "サンプル",
  year: 1990,
  month: 6,
  day: 15,
  hour: 12,
  minute: 0,
  utc_offset: 0,
  lat: 35.6895,
  lng: 139.6917,
};

/** 出生データの生の値（返事に混ざっていないことを見る札） */
const BIRTH_TRACES = ["1990", "35.6895", "139.6917"];

async function saveChart(overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await call("save_chart", { ...BIRTH, ...overrides });
  expect(result.isError).toBeUndefined();
  return result.structuredContent.chart_id as string;
}

/**
 * 2 枚を登録する。
 *
 * 偽エンジンは天体を 30° の格子に並べるので、素のまま 2 枚保存すると
 * まったく同じ図になり、アスペクトが全部オーブ 0° になる。
 * 2 枚目だけ offset を 3.5° ずらして「天体同士は 3.5°・ASC / MC は 0°」の図を作る。
 */
async function saveTwo(overridesB: Record<string, unknown> = {}): Promise<[string, string]> {
  const idA = await saveChart({ label: "わたし" });
  engine.offset = 3.5;
  const idB = await saveChart({ label: "あいて", ...overridesB });
  return [idA, idB];
}

/**
 * ラベルの無いチャートを台帳へ直接置く。
 *
 * save_chart は空のラベルを受け付けないので手で作る（見出しの「label が無ければ
 * chart_id だけ」を見るための細工）。
 */
function putLabellessChart(chartId = "nolabel1", user = "user1"): string {
  const stored: StoredChart = {
    label: "",
    house_system: "P",
    planets: [{ id: 0, lon: 0, speed: 1 }],
    cusps: [...FAKE_CUSPS],
    ascmc: [...FAKE_ASCMC],
    created: "2026-08-01T00:00:00.000Z",
  };
  kv.store.set(`chart:${user}:${chartId}`, JSON.stringify(stored));
  return chartId;
}

/** テキストの 1 節（見出しから次の空行まで）を取り出す */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const end = rest.indexOf("\n\n");
  return end === -1 ? rest : rest.slice(0, end);
}

// ---------------------------------------------------------------------------

describe("synastry", () => {
  it("2 枚を突き合わせてアスペクトと在ハウス 2 節を返す（エンジンは呼ばない）", async () => {
    const [idA, idB] = await saveTwo();
    const juldaysBefore = engine.juldays.length;
    const houseCallsBefore = engine.houseCalls.length;

    const result = await call("synastry", { a: idA, b: idB });
    expect(result.isError).toBeUndefined();
    // 突き合わせは KV だけ。ユリウス日もハウスも計算し直さない
    expect(engine.juldays.length).toBe(juldaysBefore);
    expect(engine.houseCalls.length).toBe(houseCallsBefore);

    const text: string = result.content[0].text;
    const lines = text.split("\n");
    expect(lines[0]).toBe("シナストリー");
    expect(lines[1]).toBe(`A: わたし（${idA}） / B: あいて（${idB}）`);
    expect(lines[2]).toBe("ハウス方式: A プラシーダス（P） / B プラシーダス（P）");
    // 同じ方式なら注記は出ない
    expect(text).not.toContain("2 枚でハウス方式が違います");

    expect(text).toContain(
      "■ 2 枚の間のアスペクト（メジャー5種・オーブ 5.0°・10 天体＋ASC/MC の総当たり、ノード除く）",
    );
    // 天体同士は 3.5° ずれ、ASC / MC は 2 枚とも同じ位置
    expect(text).toContain("A.太陽 ☌ B.太陽（コンジャンクション / オーブ 3.50°）");
    expect(text).toContain("A.太陽 □ B.金星（スクエア / オーブ 3.50°）");
    expect(text).toContain("A.ASC ☌ B.ASC（コンジャンクション / オーブ 0.00°）");
    expect(text).toContain("A.MC ☌ B.MC（コンジャンクション / オーブ 0.00°）");

    // 止まった図同士なので接近・離反は書かない。ノードはアスペクトに出さない
    const aspectSection = section(text, "■ 2 枚の間のアスペクト");
    expect(aspectSection).not.toContain("接近");
    expect(aspectSection).not.toContain("離反");
    expect(aspectSection).not.toContain("Nノード");

    // 在ハウスは 2 節。ノードもここには出る（11 天体）
    const aInB = section(text, "■ A の天体が B のハウスで（ノード込みの 11 天体）");
    const bInA = section(text, "■ B の天体が A のハウスで（同上）");
    expect(aInB.split("\n")[1]?.split(" / ")).toHaveLength(11);
    expect(bInA.split("\n")[1]?.split(" / ")).toHaveLength(11);
    expect(aInB).toContain("太陽 10H");
    expect(aInB).toContain("Nノード");
    expect(bInA).toContain("太陽 10H");

    expect(text).toContain("読みはあなた自身の知識で");

    const structured = result.structuredContent;
    expect(structured.kind).toBe("synastry");
    expect(structured.a).toEqual({ chart_id: idA, label: "わたし", house_system: "P" });
    expect(structured.b).toEqual({ chart_id: idB, label: "あいて", house_system: "P" });
    expect(structured.orb).toBe(5);
    expect(structured.aspects.length).toBeGreaterThan(0);
    expect(structured.overlays.a_in_b).toHaveLength(11);
    expect(structured.overlays.b_in_a).toHaveLength(11);
    expect(structured.overlays.a_in_b[0]).toEqual({ planet: "太陽", house: 10 });
    for (const hit of structured.aspects) {
      expect(hit).not.toHaveProperty("applying");
      expect(hit.a).not.toBe("Nノード");
      expect(hit.b).not.toBe("Nノード");
    }
    // 天体の黄経そのものは返さない（位置は get_chart の持ち場）
    expect(structured).not.toHaveProperty("planets");
  });

  it("A.太陽 × B.月 と A.月 × B.太陽 を別々に返す（総当たり）", async () => {
    const [idA, idB] = await saveTwo();
    const result = await call("synastry", { a: idA, b: idB });
    const pairs = result.structuredContent.aspects.map(
      (hit: { a: string; b: string }) => `${hit.a}-${hit.b}`,
    );
    // 偽エンジンでは太陽 0°・月 30°＝ 2 枚をまたぐと 26.5° と 33.5°（どちらもアスペクト外）なので、
    // 向きの違いは「太陽と火星」（120°）で見る
    expect(pairs).toContain("太陽-火星");
    expect(pairs).toContain("火星-太陽");
    // 同名同士（A.太陽 × B.太陽）も出る
    expect(pairs).toContain("太陽-太陽");
    // オーブ昇順
    const orbs = result.structuredContent.aspects.map(
      (hit: { aspect: { orb: number } }) => hit.aspect.orb,
    );
    for (let i = 1; i < orbs.length; i++) {
      expect(orbs[i]).toBeGreaterThanOrEqual(orbs[i - 1]);
    }
  });

  it("orb で絞れる。範囲外は断る", async () => {
    const [idA, idB] = await saveTwo();
    const wide = await call("synastry", { a: idA, b: idB });
    const narrow = await call("synastry", { a: idA, b: idB, orb: 3 });
    expect(narrow.isError).toBeUndefined();
    expect(narrow.content[0].text).toContain("オーブ 3.0°");
    expect(narrow.structuredContent.orb).toBe(3);
    // 3.5° ずれの組（天体同士）が落ち、ASC / MC どうしの 0° だけ残る
    expect(narrow.structuredContent.aspects.length).toBeLessThan(
      wide.structuredContent.aspects.length,
    );
    expect(narrow.content[0].text).not.toContain("オーブ 3.50°");

    for (const orb of [0.1, 20]) {
      const bad = await call("synastry", { a: idA, b: idB, orb });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain("orb");
    }
  });

  it("ハウス方式が違えば注記を添える", async () => {
    const [idA, idB] = await saveTwo({ house_system: "W" });
    const result = await call("synastry", { a: idA, b: idB });
    expect(result.content[0].text).toContain(
      "ハウス方式: A プラシーダス（P） / B ホールサイン（W）",
    );
    expect(result.content[0].text).toContain("※ 2 枚でハウス方式が違います");
    expect(result.structuredContent.b.house_system).toBe("W");
  });

  it("ラベルの無いチャートは chart_id だけを見出しに出す", async () => {
    const idA = await saveChart({ label: "わたし" });
    const idB = putLabellessChart();
    const result = await call("synastry", { a: idA, b: idB });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.split("\n")[1]).toBe(`A: わたし（${idA}） / B: ${idB}`);
    expect(result.structuredContent.b.label).toBe("");
  });

  it("同じ chart_id を 2 つ渡すと断る（1 枚の中は get_chart）", async () => {
    const idA = await saveChart();
    const result = await call("synastry", { a: idA, b: idA });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("同じチャート同士です");
    expect(result.content[0].text).toContain("get_chart");
  });

  it("知らない chart_id は、どちら側かを言い添えて断る", async () => {
    const idA = await saveChart();
    const missingB = await call("synastry", { a: idA, b: "nosuchid" });
    expect(missingB.isError).toBe(true);
    expect(missingB.content[0].text).toContain("b に指定したチャート nosuchid");
    expect(missingB.content[0].text).toContain("list_charts");

    const missingA = await call("synastry", { a: "nosuchid", b: idA });
    expect(missingA.isError).toBe(true);
    expect(missingA.content[0].text).toContain("a に指定したチャート nosuchid");
  });

  it("他人の台帳のチャートは見えない", async () => {
    const [idA, idB] = await saveTwo();
    const other: AstroContext = {
      ...context,
      auth: { user: "tomodachi", name: "ともだち", role: "friend" },
    };
    const peek = await call("synastry", { a: idA, b: idB }, other);
    expect(peek.isError).toBe(true);
    expect(peek.content[0].text).toContain("a に指定したチャート");

    // 自分の 1 枚と、他人の 1 枚の取り合わせも同じ（存在ごと見えない）
    const mine = await call("save_chart", { ...BIRTH, label: "ともだちの図" }, other);
    const mixed = await call("synastry", { a: idA, b: mine.structuredContent.chart_id });
    expect(mixed.isError).toBe(true);
    expect(mixed.content[0].text).toContain("b に指定したチャート");
  });

  it("a / b は必須。未知の引数キーは弾く", async () => {
    const idA = await saveChart();
    const noB = await call("synastry", { a: idA });
    expect(noB.isError).toBe(true);
    expect(noB.content[0].text).toContain("b は必須です");

    const typo = await call("synastry", { a: idA, b: idA, orbs: 5 });
    expect(typo.isError).toBe(true);
    expect(typo.content[0].text).toContain("orbs");
  });

  it("出生データは返事に出さない（テキストにも structuredContent にも）", async () => {
    const [idA, idB] = await saveTwo();
    const result = await call("synastry", { a: idA, b: idB });
    const text: string = result.content[0].text;
    const structured = JSON.stringify(result.structuredContent);
    for (const trace of BIRTH_TRACES) {
      expect(text).not.toContain(trace);
      expect(structured).not.toContain(trace);
    }
    expect(structured).not.toContain("birth");
    expect(structured).not.toContain("utc_offset");
  });

  it("tools/list に 16 本目として並ぶ（凍結した定義と同じ形）", async () => {
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
    // 2026-08-22 夜に kyusei が 17 本目として後ろに付いたので、synastry は末尾ではなく 16 番目
    // （2026-08-24 のスーパーセット化でカード層 5 本がさらに後ろに付き、2026-08-25 の
    //  composite が 18 本目・pillars_relations が 19 本目に入って全 24 本。
    //  synastry の位置は 16 番目のまま）
    expect(tools).toHaveLength(24);
    expect(tools[15]?.name).toBe("synastry");

    const tool: any = tools[15];
    expect(tool.title).toBe("シナストリー（2 枚の出生図の間のアスペクトと在ハウス）");
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["a", "b", "orb"]);
    expect(tool.inputSchema.required).toEqual(["a", "b"]);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    // 読みは呼び出した側・出生データは出さない、を description で約束している
    expect(tool.description).toContain("解釈をしない");
    expect(tool.description).toContain("出生データそのものは返事に出さない");
    expect(tool.description).toContain("ノードは除く");
  });
});
