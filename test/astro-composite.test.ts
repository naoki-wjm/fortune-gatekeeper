/**
 * コンポジット（composite）の配線。
 *
 * 純関数の検算は test/astro-composite-chart.test.ts の担当で、ここは
 * 「台帳から 2〜3 枚引いて中点図を組み立て、出生データを漏らさずに返すか」を見る。
 * 偽 KV と偽エンジンだけで回る（wasm には触らない）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import { mcToArmc } from "../src/astro/chart";
import type { AuthContext, StoredChart } from "../src/astro/store";
import { FakeKv } from "./stubs/fake-kv";
import {
  FAKE_ARMC_CUSPS,
  FAKE_ASCMC,
  FAKE_CUSPS,
  FAKE_EPS,
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
  // 中点図は「立て直した MC が中点 MC と一致するか」を毎回検算するので、
  // 偽エンジンにも ARMC → MC の辻褄を合わせてもらう
  engine.armcMatchesMc = true;
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

/** 2 枚目の出生データ（1986-12-29 03:00 UTC・ロンドン）。緯度が違うので平均が試せる */
const BIRTH_B = {
  label: "あいて",
  year: 1986,
  month: 12,
  day: 29,
  hour: 3,
  minute: 0,
  utc_offset: 0,
  lat: 51.5074,
  lng: -0.1278,
};

/** 2 人の出生緯度の平均（**返事に出してはいけない値**） */
const MEAN_LAT = (BIRTH.lat + BIRTH_B.lat) / 2;

/** 出生データの生の値（返事に混ざっていないことを見る札）。中間緯度も混ぜてある */
const BIRTH_TRACES = [
  "1990",
  "1986",
  "35.6895",
  "139.6917",
  "51.5074",
  "-0.1278",
  String(MEAN_LAT),
];

async function saveChart(overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await call("save_chart", { ...BIRTH, ...overrides });
  expect(result.isError).toBeUndefined();
  return result.structuredContent.chart_id as string;
}

/**
 * 2 枚を登録する。
 *
 * 偽エンジンは天体を 30° の格子に並べるので、素のまま 2 枚保存すると同じ図になる。
 * 2 枚目だけ offset を 3.5° ずらすと、中点は「id×30° ＋ 1.75°」に並ぶ。
 */
async function saveTwo(overridesB: Record<string, unknown> = {}): Promise<[string, string]> {
  const idA = await saveChart({ label: "わたし" });
  engine.offset = 3.5;
  const idB = await saveChart({ ...BIRTH_B, ...overridesB });
  engine.offset = 0;
  return [idA, idB];
}

/**
 * 出生データを預かっていない古い登録を台帳へ直接置く（簡易方式に落ちる図）。
 * 10 天体はそろえておく ―― 欠けていると「登録し直してください」で止まってしまうため。
 */
function putBirthlessChart(chartId = "oldchart", offset = 6, user = "user1"): string {
  const stored: StoredChart = {
    label: "むかしの登録",
    house_system: "P",
    planets: Array.from({ length: 10 }, (_unused, id) => ({
      id,
      lon: (id * 30 + offset) % 360,
      speed: 1,
    })),
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

describe("composite（中点図の組み立て）", () => {
  it("10 天体の中点と ASC/MC・カスプ・図の中のアスペクトを返す", async () => {
    const [idA, idB] = await saveTwo();
    const juldaysBefore = engine.juldays.length;
    const houseCallsBefore = engine.houseCalls.length;

    const result = await call("composite", { a: idA, b: idB });
    expect(result.isError).toBeUndefined();

    // 天体は計算し直さない（引くのは出生 jd 2 本と黄道傾斜 1 本、ハウスは ARMC 版が 1 回だけ）
    expect(engine.juldays.length - juldaysBefore).toBe(2);
    expect(engine.houseCalls.length).toBe(houseCallsBefore);
    expect(engine.armcCalls).toHaveLength(1);
    expect(engine.armcCalls[0]?.eps).toBe(FAKE_EPS);
    expect(engine.armcCalls[0]?.hsys).toBe("P");
    // 緯度は 2 人の出生緯度の単純平均、ARMC は中点 MC（2 枚とも 300°）から
    expect(engine.armcCalls[0]?.lat).toBeCloseTo(MEAN_LAT, 12);
    expect(engine.armcCalls[0]?.armc).toBeCloseTo(mcToArmc(300, FAKE_EPS), 12);

    const text: string = result.content[0].text;
    const lines = text.split("\n");
    expect(lines[0]).toBe("コンポジット（中点図）");
    expect(lines[1]).toBe(`A: わたし（${idA}） / B: あいて（${idB}）`);
    expect(lines[2]).toBe(
      "方式: 中点法（ダヴィソンではありません） / ハウス方式: プラシーダス（P）",
    );
    expect(text).not.toContain("簡易方式");
    expect(text).not.toContain("2 枚でハウス方式が違う");

    // 中点は id×30° ＋ 1.75°（0° と 3.5° の真ん中）
    const planetSection = section(text, "■ 中点図の天体");
    expect(planetSection).toContain("太陽 牡羊座 1°45′");
    expect(planetSection).toContain("ASC 蟹座 10°00′ / MC 水瓶座 0°00′");
    // ノードは中点図に居ない（10 天体＋ASC/MC の 1 行）
    expect(planetSection).not.toContain("Nノード");
    expect(planetSection.split("\n")).toHaveLength(12);
    // 中点図は速度を持たないので逆行の印も付かない（偽エンジンの金星は逆行しているが）
    expect(planetSection).not.toContain("逆行");

    expect(text).toContain("■ ハウスカスプ");
    expect(text).toContain("1H 蟹座 10°00′");

    expect(text).toContain(
      "■ 中点図の中のアスペクト（メジャー5種・オーブ 5.0°・10 天体＋ASC/MC）",
    );
    expect(text).toContain("太陽 ⚹ 水星（セクスタイル / オーブ 0.00°）");
    expect(text).toContain("太陽 ☍ 土星（オポジション / オーブ 0.00°）");
    expect(text).toContain("火星 ☍ MC（オポジション / オーブ 1.75°）");
    // 止まった図なので接近・離反は付かない
    const aspectSection = section(text, "■ 中点図の中のアスペクト");
    expect(aspectSection).not.toContain("接近");
    expect(aspectSection).not.toContain("離反");
    expect(aspectSection).not.toContain("Nノード");

    expect(text).toContain("規約: 中点法（ダヴィソンではない）");
    expect(text).toContain("ハウスは参考程度");
    expect(text).toContain("読みはあなた自身の知識で");

    const structured = result.structuredContent;
    expect(structured.kind).toBe("composite");
    expect(structured.method).toBe("midpoint");
    expect(structured.a).toEqual({ chart_id: idA, label: "わたし", house_system: "P" });
    expect(structured.b).toEqual({ chart_id: idB, label: "あいて", house_system: "P" });
    expect(structured).not.toHaveProperty("c");
    expect(structured).not.toHaveProperty("to_c");
    expect(structured.house_system).toBe("P");
    expect(structured.orb).toBe(5);
    expect(structured.planets).toHaveLength(10);
    expect(structured.planets[0]).toEqual({
      id: 0,
      name: "太陽",
      lon: 1.75,
      position: "牡羊座 1°45′",
      house: 9,
    });
    expect(structured.planets.map((planet: { id: number }) => planet.id)).not.toContain(11);
    // 中点図の天体に速度は無い
    for (const planet of structured.planets) {
      expect(planet).not.toHaveProperty("speed");
      expect(planet).not.toHaveProperty("retrograde");
    }
    expect(structured.angles).toEqual({ asc: 100, mc: 300 });
    expect(structured.cusps).toEqual(FAKE_ARMC_CUSPS.slice(1, 13));
    expect(structured.chart_aspects.length).toBeGreaterThan(0);
    expect(structured.conventions).toEqual({
      method: "midpoint",
      midpoint: "shorter_arc",
      opposition_tiebreak: "clockwise_from_a",
      bodies: "10_planets_plus_asc_mc",
      nodes: "excluded",
      asc: "derived_from_mc_midpoint",
      house_system: "P",
      latitude: "mean_of_birth_latitudes",
      obliquity: "at_mean_birth_jd",
    });
  });

  it("立て直した MC は中点 MC と一致する（往復の検算）", async () => {
    const [idA, idB] = await saveTwo();
    const result = await call("composite", { a: idA, b: idB });
    expect(result.structuredContent.angles.mc).toBeCloseTo(300, 9);
  });

  it("MC が中点と食い違って返ってきたら断る（壊れた返り値を通さない）", async () => {
    const [idA, idB] = await saveTwo();
    engine.armcMatchesMc = false; // 決め打ちの 310° が返る＝中点 MC（300°）と合わない
    const result = await call("composite", { a: idA, b: idB });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("MC を立て直せませんでした");
  });

  it("orb で絞れる。範囲外は断る", async () => {
    const [idA, idB] = await saveTwo();
    const wide = await call("composite", { a: idA, b: idB });
    const narrow = await call("composite", { a: idA, b: idB, orb: 1 });
    expect(narrow.isError).toBeUndefined();
    expect(narrow.content[0].text).toContain("オーブ 1.0°");
    expect(narrow.structuredContent.orb).toBe(1);
    // 1.75° の組（MC がらみ）が落ちる
    expect(narrow.structuredContent.chart_aspects.length).toBeLessThan(
      wide.structuredContent.chart_aspects.length,
    );
    expect(narrow.content[0].text).not.toContain("オーブ 1.75°");

    for (const orb of [0.1, 20]) {
      const bad = await call("composite", { a: idA, b: idB, orb });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain("orb");
    }
  });

  it("2 枚でハウス方式が違えばプラシーダスに寄せて、その理由を言い添える", async () => {
    const [idA, idB] = await saveTwo({ house_system: "W" });
    const result = await call("composite", { a: idA, b: idB });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("ハウス方式: プラシーダス（P）");
    expect(result.content[0].text).toContain("※ 2 枚でハウス方式が違うので");
    expect(result.structuredContent.house_system).toBe("P");
    expect(engine.armcCalls[0]?.hsys).toBe("P");
  });

  it("2 枚とも同じ方式ならそれを引き継ぐ", async () => {
    const [idA, idB] = await saveTwo({ house_system: "W" });
    // a / b を入れ替えても「2 枚で違う」判定は変わらない（A は P・B は W）
    const swapped = await call("composite", { a: idB, b: idA });
    expect(swapped.structuredContent.house_system).toBe("P");
    // W どうしをそろえて引き直すと W のまま
    const idW = await saveChart({ label: "ホールサイン", house_system: "W" });
    const same = await call("composite", { a: idW, b: idB });
    expect(same.structuredContent.house_system).toBe("W");
    expect(same.content[0].text).not.toContain("※ 2 枚でハウス方式が違うので");
  });
});

describe("composite（簡易方式＝出生データを預かっていない登録）", () => {
  it("ASC も中点・カスプは 30° 等分に落ち、その旨を言い添える", async () => {
    const idA = await saveChart({ label: "わたし" });
    const idOld = putBirthlessChart();

    const result = await call("composite", { a: idA, b: idOld });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain("簡易方式");
    expect(text).toContain("登録し直す");
    expect(text).toContain("MC が 10 カスプと一致しません");
    expect(text).toContain("ハウス方式: イコール（E）");

    const structured = result.structuredContent;
    expect(structured.house_system).toBe("E");
    expect(structured.conventions.asc).toBe("asc_midpoint_equal_houses");
    expect(structured.conventions.houses).toBe("equal_from_asc");
    expect(structured.conventions).not.toHaveProperty("latitude");
    // ASC は 2 枚とも 90° なので中点も 90°、カスプはそこから 30° 等分
    expect(structured.angles.asc).toBe(90);
    expect(structured.cusps).toEqual([90, 120, 150, 180, 210, 240, 270, 300, 330, 0, 30, 60]);
  });

  it("簡易方式のときは天体計算エンジンを起こさない（wasm に触らない）", async () => {
    const idA = await saveChart({ label: "わたし" });
    const idOld = putBirthlessChart();
    const withoutEngine: AstroContext = {
      ...context,
      getEngine: async () => {
        throw new Error("エンジンを起こしてはいけない場面です");
      },
    };
    const result = await call("composite", { a: idA, b: idOld }, withoutEngine);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.conventions.asc).toBe("asc_midpoint_equal_houses");
  });

  it("天体が足りない古い登録は「登録し直してください」で断る", async () => {
    const idA = await saveChart({ label: "わたし" });
    const stored: StoredChart = {
      label: "壊れた登録",
      house_system: "P",
      planets: [{ id: 0, lon: 0, speed: 1 }],
      cusps: [...FAKE_CUSPS],
      ascmc: [...FAKE_ASCMC],
      created: "2026-08-01T00:00:00.000Z",
    };
    kv.store.set("chart:user1:brokenone", JSON.stringify(stored));

    const result = await call("composite", { a: idA, b: "brokenone" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("save_chart で登録し直す");
  });
});

describe("composite（三者読み＝c）", () => {
  it("中点図 × C のアスペクトとハウスオーバーレイ 2 節が増える", async () => {
    const [idA, idB] = await saveTwo();
    const idC = await saveChart({ label: "だれか" });

    const result = await call("composite", { a: idA, b: idB, c: idC });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text.split("\n")[2]).toBe(`C: だれか（${idC}）`);
    expect(text).toContain(
      "■ 中点図と C のアスペクト（メジャー5種・オーブ 5.0°・10 天体＋ASC/MC の総当たり、ノード除く）",
    );
    // 中点は id×30°＋1.75°、C は id×30°＋0° なので同名同士が 1.75° の合になる
    expect(text).toContain("中.太陽 ☌ C.太陽（コンジャンクション / オーブ 1.75°）");
    // 向きの違う組も別々に出る（総当たり）
    expect(text).toContain("中.太陽 ⚹ C.水星");
    expect(text).toContain("中.水星 ⚹ C.太陽");
    const crossSection = section(text, "■ 中点図と C のアスペクト");
    expect(crossSection).not.toContain("Nノード");
    expect(crossSection).not.toContain("接近");

    const inC = section(text, "■ 中点図の天体が C のハウスで（10 天体）");
    const cIn = section(text, "■ C の天体が中点図のハウスで（ノード込みの 11 天体）");
    expect(inC.split("\n")[1]?.split(" / ")).toHaveLength(10);
    expect(cIn.split("\n")[1]?.split(" / ")).toHaveLength(11);
    expect(inC).not.toContain("Nノード");
    expect(cIn).toContain("Nノード");

    const structured = result.structuredContent;
    expect(structured.c).toEqual({ chart_id: idC, label: "だれか", house_system: "P" });
    expect(structured.to_c.aspects.length).toBeGreaterThan(0);
    expect(structured.to_c.overlays.composite_in_c).toHaveLength(10);
    expect(structured.to_c.overlays.c_in_composite).toHaveLength(11);
    for (const hit of structured.to_c.aspects) {
      expect(hit).not.toHaveProperty("applying");
      expect(hit.a).not.toBe("Nノード");
      expect(hit.b).not.toBe("Nノード");
    }
    // C を足しても中点図そのものは変わらない
    const without = await call("composite", { a: idA, b: idB });
    expect(structured.planets).toEqual(without.structuredContent.planets);
    expect(structured.chart_aspects).toEqual(without.structuredContent.chart_aspects);
  });

  it("c は a / b と同じ ID でもよい（本人と関係図の重なりを見る）", async () => {
    const [idA, idB] = await saveTwo();
    const result = await call("composite", { a: idA, b: idB, c: idA });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.c.chart_id).toBe(idA);
    expect(result.structuredContent.to_c.aspects.length).toBeGreaterThan(0);
  });

  it("知らない c は、どの引数かを言い添えて断る", async () => {
    const [idA, idB] = await saveTwo();
    const result = await call("composite", { a: idA, b: idB, c: "nosuchid" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("c に指定したチャート nosuchid");
    expect(result.content[0].text).toContain("list_charts");
  });
});

describe("composite の門番", () => {
  it("同じ chart_id を a / b に渡すと断る（1 枚は get_chart）", async () => {
    const idA = await saveChart();
    const result = await call("composite", { a: idA, b: idA });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("同じチャート同士です");
    expect(result.content[0].text).toContain("get_chart");
  });

  it("知らない chart_id は、どちら側かを言い添えて断る", async () => {
    const idA = await saveChart();
    const missingB = await call("composite", { a: idA, b: "nosuchid" });
    expect(missingB.isError).toBe(true);
    expect(missingB.content[0].text).toContain("b に指定したチャート nosuchid");

    const missingA = await call("composite", { a: "nosuchid", b: idA });
    expect(missingA.isError).toBe(true);
    expect(missingA.content[0].text).toContain("a に指定したチャート nosuchid");
  });

  it("他人の台帳のチャートは見えない", async () => {
    const [idA, idB] = await saveTwo();
    const other: AstroContext = {
      ...context,
      auth: { user: "tomodachi", name: "ともだち", role: "friend" },
    };
    const peek = await call("composite", { a: idA, b: idB }, other);
    expect(peek.isError).toBe(true);
    expect(peek.content[0].text).toContain("a に指定したチャート");
  });

  it("a / b は必須。未知の引数キーは弾く", async () => {
    const idA = await saveChart();
    const noB = await call("composite", { a: idA });
    expect(noB.isError).toBe(true);
    expect(noB.content[0].text).toContain("b は必須です");

    const typo = await call("composite", { a: idA, b: idA, orbs: 5 });
    expect(typo.isError).toBe(true);
    expect(typo.content[0].text).toContain("orbs");
  });
});

describe("composite と出生データ", () => {
  it("返事に出生データも緯度（中間緯度も）も出さない", async () => {
    const [idA, idB] = await saveTwo();
    const idC = await saveChart({ label: "だれか" });
    const result = await call("composite", { a: idA, b: idB, c: idC });
    const text: string = result.content[0].text;
    const structured = JSON.stringify(result.structuredContent);
    for (const trace of BIRTH_TRACES) {
      expect(text).not.toContain(trace);
      expect(structured).not.toContain(trace);
    }
    // 「birth」の字が出てよいのは規約の名前（mean_of_birth_latitudes / at_mean_birth_jd）だけ
    const withoutConventions = JSON.stringify({
      ...result.structuredContent,
      conventions: null,
    });
    expect(withoutConventions).not.toContain("birth");
    expect(structured).not.toContain("utc_offset");
    // 黄道傾斜も ARMC も出さない（どちらも出生の瞬間を絞り込む手がかりになる）
    expect(structured).not.toContain("armc");
    expect(structured).not.toContain("eps");
    expect(structured).not.toContain(String(FAKE_EPS));
    // A / B それぞれの天体の黄経も出さない（中点だけ）
    expect(structured).not.toContain('"speed"');
  });

  it("tools/list に 13 本目として並ぶ（凍結した定義と同じ形）", async () => {
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
    const tool: any = tools.find((candidate) => candidate.name === "composite");
    expect(tool).toBeDefined();
    expect(tool.title).toBe("コンポジット（2 枚の中点図）");
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["a", "b", "c", "orb"]);
    expect(tool.inputSchema.required).toEqual(["a", "b"]);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    // 中点法であってダヴィソンではない・ハウスは参考程度・読みは呼び出した側
    expect(tool.description).toContain("ダヴィソン法ではない");
    expect(tool.description).toContain("中点図のハウスは参考程度");
    expect(tool.description).toContain("三者読み");
    expect(tool.description).toContain("解釈をしない");
    expect(tool.description).toContain("出生データそのものは返事に出さない");
  });
});
