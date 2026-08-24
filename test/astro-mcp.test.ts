import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { normalizeDegree } from "../src/astro/chart";
import { handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import {
  createChart,
  newChartId,
  type AuthContext,
  type StoredChart,
} from "../src/astro/store";
import { calculateNumerology } from "../src/numerology";
import { calculateFourPillars, type FourPillarsResult } from "../src/four-pillars";
import type { RandomSource } from "../src/random";
import { FakeKv } from "./stubs/fake-kv";
import { FROZEN_CARD_TOOLS } from "./stubs/frozen-card-tools";
import {
  FAKE_ASCMC,
  FAKE_CUSPS,
  FAKE_TROPICAL_YEAR,
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

/** 占星術層に JSON-RPC を 1 発投げる（身元の確認は済んでいる前提のハンドラ直叩き） */
async function rpc(body: unknown, ctx: AstroContext = context): Promise<any> {
  const response = await handleAstroMcpRequest(
    new Request("http://localhost/astro/mcp", {
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

/** ルーター（src/index.ts）を直に叩く。占星術層はもうここには居ないので env も渡さない */
async function fetchRouter(
  path: string,
  body: unknown = null,
  method = "POST",
): Promise<{ response: Response; text: string; json: any }> {
  const init: RequestInit = { method };
  if (method === "POST") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`http://localhost${path}`, init));
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
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
 * 出生データを預からなかった時代の登録を再現する（台帳へ直接置く）。
 *
 * 今の save_chart は必ず birth を入れるので、この形はもう作れません。
 * 古い登録でも読めること・progressions だけは登録し直しを案内することを見るための細工です。
 */
function putLegacyChart(chartId = "legacy01", user = "user1"): string {
  const legacy: StoredChart = {
    label: "むかしの図",
    house_system: "P",
    planets: [{ id: 0, lon: 0, speed: 1 }],
    cusps: [...FAKE_CUSPS],
    ascmc: [...FAKE_ASCMC],
    created: "2026-08-01T00:00:00.000Z",
  };
  kv.store.set(`chart:${user}:${chartId}`, JSON.stringify(legacy));
  return chartId;
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
    // 出生データは台帳が預かる（値は返事に出さない）
    expect(instructions).toContain("この鍵の台帳に預かります");
    expect(instructions).toContain("返事には出生データそのものは出しません");
    expect(instructions).toContain("delete_chart で消えます");
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
    // 誕生日から引く占術（出生データを預かるようになって足せた口）
    expect(instructions).toContain("calculate_numerology");
    expect(instructions).toContain("ライフパス 4 経路");
    // chart_id でも生年月日の直接指定でも呼べる。公開層には無い、と言い切る
    expect(instructions).toContain("chart_id か生年月日の直接指定");
    expect(instructions).toContain("公開のカード層には無く");
    // 宿曜（誕生日を使うので鍵つき層だけ。読みは LLM の知識で）
    expect(instructions).toContain("shukuyo");
    expect(instructions).toContain("shukuyo_compat");
    expect(instructions).toContain("Lahiri");
    expect(instructions).toContain("宿の意味はサーバーに載せていません");
    expect(instructions).toContain("四体系（ホロスコープ・宿曜・四柱・九星）を合算する根拠はありません");
    // 二次進行も chart_id 方式（出生データを預かっているチャートが要る）
    expect(instructions).toContain("progressions");
    expect(instructions).toContain("progressions も chart_id で呼べます");
    expect(instructions).not.toContain("本人の URL");
    // カード層 5 本の同居（2026-08-24 スーパーセット化）と、引いた結果を保存しない約束
    expect(instructions).toContain("draw_cards");
    expect(instructions).toContain("結果は一切保存されません");
    expect(instructions).toContain("四体系と混ぜて点数を足す根拠もありません");
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

  it("22 本のツールを返す（占星術層 17 本＋カード層 5 本のスーパーセット）", async () => {
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
      "calculate_numerology",
      "shukuyo",
      "shukuyo_compat",
      "four_pillars",
      "synastry",
      "kyusei",
      // ここからカード層 5 本の同居（2026-08-24 スーパーセット化。定義は公開層と同一）
      "list_decks",
      "draw_cards",
      "cast_hexagram",
      "roll_astro_dice",
      "cast_geomancy",
    ]);
    // 名前はどれも一意（カード層と占星術層で重ならない）
    expect(new Set(names).size).toBe(names.length);
  });

  it("ツール定義は凍結（クライアントが接続時にキャッシュするので勝手に変えない）", async () => {
    const json = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    // カード層 5 本は公開層と同じ凍結 literal を共有する（定義が二重にならない証明でもある）
    expect(json.result.tools).toEqual([...FROZEN_ASTRO_TOOLS, ...FROZEN_CARD_TOOLS]);
  });

  it("ping と知らないメソッド", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 5, method: "ping" })).result).toEqual({});
    const unknown = await rpc({ jsonrpc: "2.0", id: 6, method: "resources/list" });
    expect(unknown.error.code).toBe(-32601);
  });
});

describe("カード層の同居（スーパーセット・2026-08-24）", () => {
  it("draw_cards が鍵つきの入口から引ける（公開層と同じ実装への委譲）", async () => {
    const result = await call("draw_cards", { deck: "tarot", count: 3 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.cards).toHaveLength(3);
  });

  it("cast_geomancy も引ける（引数なし・乱数だけで完結）", async () => {
    const result = await call("cast_geomancy");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.mothers).toHaveLength(4);
  });

  it("カード系の引数検問はカード層のもの（未知の引数を黙って無視しない）", async () => {
    const result = await call("draw_cards", { deck: "tarot", numbers: 3 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("未知の引数");
  });

  it("カード系を引いても KV には何も書かれない（委譲に kv を渡さない＝非永続化の検算）", async () => {
    expect(kv.store.size).toBe(0);
    for (const [name, args] of [
      ["list_decks", {}],
      ["draw_cards", { deck: "sky" }],
      ["roll_astro_dice", { count: 2 }],
      ["cast_hexagram", {}], // 納甲なし＝エンジンにも触らない
      ["cast_geomancy", {}],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBeUndefined();
    }
    expect(kv.store.size).toBe(0);
  });
});

// 2026-08-22 URL 鍵（POST /mcp/<鍵>）を引退させた。占星術層の入口は OAuth の POST /astro/mcp
//            だけになり、このルーターに残るのはカード層と案内文・404 だけ
describe("ルーティング（カード層と 404）", () => {
  it("/mcp のあとに何か続く URL は 404（もう鍵の口ではない・URL を echo しない）", async () => {
    for (const path of ["/mcp/anything", "/mcp/testkey1234567890abcd/", "/mcp/a/b"]) {
      const { response, text } = await fetchRouter(path, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expect(response.status).toBe(404);
      expect(text).toContain("見つかりません");
      expect(text).not.toContain("anything");
      expect(text).not.toContain("testkey");
    }
  });

  // 2026-08-22 roll_astro_dice 追加で更新（カード層のツールが増えても占星術層は混ざらない）
  // 2026-08-22 cast_geomancy 追加で更新（同上）
  // 2026-08-22 calculate_numerology 追加で更新（同上）
  // 2026-08-22 calculate_numerology を鍵つき層へ移して 5 本に戻した
  //            （公開層には個人データの口を生やさない）
  it("公開カード層は無傷（カード層のツールだけ・鍵も要らない）", async () => {
    const { response, json } = await fetchRouter("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(200);
    expect(json.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list_decks",
      "draw_cards",
      "cast_hexagram",
      "roll_astro_dice",
      "cast_geomancy",
    ]);
  });

  it("案内文は占星術層の存在にだけ触れ、その入口の URL は書かない", async () => {
    const response = await worker.fetch(new Request("http://localhost/"));
    const text = await response.text();
    expect(text).toContain("占星術");
    expect(text).not.toContain("/mcp/");
  });
});

describe("save_chart", () => {
  it("chart_id とネイタル要約を返す。出生データは台帳に預かり、返事には出さない", async () => {
    // 出生地（東京）と「いつもの場所」（大阪）をわざと別にして、返事に出るのが後者だけだと確かめる
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
    expect(
      text
        .trimEnd()
        .endsWith(
          "出生データ（日時・時差・緯度経度）はこのチャートに預かりました。返事には出しません。delete_chart で消えます。",
        ),
    ).toBe(true);

    // 返事には出生データの値を出さない（テキストにも structuredContent にも）
    expect(text).not.toContain("1990");
    expect(text).not.toContain("35.6895");
    expect(text).not.toContain("139.6917");
    expect(Object.keys(result.structuredContent)).not.toContain("birth");
    expect(JSON.stringify(result.structuredContent)).not.toContain("1990");
    expect(JSON.stringify(result.structuredContent)).not.toContain("35.6895");
    expect(JSON.stringify(result.structuredContent)).not.toContain("139.6917");

    // KV には計算済みの座標と一緒に出生データが入る（預かる先はここだけ）
    const raw = kv.store.get(`chart:user1:${chartId}`) as string;
    const stored = JSON.parse(raw);
    expect(Object.keys(stored).sort()).toEqual([
      "ascmc",
      "birth",
      "created",
      "cusps",
      "default_location",
      "house_system",
      "label",
      "planets",
    ]);
    expect(stored.birth).toEqual({
      year: 1990,
      month: 6,
      day: 15,
      hour: 12,
      minute: 0,
      utc_offset: 0,
      lat: 35.6895,
      lng: 139.6917,
    });
    // jd（出生の瞬間そのもの）は入れない
    expect(Object.keys(stored)).not.toContain("jd");
    expect(stored.planets).toHaveLength(11);
    expect(stored.planets[0]).toEqual({ id: 0, lon: 0, speed: 1 });
    // 「いつもの場所」は出生地とは別の覚え書き（こちらは返事にも出る）
    expect(stored.default_location).toEqual({ lat: 34.6937, lng: 135.5023, label: "大阪" });

    // 計算そのものには出生地がちゃんと渡っている
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
    // 案内文も新方針（預かる・返事には出さない・delete_chart で消える）
    expect(result.content[0].text).toContain("この鍵の台帳に預かります");
  });

  it("登録すると一覧に出る（出生データは「あり」だけを添える）", async () => {
    const chartId = await saveDefaultChart();
    const result = await call("list_charts");
    expect(result.structuredContent.charts).toHaveLength(1);
    expect(result.structuredContent.charts[0].chart_id).toBe(chartId);
    expect(result.structuredContent.charts[0].has_birth).toBe(true);
    expect(result.content[0].text).toContain("保存済みチャート（1件）");
    expect(result.content[0].text).toContain(`- ${chartId}: サンプル`);
    expect(result.content[0].text).toContain("プラシーダス（P）");
    expect(result.content[0].text).toContain("出生データ: あり");
    // 一覧にも値そのものは出さない
    expect(result.content[0].text).not.toContain("1990");
    expect(JSON.stringify(result.structuredContent)).not.toContain("139.6917");
  });

  it("出生データの無い古い登録は「なし」と添え、has_birth も false", async () => {
    const chartId = putLegacyChart();
    const result = await call("list_charts");
    expect(result.structuredContent.charts[0].chart_id).toBe(chartId);
    expect(result.structuredContent.charts[0].has_birth).toBe(false);
    expect(result.content[0].text).toContain("出生データ: なし（登録し直すと progressions などが使えます）");
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
    expect(removed.content[0].text).toBe(
      `チャート ${chartId}（サンプル）を削除しました。預かっていた出生データも一緒に消えました。`,
    );
    expect(removed.structuredContent.birth_removed).toBe(true);
    expect(kv.store.has(`chart:user1:${chartId}`)).toBe(false);

    const again = await call("delete_chart", { chart_id: chartId });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain("見つかりませんでした");

    expect((await call("list_charts")).structuredContent.charts).toEqual([]);
  });

  it("出生データの無い古い登録を消すときは、消えたとは言わない", async () => {
    const chartId = putLegacyChart();
    const removed = await call("delete_chart", { chart_id: chartId });
    expect(removed.isError).toBeUndefined();
    expect(removed.content[0].text).toBe(`チャート ${chartId}（むかしの図）を削除しました。`);
    expect(removed.structuredContent.birth_removed).toBe(false);
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
    // 出生データは預かっているが、読み直しても出てこない（読み戻す口は無い）
    expect(text).not.toContain("1990");
    expect(text).not.toContain("35.6895");
    expect(Object.keys(structured)).not.toContain("birth");
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
// 二次進行
// ---------------------------------------------------------------------------

const FRIEND: AuthContext = { user: "friend1", name: "ともだち", role: "friend" };

describe("progressions", () => {
  it("預かっている出生データで、進行天体・進行 ASC/MC・クロスアスペクトを返す", async () => {
    const chartId = await saveDefaultChart();
    const result = await call("progressions", { chart_id: chartId });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text.split("\n")[0]).toBe("プログレッション（二次進行・一日一年法）");
    expect(text).toContain(`チャート: サンプル（${chartId}）`);
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

    // **預かっていても、出生日時・出生地の数値は返事に出さない**
    expect(text).not.toContain("1990");
    expect(text).not.toContain("35.6895");
    expect(text).not.toContain("139.6917");
    expect(JSON.stringify(result.structuredContent)).not.toContain("1990");
    expect(JSON.stringify(result.structuredContent)).not.toContain("35.6895");
    expect(JSON.stringify(result.structuredContent)).not.toContain("139.6917");
    expect(Object.keys(result.structuredContent)).not.toContain("birth");

    // ARMC 方式のハウスは出生地の緯度・真黄道傾斜・チャートのハウス方式で立つ
    expect(engine.armcCalls).toHaveLength(1);
    expect(engine.armcCalls[0]?.lat).toBe(35.6895);
    expect(engine.armcCalls[0]?.eps).toBe(23.44);
    expect(engine.armcCalls[0]?.hsys).toBe("P");

    const structured = result.structuredContent;
    expect(structured.chart_id).toBe(chartId);
    expect(structured.label).toBe("サンプル");
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

  it("ハウス方式はチャートに登録したものを使う", async () => {
    const saved = await call("save_chart", { ...BIRTH, house_system: "W" });
    const chartId: string = saved.structuredContent.chart_id;

    const result = await call("progressions", { chart_id: chartId });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("ハウス方式: ホールサイン（W）");
    expect(result.structuredContent.house_system).toBe("W");
    expect(engine.armcCalls[0]?.hsys).toBe("W");
  });

  it("対象日を指定できる。utc_offset は「今日」の暦にも効く", async () => {
    const chartId = await saveDefaultChart();

    const dated = await call("progressions", { chart_id: chartId, year: 2030, month: 1, day: 1 });
    expect(dated.content[0].text).toContain("対象日: 2030-01-01 / 39歳6ヶ月相当");
    expect(dated.structuredContent.is_today).toBe(false);

    // 現在は 2026-08-20 02:15 UTC ＝ UTC-9 の土地ではまだ 8/19
    const shifted = await call("progressions", { chart_id: chartId, utc_offset: -9 });
    expect(shifted.content[0].text).toContain("対象日: 2026-08-19（今日・UTC-9 の暦）");
  });

  it("year / month / day は 3 つそろえて。出生より前は断る", async () => {
    const chartId = await saveDefaultChart();

    const partial = await call("progressions", { chart_id: chartId, year: 2030 });
    expect(partial.isError).toBe(true);
    expect(partial.content[0].text).toContain("そろえて指定してください");

    const tooEarly = await call("progressions", {
      chart_id: chartId,
      year: 1980,
      month: 1,
      day: 1,
    });
    expect(tooEarly.isError).toBe(true);
    expect(tooEarly.content[0].text).toContain("対象日が出生より前です");
  });

  it("chart_id は必須。知らない ID・他人のチャートは丁寧に断る", async () => {
    const missing = await call("progressions", {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("chart_id は必須です");

    const unknown = await call("progressions", { chart_id: "nosuchid" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("チャート nosuchid が見つかりませんでした");
    expect(unknown.content[0].text).toContain("list_charts");

    // 他人の棚は覗けない（chart: の前置きで仕切ってある）
    const chartId = await saveDefaultChart();
    const other: AstroContext = { ...context, auth: FRIEND };
    const peek = await call("progressions", { chart_id: chartId }, other);
    expect(peek.isError).toBe(true);
    expect(peek.content[0].text).toContain("見つかりませんでした");
  });

  it("出生データの無い古い登録では、値に触れずに登録し直しを案内する", async () => {
    const chartId = putLegacyChart();
    const result = await call("progressions", { chart_id: chartId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("このチャートには出生データが入っていません");
    expect(result.content[0].text).toContain("delete_chart で消して save_chart で登録し直す");
    // 断るだけで、計算にも行かない
    expect(engine.armcCalls).toHaveLength(0);
  });

  it("friend の鍵でも使える（role では門番しない）", async () => {
    const friend: AstroContext = { ...context, auth: FRIEND };
    const saved = await call("save_chart", BIRTH, friend);
    const chartId: string = saved.structuredContent.chart_id;

    const result = await call("progressions", { chart_id: chartId }, friend);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("プログレッション（二次進行・一日一年法）");
    expect(result.structuredContent.chart_id).toBe(chartId);
  });
});

// ---------------------------------------------------------------------------
// 数秘術（誕生日から引く占術）
// ---------------------------------------------------------------------------

/**
 * 数秘の見本（1986-12-29 生まれ）。
 *
 * ライフパスが 11 と 2 に割れる日で、このツールが 4 経路を並べる理由そのもの。
 * 生まれ年を 1986 にしてあるのは、返事に混じったら "1986" ですぐ見つかるようにするため
 * （基準日にはわざと別の年を使う ―― 同じ数だと「出ていない」の確かめにならないので）。
 */
const NUMEROLOGY_BIRTH = { ...BIRTH, label: "数秘の見本", year: 1986, month: 12, day: 29 };

async function saveNumerologyChart(): Promise<string> {
  const saved = await call("save_chart", NUMEROLOGY_BIRTH);
  expect(saved.isError).toBeUndefined();
  return saved.structuredContent.chart_id as string;
}

describe("calculate_numerology", () => {
  it("預かっている出生日から 4 経路と途中式を返す（純関数と同じ数）", async () => {
    const chartId = await saveNumerologyChart();
    const result = await call("calculate_numerology", {
      chart_id: chartId,
      target_year: 2026,
      target_month: 8,
      target_day: 22,
    });
    expect(result.isError).toBeUndefined();

    // 算法はカード層と同じ純関数。ここで見るのは「出生日の出どころ」だけ
    const expected = calculateNumerology({
      year: 1986,
      month: 12,
      day: 29,
      target: { year: 2026, month: 8, day: 22 },
    });

    const text: string = result.content[0].text;
    expect(text.split("\n")[0]).toBe(`チャート: 数秘の見本（${chartId}）`);
    expect(text).toContain("■ 数秘術（生年月日ベース・ピタゴラス式）");
    expect(text).toContain("ライフパス: 11 / 2 ← 経路で割れています");
    expect(text).toContain("パーソナルデイ 2026-08-22: 9（4 経路一致）");

    const structured = result.structuredContent;
    expect(structured.source).toBe("chart");
    expect(structured.chart_id).toBe(chartId);
    expect(structured.label).toBe("数秘の見本");
    expect(structured.life_path).toEqual(expected.life_path);
    expect(structured.life_path.values).toEqual([11, 2]);
    expect(structured.life_path.presets.full_sum.value).toBe(11);
    expect(structured.life_path.presets.no_master.value).toBe(2);
    expect(structured.birthday).toEqual(expected.birthday);
    expect(structured.attitude).toEqual(expected.attitude);
    expect(structured.personal_year).toEqual(expected.personal_year);
    expect(structured.personal_month).toEqual(expected.personal_month);
    expect(structured.personal_day).toEqual(expected.personal_day);
    expect(structured.conventions).toMatchObject({
      masters: [11, 22, 33],
      personal_year_start: "calendar",
    });
  });

  it("生まれ年は返事に出さない（日はバースデーナンバーとして出る）", async () => {
    const chartId = await saveNumerologyChart();
    const result = await call("calculate_numerology", {
      chart_id: chartId,
      target_year: 2026,
      target_month: 8,
      target_day: 22,
    });

    const text: string = result.content[0].text;
    // 生まれ年・生まれ月の生の数字も、出生地の座標も出ない
    expect(text).not.toContain("1986");
    expect(text).not.toContain("35.6895");
    expect(text).not.toContain("139.6917");
    const json = JSON.stringify(result.structuredContent);
    expect(json).not.toContain("1986");
    expect(json).not.toContain("35.6895");
    expect(json).not.toContain("139.6917");
    expect(Object.keys(result.structuredContent)).not.toContain("birth");

    // 生まれた日だけはバースデーナンバーとしてそのまま出る（日だけでは出生日は復元できない）
    expect(text).toContain("バースデー: 29 → 11 (→2)");
    expect(result.structuredContent.birthday.day).toBe(29);
  });

  it("基準日を省くと今日で見る（utc_offset で日付が変わる）", async () => {
    const chartId = await saveNumerologyChart();

    // 現在は 2026-08-20 02:15 UTC。省略時の暦は progressions と同じ UTC
    const today = await call("calculate_numerology", { chart_id: chartId });
    expect(today.isError).toBeUndefined();
    expect(today.structuredContent.personal_day).toMatchObject({
      year: 2026,
      month: 8,
      day: 20,
    });
    expect(today.content[0].text).toContain("パーソナルデイ 2026-08-20");

    // UTC-9 の土地ではまだ 8/19
    const shifted = await call("calculate_numerology", { chart_id: chartId, utc_offset: -9 });
    expect(shifted.structuredContent.personal_day).toMatchObject({
      year: 2026,
      month: 8,
      day: 19,
    });

    // UTC+9 なら同じ日の 11:15 なので 8/20 のまま
    const jst = await call("calculate_numerology", { chart_id: chartId, utc_offset: 9 });
    expect(jst.structuredContent.personal_day.day).toBe(20);
  });

  it("masters: 11_22 は 33 を認めない", async () => {
    // 1959-03-06 は全桁の和が 33（既定では保持、11_22 なら 6 まで落ちる）
    const saved = await call("save_chart", {
      ...BIRTH,
      label: "33 の見本",
      year: 1959,
      month: 3,
      day: 6,
    });
    const chartId: string = saved.structuredContent.chart_id;

    const wide = await call("calculate_numerology", { chart_id: chartId });
    expect(wide.structuredContent.life_path.presets.full_sum.value).toBe(33);

    const narrow = await call("calculate_numerology", { chart_id: chartId, masters: "11_22" });
    expect(narrow.structuredContent.life_path.presets.full_sum.value).toBe(6);
    expect(narrow.structuredContent.conventions.masters).toEqual([11, 22]);
  });

  it("出生データの無い古い登録では、値に触れずに登録し直しを案内する", async () => {
    const chartId = putLegacyChart();
    const result = await call("calculate_numerology", { chart_id: chartId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("このチャートには出生データが入っていません");
    expect(result.content[0].text).toContain("delete_chart で消して save_chart で登録し直す");
    // 断るだけで、数は 1 つも出さない
    expect(result.content[0].text).not.toContain("ライフパス");
    expect(result.structuredContent).toBeUndefined();
  });

  it("知らない ID・他人のチャートは丁寧に断る", async () => {
    const unknown = await call("calculate_numerology", { chart_id: "nosuchid" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("チャート nosuchid が見つかりませんでした");
    expect(unknown.content[0].text).toContain("list_charts");

    // 他人の棚は覗けない
    const chartId = await saveNumerologyChart();
    const other: AstroContext = { ...context, auth: FRIEND };
    const peek = await call("calculate_numerology", { chart_id: chartId }, other);
    expect(peek.isError).toBe(true);
    expect(peek.content[0].text).toContain("見つかりませんでした");
  });

  it("基準日の部分指定・暦に無い日・知らない masters・未知の引数を断る", async () => {
    const chartId = await saveNumerologyChart();

    for (const partial of [
      { target_year: 2026 },
      { target_year: 2026, target_month: 8 },
      { target_month: 8, target_day: 22 },
      { target_day: 22 },
    ]) {
      const result = await call("calculate_numerology", { chart_id: chartId, ...partial });
      expect(result.isError, JSON.stringify(partial)).toBe(true);
      expect(result.content[0].text).toContain("3 つそろえて指定してください");
    }

    const noSuchDay = await call("calculate_numerology", {
      chart_id: chartId,
      target_year: 2026,
      target_month: 4,
      target_day: 31,
    });
    expect(noSuchDay.isError).toBe(true);
    expect(noSuchDay.content[0].text).toContain("2026-04-31 は暦に存在しない日付です");

    const badMasters = await call("calculate_numerology", {
      chart_id: chartId,
      masters: "11_22_33_44",
    });
    expect(badMasters.isError).toBe(true);
    expect(badMasters.content[0].text).toContain("masters は 11_22_33 / 11_22");

    const badOffset = await call("calculate_numerology", { chart_id: chartId, utc_offset: 20 });
    expect(badOffset.isError).toBe(true);
    expect(badOffset.content[0].text).toContain("utc_offset は -14 以上 14 以下");

    // 綴り違いは黙って無視しない（許可キーはツール定義から作っている）
    const typo = await call("calculate_numerology", { chart_id: chartId, master: "11_22" });
    expect(typo.isError).toBe(true);
    expect(typo.content[0].text).toContain("未知の引数です: master");
    expect(typo.content[0].text).toContain("masters");
  });

  // ここから下は「登録せずに一度だけ見る」ための直接指定（2026-08-22）
  it("生年月日の直接指定でも引ける（登録は要らない）", async () => {
    const result = await call("calculate_numerology", {
      year: 1986,
      month: 12,
      day: 29,
      target_year: 2026,
      target_month: 8,
      target_day: 22,
    });
    expect(result.isError).toBeUndefined();

    // 算法は chart_id 版とまったく同じ純関数（違うのは生年月日の出どころだけ）
    const expected = calculateNumerology({
      year: 1986,
      month: 12,
      day: 29,
      target: { year: 2026, month: 8, day: 22 },
    });

    const text: string = result.content[0].text;
    expect(text.split("\n")[0]).toBe("生年月日: 直接指定（値は返事に出しません）");
    expect(text).toContain("ライフパス: 11 / 2 ← 経路で割れています");
    expect(text).toContain("パーソナルデイ 2026-08-22: 9（4 経路一致）");

    const structured = result.structuredContent;
    expect(structured.source).toBe("direct");
    // 台帳を経由していないので chart_id / label は入れない
    expect(Object.keys(structured)).not.toContain("chart_id");
    expect(Object.keys(structured)).not.toContain("label");
    expect(structured.life_path).toEqual(expected.life_path);
    expect(structured.birthday).toEqual(expected.birthday);
    expect(structured.personal_day).toEqual(expected.personal_day);
  });

  it("直接指定でも生まれ年は返事に出さない（鍵つき層の約束は同じ）", async () => {
    const result = await call("calculate_numerology", {
      year: 1986,
      month: 12,
      day: 29,
      target_year: 2026,
      target_month: 8,
      target_day: 22,
    });
    expect(result.content[0].text).not.toContain("1986");
    expect(JSON.stringify(result.structuredContent)).not.toContain("1986");
    // 生まれた日だけはバースデーナンバーとしてそのまま出る
    expect(result.content[0].text).toContain("バースデー: 29 → 11 (→2)");
  });

  it("chart_id と生年月日はどちらか一方（両方・どちらも無しは断る）", async () => {
    const chartId = await saveNumerologyChart();

    const both = await call("calculate_numerology", {
      chart_id: chartId,
      year: 1986,
      month: 12,
      day: 29,
    });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain("どちらか一方にしてください");

    const neither = await call("calculate_numerology", {});
    expect(neither.isError).toBe(true);
    expect(neither.content[0].text).toContain("chart_id か year / month / day を指定してください");

    // 直接指定の打ち忘れも、残りを勝手に埋めずに断る
    for (const partial of [{ year: 1986 }, { year: 1986, month: 12 }, { month: 12, day: 29 }]) {
      const result = await call("calculate_numerology", partial);
      expect(result.isError, JSON.stringify(partial)).toBe(true);
      expect(result.content[0].text).toContain("year / month / day の 3 つをそろえて");
    }
  });

  it("直接指定でも暦に無い生年月日は断る", async () => {
    const result = await call("calculate_numerology", { year: 1986, month: 2, day: 31 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("1986-02-31 は暦に存在しない日付です");
  });
});

// ---------------------------------------------------------------------------
// 宿曜
// ---------------------------------------------------------------------------

/**
 * 宿曜の見本（2023-03-14 10:00・UTC−7）。
 *
 * **Claude の公開日**を借りています ―― 時刻の 10 時は架空、時差は米国太平洋夏時間（PDT。
 * 2023 年の夏時間は 3/12 から）。人の誕生日と紛れない公開された日付を見本にする、という取り決めです
 * （1986-12-29 は数秘の境界事例として別の意味でリポにあるので、そちらだけに残します）。
 * 返事に混じったら "2023" や "03-14" ですぐ見つかります。
 *
 * 分が 0 なので「時刻まで使って月を出しているか」は jd の突き合わせだけでは見られません。
 * そのぶんは直接指定のテストで **1 分ずらすと別の宿になる**ことを見て埋めてあります。
 */
const SHUKUYO_BIRTH = {
  ...BIRTH,
  label: "宿曜の見本",
  year: 2023,
  month: 3,
  day: 14,
  hour: 10,
  minute: 0,
  utc_offset: -7,
};

/** 偽エンジンの swe_julday と同じ式（テスト側から jd を先回りして知るため） */
function fakeJd(year: number, month: number, day: number, utcHour: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 2440587.5 + utcHour / 24;
}

/** SHUKUYO_BIRTH の出生の瞬間（現地 10:00・UTC−7 → UTC では同じ日の 17:00） */
const SHUKUYO_NATAL_JD = fakeJd(2023, 3, 14, 10 + 7);

/**
 * 本命宿・日運に置くサイデリアル黄経。
 *
 * **宿はこの staged した黄経だけで決まり、出生の日付には依りません**（下の stageShukuyoMoon が
 * 「出生の瞬間かそれ以外か」で月を置き分けるだけなので）。だから見本の日付を替えても
 * 期待値の宿は動きません ―― 手計算はこう:
 *   1 宿 = 360° ÷ 27 = 13°20′。n 番目の宿の頭は (n − 1) × 13°20′。
 *   ・本命 190°25′ → 15 番目（亢宿 Swati、頭は 14 × 13°20′ = 186°40′）の 3°45′。
 *     次の境（15 × 13°20′ = 200°）までは 9°35′。両隣は 14 角宿 Chitra / 16 氐宿 Vishakha。
 *   ・日運 60° → 5 番目（觜宿 Mrigashira、頭は 4 × 13°20′ = 53°20′）の 6°40′。
 *   ・三九の秘法の距離は (4 − 14) mod 27 + 1 = 18 ＝ 親（中距離・組 栄親）。
 */
const NATAL_SIDEREAL = 190 + 25 / 60;
const DAY_SIDEREAL = 60;
/**
 * 出生時のアヤナムシャ（返事に出てはいけない値）。
 * 見本の年（2023）をなぞった見つけやすい数にしてあります ―― 本物の Lahiri は 2023 年で 24.15° 前後なので、
 * この値が返事に出ていたら一目で分かります。サイデリアル黄経は
 * 「staged したトロピカル − アヤナムシャ」で戻るので、宿の期待値はこの数を変えても動きません。
 */
const NATAL_AYANAMSA = 20.23;
/** 日運のアヤナムシャ（こちらは返事に出てよい＝呼び出し側が日付を指定しているので） */
const DAY_AYANAMSA = 24.2292;

/**
 * 偽エンジンの月とアヤナムシャを「出生の瞬間」と「それ以外」で切り替える。
 *
 * 素の偽エンジンは jd に依らず月を 30° に置くので、本命宿と日運が同じ宿になってしまい
 * 「取り違えていないか」を見られない。ここで別の宿に置き分ける。
 * アヤナムシャも分けてあるのは、**出生時のぶんが返事に出ていないこと**を確かめるため。
 */
function stageShukuyoMoon(): void {
  const isNatal = (jd: number): boolean => Math.abs(jd - SHUKUYO_NATAL_JD) < 1e-9;
  const base = engine.swe_calc_ut;
  engine.swe_calc_ut = (jd: number, id: number, flags: number): number[] => {
    const result = base(jd, id, flags);
    if (id === 1) {
      result[0] = normalizeDegree(
        isNatal(jd) ? NATAL_SIDEREAL + NATAL_AYANAMSA : DAY_SIDEREAL + DAY_AYANAMSA,
      );
    }
    return result;
  };
  engine.swe_get_ayanamsa_ut = (jd: number): number =>
    isNatal(jd) ? NATAL_AYANAMSA : DAY_AYANAMSA;
}

async function saveShukuyoChart(): Promise<string> {
  const saved = await call("save_chart", SHUKUYO_BIRTH);
  expect(saved.isError).toBeUndefined();
  return saved.structuredContent.chart_id as string;
}

describe("shukuyo", () => {
  beforeEach(() => {
    stageShukuyoMoon();
  });

  it("預かっている出生データから本命宿と、その日の宿・関係を返す", async () => {
    const chartId = await saveShukuyoChart();
    const result = await call("shukuyo", { chart_id: chartId, date: "2026-08-22" });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain("宿曜（天文方式・Lahiri アヤナムシャ・二十七宿）");
    expect(text).toContain(`チャート: 宿曜の見本（${chartId}）`);

    // 本命宿: サイデリアル 190°25′ ＝ 亢宿（15 番目、始まりは 14 × 13°20′ = 186°40′）の 3°45′
    expect(text).toContain("■ 本命宿（出生時刻の月）");
    expect(text).toContain("亢宿（こうしゅく・Swati・15）");
    expect(text).toContain("宿内の位置: 3°45′ / 境界まで: 前 3°45′・次 9°35′");
    expect(text).toContain("両隣: 前 角宿（かくしゅく・Chitra・14）");
    expect(text).toContain("次 氐宿（ていしゅく・Vishakha・16）");

    // その日の宿: サイデリアル 60° ＝ 觜宿（5 番目、始まりは 4 × 13°20′ = 53°20′）の 6°40′
    expect(text).toContain("■ その日の宿 2026-08-22（UTC の暦）");
    expect(text).toContain("觜宿（ししゅく・Mrigashira・5）");
    expect(text).toContain("宿内の位置: 6°40′");
    // 亢宿（索引 14）から觜宿（索引 4）は (4 − 14) mod 27 + 1 = 18 ＝ 親・中距離・組 栄親
    expect(text).toContain("本命宿から: 距離 18 → 親（しん） / 中距離 / 組 栄親");
    expect(text).toContain("アヤナムシャ 24.2292°（Lahiri）");

    const structured = result.structuredContent;
    expect(structured.kind).toBe("shukuyo");
    expect(structured.source).toBe("chart");
    expect(structured.chart_id).toBe(chartId);
    expect(structured.label).toBe("宿曜の見本");
    expect(structured.natal.shuku).toMatchObject({ number: 15, name: "亢宿", sanskrit: "Swati" });
    expect(structured.natal.sidereal_lon).toBeCloseTo(190.4167, 4);
    expect(structured.natal.position).toBe("3°45′");
    expect(structured.natal.prev.name).toBe("角宿");
    expect(structured.natal.next.name).toBe("氐宿");
    expect(structured.day.shuku).toMatchObject({ number: 5, name: "觜宿" });
    expect(structured.day.date).toBe("2026-08-22");
    expect(structured.day.relation).toMatchObject({
      distance: 18,
      name: "親",
      group: "中",
      group_label: "中距離",
      pair: "栄親",
    });
    expect(structured.day.ayanamsa).toBeCloseTo(24.2292, 6);
  });

  it("採った規約を名前で返す（Lahiri・天文方式・27 宿・旧暦は採らない）", async () => {
    const chartId = await saveShukuyoChart();
    const result = await call("shukuyo", { chart_id: chartId });

    const text: string = result.content[0].text;
    expect(text).toContain("規約: 天文方式");
    expect(text).toContain("基準点 Lahiri（SE_SIDM_LAHIRI）");
    expect(text).toContain("27 宿・婁宿（Ashvini）＝サイデリアル 0°");
    expect(text).toContain("暦方式（旧暦の日付から宿を引くやり方）は採らない");
    expect(text).toContain("2033 年問題");
    // 読みは呼び出した側の仕事。意味も吉凶も書かない
    expect(text).toContain("宿の意味・吉凶はこのサーバーに載っていません");
    expect(text).toContain("合算する根拠はありません");

    expect(result.structuredContent.system).toMatchObject({
      method: "astronomical",
      ayanamsa: "Lahiri",
      ayanamsa_id: 1,
      mansions: 27,
    });
    expect(result.structuredContent.system.span_degrees).toBeCloseTo(13 + 20 / 60, 10);
    expect(result.structuredContent.system.note).toContain("昴宿から始まる");
  });

  it("date を省くと今で見る（date_utc_offset で日付が変わる）", async () => {
    const chartId = await saveShukuyoChart();

    // 現在は 2026-08-20 02:15 UTC
    const now = await call("shukuyo", { chart_id: chartId });
    expect(now.structuredContent.day.date).toBe("2026-08-20");
    expect(now.structuredContent.day.is_now).toBe(true);
    expect(now.structuredContent.day.utc).toBe("2026-08-20T02:15:00.000Z");
    expect(now.content[0].text).toContain("（現在時刻）");

    // UTC-9 の土地ではまだ 8/19
    const shifted = await call("shukuyo", { chart_id: chartId, date_utc_offset: -9 });
    expect(shifted.structuredContent.day.date).toBe("2026-08-19");
    expect(shifted.content[0].text).toContain("（UTC-9 の暦）");

    // UTC+9 なら同じ日の 11:15
    const jst = await call("shukuyo", { chart_id: chartId, date_utc_offset: 9 });
    expect(jst.structuredContent.day.date).toBe("2026-08-20");
    expect(jst.structuredContent.day.local).toBe("2026-08-20 11:15");
  });

  it("date に時刻を付けるとその瞬間で、付けなければその日の 0 時で見る", async () => {
    const chartId = await saveShukuyoChart();

    const noon = await call("shukuyo", {
      chart_id: chartId,
      date: "2026-08-22 12:30",
      date_utc_offset: 9,
    });
    expect(noon.structuredContent.day.has_time).toBe(true);
    expect(noon.structuredContent.day.local).toBe("2026-08-22 12:30");
    expect(noon.structuredContent.day.utc).toBe("2026-08-22T03:30:00.000Z");

    // T 区切りでも同じ
    const withT = await call("shukuyo", {
      chart_id: chartId,
      date: "2026-08-22T12:30",
      date_utc_offset: 9,
    });
    expect(withT.structuredContent.day.utc).toBe("2026-08-22T03:30:00.000Z");

    const midnight = await call("shukuyo", {
      chart_id: chartId,
      date: "2026-08-22",
      date_utc_offset: 9,
    });
    expect(midnight.structuredContent.day.has_time).toBe(false);
    expect(midnight.structuredContent.day.utc).toBe("2026-08-21T15:00:00.000Z");
    expect(midnight.content[0].text).toContain("時刻の指定が無いので 0 時で見ています");
  });

  it("date は過去も未来も受ける（日記の日付を後から引き直せる）", async () => {
    const chartId = await saveShukuyoChart();
    for (const date of ["1999-12-31", "2026-08-22", "2087-03-01"]) {
      const result = await call("shukuyo", { chart_id: chartId, date });
      expect(result.isError, date).toBeUndefined();
      expect(result.structuredContent.day.date).toBe(date);
    }
  });

  it("その日の宿の切り替わりを時刻つきで並べる", async () => {
    const chartId = await saveShukuyoChart();

    // 偽エンジンの「通過」は格子で作る。窓（2026-08-22 00:00 UTC から 1 日）に 2 本入るようにする
    const windowStartJd = fakeJd(2026, 8, 22, 0);
    // 刻みは 1/4 日の倍数にそろえる（浮動小数のちょうどを踏まないように）
    engine.moonAnchorJd = windowStartJd + 0.25;
    engine.moonPeriod = 0.5;
    engine.crossCalls.length = 0;

    const result = await call("shukuyo", { chart_id: chartId, date: "2026-08-22" });
    expect(result.isError).toBeUndefined();

    const changes = result.structuredContent.day.changes;
    expect(changes).toHaveLength(2);
    // 0.25 日 = 06:00、0.75 日 = 18:00
    expect(changes[0].utc).toBe("2026-08-22T06:00:00.000Z");
    expect(changes[1].utc).toBe("2026-08-22T18:00:00.000Z");
    // 窓の頭の月は 60°＝觜宿。そこから 1 宿ずつ進む
    expect(changes[0].from.name).toBe("觜宿");
    expect(changes[0].to.name).toBe("参宿");
    expect(changes[1].from.name).toBe("参宿");
    expect(changes[1].to.name).toBe("井宿");

    const text: string = result.content[0].text;
    expect(text).toContain("□ この日の宿の切り替わり（UTC の暦の 0 時〜24 時）");
    expect(text).toContain("2026-08-22 06:00 UTC 觜宿 → 参宿（しんしゅく・Ardra・6）");

    // 探すのは「サイデリアルの境界＋アヤナムシャ」＝トロピカルの目標黄経
    const targets = engine.crossCalls
      .filter((cross) => cross.kind === "moon")
      .map((cross) => cross.targetLon);
    expect(targets[0]).toBeCloseTo(normalizeDegree(5 * (360 / 27) + DAY_AYANAMSA), 9);
    expect(targets[1]).toBeCloseTo(normalizeDegree(6 * (360 / 27) + DAY_AYANAMSA), 9);
  });

  it("切り替わらない日は「変わりません」と言う", async () => {
    const chartId = await saveShukuyoChart();
    // 既定の偽エンジンは 27.32 日周期なので、1 日の窓には 1 本も入らない
    const result = await call("shukuyo", { chart_id: chartId, date: "2026-08-22" });
    expect(result.structuredContent.day.changes).toEqual([]);
    expect(result.content[0].text).toContain("この 24 時間のうちに宿は変わりません");
  });

  it("出生データも出生時のアヤナムシャも返事に出さない", async () => {
    const chartId = await saveShukuyoChart();
    const result = await call("shukuyo", { chart_id: chartId, date: "2026-08-22" });

    const text: string = result.content[0].text;
    const json = JSON.stringify(result.structuredContent);
    for (const secret of ["2023", "03-14", "10:00", "35.6895", "139.6917"]) {
      expect(text, secret).not.toContain(secret);
      expect(json, secret).not.toContain(secret);
    }
    expect(Object.keys(result.structuredContent)).not.toContain("birth");

    // 出生時のアヤナムシャは伏せる（50″/年で動くので、値そのものが生まれた年月の目盛りになる）
    expect(text).not.toContain("20.23");
    expect(json).not.toContain("20.23");
    expect(Object.keys(result.structuredContent.natal)).not.toContain("ayanamsa");
    // 日運のぶんは出してよい（呼び出した側が日付を指定しているので）
    expect(text).toContain("24.2292");
  });

  it("生年月日＋出生時刻の直接指定でも引ける（登録は要らない）", async () => {
    const result = await call("shukuyo", {
      year: 2023,
      month: 3,
      day: 14,
      hour: 10,
      minute: 0,
      utc_offset: -7,
      date: "2026-08-22",
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text.split("\n")[1]).toBe("出生データ: 直接指定（値は返事に出しません）");
    // 台帳を通した場合とまったく同じ宿（違うのは出どころだけ）
    expect(text).toContain("亢宿（こうしゅく・Swati・15）");
    expect(result.structuredContent.source).toBe("direct");
    expect(Object.keys(result.structuredContent)).not.toContain("chart_id");
    expect(Object.keys(result.structuredContent)).not.toContain("label");

    // 直接指定でも出生データは返事に出さない
    expect(text).not.toContain("2023");
    expect(JSON.stringify(result.structuredContent)).not.toContain("2023");

    // 分まで jd に溶けている ―― 1 分ずらすと偽エンジンの「出生の瞬間」から外れて別の宿になる
    // （見本の分が 0 になったぶん、時刻の取りこぼしはここで見張る）
    const oneMinuteLater = await call("shukuyo", {
      year: 2023,
      month: 3,
      day: 14,
      hour: 10,
      minute: 1,
      utc_offset: -7,
      date: "2026-08-22",
    });
    expect(oneMinuteLater.isError).toBeUndefined();
    expect(oneMinuteLater.structuredContent.natal.shuku.name).not.toBe("亢宿");
  });

  it("時刻不明は受けない（year / month / day だけでは断る）", async () => {
    for (const partial of [
      { year: 2023, month: 3, day: 14 },
      { year: 2023, month: 3, day: 14, hour: 10 },
      { month: 3, day: 14, hour: 10, minute: 0 },
      { hour: 10, minute: 0 },
    ]) {
      const result = await call("shukuyo", partial);
      expect(result.isError, JSON.stringify(partial)).toBe(true);
      expect(result.content[0].text).toContain("5 つをそろえて指定してください");
      expect(result.content[0].text).toContain("時刻の分からない出生では引けません");
    }

    // utc_offset だけは省いてよい（UTC 扱い）
    const utcBirth = await call("shukuyo", {
      year: 2023,
      month: 3,
      day: 14,
      hour: 10,
      minute: 0,
    });
    expect(utcBirth.isError).toBeUndefined();
  });

  it("chart_id と直接指定はどちらか一方（両方・どちらも無しは断る）", async () => {
    const chartId = await saveShukuyoChart();

    const both = await call("shukuyo", {
      chart_id: chartId,
      year: 2023,
      month: 3,
      day: 14,
      hour: 10,
      minute: 0,
    });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain("どちらか一方にしてください");

    const neither = await call("shukuyo", {});
    expect(neither.isError).toBe(true);
    expect(neither.content[0].text).toContain(
      "chart_id か year / month / day / hour / minute を指定してください",
    );

    // date だけでも「誰の宿か」が決まらないので同じ断り
    const dateOnly = await call("shukuyo", { date: "2026-08-22" });
    expect(dateOnly.isError).toBe(true);
    expect(dateOnly.content[0].text).toContain("chart_id か year / month / day / hour / minute");
  });

  it("知らない ID・他人のチャート・出生データの無い古い登録を断る", async () => {
    const unknown = await call("shukuyo", { chart_id: "nosuchid" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("チャート nosuchid が見つかりませんでした");

    const chartId = await saveShukuyoChart();
    const other: AstroContext = { ...context, auth: FRIEND };
    const peek = await call("shukuyo", { chart_id: chartId }, other);
    expect(peek.isError).toBe(true);
    expect(peek.content[0].text).toContain("見つかりませんでした");

    const legacy = await call("shukuyo", { chart_id: putLegacyChart() });
    expect(legacy.isError).toBe(true);
    expect(legacy.content[0].text).toContain("このチャートには出生データが入っていません");
    expect(legacy.content[0].text).toContain("delete_chart で消して save_chart で登録し直す");
    // 断るだけで宿は 1 つも出さない
    expect(legacy.content[0].text).not.toContain("本命宿");
  });

  it("暦に無い日・壊れた date・未知の引数を断る", async () => {
    const chartId = await saveShukuyoChart();

    const badBirth = await call("shukuyo", {
      year: 2023,
      month: 2,
      day: 31,
      hour: 10,
      minute: 0,
    });
    expect(badBirth.isError).toBe(true);
    expect(badBirth.content[0].text).toContain("2023-02-31 は暦に存在しない日付です");

    const badDate = await call("shukuyo", { chart_id: chartId, date: "2026-02-30" });
    expect(badDate.isError).toBe(true);
    expect(badDate.content[0].text).toContain("2026-02-30 は暦に存在しない日付です");

    const shapeless = await call("shukuyo", { chart_id: chartId, date: "2026/08/22" });
    expect(shapeless.isError).toBe(true);
    expect(shapeless.content[0].text).toContain("date は");

    const badHour = await call("shukuyo", { chart_id: chartId, date: "2026-08-22 25:00" });
    expect(badHour.isError).toBe(true);
    expect(badHour.content[0].text).toContain("date の時刻が範囲を外れています");

    const badOffset = await call("shukuyo", { chart_id: chartId, date_utc_offset: 20 });
    expect(badOffset.isError).toBe(true);
    expect(badOffset.content[0].text).toContain("date_utc_offset は -14 以上 14 以下");

    // 綴り違いは黙って無視しない（許可キーはツール定義から作っている）
    const typo = await call("shukuyo", { chart_id: chartId, dates: "2026-08-22" });
    expect(typo.isError).toBe(true);
    expect(typo.content[0].text).toContain("未知の引数です: dates");
    expect(typo.content[0].text).toContain("date_utc_offset");
  });
});

describe("shukuyo_compat", () => {
  beforeEach(() => {
    stageShukuyoMoon();
  });

  it("宿名どうしで引ける（漢字・サンスクリット名・番号のどれでも）", async () => {
    const result = await call("shukuyo_compat", { a: "亢宿", b: "氐宿" });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain("宿曜の相性（三九の秘法）");
    expect(text).toContain("A: 宿名指定 亢宿（こうしゅく・Swati・15）");
    expect(text).toContain("B: 宿名指定 氐宿（ていしゅく・Vishakha・16）");
    expect(text).toContain("A → B: 距離 2 → 栄（えい） / 近距離 / 組 栄親");
    expect(text).toContain("B → A: 距離 27 → 親（しん） / 遠距離 / 組 栄親");
    expect(text).toContain("組: 栄親");

    const structured = result.structuredContent;
    expect(structured.kind).toBe("shukuyo_compat");
    expect(structured.a.source).toBe("name");
    expect(Object.keys(structured.a)).not.toContain("chart_id");
    expect(structured.a.shuku.number).toBe(15);
    expect(structured.b.shuku.number).toBe(16);
    expect(structured.a_to_b).toMatchObject({ distance: 2, name: "栄", group: "近" });
    expect(structured.b_to_a).toMatchObject({ distance: 27, name: "親", group: "遠" });
    expect(structured.pair).toBe("栄親");
    expect(structured.same).toBe(false);

    // 書き方が違っても同じ答え
    for (const pair of [
      { a: "亢", b: "氐" },
      { a: "Swati", b: "Vishakha" },
      { a: "swati", b: "visakha" },
      { a: "15", b: "16" },
    ]) {
      const same = await call("shukuyo_compat", pair);
      expect(same.isError, JSON.stringify(pair)).toBeUndefined();
      expect(same.structuredContent.a_to_b).toEqual(structured.a_to_b);
      expect(same.structuredContent.b_to_a).toEqual(structured.b_to_a);
    }
  });

  it("宿名だけなら天体計算を 1 回もしない（相手の出生データが要らない）", async () => {
    const before = engine.juldays.length;
    const result = await call("shukuyo_compat", { a: "Swati", b: "3" });
    expect(result.isError).toBeUndefined();
    expect(engine.juldays.length).toBe(before);
  });

  it("chart_id を渡すと台帳の本命宿を使う（宿名と混ぜてもよい）", async () => {
    const chartId = await saveShukuyoChart();
    const result = await call("shukuyo_compat", { a: chartId, b: "昴宿" });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain(`A: チャート 宿曜の見本（${chartId}） 亢宿（こうしゅく・Swati・15）`);
    expect(text).toContain("B: 宿名指定 昴宿（ぼうしゅく・Krittika・3）");

    const structured = result.structuredContent;
    expect(structured.a).toMatchObject({ source: "chart", chart_id: chartId, label: "宿曜の見本" });
    expect(structured.a.shuku.number).toBe(15);
    expect(structured.b.source).toBe("name");
    expect(structured.b.shuku.number).toBe(3);
    // 亢宿（14）→ 昴宿（2）は (2 − 14) mod 27 + 1 = 16 ＝ 壊・中距離・組 安壊
    expect(structured.a_to_b).toMatchObject({ distance: 16, name: "壊", group: "中", pair: "安壊" });
    expect(structured.b_to_a).toMatchObject({ distance: 13, name: "安", group: "中", pair: "安壊" });
  });

  it("両方 chart_id でもよい（同じチャートなら命）", async () => {
    const chartId = await saveShukuyoChart();
    const result = await call("shukuyo_compat", { a: chartId, b: chartId });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.same).toBe(true);
    expect(result.structuredContent.pair).toBe("命");
    expect(result.structuredContent.a_to_b).toMatchObject({ distance: 1, name: "命" });
    expect(result.content[0].text).toContain("組: 命（同じ宿）");
  });

  it("出生データは返事に出さない（chart_id で呼んでも）", async () => {
    const chartId = await saveShukuyoChart();
    const result = await call("shukuyo_compat", { a: chartId, b: "1" });

    const text: string = result.content[0].text;
    const json = JSON.stringify(result.structuredContent);
    for (const secret of ["2023", "03-14", "10:00", "35.6895", "139.6917", "20.23"]) {
      expect(text, secret).not.toContain(secret);
      expect(json, secret).not.toContain(secret);
    }
  });

  it("解釈は載せず、規約だけを名前で言う", async () => {
    const result = await call("shukuyo_compat", { a: "1", b: "10" });
    const text: string = result.content[0].text;
    expect(text).toContain("宿の意味・吉凶はこのサーバーに載っていません");
    expect(text).toContain("合算する根拠はありません");
    expect(text).toContain("基準点 Lahiri（SE_SIDM_LAHIRI）");
    expect(text).not.toContain("吉日");
    // 婁宿（0）→ 星宿（9）は距離 10 ＝ 業（中距離・組 業胎）
    expect(result.structuredContent.a_to_b).toMatchObject({
      distance: 10,
      name: "業",
      pair: "業胎",
    });
  });

  it("読めない宿名は、何を渡せばよいかを添えて断る", async () => {
    const unknown = await call("shukuyo_compat", { a: "亢宿", b: "そんな宿はない" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("b の宿として読めませんでした");
    expect(unknown.content[0].text).toContain("1〜27 の番号");

    // 番号の外れも同じ断り（宿は 27 まで）
    const outOfRange = await call("shukuyo_compat", { a: "28", b: "1" });
    expect(outOfRange.isError).toBe(true);
    expect(outOfRange.content[0].text).toContain("a の宿として読めませんでした");
  });

  it("出生データの無い古い登録は、どちらの側でも登録し直しを案内する", async () => {
    const legacy = putLegacyChart();
    const asA = await call("shukuyo_compat", { a: legacy, b: "亢宿" });
    expect(asA.isError).toBe(true);
    expect(asA.content[0].text).toContain(`a に指定したチャート ${legacy}`);
    expect(asA.content[0].text).toContain("出生データが入っていません");
    expect(asA.content[0].text).toContain("宿名を直接指定");

    const asB = await call("shukuyo_compat", { a: "亢宿", b: legacy });
    expect(asB.isError).toBe(true);
    expect(asB.content[0].text).toContain(`b に指定したチャート ${legacy}`);
  });

  it("他人のチャート ID は宿名として読もうとして断る（棚の中身は覗かせない）", async () => {
    const chartId = await saveShukuyoChart();
    const other: AstroContext = { ...context, auth: FRIEND };
    const peek = await call("shukuyo_compat", { a: chartId, b: "亢宿" }, other);
    expect(peek.isError).toBe(true);
    // 「見つからない」ではなく「宿名として読めない」＝登録の有無を漏らさない
    expect(peek.content[0].text).toContain("a の宿として読めませんでした");
  });

  it("a / b は必須、未知の引数は断る", async () => {
    const noB = await call("shukuyo_compat", { a: "亢宿" });
    expect(noB.isError).toBe(true);
    expect(noB.content[0].text).toContain("b は必須です");

    const empty = await call("shukuyo_compat", { a: "  ", b: "亢宿" });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain("a は必須です");

    const typo = await call("shukuyo_compat", { a: "亢宿", b: "氐宿", orb: 5 });
    expect(typo.isError).toBe(true);
    expect(typo.content[0].text).toContain("未知の引数です: orb");
  });
});

// ---------------------------------------------------------------------------
// 年間概要
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 四柱推命
// ---------------------------------------------------------------------------

/**
 * 四柱推命の見本（2022-11-30 10:00・UTC−8）。
 *
 * **ChatGPT の公開日**を借りています ―― 時刻の 10 時は架空、時差は米国太平洋時間（PST）。
 * 人の誕生日と紛れない公開された日付を見本にする、という取り決めです
 * （1986-12-29 は数秘の境界事例として別の意味でリポにあるので、時刻つきの命式とは並べません）。
 * 返事に混じったら "2022" や "11-30" ですぐ見つかります。
 */
const FOUR_PILLARS_BIRTH = {
  ...BIRTH,
  label: "四柱の見本",
  year: 2022,
  month: 11,
  day: 30,
  hour: 10,
  minute: 0,
  utc_offset: -8,
};

/** FOUR_PILLARS_BIRTH の出生の瞬間（現地 10:00・UTC−8 → UTC では同じ日の 18:00） */
const FP_NATAL_JD = fakeJd(2022, 11, 30, 10 + 8);

/**
 * 出生の瞬間に置く太陽黄経（立冬 225° と大雪 255° のあいだ＝亥月。実物も 11 月末は 248° 前後）。
 *
 * 端数まで決め打ちなのは、**10 分ちがいの出生で大運が 1 文字も変わらない**ことを見るため
 * ―― 節入りまでの日数（小数 1 桁）も起運（0.1 年）も、この黄経なら境から 0.028 日ぶん離れる。
 */
const FP_NATAL_SUN = 247.98;

/**
 * 偽エンジンの太陽を「動かす」。
 *
 * 素の偽エンジンは太陽を止めたまま（jd に依らず同じ黄経）で、通過だけ 365.24 日の格子で返すので、
 * 「太陽の位置」と「節入りの時刻」が食い違い、配線の検算（前の節入り ≦ 出生 ＜ 次の節入り）に
 * 引っかかってしまう。ここで回帰年 1 周の等速太陽に差し替えると、両方が辻褄の合う形になる。
 */
function stageMovingSun(): void {
  engine.sunMotionAnchorJd = FP_NATAL_JD - (FP_NATAL_SUN / 360) * FAKE_TROPICAL_YEAR;
}

/** 等速太陽での「黄経 x° から y° まで」の日数 */
function fpDays(degrees: number): number {
  return (degrees / 360) * FAKE_TROPICAL_YEAR;
}

async function saveFourPillarsChart(): Promise<string> {
  const saved = await call("save_chart", FOUR_PILLARS_BIRTH);
  expect(saved.isError).toBeUndefined();
  return saved.structuredContent.chart_id as string;
}

/**
 * 深い比較のために数値の埃を落とす。
 *
 * 配線側は太陽黄経を wasm（偽エンジン）経由で受け取るので 277.5 が 277.50000000019 になり、
 * その埃が起運の丸め（小数 4 桁）の境目を踏むことがある。命式の中身を突き合わせたいだけなので、
 * 小数 3 桁で切りそろえてから比べる。
 */
function roundDeep<T>(value: T, digits = 3): T {
  if (typeof value === "number") {
    const scale = 10 ** digits;
    return (Math.round(value * scale) / scale) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => roundDeep(item, digits)) as unknown as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, roundDeep(item, digits)]),
    ) as unknown as T;
  }
  return value;
}

/** 配線と同じ道具立てで、期待する命式を純関数から直に組む */
function expectedNatal(): FourPillarsResult {
  return calculateFourPillars({
    moment: { year: 2022, month: 11, day: 30, hour: 10, minute: 0, utcOffset: -8 },
    sun_longitude: FP_NATAL_SUN,
    term: {
      days_since_previous: fpDays(FP_NATAL_SUN - 225),
      days_until_next: fpDays(255 - FP_NATAL_SUN),
    },
  });
}

describe("four_pillars", () => {
  beforeEach(() => {
    stageMovingSun();
  });

  it("預かっている出生データから命式と、指定日の流年・月運・日運を返す", async () => {
    const chartId = await saveFourPillarsChart();
    const result = await call("four_pillars", {
      chart_id: chartId,
      date: "2026-08-22",
      date_utc_offset: 9,
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain("四柱推命（子平・日界 0 時・節気は太陽黄経・時刻の補正なし）");
    expect(text).toContain(`チャート: 四柱の見本（${chartId}）`);

    // 2022-11-30 10:00 ＝ 壬寅年・辛亥月（立冬から）・丁亥日・乙巳時
    expect(text).toContain("■ 四柱推命（命式）");
    expect(text).toContain("壬(陽水)");
    expect(text).toContain("日主: 丁（陰火）");
    expect(text).toContain("空亡（丁亥日＝甲申旬）: 午・未");
    expect(text).toContain("節入り: 立冬から 23.3 日／次の大雪まで 7.1 日");
    // 起運は 0.1 年まで（月数は起運 × 12 を整数へ）
    expect(text).toContain("大運（順行・男性）: 起運 2.4 年（約 29 か月／もとになった日数 7.1 日 ÷ 3）");
    expect(text).toContain("大運（逆行・女性）: 起運 7.8 年（約 94 か月／もとになった日数 23.3 日 ÷ 3）");

    // 対象日は呼び出し側が指定した日なので、そのまま書く
    expect(text).toContain("■ 対象日 2026-08-22（UTC+9 の暦）");
    expect(text).toContain("■ 流年・月運・日運（2026-08-22）");
    expect(text).toContain("日主 丁 から見た値です");

    const structured = result.structuredContent;
    expect(structured.kind).toBe("four_pillars");
    expect(structured.source).toBe("chart");
    expect(structured.chart_id).toBe(chartId);
    expect(structured.label).toBe("四柱の見本");

    // 命式は純関数の答えそのまま（＝配線が moment / 太陽黄経 / 節入りを正しく渡している）
    expect(roundDeep(structured.natal)).toEqual(roundDeep(expectedNatal()));
    expect(structured.natal.sun_longitude).toBeCloseTo(FP_NATAL_SUN, 6);
    expect(structured.natal.pillars.year.ganzhi).toBe("壬寅");
    expect(structured.natal.pillars.month.ganzhi).toBe("辛亥");
    expect(structured.natal.pillars.day.ganzhi).toBe("丁亥");
    expect(structured.natal.pillars.hour.ganzhi).toBe("乙巳");
    expect(structured.natal.day_master).toEqual({ stem: "丁", element: "火", yin_yang: "陰" });
    expect(structured.natal.void).toEqual({ decade: "甲申旬", branches: ["午", "未"] });
    // 大運は性別を預からないので両向き 10 柱ずつ
    expect(structured.natal.luck_cycles.forward.pillars).toHaveLength(10);
    expect(structured.natal.luck_cycles.backward.pillars).toHaveLength(10);
    expect(structured.natal.luck_cycles.forward.applies_to).toBe("男性");
    expect(structured.natal.luck_cycles.backward.applies_to).toBe("女性");

    expect(structured.target).toMatchObject({
      date: "2026-08-22",
      utc: "2026-08-21T15:00:00.000Z",
      local: "2026-08-22 00:00",
      utc_offset: 9,
      is_now: false,
      has_time: false,
    });
    expect(structured.date_fortune.year.ganzhi).toBe("丙午");
    expect(structured.date_fortune.month.ganzhi).toBe("丙申");
    expect(structured.date_fortune.day.ganzhi).toBe("戊辰");
    expect(structured.date_fortune.day_master).toBe("丁");
    // 時刻を指定していないので時運は出さない
    expect(structured.date_fortune.hour).toBeUndefined();
  });

  it("節入りは太陽黄経で挟んで探す（前の節 ≦ 出生 ＜ 次の節）", async () => {
    const chartId = await saveFourPillarsChart();
    engine.crossCalls.length = 0;

    const result = await call("four_pillars", { chart_id: chartId, date: "2026-08-22" });
    expect(result.isError).toBeUndefined();

    // 太陽の通過は 2 回だけ（次の節＝小寒 285°、前の節＝大雪 255°）
    const sunCrosses = engine.crossCalls.filter((cross) => cross.kind === "sun");
    expect(sunCrosses).toHaveLength(2);
    expect(sunCrosses[0]).toMatchObject({ targetLon: 255 });
    expect(sunCrosses[0].startJd).toBeCloseTo(FP_NATAL_JD, 9);
    // 前の節は 40 日戻ってから探す（節の帯は 29〜32 日なので必ず 1 本だけ入る）
    expect(sunCrosses[1]).toMatchObject({ targetLon: 225 });
    expect(sunCrosses[1].startJd).toBeCloseTo(FP_NATAL_JD - 40, 9);

    // 起運は「節入りまでの日数 ÷ 3」を小数 1 桁で
    const cycles = result.structuredContent.natal.luck_cycles;
    expect(cycles.forward.days_to_term).toBeCloseTo(fpDays(255 - FP_NATAL_SUN), 1);
    expect(cycles.backward.days_to_term).toBeCloseTo(fpDays(FP_NATAL_SUN - 225), 1);
    expect(cycles.forward.start_age).toBe(2.4);
    expect(cycles.forward.start_months).toBe(29);
    expect(cycles.backward.start_age).toBe(7.8);
    expect(cycles.backward.start_months).toBe(94);
  });

  it("節の帯として辻褄が合わない答えは断る（壊れた wrapper の受け止め）", async () => {
    const chartId = await saveFourPillarsChart();
    // 太陽の動きだけ素に戻すと、通過は 365.24 日の格子＝出生を挟まなくなる
    engine.sunMotionAnchorJd = null;

    const result = await call("four_pillars", { chart_id: chartId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("節入り（月柱の境）を計算できませんでした");
    // 断り文に jd（＝出生の瞬間そのもの）は出さない
    expect(result.content[0].text).not.toContain("24");
  });

  it("採った規約を名前で返す（日界 0 時・時刻補正なし・陰干逆行・月律分野表は採らない）", async () => {
    const chartId = await saveFourPillarsChart();
    const result = await call("four_pillars", { chart_id: chartId });

    const text: string = result.content[0].text;
    expect(text).toContain("規約: 日界 0 時／時刻の補正なし／節気は太陽黄経");
    expect(text).toContain("蔵干は本気・中気・余気を全列挙（月律分野表は採らない）");
    expect(text).toContain("十二運は陰干逆行");
    expect(text).toContain("空亡は日柱から");
    expect(text).toContain("大運は順逆の両方・起運は 0.1 年まで（流派の丸めは採らない）");
    // 読みは呼び出した側の仕事
    expect(text).toContain("通変星・十二運・蔵干・空亡・大運の意味はこのサーバーに載っていません");
    expect(text).toContain("合算する根拠はありません");

    const conventions = result.structuredContent.natal.conventions;
    expect(conventions.day_boundary).toContain("日界 0 時");
    expect(conventions.hidden_stems).toContain("月律分野表");
    expect(conventions.twelve_stages).toContain("陰干逆行");
    expect(conventions.luck_cycles).toContain("順行・逆行の両方");
    // 起運の精度も名前つきの規約として返す（流派の丸めとは別物、と言い切っておく）
    expect(conventions.luck_start_precision).toContain("0.1 年");
    expect(conventions.luck_start_precision).toContain("約 7 時間の粗さ");
    expect(result.structuredContent.date_fortune.conventions.year_pillar).toContain("立春");
  });

  it("date に時刻を付けると時運（時柱）まで、付けなければ三柱", async () => {
    const chartId = await saveFourPillarsChart();

    const withTime = await call("four_pillars", {
      chart_id: chartId,
      date: "2026-08-22 12:30",
      date_utc_offset: 9,
    });
    expect(withTime.structuredContent.target.has_time).toBe(true);
    expect(withTime.structuredContent.target.utc).toBe("2026-08-22T03:30:00.000Z");
    expect(withTime.structuredContent.date_fortune.hour).toBeDefined();
    expect(withTime.structuredContent.date_fortune.hour.label).toBe("時運");
    expect(withTime.structuredContent.date_fortune.date).toMatchObject({
      year: 2026,
      month: 8,
      day: 22,
      hour: 12,
      minute: 30,
      utc_offset: 9,
    });
    expect(withTime.content[0].text).toContain("■ 流年・月運・日運（2026-08-22 12:30）");

    const dateOnly = await call("four_pillars", {
      chart_id: chartId,
      date: "2026-08-22",
      date_utc_offset: 9,
    });
    expect(dateOnly.structuredContent.target.has_time).toBe(false);
    expect(dateOnly.structuredContent.date_fortune.hour).toBeUndefined();
    expect(dateOnly.content[0].text).toContain("時刻の指定が無いので 0 時で見ています＝時運は出しません");
  });

  it("date を省くと今で見る（date_utc_offset で暦が変わる）。過去も未来も受ける", async () => {
    const chartId = await saveFourPillarsChart();

    // 現在は 2026-08-20 02:15 UTC
    const now = await call("four_pillars", { chart_id: chartId });
    expect(now.structuredContent.target.date).toBe("2026-08-20");
    expect(now.structuredContent.target.is_now).toBe(true);
    // 「今」は時刻を持っているので時運も出る
    expect(now.structuredContent.date_fortune.hour).toBeDefined();
    expect(now.content[0].text).toContain("（現在時刻）");

    // UTC-9 の土地ではまだ 8/19
    const shifted = await call("four_pillars", { chart_id: chartId, date_utc_offset: -9 });
    expect(shifted.structuredContent.target.date).toBe("2026-08-19");
    expect(shifted.content[0].text).toContain("（UTC-9 の暦）");

    for (const date of ["1999-12-31", "2087-03-01"]) {
      const result = await call("four_pillars", { chart_id: chartId, date });
      expect(result.isError, date).toBeUndefined();
      expect(result.structuredContent.target.date).toBe(date);
    }
  });

  it("生年月日＋出生時刻の直接指定でも引ける（登録は要らない）", async () => {
    const result = await call("four_pillars", {
      year: 2022,
      month: 11,
      day: 30,
      hour: 10,
      minute: 0,
      utc_offset: -8,
      date: "2026-08-22",
      date_utc_offset: 9,
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text.split("\n")[1]).toBe("出生データ: 直接指定（値は返事に出しません）");
    // 台帳を通した場合とまったく同じ命式（違うのは出どころだけ）
    expect(roundDeep(result.structuredContent.natal)).toEqual(roundDeep(expectedNatal()));
    expect(result.structuredContent.source).toBe("direct");
    expect(Object.keys(result.structuredContent)).not.toContain("chart_id");
    expect(Object.keys(result.structuredContent)).not.toContain("label");

    // 直接指定でも出生データは返事に出さない
    expect(text).not.toContain("2022");
    expect(JSON.stringify(result.structuredContent)).not.toContain("2022");
  });

  it("23 時台の生まれには日界の代替 2 通りを添える", async () => {
    const result = await call("four_pillars", {
      year: 2022,
      month: 11,
      day: 30,
      hour: 23,
      minute: 10,
      utc_offset: -8,
      date: "2026-08-22",
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain("23 時台の生まれです。既定は日界 0 時。ほかの規約なら:");
    expect(text).toContain("日界23時");
    expect(text).toContain("夜子時");

    const alternatives = result.structuredContent.natal.alternatives;
    expect(alternatives).toHaveLength(2);
    expect(alternatives[0].name).toBe("日界23時");
    // 既定（日界 0 時）の日柱は丁亥。翌日（2022-12-01）は戊子
    expect(result.structuredContent.natal.pillars.day.ganzhi).toBe("丁亥");
    expect(alternatives[0].day.ganzhi).toBe("戊子");
    expect(alternatives[1].name).toBe("夜子時");
    expect(alternatives[1].day.ganzhi).toBe("丁亥");
    // どちらの代替も時柱は翌日の日干（戊）から五鼠遁した子刻＝壬子
    expect(alternatives[0].hour.ganzhi).toBe("壬子");
    expect(alternatives[1].hour.ganzhi).toBe("壬子");
  });

  it("10 分ちがいの出生でも大運は 1 文字も変わらない（起運から出生時刻を逆算させない）", async () => {
    const born = (hour: number, minute: number) =>
      call("four_pillars", {
        year: 2022,
        month: 11,
        day: 30,
        hour,
        minute,
        utc_offset: -8,
        date: "2026-08-22",
      });

    const a = await born(10, 0);
    const b = await born(10, 10);
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();

    // 別の瞬間であることは太陽黄経で分かる（こちらは月柱を決める派生値なので出している）
    expect(a.structuredContent.natal.sun_longitude).not.toBe(
      b.structuredContent.natal.sun_longitude,
    );

    // それでも大運はまるごと同じ ―― 起運（0.1 年）も月数も、もとになった日数（0.1 日）も
    expect(a.structuredContent.natal.luck_cycles).toEqual(
      b.structuredContent.natal.luck_cycles,
    );
    expect(a.structuredContent.natal.luck_cycles.forward.start_age).toBe(2.4);
    expect(a.structuredContent.natal.luck_cycles.forward.start_months).toBe(29);
    expect(a.structuredContent.natal.luck_cycles.backward.start_age).toBe(7.8);
    expect(a.structuredContent.natal.luck_cycles.backward.start_months).toBe(94);
    // 0.1 年より細かい桁は 1 つも出さない（4 桁で返していたころは 26 秒の精度だった）
    const json = JSON.stringify(a.structuredContent.natal.luck_cycles);
    expect(json).not.toMatch(/\d+\.\d\d/);
  });

  it("時辰の境ぎわは印だけ返す（境からの分数は出さない）", async () => {
    // 10:59 は巳刻（9:00〜11:00）の終わり際＝次の午刻まで 1 分
    const edge = await call("four_pillars", {
      year: 2022,
      month: 11,
      day: 30,
      hour: 10,
      minute: 59,
      utc_offset: -8,
    });
    expect(edge.structuredContent.natal.hour_boundary).toEqual({ side: "次", within_minutes: 15 });
    expect(edge.content[0].text).toContain("時辰の境（次の午刻）まで 15 分以内");
    // 「あと 1 分」とは書かない（時支と分数が揃うと出生時刻が分単位で復元できてしまう）
    expect(JSON.stringify(edge.structuredContent)).not.toContain("59");

    // 境から離れていれば印そのものが出ない
    const middle = await call("four_pillars", {
      year: 2022,
      month: 11,
      day: 30,
      hour: 10,
      minute: 0,
      utc_offset: -8,
    });
    expect(middle.structuredContent.natal.hour_boundary).toBeNull();
    expect(middle.content[0].text).not.toContain("時辰の境");
  });

  it("時刻不明は受けない（year / month / day だけでは断る）", async () => {
    for (const partial of [
      { year: 2022, month: 11, day: 30 },
      { year: 2022, month: 11, day: 30, hour: 10 },
      { month: 11, day: 30, hour: 10, minute: 0 },
      { hour: 10, minute: 0 },
    ]) {
      const result = await call("four_pillars", partial);
      expect(result.isError, JSON.stringify(partial)).toBe(true);
      expect(result.content[0].text).toContain("5 つをそろえて指定してください");
      expect(result.content[0].text).toContain("時柱は出生時刻の 2 時間ごとの区切りで決まるので");
      expect(result.content[0].text).toContain("時刻の分からない出生では引けません");
    }

    // utc_offset だけは省いてよい（UTC 扱い）
    const utcBirth = await call("four_pillars", {
      year: 2022,
      month: 11,
      day: 30,
      hour: 10,
      minute: 0,
    });
    expect(utcBirth.isError).toBeUndefined();
  });

  it("chart_id と直接指定はどちらか一方（両方・どちらも無しは断る）", async () => {
    const chartId = await saveFourPillarsChart();

    const both = await call("four_pillars", {
      chart_id: chartId,
      year: 2022,
      month: 11,
      day: 30,
      hour: 10,
      minute: 0,
    });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain("どちらか一方にしてください");
    expect(both.content[0].text).not.toContain("命式");

    const neither = await call("four_pillars", {});
    expect(neither.isError).toBe(true);
    expect(neither.content[0].text).toContain(
      "chart_id か year / month / day / hour / minute を指定してください",
    );

    // date だけでは「誰の命式か」が決まらないので同じ断り
    const dateOnly = await call("four_pillars", { date: "2026-08-22" });
    expect(dateOnly.isError).toBe(true);
    expect(dateOnly.content[0].text).toContain("chart_id か year / month / day / hour / minute");
  });

  it("知らない ID・他人のチャート・出生データの無い古い登録を断る", async () => {
    const unknown = await call("four_pillars", { chart_id: "nosuchid" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("チャート nosuchid が見つかりませんでした");

    const chartId = await saveFourPillarsChart();
    const other: AstroContext = { ...context, auth: FRIEND };
    const peek = await call("four_pillars", { chart_id: chartId }, other);
    expect(peek.isError).toBe(true);
    expect(peek.content[0].text).toContain("見つかりませんでした");

    const legacy = await call("four_pillars", { chart_id: putLegacyChart() });
    expect(legacy.isError).toBe(true);
    expect(legacy.content[0].text).toContain("このチャートには出生データが入っていません");
    expect(legacy.content[0].text).toContain("delete_chart で消して save_chart で登録し直す");
    // 断るだけで命式は 1 柱も出さない
    expect(legacy.content[0].text).not.toContain("日主");
  });

  it("出生データそのものは返事に出さない", async () => {
    const chartId = await saveFourPillarsChart();
    const result = await call("four_pillars", {
      chart_id: chartId,
      date: "2026-08-22",
      date_utc_offset: 9,
    });

    const text: string = result.content[0].text;
    const json = JSON.stringify(result.structuredContent);
    // 生年月日・出生時刻・出生地の値（見つけやすい数にしてある）
    for (const secret of ["2022", "11-30", "10:00", "35.6895", "139.6917"]) {
      expect(text, secret).not.toContain(secret);
      expect(json, secret).not.toContain(secret);
    }
    expect(Object.keys(result.structuredContent)).not.toContain("birth");
    expect(json).not.toContain('"birth"');
    // 出生の瞬間のユリウス日も出さない（日時そのものなので）
    expect(json).not.toContain(String(Math.floor(FP_NATAL_JD)));
    // 出生の時差（UTC−8）も出さない。返事に出る utc_offset は「対象日を見た暦」のぶんだけ
    expect(text).not.toContain("UTC-8");
    expect(result.structuredContent.target.utc_offset).toBe(9);
    expect(Object.keys(result.structuredContent.natal)).not.toContain("utc_offset");
  });

  it("暦に無い日・壊れた date・未知の引数を断る", async () => {
    const chartId = await saveFourPillarsChart();

    const badBirth = await call("four_pillars", {
      year: 2022,
      month: 2,
      day: 31,
      hour: 10,
      minute: 0,
    });
    expect(badBirth.isError).toBe(true);
    expect(badBirth.content[0].text).toContain("2022-02-31 は暦に存在しない日付です");

    const badDate = await call("four_pillars", { chart_id: chartId, date: "2026-02-30" });
    expect(badDate.isError).toBe(true);
    expect(badDate.content[0].text).toContain("2026-02-30 は暦に存在しない日付です");

    const shapeless = await call("four_pillars", { chart_id: chartId, date: "2026/08/22" });
    expect(shapeless.isError).toBe(true);
    expect(shapeless.content[0].text).toContain("date は");

    const badHour = await call("four_pillars", { chart_id: chartId, date: "2026-08-22 25:00" });
    expect(badHour.isError).toBe(true);
    expect(badHour.content[0].text).toContain("date の時刻が範囲を外れています");

    const badOffset = await call("four_pillars", { chart_id: chartId, date_utc_offset: 20 });
    expect(badOffset.isError).toBe(true);
    expect(badOffset.content[0].text).toContain("date_utc_offset は -14 以上 14 以下");

    // 綴り違いは黙って無視しない（許可キーはツール定義から作っている）
    const typo = await call("four_pillars", { chart_id: chartId, dates: "2026-08-22" });
    expect(typo.isError).toBe(true);
    expect(typo.content[0].text).toContain("未知の引数です: dates");
    expect(typo.content[0].text).toContain("date_utc_offset");
  });
});

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
    const chartId = await saveDefaultChart();

    const ok = await call("progressions", { chart_id: chartId, year: 2024, month: 2, day: 29 });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toContain("対象日: 2024-02-29");

    for (const date of INVALID) {
      const ng = await call("progressions", { chart_id: chartId, ...date });
      expect(ng.isError).toBe(true);
      expect(ng.content[0].text).toContain("は暦に存在しない日付です");
    }
  });

  it("暦に無い出生日は台帳に入らない＝預かる出生データも常に実在日", async () => {
    for (const date of INVALID) {
      expect((await call("save_chart", { ...BIRTH, ...date })).isError).toBe(true);
    }
    expect((await call("list_charts")).structuredContent.charts).toEqual([]);
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
 * - 2026-08-22 出生データを台帳で預かる改定で更新（save_chart / list_charts / get_chart /
 *   delete_chart の description と、progressions（chart_id を取るようになり required も付いた）。
 *   transit 系・リターン・yearly_overview・transit_events・update_default_location は動かしていない）
 * - 2026-08-22 calculate_numerology（12 本目）を末尾に追加で更新
 *   （既存 11 本は 1 文字も動かしていない）
 * - 2026-08-22 calculate_numerology を chart_id / 生年月日の直接指定の両受けにして更新
 *   （公開層から移してきたぶん。title・description と、year / month / day の 3 引数が増え、
 *   required が外れた。既存 11 本は 1 文字も動かしていない）
 * - 2026-08-22 宿曜の shukuyo / shukuyo_compat（13・14 本目）を末尾に追加で更新
 *   （既存 12 本は 1 文字も動かしていない）
 * - 2026-08-22 四柱推命の four_pillars（15 本目）を末尾に追加で更新
 *   （既存 14 本は 1 文字も動かしていない）
 * - 2026-08-22 シナストリーの synastry（16 本目）を末尾に追加で更新
 *   （既存 15 本は 1 文字も動かしていない）
 * - 2026-08-22 九星気学の kyusei（17 本目）を末尾に追加で更新
 *   （既存 16 本は 1 文字も動かしていない）
 */
const FROZEN_ASTRO_TOOLS = [
  {
    "name": "save_chart",
    "title": "出生図を登録する",
    "description": "出生データからネイタルチャート（出生図）を計算し、chart_id を付けて保存する。以後は chart_id だけでトランジットなどを引ける。\n保存されるのは計算結果の座標（天体の黄経と速度・ハウスカスプ・ASC/MC・ラベル・ハウス方式）と、**渡された出生データそのもの**（年月日・時刻・時差・緯度経度）。出生データは誕生日から引く占術と progressions のために預かるもので、この鍵の台帳にだけ入り、**どのツールの返事にも出さない**（delete_chart で消える）。\nハウス方式を変えて計算し直したいときは、delete_chart で消してからもう一度このツールを呼ぶ（同じ chart_id への上書き登録は無い）。\n日時は**出生地の現地時刻**で渡し、utc_offset にその土地の時差を書く（日本は 9）。緯度・経度は北緯・東経が正、南緯・西経が負。\ndefault_lat / default_lng は「いつもの場所」（現在の居住地など）で、後々のリターン計算で使う。分からなければ省略してよい。",
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
    "description": "この URL に登録されているチャートの一覧を返す（chart_id・ラベル・ハウス方式・「いつもの場所」・出生データを預かっているか・登録日時）。transit を呼ぶ前に chart_id を確かめたいときに使う。出生データは「あり / なし」だけを返し、値そのものは出さない。",
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
    "description": "save_chart で登録したネイタルチャート（出生図）を chart_id から読み直す。返るのは (1) ネイタル天体の星座・度数・逆行と在ハウス、(2) ASC / MC とハウスカスプ、(3) **出生図の中のアスペクト**（ネイタル内アスペクト。10 天体＋ASC / MC の総当たり、メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション）。\n保存済みの座標を読むだけで計算し直さないので、ハウス方式を変えたいときは delete_chart してから save_chart で登録し直すこと。預かっている出生データはここには出さない（値を読み戻す口は無い）。\nネイタルの読み直し・出生図そのものを話題にするときはこれ（transit は「今の空」用）。\nこのツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
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
    "description": "chart_id を指定して登録を取り消す。計算済みの座標も、預かっている出生データも一緒に消える（戻せないので、必要ならもう一度 save_chart で登録し直すこと）。",
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
    "description": "二次進行（セカンダリー・プログレッション／一日一年法）を計算する。出生の翌日の空を1歳、翌々日を2歳と読む技法で、進行天体・進行 ASC / MC と、それらがネイタルに落とすアスペクト（メジャー5種・オーブ 1°）を返す。\nchart_id で呼ぶ。**出生データ（日時・場所）を預かっているチャートが要る**——二次進行は出生の瞬間そのものから毎回ネイタルを引き直すため。出生データを保存しない時代に登録されたチャートでは使えないので、その旨だけを返す（delete_chart して save_chart で登録し直せば使える）。\nyear / month / day を省略すると今日で計算する。返却テキストに出生日時・出生地そのものは出さない。\nこのツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）"
        },
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
  },
  {
    "name": "calculate_numerology",
    "title": "数秘術（生年月日から）",
    "description": "生年月日から数秘術（ピタゴラス式）を計算する。**登録済みチャートの chart_id か、生年月日の直接指定（year / month / day）のどちらか一方**で呼ぶ——chart_id なら台帳が預かっている出生データを使うので生年月日を渡し直さなくてよく、直接指定は登録せずに一度だけ見るときに使う。\n数秘術は誕生日を使うので公開のカード層には置いていない。この鍵つきの入口だけにある。\n乱数は使わない——ここでのサーバーの仕事は規約を固定すること。ライフパスは流派（還元の規約）によって同じ生年月日から違う数が出る（1986-12-29 は 11 にも 2 にもなる）ため、単一の答えではなく名前つきの 4 経路と途中式を返す——full_sum=全桁をまとめて足し最後の和でマスターを保持 / component_reduce=年・月・日を 1 桁まで還元してから足す / component_keep=年・月・日を還元するときマスターは保持して足す / no_master=マスターを認めず 1 桁まで還元。\nほかにバースデーナンバー、アティチュードナンバー（サンナンバー＝月＋日）、パーソナルイヤー／マンス／デイ（暦年起点＝1 月 1 日で切り替わる）も返す。名前数秘（表現数・魂数など）・ピナクル・チャレンジは範囲外。\n**出生データそのものは返事に出さない**（直接指定で呼んだときも同じ。生まれた日だけはバースデーナンバーとして数字で出る。年と月は還元したあとの値しか出ない）。chart_id で呼ぶとき、出生データを預かっていないチャート（保存しない時代の登録）では使えないので、その旨だけを返す（delete_chart して save_chart で登録し直せば使える）。\nこのツールは解釈をしない——どの経路で読むかは呼び出した側（あるいは占われる本人の流派）で決めること。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）。year / month / day とはどちらか一方だけを指定する"
        },
        "year": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9999,
          "description": "生年月日の年（西暦）。登録せずに一度だけ見るときの直接指定で、year / month / day は 3 つそろえて指定する（chart_id とは併用できない）"
        },
        "month": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "生年月日の月（1-12）"
        },
        "day": {
          "type": "integer",
          "minimum": 1,
          "maximum": 31,
          "description": "生年月日の日（1-31）。暦に存在しない日付（2026-02-31 など）は断る"
        },
        "target_year": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9999,
          "description": "パーソナルイヤー／マンス／デイを見る基準日の年。target_year / target_month / target_day は 3 つそろえて指定する。3 つとも省略すると今日で見る。"
        },
        "target_month": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "基準日の月（1-12）"
        },
        "target_day": {
          "type": "integer",
          "minimum": 1,
          "maximum": 31,
          "description": "基準日の日（1-31）"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "基準日を省いたとき「今日」をどの土地の暦で決めるか（時間単位。日本時間なら 9。省略すると UTC）。target_* を指定したときは使わない"
        },
        "masters": {
          "type": "string",
          "enum": [
            "11_22_33",
            "11_22"
          ],
          "default": "11_22_33",
          "description": "マスターナンバーとして扱う数（既定 11_22_33）。11_22 にすると 33 を認めず 6 まで還元する。"
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
    "name": "shukuyo",
    "title": "宿曜（本命宿とその日の宿）",
    "description": "宿曜占星術（二十七宿）の本命宿と、指定した日の宿（日運）を計算する。\n**天文方式**——宿は出生時刻の月のサイデリアル黄経を 13°20′ で割って決める。基準点（アヤナムシャ）は **Lahiri** に固定（式で出るので天文暦・恒星ファイルが要らない）。暦方式（旧暦の日付から宿を引くやり方）は**採らない**——旧暦は 2033 年問題のように裁定者のいない未解決の規約を含むため。27 宿（牛宿を含まない）で、サイデリアル 0° を**婁宿（Ashvini）**の始まりに置く。『宿曜経』の列挙が昴宿から始まるのは「表の並び」であって、位置の起点ではない。\n**chart_id か、生年月日＋出生時刻の直接指定（year / month / day / hour / minute）のどちらか一方**で呼ぶ。月は 1 日でほぼ 1 宿ぶん動くので、**出生時刻は必須**（時刻の分からない出生では引かない）。\n返るのは (1) 本命宿（漢字の宿名・サンスクリット名・1〜27 の番号）と宿内の位置・両隣の宿・前後の境界までの距離、(2) date（省略すると今日）の月の宿と、本命宿から見た三九の秘法の関係（命・栄・衰・安・危・成・壊・友・親・業・胎＋近距離／中距離／遠距離）、(3) その日のうちに宿が切り替わる時刻。date は**過去も未来も受ける**（日記の日付を後から引き直すときなど）。\n**このツールは解釈をしない**——宿の意味も吉凶もサーバーに載せていないので、読みはあなた自身の知識で。ホロスコープ・宿曜・四柱はそれぞれ別の体系で、**三体系を合算する根拠はない**（並べて眺めるのはよいが、点数を足したり多数決を取ったりしない）。\n出生データそのものは返事に出さない（宿・サイデリアル黄経のような派生値だけを返す）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）。生年月日の直接指定とはどちらか一方だけを指定する"
        },
        "year": {
          "type": "integer",
          "description": "出生年（西暦）。登録せずに一度だけ見るときの直接指定で、year / month / day / hour / minute は 5 つそろえて指定する（chart_id とは併用できない）"
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
          "description": "出生時刻の「時」（0-23、出生地の現地時刻）。宿は月の位置で決まるので必須"
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
          "description": "出生地の UTC からの時差（時間単位。日本は 9。省略すると UTC 扱い）。直接指定のときだけ使う（chart_id では預かっている時差を使う）"
        },
        "date": {
          "type": "string",
          "pattern": "^-?\\d{1,5}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2})?$",
          "description": "日運を見る日 \"YYYY-MM-DD\"、時刻まで見たいときは \"YYYY-MM-DD HH:MM\"（省略すると今）。過去も未来も受ける。時刻を省いたときはその日の 0 時の月の宿を返し、切り替わり時刻を別に添える"
        },
        "date_utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "date と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）。「その日の 0 時〜24 時」の区切りもこの時差の土地の暦で見る"
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
    "name": "shukuyo_compat",
    "title": "宿曜の相性（三九の秘法）",
    "description": "2 つの宿の関係（三九の秘法）を計算する。\na / b はそれぞれ**登録済みの chart_id か、宿の名前**（漢字「亢宿」「亢」／サンスクリット名「Swati」／1〜27 の番号）。相手の宿名だけでも呼べるので、**相手の出生データを会話に出さずに済む**（まず台帳を chart_id として引き、見つからなければ宿名として読む）。\n返るのは A→B と B→A の関係（本命宿を 1 として数えた距離 1〜27 と、命／栄／衰／安／危／成／壊／友／親／業／胎、近距離・中距離・遠距離）と、向きによらない**組の名前**（命・栄親・友衰・安壊・危成・業胎）。三九の秘法は向きで名前が変わる（A から見て栄なら B から見ると親）ので両方向を返す。\n**このツールは解釈をしない**——関係の意味はサーバーに載せていないので、読みはあなた自身の知識で。ホロスコープ・宿曜・四柱を合算する根拠はない。\nchart_id で呼んだときも出生データは返事に出さない。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "a": {
          "type": "string",
          "description": "片方（chart_id か宿名。「亢宿」「亢」「Swati」「15」のいずれの書き方でもよい）"
        },
        "b": {
          "type": "string",
          "description": "もう片方（同じ書き方）"
        }
      },
      "required": [
        "a",
        "b"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "four_pillars",
    "title": "四柱推命（命式と流年・月運・日運）",
    "description": "四柱推命（子平）の命式と、指定した日の流年・月運・日運を計算する。\n**chart_id か、生年月日＋出生時刻の直接指定（year / month / day / hour / minute）のどちらか一方**で呼ぶ。時柱は 2 時間ごとの区切りで決まるので**出生時刻は必須**（時刻の分からない出生では引かない）。\n返るのは (1) 命式（年柱・月柱・日柱・時柱の干支と五行・陰陽、日干から見た通変星と十二運、蔵干＝本気／中気／余気、空亡）、(2) 日主・空亡・節入りからの日数・大運（順行と逆行を 10 柱ずつ）、(3) date（省略すると今）の流年・月運・日運と、命式との天干五合・六合・六沖。date に時刻を付ければ時運（時柱）も出し、日付だけなら年・月・日の三柱で見る。date は**過去も未来も受ける**。\n**採った規約は名前で固定して返り値にも書く**（流派で割れるところが多いので、読む側が「この鯖はこの流派」と分かるように）——日界は 0 時（23 時台生まれのときだけ「日界 23 時」「夜子時」の 2 通りを alternatives に添える）/ 時刻の補正なし（経度補正も均時差もかけない。時辰の境から 15 分以内のときだけ印を出し、境からの分数そのものは出さない）/ 節気は太陽黄経（立春 315°、30° ごとに月柱が替わる。年柱も立春で切り替える）/ 蔵干は本気・中気・余気を全部並べ、通変星は本気で代表する（月律分野表は採らない。代わりに節入りからの日数を返すので、その表で絞りたければ読む側で絞れる）/ 十二運は陰干逆行（陽生陰死方式は採らない）/ 空亡は日柱の旬から / 大運は性別を預からないので順行・逆行の両方を返し、起運（日数 ÷ 3）は切り上げ・満年齢といった流派の丸めを採らない（返す精度は 0.1 年まで＝出生時刻を約 7 時間の粗さでしか含まない）/ 巡りと命式の関係は天干五合・六合・六沖のみ（三合・刑・害は範囲外）。\n**このツールは解釈をしない**——通変星も十二運も蔵干も大運も名前を並べるだけで、格局・用神・強弱・吉凶はサーバーに載せていない。読みはあなた自身の知識で。ホロスコープ・宿曜・四柱はそれぞれ別の体系で、**三体系を合算する根拠はない**（並べて眺めるのはよいが、点数を足したり多数決を取ったりしない）。\n出生データそのものは返事に出さない（命式・蔵干・大運のような派生値だけを返す）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）。生年月日の直接指定とはどちらか一方だけを指定する"
        },
        "year": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9999,
          "description": "出生年（西暦）。登録せずに一度だけ見るときの直接指定で、year / month / day / hour / minute は 5 つそろえて指定する（chart_id とは併用できない）"
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
          "description": "出生時刻の「時」（0-23、出生地の現地時刻）。時柱を立てるので必須。23 時台のときは日界の代替（日界 23 時・夜子時）も添える"
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
          "description": "出生地の UTC からの時差（時間単位。日本は 9。省略すると UTC 扱い）。直接指定のときだけ使う（chart_id では預かっている時差を使う）"
        },
        "date": {
          "type": "string",
          "pattern": "^-?\\d{1,5}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2})?$",
          "description": "流年・月運・日運を見る日 \"YYYY-MM-DD\"、時運（時柱）まで見たいときは \"YYYY-MM-DD HH:MM\"（省略すると今）。過去も未来も受ける"
        },
        "date_utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "date と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）。日運の日界（0 時）もこの時差の土地の暦で見る"
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
    "name": "synastry",
    "title": "シナストリー（2 枚の出生図の間のアスペクトと在ハウス）",
    "description": "登録済みの出生図 2 枚を突き合わせ、その間のアスペクト（シナストリー）と、互いのハウスに相手の天体がどう入るか（ハウスオーバーレイ）を計算する。\na / b は**どちらも呼び出した人の台帳の chart_id**（list_charts で確認できる）。相手のぶんも先に save_chart で登録しておけば、**相手の出生データを会話に出さずに済む**（他人の台帳のチャートは見えない）。\n返るのは (1) A の 10 天体＋ASC / MC と B の 10 天体＋ASC / MC の総当たりアスペクト（メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション、既定オーブ 5°＝orb で変えられる。ノードは除く）、(2) A の天体（ノード込みの 11 天体）が B のハウスのどこに入るか、(3) その逆＝B の天体が A のハウスのどこに入るか。\nどちらも止まった図なので接近・離反は付かない。天体の黄経そのものは返さないので、位置が要るときは get_chart で 1 枚ずつ読むこと（1 枚の図の中のアスペクトも get_chart の持ち場）。\nこのツールは解釈をしない——相性の良し悪しも組み合わせの意味もサーバーに載せていないので、読みはあなた自身の知識で。\n出生データそのものは返事に出さない（アスペクトと在ハウスの派生値だけを返す）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "a": {
          "type": "string",
          "description": "片方のチャート ID（list_charts で確認できる）"
        },
        "b": {
          "type": "string",
          "description": "もう片方のチャート ID（a とは別の ID）"
        },
        "orb": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 10,
          "description": "アスペクトのオーブ（度）。省略すると 5°（止まった図同士は広めに取るのが通例。トランジットの 1° とは別）"
        }
      },
      "required": [
        "a",
        "b"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "kyusei",
    "title": "九星気学（本命星・月命星・日命星と年盤・月盤・日盤）",
    "description": "九星気学の本命星・月命星・日命星と、指定した日の年盤・月盤・日盤を計算する。\n**chart_id か、生年月日の直接指定（year / month / day）のどちらか一方**で呼ぶ。**出生時刻は任意**——hour / minute が無くても本命星・月命星は出る（時刻の分からない出生でも引ける。省いたときはその日の 12 時を仮に置いている）。ただし**立春・節入りの当日**に生まれた人は時刻で星が変わるので、そのときだけ両方の候補を alternatives に添える（hour / minute を付ければ確定する）。\n返るのは (1) 本命星（立春で切った年）・月命星（節で切った月）・日命星（陽遁／陰遁）、(2) date（省略すると今）の年盤・月盤・日盤（後天定位に中宮からの差を配ったもの。9 宮は 北・北東・東・南東・南・南西・西・北西・中宮 の順、図は南を上・東を左に描く）と、各盤に立つ殺 9 種（五黄殺・暗剣殺・歳破／月破／日破・本命殺・本命的殺・月命殺・月命的殺）。date は**過去も未来も受ける**。\n**採った規約は名前で固定して返り値にも書く**（流派で割れるところが多いので、読む側が「この鯖はこの流派」と分かるように）——年界は立春（節分までは 1 つ前の年の星）/ 月界は節（太陽黄経 30° ごと）/ 日界は 0 時 / 陽遁・陰遁は**冬至・夏至に最も近い甲子日**で切り替え（前後が同距離なら後の甲子）/ **閏遁は置かない**（切り替えの間隔が 240 日になる期間もそのまま続ける）/ 破は支の対冲を**八方位に丸めた**もの（四隅の宮では 60° のうち 30° だけが実際の破に当たる）/ **時盤は持たない**。⚠ **日盤の切り替えは流派で割れる**ので、暦によっては日の星がこのサーバーと違う日がある。\n**このツールは解釈をしない**——吉方位も凶方位も相性も、九星や殺の意味もサーバーに載せていない（「五黄殺」「歳破」は計算上の名前で、吉凶の言葉は 1 語も足していない）。読みはあなた自身の知識で。ホロスコープ・宿曜・四柱・九星はそれぞれ別の体系で、**四体系を合算する根拠はない**（並べて眺めるのはよいが、点数を足したり多数決を取ったりしない）。\n九星気学も誕生日を使うので公開のカード層には置いていない。この鍵つきの入口だけにある。出生データそのものは返事に出さない（星・盤・殺のような派生値だけを返す）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "chart_id": {
          "type": "string",
          "description": "対象のチャート ID（list_charts で確認できる）。生年月日の直接指定とはどちらか一方だけを指定する"
        },
        "year": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9999,
          "description": "出生年（西暦）。登録せずに一度だけ見るときの直接指定で、year / month / day は 3 つそろえて指定する（chart_id とは併用できない）"
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
          "description": "出生時刻の「時」（0-23、出生地の現地時刻）。**任意**——省くとその日の 12 時で見る（立春・節入りの当日の生まれのときだけ星が変わるので、そのときは両方の候補を添える）"
        },
        "minute": {
          "type": "integer",
          "minimum": 0,
          "maximum": 59,
          "description": "出生時刻の「分」（0-59、出生地の現地時刻）。任意"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "出生地の UTC からの時差（時間単位。日本は 9。省略すると UTC 扱い）。直接指定のときだけ使う（chart_id では預かっている時差を使う）"
        },
        "date": {
          "type": "string",
          "pattern": "^-?\\d{1,5}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2})?$",
          "description": "年盤・月盤・日盤を見る日 \"YYYY-MM-DD\"、時刻まで決めたいときは \"YYYY-MM-DD HH:MM\"（省略すると今）。過去も未来も受ける。時盤は無いので、時刻は月界・日界の境の判定にだけ効く"
        },
        "date_utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "description": "date と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）。日盤の日界（0 時）も陽遁・陰遁の切り替えの甲子日も、この時差の土地の暦で見る"
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  }
];
