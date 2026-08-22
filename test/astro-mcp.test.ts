import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { normalizeDegree } from "../src/astro/chart";
import { handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import {
  createChart,
  newChartId,
  type AuthContext,
  type StoredChart,
} from "../src/astro/store";
import type { RandomSource } from "../src/random";
import { FakeKv } from "./stubs/fake-kv";
import { FAKE_ASCMC, FAKE_CUSPS, makeFakeEngine, type FakeEngine } from "./stubs/fake-engine";

const OWNER_KEY = "testkey1234567890abcd";
const OWNER_RECORD = JSON.stringify({ user: "user1", name: "オーナー", role: "owner" });
const OWNER: AuthContext = { user: "user1", name: "オーナー", role: "owner" };

let kv: FakeKv;
let engine: FakeEngine;
let context: AstroContext;

beforeEach(() => {
  kv = new FakeKv();
  kv.store.set(`key:${OWNER_KEY}`, OWNER_RECORD);
  engine = makeFakeEngine();
  context = {
    auth: OWNER,
    kv,
    getEngine: async () => engine,
    now: () => new Date("2026-08-20T02:15:00Z"),
  };
});

/** 占星術層に JSON-RPC を 1 発投げる（鍵の照合は済んでいる前提のハンドラ直叩き） */
async function rpc(body: unknown, ctx: AstroContext = context): Promise<any> {
  const response = await handleAstroMcpRequest(
    new Request(`http://localhost/mcp/${OWNER_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  );
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

let nextId = 1;

/** tools/call を 1 発。result（ToolResult）を返す */
async function call(name: string, args: unknown = {}, ctx: AstroContext = context): Promise<any> {
  const json = await rpc(
    { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } },
    ctx,
  );
  return json.result;
}

/** worker.fetch 経由（鍵の照合込み） */
async function fetchMcp(
  path: string,
  body: unknown,
  method = "POST",
  // withEnv: false で「バインディングごと無い」状態を再現する
  options: { withEnv?: boolean } = {},
): Promise<{ response: Response; json: any }> {
  const init: RequestInit = { method };
  if (method === "POST") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const env: Env | undefined =
    options.withEnv === false ? undefined : { ASTRO_KV: kv.asKvNamespace() };
  const response = await worker.fetch(new Request(`http://localhost${path}`, init), env);
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, json };
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

async function saveDefaultChart(): Promise<string> {
  const result = await call("save_chart", BIRTH);
  expect(result.isError).toBeUndefined();
  return result.structuredContent.chart_id as string;
}

/**
 * 偽エンジンの天体を 1 つだけずらす（以後に計算される図にだけ効く）。
 *
 * 偽エンジンは天体を 30° の格子に並べるので、素のままだと図の中のアスペクトが
 * 全部ぴったり（オーブ 0°）になり、オーブを変えても本数が動かない。
 * 1 天体だけ半端な角度へずらすと「オーブ 5° なら拾い、2° なら落ちる」組ができる。
 */
function nudgePlanet(planetId: number, delta: number): void {
  const base = engine.swe_calc_ut;
  engine.swe_calc_ut = (jd: number, id: number, flags: number): number[] => {
    const result = base(jd, id, flags);
    if (id === planetId) result[0] = normalizeDegree((result[0] as number) + delta);
    return result;
  };
}

// ---------------------------------------------------------------------------

describe("占星術層の initialize / tools/list", () => {
  it("serverInfo はカード層と同じ名前、instructions は別文", async () => {
    const json = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(json.result.protocolVersion).toBe("2025-03-26");
    expect(json.result.capabilities).toEqual({ tools: {} });
    expect(json.result.serverInfo.name).toBe("fortune-gatekeeper");
    expect(typeof json.result.serverInfo.version).toBe("string");

    const instructions: string = json.result.instructions;
    // 計算はサーバー、解釈は会話中の LLM
    expect(instructions).toContain("計算するのはサーバー");
    expect(instructions).toContain("解釈は一切しません");
    // 原本レス
    expect(instructions).toContain("出生日時と出生地は計算に使ったあと捨てます");
    // ツールの使い分け
    expect(instructions).toContain("save_chart");
    expect(instructions).toContain("list_charts");
    expect(instructions).toContain("transit");
    expect(instructions).toContain("delete_chart");
    expect(instructions).toContain("update_default_location");
    expect(instructions).toContain("lunar_return");
    expect(instructions).toContain("solar_return");
    expect(instructions).toContain("yearly_overview");
    expect(instructions).toContain("transit_events");
    // 二次進行は「原本を預けた本人だけ」と断ってある
    expect(instructions).toContain("progressions");
    expect(instructions).toContain("原本を預けた本人");
    // カード層の文言は混ざらない
    expect(instructions).not.toContain("draw_cards");
    // 作者の氏名は書かない
    expect(instructions).not.toContain("和条門");
  });

  it("知らないバージョンなら既定の 2025-06-18", async () => {
    const json = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(json.result.protocolVersion).toBe("2025-06-18");
  });

  it("11 本のツールを返す", async () => {
    const json = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual([
      "save_chart",
      "list_charts",
      "get_chart",
      "delete_chart",
      "transit",
      "lunar_return",
      "solar_return",
      "progressions",
      "update_default_location",
      "yearly_overview",
      "transit_events",
    ]);
  });

  it("ツール定義は凍結（クライアントが接続時にキャッシュするので勝手に変えない）", async () => {
    const json = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    expect(json.result.tools).toEqual(FROZEN_ASTRO_TOOLS);
  });

  it("ping と知らないメソッド", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 5, method: "ping" })).result).toEqual({});
    const unknown = await rpc({ jsonrpc: "2.0", id: 6, method: "resources/list" });
    expect(unknown.error.code).toBe(-32601);
  });
});

describe("鍵の照合（POST /mcp/<鍵>）", () => {
  it("知らない鍵は 401。鍵そのものは返事に出さない", async () => {
    const { response, json } = await fetchMcp("/mcp/badkey0000", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(401);
    expect(json.error.code).toBe(-32001);
    expect(json.error.message).not.toContain("badkey0000");
    expect(json.error.message).toContain("確認できませんでした");
  });

  it("形の違う鍵（記号入り・短すぎ）も同じ 401", async () => {
    for (const key of ["a", "%E3%81%82%E3%81%82", "key:testkey123"]) {
      const { response } = await fetchMcp(`/mcp/${key}`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expect(response.status).toBe(401);
    }
  });

  it("正しい鍵なら initialize と tools/list が通る", async () => {
    const init = await fetchMcp(`/mcp/${OWNER_KEY}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(init.response.status).toBe(200);
    expect(init.response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(init.json.result.serverInfo.name).toBe("fortune-gatekeeper");
    expect(init.json.result.instructions).toContain("ホロスコープ");

    const tools = await fetchMcp(`/mcp/${OWNER_KEY}`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(tools.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "save_chart",
      "list_charts",
      "get_chart",
      "delete_chart",
      "transit",
      "lunar_return",
      "solar_return",
      "progressions",
      "update_default_location",
      "yearly_overview",
      "transit_events",
    ]);
  });

  it("鍵つき URL でも GET / DELETE は 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const { response } = await fetchMcp(`/mcp/${OWNER_KEY}`, null, method);
      expect(response.status).toBe(405);
    }
  });

  it("KV バインディングが無ければ 500（黙って動いたふりをしない）", async () => {
    const { response, json } = await fetchMcp(
      `/mcp/${OWNER_KEY}`,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "POST",
      { withEnv: false },
    );
    expect(response.status).toBe(500);
    expect(json.error.code).toBe(-32603);
  });

  it("公開カード層は無傷（3 本のまま・鍵も要らない）", async () => {
    const { response, json } = await fetchMcp("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(200);
    expect(json.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list_decks",
      "draw_cards",
      "cast_hexagram",
    ]);
  });

  it("案内文は占星術層の存在にだけ触れ、鍵の形は書かない", async () => {
    const response = await worker.fetch(new Request("http://localhost/"));
    const text = await response.text();
    expect(text).toContain("占星術");
    expect(text).not.toContain("/mcp/");
  });
});

describe("save_chart", () => {
  it("chart_id とネイタル要約を返し、出生日時・出生地は保存しない", async () => {
    // 出生地（東京）と「いつもの場所」（大阪）をわざと別にして、残るのが後者だけだと確かめる
    const result = await call("save_chart", {
      ...BIRTH,
      default_lat: 34.6937,
      default_lng: 135.5023,
      default_location_label: "大阪",
    });
    expect(result.isError).toBeUndefined();

    const chartId: string = result.structuredContent.chart_id;
    expect(chartId).toMatch(/^[a-z0-9]{8}$/);

    const text: string = result.content[0].text;
    expect(text).toContain(`chart_id: ${chartId}`);
    expect(text).toContain("ラベル: サンプル");
    expect(text).toContain("ハウス方式: プラシーダス（P）");
    expect(text).toContain("いつもの場所: 大阪 緯度 34.6937 / 経度 135.5023");
    // 偽エンジンは天体を 30° 刻みに並べる。ハウスはカスプ（1H=90°）基準
    expect(text).toContain("太陽 牡羊座 0°00′ (10H)");
    expect(text).toContain("月 牡牛座 0°00′ (11H)");
    expect(text).toContain("金星 蟹座 0°00′ (1H)（逆行）");
    expect(text).toContain("ASC 蟹座 0°00′ / MC 水瓶座 0°00′");
    expect(text.trimEnd().endsWith("出生日時・出生地は保存していません（計算に使って捨てました）。")).toBe(
      true,
    );

    // KV に落ちた中身に、出生日時・出生地・jd が混ざっていないこと
    const raw = kv.store.get(`chart:user1:${chartId}`) as string;
    const stored = JSON.parse(raw);
    expect(Object.keys(stored).sort()).toEqual([
      "ascmc",
      "created",
      "cusps",
      "default_location",
      "house_system",
      "label",
      "planets",
    ]);
    // 出生年・出生地の緯度経度はどこにも残っていない
    expect(raw).not.toContain("1990");
    expect(raw).not.toContain("35.6895");
    expect(raw).not.toContain("139.6917");
    expect(stored.planets).toHaveLength(11);
    expect(stored.planets[0]).toEqual({ id: 0, lon: 0, speed: 1 });
    // 明示的に預けた「いつもの場所」だけが残る
    expect(stored.default_location).toEqual({ lat: 34.6937, lng: 135.5023, label: "大阪" });

    // 計算そのものには出生地がちゃんと渡っている（渡してから捨てている）
    expect(engine.houseCalls[0]?.lat).toBe(35.6895);
    expect(engine.houseCalls[0]?.lng).toBe(139.6917);
  });

  it("いつもの場所を省略すれば default_location も持たない", async () => {
    const result = await call("save_chart", BIRTH);
    expect(result.structuredContent.default_location).toBeUndefined();
    expect(result.content[0].text).not.toContain("いつもの場所");
  });

  it("時差は jd に溶ける（日本時間 21:00 ＝ 12:00 UTC）", async () => {
    await call("save_chart", BIRTH);
    const utcJd = engine.juldays[0] as number;

    engine.juldays.length = 0;
    await call("save_chart", { ...BIRTH, hour: 21, utc_offset: 9 });
    expect(engine.juldays[0]).toBeCloseTo(utcJd, 8);
  });

  it("ハウス方式は指定どおりエンジンに渡る", async () => {
    await call("save_chart", { ...BIRTH, house_system: "W" });
    expect(engine.houseCalls[0]?.hsys).toBe("W");
    const listed = await call("list_charts");
    expect(listed.content[0].text).toContain("ホールサイン（W）");
  });

  it("足りない引数・範囲外・知らないハウス方式は isError", async () => {
    expect((await call("save_chart", {})).content[0].text).toContain("label は必須です");
    const noYear = await call("save_chart", { ...BIRTH, year: undefined });
    expect(noYear.isError).toBe(true);
    expect((await call("save_chart", { ...BIRTH, month: 13 })).isError).toBe(true);
    expect((await call("save_chart", { ...BIRTH, lat: 91 })).isError).toBe(true);
    expect((await call("save_chart", { ...BIRTH, hour: 12.5 })).isError).toBe(true);
    const badHouse = await call("save_chart", { ...BIRTH, house_system: "Z" });
    expect(badHouse.isError).toBe(true);
    expect(badHouse.content[0].text).toContain("house_system");
    // いつもの場所は緯度・経度そろえて
    const halfPlace = await call("save_chart", { ...BIRTH, default_lat: 35 });
    expect(halfPlace.isError).toBe(true);
  });

  it("エンジンが立ち上がらなければ、そう言う", async () => {
    const broken: AstroContext = {
      ...context,
      getEngine: async () => {
        throw new Error("wasm がありません");
      },
    };
    const result = await call("save_chart", BIRTH, broken);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("天体計算エンジンを初期化できませんでした");
  });
});

describe("list_charts / delete_chart", () => {
  it("0 件なら save_chart へ誘導する", async () => {
    const result = await call("list_charts");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.charts).toEqual([]);
    expect(result.content[0].text).toContain("保存済みのチャートはまだありません");
    expect(result.content[0].text).toContain("save_chart");
  });

  it("登録すると一覧に出る", async () => {
    const chartId = await saveDefaultChart();
    const result = await call("list_charts");
    expect(result.structuredContent.charts).toHaveLength(1);
    expect(result.structuredContent.charts[0].chart_id).toBe(chartId);
    expect(result.content[0].text).toContain("保存済みチャート（1件）");
    expect(result.content[0].text).toContain(`- ${chartId}: サンプル`);
    expect(result.content[0].text).toContain("プラシーダス（P）");
  });

  it("他人のチャートは見えない（chart: の前置きで仕切ってある）", async () => {
    const chartId = await saveDefaultChart();
    const other: AstroContext = {
      ...context,
      auth: { user: "tomodachi", name: "ともだち", role: "friend" },
    };
    const listed = await call("list_charts", {}, other);
    expect(listed.structuredContent.charts).toEqual([]);
    const peek = await call("transit", { chart_id: chartId }, other);
    expect(peek.isError).toBe(true);
  });

  it("delete_chart は消して、二度目は見つからない", async () => {
    const chartId = await saveDefaultChart();

    const removed = await call("delete_chart", { chart_id: chartId });
    expect(removed.isError).toBeUndefined();
    expect(removed.content[0].text).toBe(`チャート ${chartId}（サンプル）を削除しました。`);
    expect(kv.store.has(`chart:user1:${chartId}`)).toBe(false);

    const again = await call("delete_chart", { chart_id: chartId });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain("見つかりませんでした");

    expect((await call("list_charts")).structuredContent.charts).toEqual([]);
  });
});

describe("get_chart", () => {
  it("保存済みの座標を読み直し、出生図の中のアスペクトを足して返す（エンジンは呼ばない）", async () => {
    const chartId = await saveDefaultChart();
    const juldaysBefore = engine.juldays.length;
    const houseCallsBefore = engine.houseCalls.length;

    const result = await call("get_chart", { chart_id: chartId });
    expect(result.isError).toBeUndefined();
    // 読み直しは KV だけ。ユリウス日もハウスも計算し直さない
    expect(engine.juldays.length).toBe(juldaysBefore);
    expect(engine.houseCalls.length).toBe(houseCallsBefore);

    const text: string = result.content[0].text;
    expect(text.split("\n")[0]).toBe("出生図（ネイタル）");
    expect(text).toContain(`チャート: サンプル（${chartId}） / ハウス方式: プラシーダス（P）`);
    expect(text).toContain("■ ネイタル天体");
    expect(text).toContain("太陽 牡羊座 0°00′ (10H)");
    expect(text).toContain("金星 蟹座 0°00′ (1H)（逆行）");
    expect(text).toContain("Nノード 魚座 0°00′");
    expect(text).toContain("ASC 蟹座 0°00′ / MC 水瓶座 0°00′");
    expect(text).toContain("■ ハウスカスプ");
    expect(text).toContain("1H 蟹座 0°00′ / 2H 獅子座 0°00′");
    expect(text).toContain("■ ネイタル内アスペクト（メジャー5種・オーブ 5.0°・10 天体＋ASC/MC、ノード除く）");
    // 偽エンジンは 30° 刻み＝太陽 0°・水星 60°・金星 90°・火星 120°・土星 180°、ASC 90°
    expect(text).toContain("太陽 ⚹ 水星（セクスタイル / オーブ 0.00°）");
    expect(text).toContain("太陽 □ 金星（スクエア / オーブ 0.00°）");
    expect(text).toContain("太陽 △ 火星（トライン / オーブ 0.00°）");
    expect(text).toContain("太陽 ☍ 土星（オポジション / オーブ 0.00°）");
    expect(text).toContain("金星 ☌ ASC（コンジャンクション / オーブ 0.00°）");
    // 止まった図なので接近・離反は書かない。ノードはアスペクトに出さない
    expect(text).not.toContain("接近");
    expect(text).not.toContain("離反");
    const aspectSection = text.slice(text.indexOf("■ ネイタル内アスペクト"));
    expect(aspectSection).not.toContain("Nノード");

    const structured = result.structuredContent;
    expect(structured.chart_id).toBe(chartId);
    expect(structured.house_system).toBe("P");
    expect(structured.planets).toHaveLength(11);
    expect(structured.planets[0]).toMatchObject({ id: 0, name: "太陽", lon: 0, house: 10 });
    expect(structured.angles).toEqual({ asc: 90, mc: 300 });
    expect(structured.cusps).toHaveLength(12);
    expect(structured.cusps[0]).toBe(90);
    expect(structured.orb).toBe(5);
    expect(structured.natal_aspects.length).toBeGreaterThan(0);
    for (const hit of structured.natal_aspects) {
      expect(hit.a).not.toBe("Nノード");
      expect(hit.b).not.toBe("Nノード");
      expect(hit).not.toHaveProperty("applying");
    }
    // 出生日時・出生地は読み直しても出てこない（そもそも持っていない）
    expect(text).not.toContain("1990");
    expect(JSON.stringify(structured)).not.toContain("139.6917");
  });

  it("いつもの場所があれば見出しに添える", async () => {
    const result = await call("save_chart", {
      ...BIRTH,
      default_lat: 34.6937,
      default_lng: 135.5023,
      default_location_label: "大阪",
    });
    const chartId: string = result.structuredContent.chart_id;
    const read = await call("get_chart", { chart_id: chartId });
    expect(read.content[0].text).toContain("いつもの場所: 大阪（34.6937, 135.5023）");
    expect(read.structuredContent.default_location).toEqual({
      lat: 34.6937,
      lng: 135.5023,
      label: "大阪",
    });
  });

  it("orb を指定すると見出しと structuredContent に反映される。範囲外は断る", async () => {
    const chartId = await saveDefaultChart();
    const narrow = await call("get_chart", { chart_id: chartId, orb: 2 });
    expect(narrow.isError).toBeUndefined();
    expect(narrow.content[0].text).toContain("オーブ 2.0°");
    expect(narrow.structuredContent.orb).toBe(2);

    for (const orb of [0.1, 20]) {
      const bad = await call("get_chart", { chart_id: chartId, orb });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain("orb");
    }
  });

  it("知らない chart_id・他人のチャートは丁寧に断る", async () => {
    const missing = await call("get_chart", { chart_id: "nosuchid" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("チャート nosuchid が見つかりませんでした");
    expect(missing.content[0].text).toContain("list_charts");

    const chartId = await saveDefaultChart();
    const other: AstroContext = {
      ...context,
      auth: { user: "tomodachi", name: "ともだち", role: "friend" },
    };
    const peek = await call("get_chart", { chart_id: chartId }, other);
    expect(peek.isError).toBe(true);
  });
});

describe("transit", () => {
  it("日時を指定すると、その時刻の天体・在ハウス・アスペクトを返す", async () => {
    const chartId = await saveDefaultChart();
    // ネイタルから 0.5° ずらした空にする
    engine.offset = 0.5;

    const result = await call("transit", {
      chart_id: chartId,
      year: 2026,
      month: 8,
      day: 20,
      hour: 0,
      minute: 0,
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text.split("\n")[0]).toBe("トランジット");
    expect(text).toContain(`チャート: サンプル（${chartId}） / ハウス方式: プラシーダス（P）`);
    expect(text).toContain("日時: 2026-08-20 00:00 UTC");
    // utc_offset を渡していないのでローカル表示は出ない
    expect(text).not.toContain("ローカル");

    // (a) 星座・度数・逆行 と (b) ネイタルのカスプによる在ハウス
    expect(text).toContain("■ トランジット天体（カッコ内はネイタルのカスプで見た在ハウス）");
    expect(text).toContain("太陽 牡羊座 0°30′ (10H)");
    expect(text).toContain("金星 蟹座 0°30′ (1H)（逆行）");
    // ネイタルも参考に並ぶ
    expect(text).toContain("■ ネイタル天体（参考）");
    expect(text).toContain("ASC 蟹座 0°00′ / MC 水瓶座 0°00′");

    // (c) クロスアスペクト（ASC / MC も相手になる）
    expect(text).toContain("■ ネイタルへのアスペクト（メジャー5種・オーブ 1.0°）");
    expect(text).toContain("T.太陽 ☌ N.太陽（コンジャンクション / オーブ 0.50° / 離反）");
    expect(text).toContain("N.ASC");
    expect(text).toContain("N.MC");
    // 逆行してくる金星はネイタル金星へ接近中
    expect(text).toContain("T.金星 ☌ N.金星（コンジャンクション / オーブ 0.50° / 接近）");

    const structured = result.structuredContent;
    expect(structured.chart_id).toBe(chartId);
    expect(structured.utc).toBe("2026-08-20T00:00:00.000Z");
    expect(structured.is_now).toBe(false);
    expect(structured.transit_planets).toHaveLength(11);
    expect(structured.transit_planets[0]).toEqual({
      id: 0,
      name: "太陽",
      lon: 0.5,
      speed: 1,
      retrograde: false,
      position: "牡羊座 0°30′",
      house: 10,
    });
    expect(structured.aspects.length).toBeGreaterThan(0);
    // オーブの狭い順
    const orbs = structured.aspects.map((hit: { aspect: { orb: number } }) => hit.aspect.orb);
    expect([...orbs].sort((a, b) => a - b)).toEqual(orbs);
  });

  it("utc_offset を渡すとローカル表示も付く", async () => {
    const chartId = await saveDefaultChart();
    const result = await call("transit", {
      chart_id: chartId,
      year: 2026,
      month: 8,
      day: 20,
      hour: 9,
      minute: 0,
      utc_offset: 9,
    });
    const text: string = result.content[0].text;
    expect(text).toContain("日時: 2026-08-20 00:00 UTC");
    expect(text).toContain("ローカル 2026-08-20 09:00（UTC+9）");
    expect(result.structuredContent.utc).toBe("2026-08-20T00:00:00.000Z");
  });

  it("日時をすべて省略すると現在時刻（UTC）", async () => {
    const chartId = await saveDefaultChart();
    const result = await call("transit", { chart_id: chartId });
    expect(result.content[0].text).toContain("日時: 2026-08-20 02:15 UTC（現在時刻）");
    expect(result.structuredContent.is_now).toBe(true);
    expect(result.structuredContent.utc).toBe("2026-08-20T02:15:00.000Z");
  });

  it("日付を半端に指定したら止める", async () => {
    const chartId = await saveDefaultChart();
    const result = await call("transit", { chart_id: chartId, hour: 12 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("year / month / day をそろえて");
  });

  it("アスペクトが 1 本も無ければ、その旨", async () => {
    const chartId = await saveDefaultChart();
    // 15° ずらすとメジャーアスペクト（0/60/90/120/180）からきれいに外れる
    engine.offset = 15;
    const result = await call("transit", { chart_id: chartId, year: 2026, month: 8, day: 20 });
    expect(result.content[0].text).toContain("該当なし");
    expect(result.structuredContent.aspects).toEqual([]);
  });

  it("空の中のアスペクト（トランジット天体同士）も足す。既定オーブは 5°", async () => {
    const chartId = await saveDefaultChart();
    engine.offset = 0.5;

    const result = await call("transit", { chart_id: chartId, year: 2026, month: 8, day: 20 });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain(
      "■ 空の中のアスペクト（トランジット天体同士・メジャー5種・オーブ 5.0°・ノード除く）",
    );
    // 偽エンジンの空は 30° 刻み＝太陽 0.5°・水星 60.5°・金星 90.5°・火星 120.5°・土星 180.5°
    expect(text).toContain("太陽 ⚹ 水星（セクスタイル / オーブ 0.00°）");
    expect(text).toContain("太陽 □ 金星（スクエア / オーブ 0.00°）");
    expect(text).toContain("太陽 △ 火星（トライン / オーブ 0.00°）");
    expect(text).toContain("太陽 ☍ 土星（オポジション / オーブ 0.00°）");

    // 個人向けの読み（ネイタルへ）が先、その日の空そのものの背景が後
    expect(text.indexOf("■ ネイタルへのアスペクト")).toBeLessThan(
      text.indexOf("■ 空の中のアスペクト"),
    );

    // 同じ図の中の 2 点なので T. / N. の札も接近・離反も付かない。ノードも入らない
    const skySection = text.slice(text.indexOf("■ 空の中のアスペクト"));
    expect(skySection).not.toContain("T.");
    expect(skySection).not.toContain("N.");
    expect(skySection).not.toContain("接近");
    expect(skySection).not.toContain("離反");
    expect(skySection).not.toContain("Nノード");
    // transit は空側の ASC/MC を立てないので、点は天体だけ
    expect(skySection).not.toContain("ASC");
    expect(skySection).not.toContain("MC");

    const chartAspects = result.structuredContent.chart_aspects;
    expect(chartAspects.length).toBeGreaterThan(0);
    for (const hit of chartAspects) {
      expect(typeof hit.a).toBe("string");
      expect(typeof hit.b).toBe("string");
      expect(hit).not.toHaveProperty("applying");
      expect(hit).not.toHaveProperty("transit");
      expect(hit.a).not.toBe("Nノード");
      expect(hit.b).not.toBe("Nノード");
    }
    // オーブの狭い順
    const orbs = chartAspects.map((hit: { aspect: { orb: number } }) => hit.aspect.orb);
    expect([...orbs].sort((a: number, b: number) => a - b)).toEqual(orbs);
  });

  it("orb は空の中のアスペクトにだけ効く（ネイタルへの 1° は動かない）", async () => {
    const chartId = await saveDefaultChart();
    // ネイタルを保存したあとで火星だけ 3° ずらす＝オーブ 5° なら拾い、2° なら落ちる
    nudgePlanet(4, 3);

    const when = { chart_id: chartId, year: 2026, month: 8, day: 20 };
    const wide = await call("transit", when);
    const narrow = await call("transit", { ...when, orb: 2 });
    expect(narrow.isError).toBeUndefined();

    expect(narrow.content[0].text).toContain(
      "■ 空の中のアスペクト（トランジット天体同士・メジャー5種・オーブ 2.0°・ノード除く）",
    );
    expect(wide.content[0].text).toContain("太陽 △ 火星（トライン / オーブ 3.00°）");
    expect(narrow.content[0].text).not.toContain("太陽 △ 火星");
    expect(narrow.structuredContent.chart_aspects.length).toBeLessThan(
      wide.structuredContent.chart_aspects.length,
    );

    // 図→ネイタルのアスペクトは 1° のまま（見出しも中身も同じ）
    expect(narrow.content[0].text).toContain(
      "■ ネイタルへのアスペクト（メジャー5種・オーブ 1.0°）",
    );
    expect(narrow.structuredContent.aspects).toEqual(wide.structuredContent.aspects);
  });

  it("知らない chart_id は丁寧に断る", async () => {
    const result = await call("transit", { chart_id: "nosuchid" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("チャート nosuchid が見つかりませんでした");
    expect(result.content[0].text).toContain("list_charts");
  });

  it("chart_id の形をしていないものも同じ扱い（KV を引きに行かない）", async () => {
    const result = await call("transit", { chart_id: "../../key:testkey123" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("見つかりませんでした");
  });
});

// ---------------------------------------------------------------------------
// リターン（ルナリターン・ソーラーリターン）
// ---------------------------------------------------------------------------

/** 偽エンジンと同じ式でユリウス日を作る（テスト側から通過の日時を仕込むため） */
function jdOf(year: number, month: number, day: number, hour = 0): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 2440587.5 + hour / 24;
}

/** 東京を「いつもの場所」として登録したチャート */
async function saveChartWithHome(): Promise<string> {
  const result = await call("save_chart", {
    ...BIRTH,
    default_lat: 35.6895,
    default_lng: 139.6917,
    default_location_label: "東京",
  });
  expect(result.isError).toBeUndefined();
  return result.structuredContent.chart_id as string;
}

describe("lunar_return", () => {
  it("引数を省略すると現在時刻から見て次の 1 回", async () => {
    const chartId = await saveChartWithHome();
    // 次の通過を 2026-08-21 03:00 UTC に仕込む（現在は 2026-08-20 02:15 UTC）
    engine.moonAnchorJd = jdOf(2026, 8, 21, 3);

    const result = await call("lunar_return", { chart_id: chartId, utc_offset: 9 });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text.split("\n")[0]).toBe("ルナリターン（月の帰還）");
    expect(text).toContain(`チャート: サンプル（${chartId}） / ハウス方式: プラシーダス（P）`);
    // ネイタル月は偽エンジンでは 30°（牡牛座 0°）
    expect(text).toContain("ネイタルの月: 牡牛座 0°00′");
    expect(text).toContain("リターン図を立てた場所: 東京（緯度 35.6895 / 経度 139.6917）");
    expect(text).toContain("（現在）より後の次の 1 回");
    expect(text).toContain("リターンの瞬間: 2026-08-21 03:00 UTC");
    expect(text).toContain("ローカル 2026-08-21 12:00（UTC+9）");
    expect(text).toContain("□ リターン図の天体（カッコ内はリターン図自身のカスプで見た在ハウス）");
    expect(text).toContain("太陽 牡羊座 0°00′ (10H)");
    expect(text).toContain("ASC 蟹座 0°00′ / MC 水瓶座 0°00′");
    expect(text).toContain("□ リターン図のハウスカスプ");
    expect(text).toContain("1H 蟹座 0°00′ / 2H 獅子座 0°00′");
    expect(text).toContain("□ ネイタルへのアスペクト（メジャー5種・オーブ 1.0°）");
    expect(text).toContain("T.月 ☌ N.月");
    // 1 回しか無いときは「■ n 回目」を出さない
    expect(text).not.toContain("■ 1 回目");

    // 「いつもの場所」でハウスを立てている（最後の swe_houses 呼び出し）
    const lastHouse = engine.houseCalls[engine.houseCalls.length - 1];
    expect(lastHouse?.lat).toBe(35.6895);
    expect(lastHouse?.lng).toBe(139.6917);
    expect(lastHouse?.hsys).toBe("P");

    // 通過計算は月・フラグ 260・現在の jd から
    expect(engine.crossCalls).toHaveLength(1);
    expect(engine.crossCalls[0]?.kind).toBe("moon");
    expect(engine.crossCalls[0]?.targetLon).toBe(30);
    expect(engine.crossCalls[0]?.flags).toBe(260);
    expect(engine.crossCalls[0]?.startJd).toBeCloseTo(jdOf(2026, 8, 20) + 2.25 / 24, 6);

    const structured = result.structuredContent;
    expect(structured.kind).toBe("lunar_return");
    expect(structured.is_next).toBe(true);
    expect(structured.period).toBeNull();
    expect(structured.location).toEqual({ lat: 35.6895, lng: 139.6917, label: "東京" });
    expect(structured.returns).toHaveLength(1);
    expect(structured.returns[0].utc).toBe("2026-08-21T03:00:00.000Z");
    expect(structured.returns[0].planets).toHaveLength(11);
    expect(structured.returns[0].cusps).toHaveLength(13);
    expect(structured.returns[0].aspects.length).toBeGreaterThan(0);
  });

  it("year / month を指定すると、その月に入るぶんをすべて返す（2 回の月）", async () => {
    const chartId = await saveChartWithHome();
    // 8/2 と 8/29.32 の 2 回が 8 月に入る並び
    engine.moonAnchorJd = jdOf(2026, 8, 2);

    const result = await call("lunar_return", {
      chart_id: chartId,
      year: 2026,
      month: 8,
      utc_offset: 9,
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain("対象: 2026年8月（UTC+9 の暦） ― 2件");
    expect(text).toContain("■ 1 回目");
    expect(text).toContain("■ 2 回目");
    expect(result.structuredContent.returns).toHaveLength(2);
    expect(result.structuredContent.is_next).toBe(false);
    expect(result.structuredContent.period).toEqual({ year: 2026, month: 8 });
    // 2 件目は 27.32 日後
    const [first, second] = result.structuredContent.returns;
    expect(second.jd - first.jd).toBeCloseTo(27.32, 6);
  });

  it("その月に 1 回も入らなければ、そう言う（0 回の月）", async () => {
    const chartId = await saveChartWithHome();
    // 周期を伸ばして 8 月を素通りさせる（次の通過は 9/5）
    engine.moonPeriod = 35;
    engine.moonAnchorJd = jdOf(2026, 9, 5);

    const result = await call("lunar_return", { chart_id: chartId, year: 2026, month: 8 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("対象: 2026年8月（UTC の暦） ― 0件");
    expect(result.content[0].text).toContain("この期間に月のリターンはありませんでした");
    expect(result.structuredContent.returns).toEqual([]);
  });

  it("暦月の区切りは utc_offset の土地の暦で見る", async () => {
    const chartId = await saveChartWithHome();
    // 2026-08-31 20:00 UTC ＝ 日本時間では 9/1 05:00。JST の暦では 8 月に入らない
    engine.moonAnchorJd = jdOf(2026, 8, 31, 20);

    const utc = await call("lunar_return", { chart_id: chartId, year: 2026, month: 8 });
    const utcMoments = utc.structuredContent.returns.map((one: { utc: string }) => one.utc);
    expect(utcMoments).toContain("2026-08-31T20:00:00.000Z");

    const jst = await call("lunar_return", {
      chart_id: chartId,
      year: 2026,
      month: 8,
      utc_offset: 9,
    });
    const jstMoments = jst.structuredContent.returns.map((one: { utc: string }) => one.utc);
    // 日本時間では 9/1 05:00 なので、JST の 8 月には入らない
    expect(jstMoments).not.toContain("2026-08-31T20:00:00.000Z");
    expect(jstMoments).toHaveLength(utcMoments.length - 1);
  });

  it("lat / lng を渡せばそこで立てる（いつもの場所より優先）", async () => {
    const chartId = await saveChartWithHome();
    engine.moonAnchorJd = jdOf(2026, 8, 21, 3);

    const result = await call("lunar_return", {
      chart_id: chartId,
      lat: 34.6937,
      lng: 135.5023,
      location_label: "大阪",
    });
    expect(result.content[0].text).toContain(
      "リターン図を立てた場所: 大阪（緯度 34.6937 / 経度 135.5023）",
    );
    const lastHouse = engine.houseCalls[engine.houseCalls.length - 1];
    expect(lastHouse?.lat).toBe(34.6937);
    // utc_offset を渡していないのでローカル表示は出ない
    expect(result.content[0].text).not.toContain("ローカル");
  });

  it("場所が分からなければ、場所を教えてほしいと言う", async () => {
    const chartId = await saveDefaultChart(); // いつもの場所を登録していない
    const result = await call("lunar_return", { chart_id: chartId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("リターン図を立てる場所が分かりません");
    expect(result.content[0].text).toContain("default_lat / default_lng");
  });

  it("year と month は片方だけでは受け付けない", async () => {
    const chartId = await saveChartWithHome();
    const onlyYear = await call("lunar_return", { chart_id: chartId, year: 2026 });
    expect(onlyYear.isError).toBe(true);
    expect(onlyYear.content[0].text).toContain("year と month はそろえて");
    expect((await call("lunar_return", { chart_id: chartId, month: 8 })).isError).toBe(true);
  });

  it("lat だけ・知らない chart_id も丁寧に断る", async () => {
    const chartId = await saveChartWithHome();
    const halfPlace = await call("lunar_return", { chart_id: chartId, lat: 35 });
    expect(halfPlace.isError).toBe(true);
    expect(halfPlace.content[0].text).toContain("lat と lng は両方そろえて");

    const missing = await call("lunar_return", { chart_id: "nosuchid" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("見つかりませんでした");
  });

  it("リターン図の中のアスペクトも足す（ASC / MC も点に入り、ノードは入らない）", async () => {
    const chartId = await saveChartWithHome();
    engine.moonAnchorJd = jdOf(2026, 8, 21, 3);

    const result = await call("lunar_return", { chart_id: chartId });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain(
      "□ リターン図の中のアスペクト（メジャー5種・オーブ 5.0°・10 天体＋ASC/MC、ノード除く）",
    );
    // 偽エンジンのリターン図は ASC 90°（＝金星と重なる）・MC 300°
    expect(text).toContain("金星 ☌ ASC（コンジャンクション / オーブ 0.00°）");
    expect(text).toContain("太陽 ⚹ MC（セクスタイル / オーブ 0.00°）");
    // ネイタルへの読みが先、リターン図そのものの背景が後
    expect(text.indexOf("□ ネイタルへのアスペクト")).toBeLessThan(
      text.indexOf("□ リターン図の中のアスペクト"),
    );

    const chartAspects = result.structuredContent.returns[0].chart_aspects;
    expect(chartAspects.length).toBeGreaterThan(0);
    const names: string[] = chartAspects.flatMap((hit: { a: string; b: string }) => [hit.a, hit.b]);
    expect(names).toContain("ASC");
    expect(names).toContain("MC");
    expect(names).not.toContain("Nノード");
    for (const hit of chartAspects) expect(hit).not.toHaveProperty("applying");
  });

  it("orb はリターン図の中のアスペクトにだけ効く（ネイタルへの 1° は動かない）", async () => {
    const chartId = await saveChartWithHome();
    engine.moonAnchorJd = jdOf(2026, 8, 21, 3);
    // ネイタルを保存したあとで火星だけ 3° ずらす
    nudgePlanet(4, 3);

    const wide = await call("lunar_return", { chart_id: chartId });
    const narrow = await call("lunar_return", { chart_id: chartId, orb: 2 });
    expect(narrow.isError).toBeUndefined();

    expect(narrow.content[0].text).toContain("オーブ 2.0°・10 天体＋ASC/MC、ノード除く");
    expect(wide.content[0].text).toContain("太陽 △ 火星（トライン / オーブ 3.00°）");
    expect(narrow.content[0].text).not.toContain("太陽 △ 火星");
    expect(narrow.structuredContent.returns[0].chart_aspects.length).toBeLessThan(
      wide.structuredContent.returns[0].chart_aspects.length,
    );

    expect(narrow.content[0].text).toContain(
      "□ ネイタルへのアスペクト（メジャー5種・オーブ 1.0°）",
    );
    expect(narrow.structuredContent.returns[0].aspects).toEqual(
      wide.structuredContent.returns[0].aspects,
    );
  });

  it("通過計算が開始 jd より後を返さなければエラーにする（wrapper のエラーチェックが壊れているため）", async () => {
    const chartId = await saveChartWithHome();
    engine.crossFails = true;

    const result = await call("lunar_return", { chart_id: chartId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("月が同じ黄経に戻る瞬間を計算できませんでした");
    expect(result.content[0].text).toContain("探索開始より後");
  });
});

describe("solar_return", () => {
  it("year を指定するとその年の 1 回", async () => {
    const chartId = await saveChartWithHome();
    engine.sunAnchorJd = jdOf(2027, 6, 16, 6);

    const result = await call("solar_return", {
      chart_id: chartId,
      year: 2027,
      utc_offset: 9,
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text.split("\n")[0]).toBe("ソーラーリターン（太陽の帰還）");
    expect(text).toContain("ネイタルの太陽: 牡羊座 0°00′");
    expect(text).toContain("対象: 2027年（UTC+9 の暦） ― 1件");
    expect(text).toContain("リターンの瞬間: 2027-06-16 06:00 UTC");
    expect(text).toContain("ローカル 2027-06-16 15:00（UTC+9）");
    expect(result.structuredContent.kind).toBe("solar_return");
    expect(result.structuredContent.period).toEqual({ year: 2027 });
    expect(result.structuredContent.returns).toHaveLength(1);

    // 太陽で・その年の 1 月 1 日から探している
    expect(engine.crossCalls).toHaveLength(1);
    expect(engine.crossCalls[0]?.kind).toBe("sun");
    expect(engine.crossCalls[0]?.targetLon).toBe(0);
    expect(engine.crossCalls[0]?.startJd).toBeCloseTo(jdOf(2027, 1, 1) - 9 / 24, 6);
  });

  it("year を省略すると現在時刻から見て次の 1 回", async () => {
    const chartId = await saveChartWithHome();
    engine.sunAnchorJd = jdOf(2027, 6, 16, 6);

    const result = await call("solar_return", { chart_id: chartId });
    expect(result.structuredContent.is_next).toBe(true);
    expect(result.structuredContent.returns[0].utc).toBe("2027-06-16T06:00:00.000Z");
    expect(engine.crossCalls[0]?.startJd).toBeCloseTo(jdOf(2026, 8, 20) + 2.25 / 24, 6);
  });

  it("リターン図の中のアスペクトも足す（ASC / MC 込み・orb で広さが変わる）", async () => {
    const chartId = await saveChartWithHome();
    engine.sunAnchorJd = jdOf(2027, 6, 16, 6);
    // ネイタルを保存したあとで火星だけ 3° ずらす
    nudgePlanet(4, 3);

    const wide = await call("solar_return", { chart_id: chartId, year: 2027 });
    expect(wide.isError).toBeUndefined();
    expect(wide.content[0].text).toContain(
      "□ リターン図の中のアスペクト（メジャー5種・オーブ 5.0°・10 天体＋ASC/MC、ノード除く）",
    );
    expect(wide.content[0].text).toContain("金星 ☌ ASC（コンジャンクション / オーブ 0.00°）");
    expect(wide.content[0].text).toContain("太陽 △ 火星（トライン / オーブ 3.00°）");
    // ネイタルへの読みが先、リターン図そのものの背景が後
    expect(wide.content[0].text.indexOf("□ ネイタルへのアスペクト")).toBeLessThan(
      wide.content[0].text.indexOf("□ リターン図の中のアスペクト"),
    );

    const wideAspects = wide.structuredContent.returns[0].chart_aspects;
    const names: string[] = wideAspects.flatMap((hit: { a: string; b: string }) => [hit.a, hit.b]);
    expect(names).toContain("ASC");
    expect(names).toContain("MC");
    expect(names).not.toContain("Nノード");

    const narrow = await call("solar_return", { chart_id: chartId, year: 2027, orb: 2 });
    expect(narrow.isError).toBeUndefined();
    expect(narrow.content[0].text).toContain("オーブ 2.0°・10 天体＋ASC/MC、ノード除く");
    expect(narrow.content[0].text).not.toContain("太陽 △ 火星");
    expect(narrow.structuredContent.returns[0].chart_aspects.length).toBeLessThan(
      wideAspects.length,
    );

    // 図→ネイタルのアスペクトは 1° のまま
    expect(narrow.content[0].text).toContain(
      "□ ネイタルへのアスペクト（メジャー5種・オーブ 1.0°）",
    );
    expect(narrow.structuredContent.returns[0].aspects).toEqual(
      wide.structuredContent.returns[0].aspects,
    );
  });
});

// ---------------------------------------------------------------------------
// 図の中のアスペクト（3 ツール共通）
// ---------------------------------------------------------------------------

describe("図の中のアスペクトの orb", () => {
  it("0.5〜10 の外は 3 ツールとも断る", async () => {
    const chartId = await saveChartWithHome();
    for (const name of ["transit", "lunar_return", "solar_return"]) {
      for (const orb of [0.4, 11]) {
        const bad = await call(name, { chart_id: chartId, orb });
        expect(bad.isError).toBe(true);
        expect(bad.content[0].text).toContain("orb");
        expect(bad.content[0].text).toContain("0.5 以上 10 以下");
      }
    }
  });

  it("orb は未知の引数扱いにならない（get_chart と同じく受け付ける）", async () => {
    const chartId = await saveChartWithHome();
    for (const name of ["transit", "lunar_return", "solar_return", "get_chart"]) {
      const ok = await call(name, { chart_id: chartId, orb: 3 });
      expect(ok.isError).toBeUndefined();
      expect(ok.content[0].text).not.toContain("未知の引数です");
    }
  });
});

// ---------------------------------------------------------------------------
// いつもの場所の差し替え
// ---------------------------------------------------------------------------

describe("update_default_location", () => {
  it("いつもの場所だけ差し替わり、一覧とリターンに反映される", async () => {
    const chartId = await saveChartWithHome(); // 東京
    const before = JSON.parse(kv.store.get(`chart:user1:${chartId}`) as string);

    const result = await call("update_default_location", {
      chart_id: chartId,
      lat: 34.6937,
      lng: 135.5023,
      location_label: "大阪",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(
      `チャート ${chartId}（サンプル）の「いつもの場所」を更新しました。`,
    );
    expect(result.content[0].text).toContain("いつもの場所: 大阪 緯度 34.6937 / 経度 135.5023");
    expect(result.content[0].text).toContain("保存済みの計算結果");
    expect(result.structuredContent).toEqual({
      chart_id: chartId,
      default_location: { lat: 34.6937, lng: 135.5023, label: "大阪" },
    });

    // 計算結果（天体・カスプ・ASC/MC）もラベル・ハウス方式・登録日時も動かない
    const after = JSON.parse(kv.store.get(`chart:user1:${chartId}`) as string);
    expect(after.planets).toEqual(before.planets);
    expect(after.cusps).toEqual(before.cusps);
    expect(after.ascmc).toEqual(before.ascmc);
    expect(after.label).toBe(before.label);
    expect(after.house_system).toBe(before.house_system);
    expect(after.created).toBe(before.created);
    // 再計算していない（エンジンを呼びに行かない）
    const houseCallsBefore = engine.houseCalls.length;

    const listed = await call("list_charts");
    expect(listed.structuredContent.charts[0].default_location).toEqual({
      lat: 34.6937,
      lng: 135.5023,
      label: "大阪",
    });
    expect(listed.content[0].text).toContain("いつもの場所: 大阪（34.6937, 135.5023）");
    expect(engine.houseCalls).toHaveLength(houseCallsBefore);

    // 場所を省いたリターンが新しい土地で立つ
    engine.moonAnchorJd = jdOf(2026, 8, 21, 3);
    const returned = await call("lunar_return", { chart_id: chartId });
    expect(returned.isError).toBeUndefined();
    expect(returned.content[0].text).toContain(
      "リターン図を立てた場所: 大阪（緯度 34.6937 / 経度 135.5023）",
    );
    const lastHouse = engine.houseCalls[engine.houseCalls.length - 1];
    expect(lastHouse?.lat).toBe(34.6937);
    expect(lastHouse?.lng).toBe(135.5023);
  });

  it("呼び名を省けば呼び名なしになる（前の呼び名は引き継がない）", async () => {
    const chartId = await saveChartWithHome(); // 東京
    const result = await call("update_default_location", {
      chart_id: chartId,
      lat: 51.5074,
      lng: -0.1278,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.default_location).toEqual({ lat: 51.5074, lng: -0.1278 });
    expect(result.content[0].text).toContain("いつもの場所: 緯度 51.5074 / 経度 -0.1278");
    expect(result.content[0].text).not.toContain("東京");
  });

  it("いつもの場所を持たないチャートに、後から付け足せる", async () => {
    const chartId = await saveDefaultChart(); // いつもの場所なし
    const result = await call("update_default_location", {
      chart_id: chartId,
      lat: 35.6895,
      lng: 139.6917,
      location_label: "東京",
    });
    expect(result.isError).toBeUndefined();

    engine.moonAnchorJd = jdOf(2026, 8, 21, 3);
    const returned = await call("lunar_return", { chart_id: chartId });
    expect(returned.isError).toBeUndefined();
    expect(returned.content[0].text).toContain(
      "リターン図を立てた場所: 東京（緯度 35.6895 / 経度 139.6917）",
    );
  });

  it("clear: true で消える。以後リターンは場所を訊いてくる", async () => {
    const chartId = await saveChartWithHome();

    const cleared = await call("update_default_location", { chart_id: chartId, clear: true });
    expect(cleared.isError).toBeUndefined();
    expect(cleared.content[0].text).toContain(
      "いつもの場所: 未設定（リターンは呼び出し時に場所を指定してください）",
    );
    expect(cleared.structuredContent.default_location).toBeNull();

    const stored = JSON.parse(kv.store.get(`chart:user1:${chartId}`) as string);
    expect(stored.default_location).toBeUndefined();
    expect(stored.planets).toHaveLength(11);

    const listed = await call("list_charts");
    expect(listed.structuredContent.charts[0].default_location).toBeUndefined();
    expect(listed.content[0].text).not.toContain("いつもの場所");

    const returned = await call("lunar_return", { chart_id: chartId });
    expect(returned.isError).toBe(true);
    expect(returned.content[0].text).toContain("リターン図を立てる場所が分かりません");

    // 場所を渡せばこれまで通り立つ
    engine.moonAnchorJd = jdOf(2026, 8, 21, 3);
    const withPlace = await call("lunar_return", { chart_id: chartId, lat: 35, lng: 139 });
    expect(withPlace.isError).toBeUndefined();

    // もともと持っていないチャートに clear をかけても素通り（冪等）
    const again = await call("update_default_location", { chart_id: chartId, clear: true });
    expect(again.isError).toBeUndefined();
    expect(again.structuredContent.default_location).toBeNull();
  });

  it("lat / lng は両方そろえて。clear と場所は同時に指定できない", async () => {
    const chartId = await saveChartWithHome();

    const halfPlace = await call("update_default_location", { chart_id: chartId, lat: 35 });
    expect(halfPlace.isError).toBe(true);
    expect(halfPlace.content[0].text).toContain("lat と lng は両方そろえて");
    expect((await call("update_default_location", { chart_id: chartId, lng: 139 })).isError).toBe(
      true,
    );

    const nothing = await call("update_default_location", { chart_id: chartId });
    expect(nothing.isError).toBe(true);
    expect(nothing.content[0].text).toContain("clear: true");

    const both = await call("update_default_location", {
      chart_id: chartId,
      clear: true,
      lat: 34.6937,
      lng: 135.5023,
    });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain("clear と場所の指定は同時にできません");

    const labelToo = await call("update_default_location", {
      chart_id: chartId,
      clear: true,
      location_label: "大阪",
    });
    expect(labelToo.isError).toBe(true);

    const outOfRange = await call("update_default_location", {
      chart_id: chartId,
      lat: 91,
      lng: 0,
    });
    expect(outOfRange.isError).toBe(true);

    const badClear = await call("update_default_location", { chart_id: chartId, clear: "yes" });
    expect(badClear.isError).toBe(true);

    // どのエラーでも「いつもの場所」は元のまま
    const listed = await call("list_charts");
    expect(listed.structuredContent.charts[0].default_location).toEqual({
      lat: 35.6895,
      lng: 139.6917,
      label: "東京",
    });
  });

  it("知らない chart_id・他人のチャートは丁寧に断る", async () => {
    const missing = await call("update_default_location", {
      chart_id: "nosuchid",
      lat: 35,
      lng: 139,
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("チャート nosuchid が見つかりませんでした");
    expect(missing.content[0].text).toContain("list_charts");

    const chartId = await saveChartWithHome();
    const other: AstroContext = {
      ...context,
      auth: { user: "tomodachi", name: "ともだち", role: "friend" },
    };
    const peek = await call(
      "update_default_location",
      { chart_id: chartId, lat: 0, lng: 0 },
      other,
    );
    expect(peek.isError).toBe(true);
    // 持ち主のチャートは無傷
    const listed = await call("list_charts");
    expect(listed.structuredContent.charts[0].default_location.label).toBe("東京");
  });
});

// ---------------------------------------------------------------------------
// 二次進行（オーナー特権）
// ---------------------------------------------------------------------------

/** ダミーの出生原本（本物の値ではない。1990-06-15 12:00 UTC・東京） */
const OWNER_NATAL_JSON = JSON.stringify({
  user: "user1",
  year: 1990,
  month: 6,
  day: 15,
  hour: 12,
  minute: 0,
  utc_offset: 0,
  lat: 35.6895,
  lng: 139.6917,
  house_system: "P",
});

const FRIEND: AuthContext = { user: "friend1", name: "ともだち", role: "friend" };

describe("progressions", () => {
  it("オーナー＋原本ありなら、進行天体・進行 ASC/MC・クロスアスペクトを返す", async () => {
    const owner: AstroContext = { ...context, ownerNatal: OWNER_NATAL_JSON };
    const result = await call("progressions", {}, owner);
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text.split("\n")[0]).toBe("プログレッション（二次進行・一日一年法）");
    // 1990-06-15 → 2026-08-20 は 36.18 年ぶん
    expect(text).toContain("対象日: 2026-08-20（今日・UTC の暦） / 36歳2ヶ月相当");
    expect(text).toContain("ハウス方式: プラシーダス（P）");
    expect(text).toContain("■ 進行天体（カッコ内は出生図のカスプで見た在ハウス）");
    expect(text).toContain("太陽 牡羊座 0°00′ (10H)");
    // 進行 ASC/MC は swe_houses_armc の値（偽エンジンでは 100° / 310°）
    expect(text).toContain("ASC 蟹座 10°00′ / MC 水瓶座 10°00′");
    expect(text).toContain("■ ネイタル（参考）");
    expect(text).toContain("■ 進行天体からネイタルへのアスペクト（メジャー5種・オーブ 1.0°）");
    expect(text).toContain("P.太陽 ☌ N.太陽");
    // トランジットの記号（T.）は使わない
    expect(text).not.toContain("T.太陽");

    // **出生日時・出生地の数値は書かない**
    expect(text).not.toContain("1990");
    expect(text).not.toContain("35.6895");
    expect(text).not.toContain("139.6917");
    expect(JSON.stringify(result.structuredContent)).not.toContain("35.6895");

    // ARMC 方式のハウスは出生地の緯度・真黄道傾斜・チャートのハウス方式で立つ
    expect(engine.armcCalls).toHaveLength(1);
    expect(engine.armcCalls[0]?.lat).toBe(35.6895);
    expect(engine.armcCalls[0]?.eps).toBe(23.44);
    expect(engine.armcCalls[0]?.hsys).toBe("P");

    const structured = result.structuredContent;
    expect(structured.target_date).toBe("2026-08-20");
    expect(structured.is_today).toBe(true);
    expect(structured.age_label).toBe("36歳2ヶ月相当");
    expect(structured.age_years).toBeCloseTo(36.18, 1);
    expect(structured.progressed_planets).toHaveLength(11);
    expect(structured.natal_planets).toHaveLength(11);
    expect(structured.progressed_angles.asc_position).toBe("蟹座 10°00′");
    // 出生の瞬間そのもの（jd）は載せない
    expect(Object.keys(structured)).not.toContain("natal_jd");
    expect(Object.keys(structured)).not.toContain("progressed_jd");
  });

  it("対象日を指定できる。utc_offset は「今日」の暦にも効く", async () => {
    const owner: AstroContext = { ...context, ownerNatal: OWNER_NATAL_JSON };

    const dated = await call("progressions", { year: 2030, month: 1, day: 1 }, owner);
    expect(dated.content[0].text).toContain("対象日: 2030-01-01 / 39歳6ヶ月相当");
    expect(dated.structuredContent.is_today).toBe(false);

    // 現在は 2026-08-20 02:15 UTC ＝ UTC-9 の土地ではまだ 8/19
    const shifted = await call("progressions", { utc_offset: -9 }, owner);
    expect(shifted.content[0].text).toContain("対象日: 2026-08-19（今日・UTC-9 の暦）");
  });

  it("year / month / day は 3 つそろえて。出生より前は断る", async () => {
    const owner: AstroContext = { ...context, ownerNatal: OWNER_NATAL_JSON };

    const partial = await call("progressions", { year: 2030 }, owner);
    expect(partial.isError).toBe(true);
    expect(partial.content[0].text).toContain("そろえて指定してください");

    const tooEarly = await call("progressions", { year: 1980, month: 1, day: 1 }, owner);
    expect(tooEarly.isError).toBe(true);
    expect(tooEarly.content[0].text).toContain("対象日が出生より前です");
  });

  it("friend の鍵では使えない（原本の有無には触れない）", async () => {
    const friend: AstroContext = { ...context, auth: FRIEND, ownerNatal: OWNER_NATAL_JSON };
    const result = await call("progressions", {}, friend);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("出生原本を預けた本人専用です");
    // 原本の中身も、預かっているかどうかも言わない
    expect(result.content[0].text).not.toContain("OWNER_NATAL");
    expect(result.content[0].text).not.toContain("1990");
  });

  it("原本が預けられていなければ、その設定が要ると言う", async () => {
    const result = await call("progressions", {}); // context には ownerNatal が無い
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("出生の原本が預けられていない");
    expect(result.content[0].text).toContain("wrangler secret put OWNER_NATAL");
  });

  it("原本の持ち主が違えば断る", async () => {
    const other: AstroContext = {
      ...context,
      ownerNatal: JSON.stringify({ ...JSON.parse(OWNER_NATAL_JSON), user: "someone-else" }),
    };
    const result = await call("progressions", {}, other);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("出生原本の持ち主のものではありません");
    expect(result.content[0].text).not.toContain("someone-else");
  });

  it("原本が壊れていたら、中身に触れずに断る", async () => {
    for (const broken of [
      "これは JSON ではありません",
      JSON.stringify({ user: "user1", year: 1990 }),
      JSON.stringify({ ...JSON.parse(OWNER_NATAL_JSON), house_system: "Z" }),
      JSON.stringify({ ...JSON.parse(OWNER_NATAL_JSON), lat: 999 }),
    ]) {
      const ctx: AstroContext = { ...context, ownerNatal: broken };
      const result = await call("progressions", {}, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("読み取れませんでした");
      expect(result.content[0].text).not.toContain("year");
      expect(result.content[0].text).not.toContain("1990");
    }
  });
});

// ---------------------------------------------------------------------------
// 年間概要
// ---------------------------------------------------------------------------

describe("yearly_overview", () => {
  /**
   * 偽エンジンの天体は jd に依らず同じ位置に居る＝逆行もイングレスも起きない。
   * さらに save_chart のあとに offset を 15° 動かしておくと、ネイタル（30° 刻み）と
   * トランジット（＋15°）の離角がすべて 15° の奇数倍になり、メジャーアスペクトも一つも立たない。
   * ＝ **イベントが 1 件も無い年**を作れるので、器のほうだけを確かめられる。
   */
  async function saveFlatChart(): Promise<string> {
    const chartId = await saveChartWithHome();
    engine.offset = 15;
    return chartId;
  }

  it("year を指定するとその年のソーラーリターンから 1 年", async () => {
    const chartId = await saveFlatChart();
    engine.sunAnchorJd = jdOf(2027, 6, 16, 6);

    const result = await call("yearly_overview", {
      chart_id: chartId,
      year: 2027,
      utc_offset: 9,
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text.split("\n")[0]).toBe("年間概要（ソーラーリターン年）");
    expect(text).toContain(`チャート: サンプル（${chartId}） / ハウス方式: プラシーダス（P）`);
    expect(text).toContain("ネイタルの太陽: 牡羊座 0°00′");
    expect(text).toContain("期間: 2027-06-16 06:00 UTC / ローカル 2027-06-16 15:00（UTC+9）");
    expect(text).toContain("（365 日）");
    expect(text).toContain("対象: 2027年のソーラーリターンから 1 年");
    expect(text).toContain("日付は UTC+9 の暦 で 1 日刻み");
    expect(text).toContain("start は入った最初の日、end は外れた最初の日");
    expect(text).toContain("（t.＝トランジット / n.＝ネイタル）");

    // 4 節。イベントが無いので逆行は 8 天体すべて「なし」、他の節は「なし」1 行
    expect(text).toContain("■ 逆行期間");
    expect(text).toContain("水星: なし");
    expect(text).toContain("冥王星: なし");
    expect(text).toContain("■ 星座イングレス（木星〜冥王星）");
    expect(text).toContain("■ ASC / MC へのトランジット");
    expect(text).toContain("■ ネイタル天体へのトランジット");

    // 太陽で 2 回 ―― その年の 1 月 1 日（時差込み）から 1 回、その翌日から次の 1 回
    expect(engine.crossCalls).toHaveLength(2);
    expect(engine.crossCalls.every((crossCall) => crossCall.kind === "sun")).toBe(true);
    expect(engine.crossCalls[0]?.startJd).toBeCloseTo(jdOf(2027, 1, 1) - 9 / 24, 6);
    expect(engine.crossCalls[1]?.startJd).toBeCloseTo(jdOf(2027, 6, 16, 6) + 1, 6);

    const structured = result.structuredContent;
    expect(structured.kind).toBe("yearly_overview");
    expect(structured.chart_id).toBe(chartId);
    expect(structured.label).toBe("サンプル");
    expect(structured.house_system).toBe("P");
    expect(structured.utc_offset).toBe(9);
    expect(structured.orb).toBe(1);
    expect(structured.resolution).toBe("day");
    expect(structured.period).toEqual({
      solar_return_year: 2027,
      start_utc: "2027-06-16T06:00:00.000Z",
      end_utc: expect.stringMatching(/^2028-06-15T/),
      start_jd: jdOf(2027, 6, 16, 6),
      end_jd: jdOf(2027, 6, 16, 6) + 365.24,
      start_date: "2027-06-16",
      end_date: "2028-06-15",
      days: 365,
      is_current: false,
    });
    expect(structured.retrogrades).toEqual([]);
    expect(structured.ingresses).toEqual([]);
    expect(structured.angle_aspects).toEqual([]);
    expect(structured.natal_aspects).toEqual([]);
    // 疎サンプル＝総当たり（2,928 回）の 1 割強
    expect(structured.diagnostics.ephemeris_calls).toBe(355);
  });

  it("year を省略すると現在を含むソーラーリターン年", async () => {
    const chartId = await saveFlatChart();
    engine.sunAnchorJd = jdOf(2026, 3, 10);

    const result = await call("yearly_overview", { chart_id: chartId });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain("対象: 現在（2026-08-20 02:15 UTC）を含むソーラーリターン年");
    expect(text).toContain("日付は UTC の暦 で 1 日刻み");

    // 1 年前（366 日前）から探すと、必ず現在以前のリターンに落ちる
    expect(engine.crossCalls[0]?.startJd).toBeCloseTo(jdOf(2026, 8, 20) + 2.25 / 24 - 366, 6);
    const structured = result.structuredContent;
    expect(structured.period.is_current).toBe(true);
    expect(structured.period.start_date).toBe("2026-03-10");
    expect(structured.period.solar_return_year).toBe(2026);
    expect(structured.utc_offset).toBe(0);
  });

  it("知らない chart_id は isError", async () => {
    const result = await call("yearly_overview", { chart_id: "zzzz9999" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("見つかりませんでした");
  });

  it("ソーラーリターン年としてありえない長さなら計算せずに断る", async () => {
    const chartId = await saveFlatChart();
    engine.sunPeriod = 200; // リターンの間隔が 200 日＝そもそも太陽の周期ではない

    const result = await call("yearly_overview", { chart_id: chartId, year: 2027 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("300〜400日");
  });
});

// ---------------------------------------------------------------------------
// 期間内のトランジットイベント（時刻つき）
// ---------------------------------------------------------------------------

describe("transit_events", () => {
  /**
   * 「止まった空」を作る。
   *
   * 偽エンジンの天体は jd に依らず同じ位置に居るが、速度は 1（金星だけ −0.5）を返す作りなので、
   * そのままだと「位置は動かないのに速度がある」という物理的にありえない標本になり、
   * エルミート補間が区間の中で暴れる（ありもしない留が並ぶ）。ここでは速度も 0 にそろえておく。
   * さらに天体を 15° ずらせば、ネイタル（30° 刻み）との離角がすべて 15° の奇数倍になり
   * メジャーアスペクトも一つも立たない ＝ **イベントが 1 件も無い期間**で器だけを確かめられる。
   */
  function freezeSky(): void {
    engine.swe_calc_ut = (_jd: number, planetId: number, _flags: number): number[] =>
      planetId === -1 ? [23.44, 23.44, 0, 0, 0, 0] : [planetId * 30 + 15, 0, 1, 0, 0, 0];
  }

  /** 月だけ 100° から 13°/日 で走らせる（ほかは 15° ずらして止めたまま） */
  function moveTheMoon(startJd: number): void {
    engine.swe_calc_ut = (jd: number, planetId: number, _flags: number): number[] => {
      if (planetId === 1) return [normalizeDegree(100 + 13 * (jd - startJd)), 0, 1, 13, 0, 0];
      if (planetId === -1) return [23.44, 23.44, 0, 0, 0, 0];
      return [planetId * 30 + 15, 0, 1, 0, 0, 0];
    };
  }

  it("start と days を指定すると、その日の 0 時から（utc_offset の暦で）", async () => {
    const chartId = await saveChartWithHome();
    freezeSky();

    const result = await call("transit_events", {
      chart_id: chartId,
      start: "2026-08-20",
      days: 3,
      utc_offset: 9,
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text.split("\n")[0]).toBe("トランジットイベント（時刻つき）");
    expect(text).toContain(`チャート: サンプル（${chartId}） / ハウス方式: プラシーダス（P）`);
    expect(text).toContain("期間: 2026-08-20 00:00（UTC+9） 〜 2026-08-23 00:00（UTC+9）");
    expect(text).toContain("（3 日、UTC では 2026-08-19 15:00 〜 2026-08-22 15:00）");
    expect(text).toContain("動く側: 太陽〜冥王星（10 天体）、相手: ネイタル 10 天体（ノード除く）と ASC / MC");
    expect(text).toContain("メジャー5種・オーブ 1.0°");
    expect(text).toContain("時刻は UTC+9、分単位（細かさ 10 分刻み＋二分法）");
    // 止まった空なのでイベントは 1 件も無い
    expect(text).toContain("■ 期間内のイベント（時系列。t.＝トランジット / n.＝ネイタル）");
    expect(text).toContain("なし");
    expect(text).toContain("■ 件数 アスペクト窓 0 / exact 0 / 留 0 / イングレス 0");

    const structured = result.structuredContent;
    expect(structured.kind).toBe("transit_events");
    expect(structured.chart_id).toBe(chartId);
    expect(structured.label).toBe("サンプル");
    expect(structured.house_system).toBe("P");
    expect(structured.bodies).toBe("all");
    expect(structured.utc_offset).toBe(9);
    expect(structured.orb).toBe(1);
    expect(structured.tick_minutes).toBe(10);
    expect(structured.period).toEqual({
      start_utc: "2026-08-19T15:00:00.000Z",
      end_utc: "2026-08-22T15:00:00.000Z",
      start_local: "2026-08-20 00:00",
      end_local: "2026-08-23 00:00",
      days: 3,
    });
    expect(structured.windows).toEqual([]);
    expect(structured.stations).toEqual([]);
    expect(structured.ingresses).toEqual([]);
    expect(structured.counts).toEqual({ windows: 0, exacts: 0, stations: 0, ingresses: 0 });
    // 5 天体が 1 日おき（4 点）＋ 5 天体が 4 日おき（2 点）＝ 30 回
    expect(structured.diagnostics.ephemeris_calls).toBe(30);
  });

  it("start を省略すると utc_offset の暦での今日から 7 日", async () => {
    const chartId = await saveChartWithHome();
    freezeSky();

    const result = await call("transit_events", { chart_id: chartId, utc_offset: 9 });
    expect(result.isError).toBeUndefined();

    // 現在は 2026-08-20 02:15 UTC ＝ 日本時間では同日 11:15。その日の 0 時から
    const text: string = result.content[0].text;
    expect(text).toContain("期間: 2026-08-20 00:00（UTC+9） 〜 2026-08-27 00:00（UTC+9）");
    expect(text).toContain("（7 日、");
    expect(result.structuredContent.period.start_utc).toBe("2026-08-19T15:00:00.000Z");
    expect(result.structuredContent.period.days).toBe(7);
  });

  it("動く天体があれば時刻つきで時系列に並ぶ", async () => {
    const chartId = await saveChartWithHome();
    // 2026-08-20 00:00（UTC+9）＝ 2026-08-19 15:00 UTC
    moveTheMoon(jdOf(2026, 8, 19, 15));

    const result = await call("transit_events", {
      chart_id: chartId,
      start: "2026-08-20",
      days: 3,
      utc_offset: 9,
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    // 月は 119°（08-21 11:04）で入り、120°（12:55）でネイタル太陽とトライン、121°（14:46）で外れる
    expect(text).toContain("08-21 11:04〜14:46  t.月 △ n.太陽(10H)  exact 12:55");
    // 同じ 120° で獅子座入り
    expect(text).toContain("08-21 12:55  t.月 獅子座入り");

    const structured = result.structuredContent;
    const trine = structured.windows.find(
      (window: { transit: string; target: { name: string }; aspect: { angle: number } }) =>
        window.transit === "月" && window.target.name === "太陽" && window.aspect.angle === 120,
    );
    expect(trine.target).toEqual({ kind: "planet", name: "太陽", id: 0, house: 10 });
    expect(trine.aspect).toEqual({ angle: 120, name: "トライン", symbol: "△" });
    expect(trine.entering).toMatch(/^2026-08-21T02:04:/);
    expect(trine.leaving).toMatch(/^2026-08-21T05:46:/);
    expect(trine.exact).toHaveLength(1);
    expect(trine.exact[0]).toMatch(/^2026-08-21T03:55:/);
    expect(trine.min_orb).toBe(0);
    expect(trine.applying_at_start).toBe(true);
    expect(trine.clipped).toBeUndefined();
    expect(structured.counts.windows).toBeGreaterThan(0);
    expect(structured.ingresses[0]).toMatchObject({
      transit: "月",
      id: 1,
      sign: "獅子座",
      sign_index: 4,
      retrograde: false,
    });
  });

  it("期間の上限は bodies による（超えたら逃げ道を案内する）", async () => {
    const chartId = await saveChartWithHome();
    freezeSky();

    const tooLong = await call("transit_events", {
      chart_id: chartId,
      start: "2026-08-20",
      days: 40,
      bodies: "all",
    });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content[0].text).toContain("no_moon");
    expect(tooLong.content[0].text).toContain("outer");
    expect(tooLong.content[0].text).toContain("yearly_overview");

    const noMoon = await call("transit_events", {
      chart_id: chartId,
      start: "2026-08-20",
      days: 40,
      bodies: "no_moon",
    });
    expect(noMoon.isError).toBeUndefined();
    expect(noMoon.structuredContent.bodies).toBe("no_moon");
    expect(noMoon.content[0].text).toContain("動く側: 月を除く 9 天体");

    const wayTooLong = await call("transit_events", {
      chart_id: chartId,
      start: "2026-08-20",
      days: 400,
      bodies: "outer",
    });
    expect(wayTooLong.isError).toBe(true);
  });

  it("start の書式・bodies の値・知らない chart_id は isError", async () => {
    const chartId = await saveChartWithHome();
    freezeSky();

    const slashes = await call("transit_events", { chart_id: chartId, start: "2026/08/20" });
    expect(slashes.isError).toBe(true);
    expect(slashes.content[0].text).toContain("YYYY-MM-DD");

    const noSuchMonth = await call("transit_events", { chart_id: chartId, start: "2026-13-01" });
    expect(noSuchMonth.isError).toBe(true);

    const badBodies = await call("transit_events", { chart_id: chartId, bodies: "moon" });
    expect(badBodies.isError).toBe(true);
    expect(badBodies.content[0].text).toContain("bodies は");

    const unknown = await call("transit_events", { chart_id: "zzzz9999" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("見つかりませんでした");
  });
});

describe("知らないツール", () => {
  it("isError で返す", async () => {
    const result = await call("reverse_horoscope", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("知らないツールです");
  });
});

// ---------------------------------------------------------------------------
// 暦に無い日
// ---------------------------------------------------------------------------

/**
 * 2026-02-31 のような日付は日の範囲（1〜31）を通り抜けてしまい、swe_julday はそれを
 * 黙って 3 月 3 日へ繰り上げる ―― 打ち間違いが「別の日の図」として静かに返るのを防ぐ。
 */
describe("実在しない暦日", () => {
  /** うるう年（4 で割り切れる / 400 で割り切れる） */
  const VALID = [
    { year: 2024, month: 2, day: 29 },
    { year: 2000, month: 2, day: 29 },
  ];
  /** 平年の 2/29・無い日・100 で割り切れて 400 で割り切れない年の 2/29 */
  const INVALID = [
    { year: 2023, month: 2, day: 29 },
    { year: 2026, month: 2, day: 30 },
    { year: 2026, month: 4, day: 31 },
    { year: 1900, month: 2, day: 29 },
  ];

  it("save_chart: うるう年は通り、暦に無い日は isError", async () => {
    for (const date of VALID) {
      const ok = await call("save_chart", { ...BIRTH, ...date });
      expect(ok.isError).toBeUndefined();
    }
    for (const date of INVALID) {
      const ng = await call("save_chart", { ...BIRTH, ...date });
      expect(ng.isError).toBe(true);
      expect(ng.content[0].text).toContain("は暦に存在しない日付です");
      // 利用者が渡した値なので、どの日付が駄目だったかは言ってよい
      expect(ng.content[0].text).toContain(String(date.year));
    }
  });

  it("transit: 指定日が暦に無ければ isError（繰り上がった図を返さない）", async () => {
    const chartId = await saveDefaultChart();

    const ok = await call("transit", { chart_id: chartId, year: 2024, month: 2, day: 29 });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toContain("日時: 2024-02-29 00:00 UTC");

    for (const date of INVALID) {
      const ng = await call("transit", { chart_id: chartId, ...date });
      expect(ng.isError).toBe(true);
      expect(ng.content[0].text).toContain("は暦に存在しない日付です");
    }
  });

  it("transit_events: start の日付も暦で検算する", async () => {
    const chartId = await saveDefaultChart();

    const ok = await call("transit_events", {
      chart_id: chartId,
      start: "2024-02-29",
      days: 1,
      bodies: "outer",
    });
    expect(ok.isError).toBeUndefined();

    for (const date of INVALID) {
      const start = `${date.year}-${String(date.month).padStart(2, "0")}-${date.day}`;
      const ng = await call("transit_events", { chart_id: chartId, start, days: 1 });
      expect(ng.isError).toBe(true);
      expect(ng.content[0].text).toContain("は暦に存在しない日付です");
    }
  });

  it("progressions: 対象日も暦で検算する", async () => {
    const owner: AstroContext = { ...context, ownerNatal: OWNER_NATAL_JSON };

    const ok = await call("progressions", { year: 2024, month: 2, day: 29 }, owner);
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toContain("対象日: 2024-02-29");

    for (const date of INVALID) {
      const ng = await call("progressions", date, owner);
      expect(ng.isError).toBe(true);
      expect(ng.content[0].text).toContain("は暦に存在しない日付です");
    }
  });

  it("progressions: 原本（OWNER_NATAL）の日付が暦に無いときは、値を出さずに断る", async () => {
    const ctx: AstroContext = {
      ...context,
      ownerNatal: JSON.stringify({ ...JSON.parse(OWNER_NATAL_JSON), month: 2, day: 31 }),
    };
    const result = await call("progressions", {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("OWNER_NATAL の日付が暦に存在しません");
    // 預かりものなので、日付そのものは書かない
    expect(result.content[0].text).not.toContain("31");
    expect(result.content[0].text).not.toContain("1990");
  });

  it("lunar_return / solar_return は日を取らない（月初 1 日固定なので暦の穴が無い）", async () => {
    const chartId = await saveChartWithHome();

    // 平年の 2 月でも「その月に入るリターン」は普通に引ける
    const lunar = await call("lunar_return", { chart_id: chartId, year: 2023, month: 2 });
    expect(lunar.isError).toBeUndefined();
    expect(lunar.content[0].text).toContain("2023年2月");

    const solar = await call("solar_return", { chart_id: chartId, year: 2023 });
    expect(solar.isError).toBeUndefined();
    expect(solar.content[0].text).toContain("2023年");

    // day を渡そうとしても、そもそも受け付けない
    const withDay = await call("solar_return", { chart_id: chartId, year: 2023, day: 31 });
    expect(withDay.isError).toBe(true);
    expect(withDay.content[0].text).toContain("未知の引数です: day");
  });
});

// ---------------------------------------------------------------------------
// 未知の引数キー
// ---------------------------------------------------------------------------

describe("未知の引数キー", () => {
  it("綴り違いを黙って無視しない（default_latt は成功扱いにしない）", async () => {
    const result = await call("save_chart", { ...BIRTH, default_latt: 34.7, default_lng: 135.5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("未知の引数です: default_latt");
    // 正しい綴りを言い添える（使えるキーの一覧はツール定義から作っている）
    expect(result.content[0].text).toContain("default_lat");
    // 保存もされていない
    expect([...kv.store.keys()].filter((key) => key.startsWith("chart:"))).toHaveLength(0);
  });

  it("引数を取らないツールでも断る（list_charts）", async () => {
    const result = await call("list_charts", { chart_id: "abcd1234" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("未知の引数です: chart_id");
    expect(result.content[0].text).toContain("このツールは引数を取りません");
  });

  it("複数の余分なキーはまとめて挙げる", async () => {
    const chartId = await saveDefaultChart();
    const result = await call("transit", { chart_id: chartId, foo: 1, bar: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("未知の引数です: foo, bar");
  });

  it("正しい引数はこれまで通り通る", async () => {
    const chartId = await saveDefaultChart();
    const transit = await call("transit", {
      chart_id: chartId,
      year: 2026,
      month: 8,
      day: 20,
      hour: 11,
      minute: 15,
      utc_offset: 9,
    });
    expect(transit.isError).toBeUndefined();

    const events = await call("transit_events", {
      chart_id: chartId,
      start: "2026-08-20",
      days: 3,
      bodies: "outer",
      utc_offset: 9,
    });
    expect(events.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// chart_id の発行
// ---------------------------------------------------------------------------

describe("chart_id の衝突回避", () => {
  const SAMPLE: StoredChart = {
    label: "衝突テスト",
    house_system: "P",
    planets: [{ id: 0, lon: 0, speed: 1 }],
    cusps: [...FAKE_CUSPS],
    ascmc: [...FAKE_ASCMC],
    created: "2026-08-22T00:00:00.000Z",
  };

  /** 引く目を並べた乱数源（8 回で chart_id 1 本ぶん） */
  function scriptedRandom(draws: readonly number[]): RandomSource {
    const queue = [...draws];
    return { int: () => queue.shift() ?? 0 };
  }

  it("埋まっている id は避けて引き直す（既存の図を上書きしない）", async () => {
    // 目 0 → "2"、目 1 → "3"（CHART_ID_ALPHABET の頭 2 文字）
    const random = scriptedRandom([...Array(8).fill(0), ...Array(8).fill(1)]);
    const taken = newChartId(scriptedRandom(Array(8).fill(0)));
    kv.store.set(`chart:user1:${taken}`, JSON.stringify({ ...SAMPLE, label: "先客" }));

    const chartId = await createChart(kv, "user1", SAMPLE, random);
    expect(chartId).not.toBe(taken);
    expect(chartId).toMatch(/^[a-z0-9]{8}$/);

    // 先客は無傷、新しい図は新しい ID に入っている
    expect(JSON.parse(kv.store.get(`chart:user1:${taken}`) as string).label).toBe("先客");
    expect(JSON.parse(kv.store.get(`chart:user1:${chartId}`) as string).label).toBe("衝突テスト");
  });

  it("引き直しても空きが無ければ例外（黙って上書きしない）", async () => {
    const always = () => scriptedRandom(Array(8).fill(0));
    kv.store.set(`chart:user1:${newChartId(always())}`, JSON.stringify(SAMPLE));

    await expect(createChart(kv, "user1", SAMPLE, always())).rejects.toThrow(
      /空きが見つかりませんでした/,
    );
  });

  it("同じ id が別の人の棚にあってもぶつからない（棚は user ごと）", async () => {
    const draws = () => scriptedRandom(Array(8).fill(0));
    const mine = await createChart(kv, "user1", SAMPLE, draws());
    const theirs = await createChart(kv, "user2", SAMPLE, draws());
    expect(theirs).toBe(mine);
  });
});

/**
 * tools/list の返り値まるごと（凍結）。
 *
 * カード層と同じ理由 ―― クライアントは接続時にツール定義を取り込んでキャッシュし、
 * サーバー側を直しても取り直しに来ない。うっかり文言をいじってしまわないよう丸ごと止めてある。
 * 意図して変えたときだけこの literal を更新すること。
 * ※ 返り値（content / structuredContent）を増やすのは「定義」の変更ではないので、ここは緑のまま。
 *
 * 更新履歴:
 * - 2026-08-22 図の中のアスペクト追加で更新（transit / lunar_return / solar_return の 3 本だけ。
 *   description に項目が 1 つ増え、inputSchema に orb が生えた。残り 8 本は 1 文字も動かしていない）
 */
const FROZEN_ASTRO_TOOLS = [
  {
    "name": "save_chart",
    "title": "出生図を登録する",
    "description": "出生データからネイタルチャート（出生図）を計算し、chart_id を付けて保存する。以後は chart_id だけでトランジットなどを引ける。\n**保存されるのは計算結果の座標だけ**——天体の黄経と速度・ハウスカスプ・ASC/MC・ラベル・ハウス方式のみで、出生日時と出生地は計算に使ったあと捨てる（サーバーに残らない）。そのぶん、ハウス方式を変えて計算し直したいときは、もう一度このツールを呼ぶ必要がある。\n日時は**出生地の現地時刻**で渡し、utc_offset にその土地の時差を書く（日本は 9）。緯度・経度は北緯・東経が正、南緯・西経が負。\ndefault_lat / default_lng は「いつもの場所」（現在の居住地など）で、後々のリターン計算で使う。分からなければ省略してよい。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "label": {
          "type": "string",
          "description": "チャートの呼び名（一覧に出る）。本人の名前でも「わたし」「Aさん」でもよい。"
        },
        "year": {
          "type": "integer",
          "description": "出生年（西暦）"
        },
        "month": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "出生月（1-12）"
        },
        "day": {
          "type": "integer",
          "minimum": 1,
          "maximum": 31,
          "description": "出生日（1-31）"
        },
        "hour": {
          "type": "integer",
          "minimum": 0,
          "maximum": 23,
          "description": "出生時刻の「時」（0-23、出生地の現地時刻）"
        },
        "minute": {
          "type": "integer",
          "minimum": 0,
          "maximum": 59,
          "description": "出生時刻の「分」（0-59、出生地の現地時刻）"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "出生地の UTC からの時差（時間単位。日本は 9、インドのような 30 分刻みは 5.5 のように小数で）"
        },
        "lat": {
          "type": "number",
          "minimum": -90,
          "maximum": 90,
          "description": "出生地の緯度（北緯が正）"
        },
        "lng": {
          "type": "number",
          "minimum": -180,
          "maximum": 180,
          "description": "出生地の経度（東経が正）"
        },
        "house_system": {
          "type": "string",
          "enum": [
            "P",
            "K",
            "W",
            "E"
          ],
          "default": "P",
          "description": "ハウス方式（既定 P）。P=プラシーダス / K=コッホ / W=ホールサイン / E=イコール。出生時刻がはっきりしない場合はホールサイン（W）が無難。"
        },
        "default_lat": {
          "type": "number",
          "minimum": -90,
          "maximum": 90,
          "description": "「いつもの場所」の緯度（任意。リターン計算で使う）"
        },
        "default_lng": {
          "type": "number",
          "minimum": -180,
          "maximum": 180,
          "description": "「いつもの場所」の経度（任意）"
        },
        "default_location_label": {
          "type": "string",
          "description": "「いつもの場所」の呼び名（任意。例: 東京）"
        }
      },
      "required": [
        "label",
        "year",
        "month",
        "day",
        "hour",
        "minute",
        "utc_offset",
        "lat",
        "lng"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "list_charts",
    "title": "登録済みチャートの一覧",
    "description": "この URL に登録されているチャートの一覧を返す（chart_id・ラベル・ハウス方式・「いつもの場所」・登録日時）。transit を呼ぶ前に chart_id を確かめたいときに使う。",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "get_chart",
    "title": "出生図を読み直す",
    "description": "save_chart で登録したネイタルチャート（出生図）を chart_id から読み直す。返るのは (1) ネイタル天体の星座・度数・逆行と在ハウス、(2) ASC / MC とハウスカスプ、(3) **出生図の中のアスペクト**（ネイタル内アスペクト。10 天体＋ASC / MC の総当たり、メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション）。\n保存済みの座標を読むだけで計算し直さないので、ハウス方式を変えたいときは save_chart で登録し直すこと（出生日時・出生地は保存していない）。\nネイタルの読み直し・出生図そのものを話題にするときはこれ（transit は「今の空」用）。\nこのツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）"
        },
        "orb": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 10,
          "description": "ネイタル内アスペクトのオーブ（度）。省略すると 5°（出生図は広めに取るのが通例。トランジットの 1° とは別）"
        }
      },
      "required": [
        "chart_id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "delete_chart",
    "title": "登録済みチャートを消す",
    "description": "chart_id を指定して登録を取り消す。消したチャートは戻せない（出生日時・出生地を保存していないため、サーバー側で再計算できない）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "消すチャートの ID（list_charts で確認できる）"
        }
      },
      "required": [
        "chart_id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "transit",
    "title": "トランジットを見る",
    "description": "登録済みのチャートに対して、指定時刻の天体（トランジット）を計算する。返るのは (1) トランジット天体の星座・度数・逆行、(2) それがネイタルのカスプで見て第何ハウスに入っているか、(3) ネイタル天体および ASC / MC とのアスペクト（メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション、オーブ 1°）、(4) **空の中のアスペクト**（トランジット天体同士。10 天体の総当たり、メジャー5種、既定オーブ 5°＝orb で変えられる。ノードは除く）。\n日時をすべて省略すると**現在時刻（UTC）**で計算する。特定の日を見たいときは year / month / day を指定し、必要なら hour / minute と utc_offset（その時刻がどの時差の土地の時計か）を添える。\nこのツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）"
        },
        "year": {
          "type": "integer",
          "description": "見たい日の年（省略すると現在時刻）"
        },
        "month": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "見たい日の月（1-12）"
        },
        "day": {
          "type": "integer",
          "minimum": 1,
          "maximum": 31,
          "description": "見たい日の日（1-31）"
        },
        "hour": {
          "type": "integer",
          "minimum": 0,
          "maximum": 23,
          "description": "見たい時刻の「時」（0-23、省略すると 0 時）"
        },
        "minute": {
          "type": "integer",
          "minimum": 0,
          "maximum": 59,
          "description": "見たい時刻の「分」（0-59、省略すると 0 分）"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "指定した日時がどの時差の土地の時計か（時間単位。日本時間なら 9。省略すると UTC 扱い）"
        },
        "orb": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 10,
          "description": "空の中のアスペクト（トランジット天体同士）のオーブ（度）。省略すると 5°（1 枚の図の中は広めに取るのが通例）。**ネイタルへのアスペクト（オーブ 1°）には効かない**"
        }
      },
      "required": [
        "chart_id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "lunar_return",
    "title": "ルナリターン（月の帰還）",
    "description": "登録済みチャートの**ネイタルの月**と同じ黄経に、空の月が戻ってくる瞬間（ルナリターン）を求め、その瞬間のホロスコープ一式を返す。約27.3日に1回めぐってくる。\nyear と month を指定すると**その月に入るリターンをすべて**返す（たいてい1回、暦月の並びによっては2回、まれに0回）。両方省略すると**現在時刻から見て次の1回**。year と month はそろえて指定すること。\n返るのは (1) リターンの瞬間（UTC。utc_offset を渡せばその土地の時計でも）、(2) リターン図の11天体（星座・度数・逆行・在ハウスはリターン図自身のカスプで）、(3) リターン図の ASC / MC とハウスカスプ、(4) ネイタルの天体・ASC / MC とのアスペクト（メジャー5種・オーブ 1°）、(5) **リターン図の中のアスペクト**（リターン図の 10 天体＋ASC / MC の総当たり。メジャー5種、既定オーブ 5°＝orb で変えられる。ノードは除く）。\nリターン図を立てる場所は lat / lng で指定する。省略するとチャートに登録された「いつもの場所」（save_chart の default_lat / default_lng）を使う。どちらも無いときは場所を教えてほしい旨を返す。\nこのツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）"
        },
        "year": {
          "type": "integer",
          "description": "見たい年（month とそろえて指定。省略すると現在時刻から見て次の1回）"
        },
        "month": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "見たい月（1-12。year とそろえて指定）"
        },
        "lat": {
          "type": "number",
          "minimum": -90,
          "maximum": 90,
          "description": "リターン図を立てる場所の緯度（省略するとチャートの「いつもの場所」）"
        },
        "lng": {
          "type": "number",
          "minimum": -180,
          "maximum": 180,
          "description": "リターン図を立てる場所の経度（lat とそろえて指定）"
        },
        "location_label": {
          "type": "string",
          "description": "その場所の呼び名（任意。例: 東京）"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "表示に使う時差（時間単位。日本時間なら 9。省略すると UTC だけで表示する）。year / month を指定したときは、暦月の区切りもこの時差の土地の暦で見る。"
        },
        "orb": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 10,
          "description": "リターン図の中のアスペクトのオーブ（度）。省略すると 5°（1 枚の図の中は広めに取るのが通例）。**ネイタルへのアスペクト（オーブ 1°）には効かない**"
        }
      },
      "required": [
        "chart_id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "solar_return",
    "title": "ソーラーリターン（太陽の帰還）",
    "description": "登録済みチャートの**ネイタルの太陽**と同じ黄経に、空の太陽が戻ってくる瞬間（ソーラーリターン）を求め、その瞬間のホロスコープ一式を返す。年に1回、誕生日の前後1日ほどの範囲でめぐってくる。\nyear を指定するとその年の1回を返す（その年の1月1日から探す）。省略すると**現在時刻から見て次の1回**。\n返るものは lunar_return と同じ形——リターンの瞬間、リターン図の11天体（在ハウスはリターン図自身のカスプ）、ASC / MC とハウスカスプ、ネイタルとのアスペクト（メジャー5種・オーブ 1°）、**リターン図の中のアスペクト**（リターン図の 10 天体＋ASC / MC の総当たり。メジャー5種、既定オーブ 5°＝orb で変えられる。ノードは除く）。\nリターン図を立てる場所は lat / lng で指定する。省略するとチャートに登録された「いつもの場所」を使う。\nこのツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）"
        },
        "year": {
          "type": "integer",
          "description": "見たい年（省略すると現在時刻から見て次の1回）"
        },
        "lat": {
          "type": "number",
          "minimum": -90,
          "maximum": 90,
          "description": "リターン図を立てる場所の緯度（省略するとチャートの「いつもの場所」）"
        },
        "lng": {
          "type": "number",
          "minimum": -180,
          "maximum": 180,
          "description": "リターン図を立てる場所の経度（lat とそろえて指定）"
        },
        "location_label": {
          "type": "string",
          "description": "その場所の呼び名（任意。例: 東京）"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "表示に使う時差（時間単位。日本時間なら 9。省略すると UTC だけで表示する）"
        },
        "orb": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 10,
          "description": "リターン図の中のアスペクトのオーブ（度）。省略すると 5°（1 枚の図の中は広めに取るのが通例）。**ネイタルへのアスペクト（オーブ 1°）には効かない**"
        }
      },
      "required": [
        "chart_id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "progressions",
    "title": "プログレッション（二次進行）",
    "description": "二次進行（セカンダリー・プログレッション／一日一年法）を計算する。出生の翌日の空を1歳、翌々日を2歳と読む技法で、進行天体・進行 ASC / MC と、それらがネイタルに落とすアスペクト（メジャー5種・オーブ 1°）を返す。\n**このツールだけは出生の原本（日時・場所）が要るため、原本をサーバーに預けた本人の URL でしか動かない。**chart_id は取らない——原本から毎回ネイタルを引き直すので、登録済みチャートとの取り違えが起きない。使えない URL では、その旨だけを返す。\nyear / month / day を省略すると今日で計算する。返却テキストに出生日時・出生地そのものは出さない。\nこのツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "year": {
          "type": "integer",
          "description": "見たい日の年（month / day とそろえて指定。省略すると今日）"
        },
        "month": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "見たい日の月（1-12）"
        },
        "day": {
          "type": "integer",
          "minimum": 1,
          "maximum": 31,
          "description": "見たい日の日（1-31）"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "表示に使う時差（時間単位。日本時間なら 9）。日付を省略したときの「今日」もこの時差の土地の暦で決める（省略すると UTC）"
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "update_default_location",
    "title": "いつもの場所を差し替える",
    "description": "登録済みチャートの「いつもの場所」（リターン計算で使う土地）だけを差し替える。**出生データの再入力は不要で、保存済みの計算結果（天体・カスプ・ASC/MC）には一切触れない**——「いつもの場所」は出生データとは無関係の覚え書きなので、差し替えても図は変わらない。\n引っ越したとき、あるいはリターンをこれから別の土地で立てたくなったときに使う。lat と lng は両方そろえて指定すること。\nclear: true にすると「いつもの場所」を削除する（以後、lunar_return / solar_return は呼び出しのたびに lat / lng の指定が必要になる）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）"
        },
        "lat": {
          "type": "number",
          "minimum": -90,
          "maximum": 90,
          "description": "新しい「いつもの場所」の緯度（北緯が正。lng とそろえて指定）"
        },
        "lng": {
          "type": "number",
          "minimum": -180,
          "maximum": 180,
          "description": "新しい「いつもの場所」の経度（東経が正。lat とそろえて指定）"
        },
        "location_label": {
          "type": "string",
          "description": "その場所の呼び名（任意。例: 東京）"
        },
        "clear": {
          "type": "boolean",
          "default": false,
          "description": "true にすると「いつもの場所」を削除する（lat / lng と同時には指定できない）"
        }
      },
      "required": [
        "chart_id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "yearly_overview",
    "title": "年間概要（ソーラーリターン年の天体イベント）",
    "description": "登録済みチャートの**ソーラーリターンから次のソーラーリターンまでの 1 年**を 1 日刻みで走査し、その年に起きる天体イベントを一覧にする。返るのは (1) 水星〜冥王星の逆行期間、(2) 木星〜冥王星の星座イングレス（逆行で前の星座へ戻るものも含む）、(3) 木星〜冥王星がネイタルの ASC / MC に作るメジャーアスペクトの期間、(4) 同じくネイタルの 10 天体（ノードを除く）に作るメジャーアスペクトの期間（メジャー5種・オーブ 1°、各期間には最接近の日も添える）。\nyear を指定するとその年のソーラーリターンから始まる 1 年。省略すると**現在を含むソーラーリターン年**（直近のソーラーリターンから次のソーラーリターンまで）。\n日付の解像度は 1 日。start はその状態に入った最初の日、end は外れた最初の日（Web 版 Astro Tool の年間概要と同じ数え方）。utc_offset を渡すとその土地の暦で日付を出す。\n速い天体（太陽・月・水星・金星・火星）のトランジットや時刻単位の精度が要るときは transit を使うこと。このツールは解釈をしない——出た期間と角度をどう読むかは呼び出した側の仕事。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）"
        },
        "year": {
          "type": "integer",
          "description": "ソーラーリターンの年（その年の 1 月 1 日以降に来るリターンから 1 年。省略すると現在を含むソーラーリターン年）"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "日付に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）"
        }
      },
      "required": [
        "chart_id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "transit_events",
    "title": "期間内のトランジットイベント（時刻つき）",
    "description": "登録済みチャートに対して、指定した期間（既定は今日から 7 日間）に起きるトランジットのイベントを**時刻つき（分単位）**で時系列に並べる。返るのは (1) トランジット天体がネイタルの 10 天体（ノード除く）と ASC / MC に作るメジャーアスペクト（合・セクスタイル・スクエア・トライン・オポジション、オーブ 1°）の**入った時刻（entering）・ぴったりの時刻（exact）・外れた時刻（leaving）**と最小オーブ、(2) 留（逆行の始まり・終わり）の時刻、(3) 星座イングレスの時刻。\nbodies で動く側の天体を選ぶ: all＝太陽〜冥王星の 10 天体（最長 31 日）／no_moon＝月を除く（最長 93 日）／outer＝木星〜冥王星（最長 366 日）。月は 1 か月に 60 本ほどアスペクトを作るので、長い期間は no_moon か outer で。\nstart は \"YYYY-MM-DD\"（utc_offset の暦でその日の 0 時から）。省略すると utc_offset の暦での今日。\n1 年を日単位で俯瞰するなら yearly_overview、ある一瞬の配置を見るなら transit。このツールは解釈をしない——出た時刻と角度をどう読むかは呼び出した側の仕事。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）"
        },
        "start": {
          "type": "string",
          "pattern": "^-?\\d{1,5}-\\d{2}-\\d{2}$",
          "description": "開始日 \"YYYY-MM-DD\"（utc_offset の暦。省略すると今日）"
        },
        "days": {
          "type": "integer",
          "minimum": 1,
          "maximum": 366,
          "description": "日数（省略すると 7。上限は bodies による: all 31 / no_moon 93 / outer 366）"
        },
        "bodies": {
          "type": "string",
          "enum": [
            "all",
            "no_moon",
            "outer"
          ],
          "default": "all",
          "description": "動く側の天体の組"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "暦と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC）"
        }
      },
      "required": [
        "chart_id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  }
];
