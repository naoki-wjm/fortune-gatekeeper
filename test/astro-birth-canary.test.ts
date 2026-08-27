/**
 * 出生データの canary（全ツール横断。2026-08-27 査読対応）。
 *
 * 鍵つき層の約束は「**どのツールも、返事（text・structuredContent・エラー文）に出生データを出さない**」。
 * ツールごとの個別テストでは「新しく足した 1 本が約束を破っていないか」を見落としうるので、
 * ここでは **tools/list に載っている全部**を表駆動で回し、正常系でも異常系でも
 * 出生データ（と、台帳に紛れ込ませた canary 文字列）が返事に出ないことを一度に確かめる。
 *
 * ツールを足したら、この表にも 1 行足すまでテストが落ちる（それが狙い）。
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASTRO_TOOLS, handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import { TOOLS as CARD_TOOLS } from "../src/mcp";
import { type AstroKv, type AuthContext } from "../src/astro/store";
import { FakeKv } from "./stubs/fake-kv";
import { makeFakeEngine, type FakeEngine } from "./stubs/fake-engine";

const OWNER: AuthContext = { user: "user1", name: "オーナー", role: "owner" };

/** ツールに渡す「今」も、save_chart が打つ created も、この瞬間で止める */
const NOW = new Date("2026-08-20T02:15:00Z");

const CHART_A = "aaaa1111";
const CHART_B = "bbbb2222";
const CHART_C = "cccc3333";

/**
 * 台帳に預ける出生データ。3 枚とも**互いに違う特徴的な値**にしてある
 * （どれか 1 つでも返事に出たら、どの経路から漏れたかが分かる）。
 */
const BIRTHS = {
  [CHART_A]: {
    year: 1987,
    month: 3,
    day: 21,
    hour: 7,
    minute: 43,
    utc_offset: 5.75,
    lat: 51.4779,
    lng: -0.00151,
  },
  [CHART_B]: {
    year: 1963,
    month: 11,
    day: 5,
    hour: 19,
    minute: 8,
    utc_offset: -3.5,
    lat: -33.8688,
    lng: 151.2093,
  },
  [CHART_C]: {
    year: 2004,
    month: 9,
    day: 30,
    hour: 4,
    minute: 21,
    utc_offset: 12.75,
    lat: 64.1466,
    lng: -21.9426,
  },
} as const;

/**
 * 返事に出てはいけない文字列。
 *
 * ⚠ **月・日・時・分の 1〜2 桁は入れていない** ―― 度数・ハウス番号・件数と当たり前に衝突するので、
 * 「3」や「21」を禁止すると本物の漏れではないところで落ちる（見張りとして役に立たない）。
 * 代わりに、桁数が多くて誤検出しにくい 年・時差・緯度経度 と、時刻の形（`h:mm`）を見る。
 */
const CANARY_STRINGS = ["CANARY_FIELD_A", "CANARY_FIELD_B", "CANARY_FIELD_C"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 台帳のレコードにそのまま書いてある値（下のテストで「実在すること」も確かめる） */
const BIRTH_VALUE_TOKENS = [
  // 年（4 桁。2026 まわりの「今年」「対象年」とは当たらない値を選んである）
  "1987",
  "1963",
  "2004",
  // 時差（小数つき）
  "5.75",
  "12.75",
  // 緯度経度（小数第 4 位まで）
  "51.4779",
  "-0.00151",
  "0.00151",
  "-33.8688",
  "33.8688",
  "151.2093",
  "64.1466",
  "-21.9426",
  "21.9426",
];

/** 出生時刻は「時:分」の形でだけ見る（数字ひとつでは度数・件数と区別できないため） */
const BIRTH_TIME_TOKENS = Object.values(BIRTHS).flatMap((birth) => [
  `${birth.hour}:${pad(birth.minute)}`,
  `${pad(birth.hour)}:${pad(birth.minute)}`,
]);

const FORBIDDEN_TOKENS: string[] = [
  ...CANARY_STRINGS,
  ...BIRTH_VALUE_TOKENS,
  ...BIRTH_TIME_TOKENS,
];

/**
 * 台帳へ直に置くレコード。**知らないフィールドを 3 つ混ぜてある**
 * ―― parseStoredChart が落とすはずのもので、落とし損ねたら canary として表に出る。
 */
function storedRecord(chartId: keyof typeof BIRTHS, label: string): Record<string, unknown> {
  return {
    label,
    house_system: "P",
    planets: [
      { id: 0, lon: 10, speed: 1 },
      { id: 1, lon: 40, speed: 13 },
      { id: 2, lon: 70, speed: 1.2 },
      { id: 3, lon: 100, speed: -0.5 },
      { id: 4, lon: 130, speed: 0.7 },
      { id: 5, lon: 160, speed: 0.2 },
      { id: 6, lon: 190, speed: 0.1 },
      { id: 7, lon: 220, speed: 0.05 },
      { id: 8, lon: 250, speed: 0.03 },
      { id: 9, lon: 280, speed: 0.01 },
      { id: 11, lon: 310, speed: -0.05 },
    ],
    cusps: [0, 90, 120, 150, 180, 210, 240, 270, 300, 330, 0, 30, 60],
    ascmc: [90, 300, 0, 0, 0, 0, 0, 0],
    default_location: { lat: 35, lng: 139, label: "いつもの場所" },
    birth: BIRTHS[chartId],
    created: "2026-08-01T00:00:00.000Z",
    // ここから下は StoredChart に無いフィールド（読み出しで落ちるはず）
    secret_canary: "CANARY_FIELD_A",
    birth_raw: "CANARY_FIELD_B",
    notes: { deep: "CANARY_FIELD_C" },
  };
}

interface Bench {
  kv: FakeKv;
  engine: FakeEngine;
  context: AstroContext;
}

function seedCharts(kv: FakeKv): void {
  kv.store.set(`chart:${OWNER.user}:${CHART_A}`, JSON.stringify(storedRecord(CHART_A, "えー")));
  kv.store.set(`chart:${OWNER.user}:${CHART_B}`, JSON.stringify(storedRecord(CHART_B, "びー")));
  kv.store.set(`chart:${OWNER.user}:${CHART_C}`, JSON.stringify(storedRecord(CHART_C, "しー")));
}

/** 3 枚とも「読めない台帳レコード」にする（cusps を 5 個に切る。canary はそのまま残す） */
function breakCharts(kv: FakeKv): void {
  for (const chartId of [CHART_A, CHART_B, CHART_C] as const) {
    const record = storedRecord(chartId, "こわれ");
    record["cusps"] = [0, 90, 120, 150, 180];
    kv.store.set(`chart:${OWNER.user}:${chartId}`, JSON.stringify(record));
  }
}

function makeBench(): Bench {
  const kv = new FakeKv();
  seedCharts(kv);
  const engine = makeFakeEngine();
  // 偽エンジンの素の作りでは通らない科があるので、既存テストと同じ細工をしておく:
  //   armcMatchesMc … コンポジットは「立て直した MC が中点 MC と合うか」を毎回検算する
  //   sunMotionAnchorJd … 四柱・九星の節入りは「太陽の位置と通過時刻の辻褄」に頼る
  engine.armcMatchesMc = true;
  engine.sunMotionAnchorJd = 2_459_000.5;
  return {
    kv,
    engine,
    context: { auth: OWNER, kv, getEngine: async () => engine, now: () => NOW },
  };
}

type KvOp = "get" | "put" | "delete" | "list";

/** 指定の操作だけが CANARY 入りの例外で落ちる KV */
function failingKv(base: FakeKv, failing: KvOp): AstroKv {
  const boom = (op: KvOp): never => {
    throw new Error(`CANARY_KV_${op}`);
  };
  return {
    async get(key) {
      return failing === "get" ? boom("get") : base.get(key);
    },
    async put(key, value) {
      return failing === "put" ? boom("put") : base.put(key, value);
    },
    async delete(key) {
      return failing === "delete" ? boom("delete") : base.delete(key);
    },
    async list(options) {
      return failing === "list" ? boom("list") : base.list(options);
    },
  };
}

/**
 * シナリオ（各ツールについて全部回す）。
 * `expectOk` は正常系だけ ―― 異常系はツールによって「そこまで届かないので成功する」ことがあり
 * （list_decks は KV もエンジンも使わない）、失敗を強制すると意味の無い縛りになる。
 */
interface Scenario {
  label: string;
  expectOk?: boolean;
  apply: (bench: Bench) => AstroContext;
}

const SCENARIOS: Scenario[] = [
  { label: "正常系", expectOk: true, apply: (bench) => bench.context },
  {
    label: "エンジンが立ち上がらない",
    apply: (bench) => ({
      ...bench.context,
      getEngine: async () => {
        throw new Error("CANARY_ENGINE");
      },
    }),
  },
  ...(["get", "put", "delete", "list"] as KvOp[]).map((op) => ({
    label: `KV の ${op} が落ちる`,
    apply: (bench: Bench) => ({ ...bench.context, kv: failingKv(bench.kv, op) }),
  })),
  {
    label: "計算の途中で swe_houses が落ちる",
    apply: (bench) => {
      bench.engine.swe_houses = () => {
        throw new Error("CANARY_HOUSES");
      };
      return bench.context;
    },
  },
  {
    label: "計算の途中で swe_calc_ut が落ちる",
    apply: (bench) => {
      bench.engine.swe_calc_ut = () => {
        throw new Error("CANARY_CALC");
      };
      return bench.context;
    },
  },
  {
    label: "台帳レコードが壊れている",
    apply: (bench) => {
      breakCharts(bench.kv);
      return bench.context;
    },
  },
];

/**
 * ツール名 → 引数の表。tools/list に載っている名前がここに無ければ落ちる（新ツールの見張り）。
 * chart_id 系は A の 1 枚、2 枚以上を見る科は A・B（四柱の多者盤面だけ C も）。
 * カード層の 7 本は最小の引数で（cast_hexagram だけ nakko: true＝エンジンを通る道を選ぶ）。
 */
const TOOL_ARGUMENTS: Record<string, unknown> = {
  // 出生図の台帳
  save_chart: {
    label: "とうろく",
    year: BIRTHS[CHART_A].year,
    month: BIRTHS[CHART_A].month,
    day: BIRTHS[CHART_A].day,
    hour: BIRTHS[CHART_A].hour,
    minute: BIRTHS[CHART_A].minute,
    utc_offset: BIRTHS[CHART_A].utc_offset,
    lat: BIRTHS[CHART_A].lat,
    lng: BIRTHS[CHART_A].lng,
  },
  list_charts: {},
  get_chart: { chart_id: CHART_A },
  delete_chart: { chart_id: CHART_A },
  update_default_location: { chart_id: CHART_A, lat: 35, lng: 139, location_label: "あたらしい場所" },
  // 天体系
  transit: { chart_id: CHART_A },
  transit_events: { chart_id: CHART_A, days: 3 },
  lunar_return: { chart_id: CHART_A },
  solar_return: { chart_id: CHART_A },
  progressions: { chart_id: CHART_A },
  yearly_overview: { chart_id: CHART_A },
  natal_moon_calendar: { chart_id: CHART_A, days: 3 },
  // 2 枚以上の図
  synastry: { a: CHART_A, b: CHART_B },
  composite: { a: CHART_A, b: CHART_B },
  // 誕生日系
  calculate_numerology: { chart_id: CHART_A },
  shukuyo: { chart_id: CHART_A },
  shukuyo_compat: { a: CHART_A, b: CHART_B },
  four_pillars: { chart_id: CHART_A },
  pillars_relations: { charts: [CHART_A, CHART_B, CHART_C] },
  kyusei: { chart_id: CHART_A },
  // 同居しているカード層
  list_decks: {},
  draw_cards: { deck: "sky" },
  cast_hexagram: { nakko: true },
  roll_astro_dice: {},
  cast_geomancy: {},
  moon_calendar: { days: 3 },
  reverse_horoscope: {
    conditions: [{ body: "sun", sign: "aries" }],
    year_from: 2000,
    year_to: 2000,
  },
};

const ENTRANCE_TOOL_NAMES = [...ASTRO_TOOLS, ...CARD_TOOLS].map((tool) => tool.name);

let requestId = 1;

async function rpc(body: unknown, context: AstroContext): Promise<any> {
  const response = await handleAstroMcpRequest(
    new Request("http://localhost/astro/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    context,
  );
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function callTool(name: string, args: unknown, context: AstroContext): Promise<any> {
  return rpc(
    { jsonrpc: "2.0", id: requestId++, method: "tools/call", params: { name, arguments: args } },
    context,
  );
}

/** 見つかった禁止トークンの前後を少しだけ添える（何がどこに出たかを一目で） */
function excerpt(haystack: string, token: string): string {
  const at = haystack.indexOf(token);
  return haystack.slice(Math.max(0, at - 40), at + token.length + 40);
}

/**
 * JSON-RPC の返事まるごと・content[*].text・structuredContent の 3 つを見る
 * （error 経路も落とさないよう、まるごとの JSON も対象にしている）。
 */
function assertNoLeak(json: any, where: string): void {
  const haystacks: { name: string; text: string }[] = [
    { name: "JSON-RPC 全体", text: JSON.stringify(json) },
  ];
  const result = json?.result;
  if (Array.isArray(result?.content)) {
    for (const [index, entry] of result.content.entries()) {
      if (typeof entry?.text === "string") {
        haystacks.push({ name: `content[${index}].text`, text: entry.text });
      }
    }
  }
  if (result?.structuredContent !== undefined) {
    haystacks.push({ name: "structuredContent", text: JSON.stringify(result.structuredContent) });
  }

  for (const token of FORBIDDEN_TOKENS) {
    for (const haystack of haystacks) {
      if (haystack.text.includes(token)) {
        expect.fail(
          `${where}: ${haystack.name} に禁止トークン「${token}」が出ました …${excerpt(haystack.text, token)}…`,
        );
      }
    }
  }
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // save_chart の created（new Date()）も止める＝時刻の形の誤検出を消す
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // 内部障害の固定文は参照 ID をログに落とすので、テストの出力が埋まらないよう黙らせる
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  vi.useRealTimers();
});

describe("見張りそのものの検算", () => {
  it("禁止トークンは台帳のレコードに実在する（打ち間違いの見張り）", () => {
    const raw = ([CHART_A, CHART_B, CHART_C] as const)
      .map((chartId) => JSON.stringify(storedRecord(chartId, "ラベル")))
      .join("");
    for (const token of [...CANARY_STRINGS, ...BIRTH_VALUE_TOKENS]) {
      expect(raw, `禁止トークン「${token}」が台帳のレコードに無い＝打ち間違い`).toContain(token);
    }
  });

  it("出生データが混ざった返事なら assertNoLeak は落ちる（見張りが空撃ちでない）", () => {
    const leaked = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: `出生 ${BIRTHS[CHART_A].year} 年 / 緯度 51.4779` }],
      },
    };
    expect(() => assertNoLeak(leaked, "わざと漏らした返事")).toThrow("禁止トークン");
  });

  it("出生時刻の「時:分」にも、台帳の canary にも反応する", () => {
    const leakedTime = {
      result: { content: [{ type: "text", text: "出生時刻 07:43 ごろ" }] },
    };
    expect(() => assertNoLeak(leakedTime, "時刻")).toThrow("禁止トークン");

    const leakedCanary = {
      result: { structuredContent: { memo: "CANARY_FIELD_C" } },
    };
    expect(() => assertNoLeak(leakedCanary, "台帳の余りもの")).toThrow("禁止トークン");
  });
});

describe("表と tools/list がそろっている", () => {
  it("tools/list に載っている名前は全部この表にある（新ツールはここで落ちる）", async () => {
    const bench = makeBench();
    const json = await rpc(
      { jsonrpc: "2.0", id: requestId++, method: "tools/list" },
      bench.context,
    );
    const listed: string[] = json.result.tools.map((tool: { name: string }) => tool.name);

    const missing = listed.filter((name) => !(name in TOOL_ARGUMENTS));
    if (missing.length > 0) {
      expect.fail(
        `canary の表に無いツールがあります: ${missing.join(", ")}` +
          "（test/astro-birth-canary.test.ts の TOOL_ARGUMENTS に引数を 1 行足してください）",
      );
    }

    const stale = Object.keys(TOOL_ARGUMENTS).filter((name) => !listed.includes(name));
    if (stale.length > 0) {
      expect.fail(`tools/list に無いツールが表に残っています: ${stale.join(", ")}`);
    }

    expect(listed).toEqual(ENTRANCE_TOOL_NAMES);
  });
});

describe("どのツールも出生データを返さない", () => {
  for (const name of ENTRANCE_TOOL_NAMES) {
    it(`${name}（正常系と異常系 ${SCENARIOS.length} 通り）`, async () => {
      const args = TOOL_ARGUMENTS[name];
      expect(args, `${name} の引数が表にありません`).toBeDefined();

      for (const scenario of SCENARIOS) {
        const bench = makeBench();
        const context = scenario.apply(bench);
        const json = await callTool(name, args, context);
        const where = `${name} / ${scenario.label}`;

        expect(json?.result, `${where}: result が返っていません`).toBeDefined();
        if (scenario.expectOk) {
          expect(json.result.isError, `${where}: 正常系なのに isError`).toBeUndefined();

          // 台帳に混ぜた「知らないフィールド」は structuredContent に出ない（キーごと落ちる）。
          // ⚠ `"birth"` というキー名そのものは禁じない ―― 九星は**出生側の星**（派生値）を
          //    `birth` に入れて返しており、それは出してよいもの。見張るのは「預かった原本の形」＝
          //    `"birth": { "year": …` が出ていないか。
          const dumped = JSON.stringify(json.result.structuredContent ?? null);
          expect(dumped).not.toMatch(/"birth"\s*:\s*\{\s*"year"/);
          expect(dumped).not.toContain('"secret_canary"');
          expect(dumped).not.toContain('"birth_raw"');
          expect(dumped).not.toContain('"notes"');
        }

        assertNoLeak(json, where);
      }
    });
  }
});

describe("壊れた台帳レコードの言い分", () => {
  it("chart_id 以外は書かない（読めない中身のことは何も言わない）", async () => {
    const bench = makeBench();
    breakCharts(bench.kv);
    const json = await callTool("get_chart", { chart_id: CHART_A }, bench.context);

    expect(json.result.isError).toBe(true);
    const text: string = json.result.content[0].text;
    expect(text).toContain(CHART_A);
    expect(text).toContain("台帳レコードが壊れていて読めません");
    expect(text).toContain("delete_chart");
    expect(text).not.toContain("こわれ");
    assertNoLeak(json, "get_chart / 壊れたレコード");
  });

  it("list_charts は壊れた登録を飛ばし、ID だけ添える", async () => {
    const bench = makeBench();
    breakCharts(bench.kv);
    const json = await callTool("list_charts", {}, bench.context);

    expect(json.result.isError).toBeUndefined();
    expect(json.result.structuredContent.charts).toEqual([]);
    expect(json.result.structuredContent.broken_chart_ids).toEqual([CHART_A, CHART_B, CHART_C]);
    expect(json.result.content[0].text).toContain("台帳レコードが壊れていて読めない登録");
    assertNoLeak(json, "list_charts / 壊れたレコード");
  });

  it("壊れていない登録に broken_chart_ids は出ない（従来の形のまま）", async () => {
    const bench = makeBench();
    const json = await callTool("list_charts", {}, bench.context);
    expect(json.result.structuredContent.charts).toHaveLength(3);
    expect(json.result.structuredContent).not.toHaveProperty("broken_chart_ids");
    expect(json.result.content[0].text).not.toContain("壊れていて読めない");
  });
});

// ---------------------------------------------------------------------------
// 出生の打ち間違いを書き返さない（2026-08-27 査読 I-1）
// ---------------------------------------------------------------------------

/**
 * 生年月日を**直接**受け付けるツールと、その birth の経路にある引数。
 *
 * `utc_offset` は同じ名前でも意味が科によって違う ―― 宿曜・四柱・九星・save_chart では
 * **出生の時差**だが、calculate_numerology では「今日」を決めるための時差（対象日の側）。
 * だからこの表は「schema にあるか」ではなく「birth の経路を通るか」で書いてある。
 */
const BIRTH_PATH_FIELDS: Record<string, readonly string[]> = {
  save_chart: ["year", "month", "day", "hour", "minute", "utc_offset", "lat", "lng"],
  calculate_numerology: ["year", "month", "day"],
  shukuyo: ["year", "month", "day", "hour", "minute", "utc_offset"],
  four_pillars: ["year", "month", "day", "hour", "minute", "utc_offset"],
  kyusei: ["year", "month", "day", "hour", "minute", "utc_offset"],
};

/** それ自体は正しい生年月日（ここから 1 つだけ壊して投げる） */
const BIRTH_PATH_BASE: Record<string, Record<string, unknown>> = {
  save_chart: {
    label: "うちまちがい",
    year: 1975,
    month: 5,
    day: 12,
    hour: 8,
    minute: 30,
    utc_offset: 9,
    lat: 35,
    lng: 139,
  },
  calculate_numerology: { year: 1975, month: 5, day: 12 },
  shukuyo: { year: 1975, month: 5, day: 12, hour: 8, minute: 30, utc_offset: 9 },
  four_pillars: { year: 1975, month: 5, day: 12, hour: 8, minute: 30, utc_offset: 9 },
  kyusei: { year: 1975, month: 5, day: 12, hour: 8, minute: 30, utc_offset: 9 },
};

/**
 * 壊し方の表。`tokens` は**返事のどこにも出てはいけない**文字列。
 *
 * ⚠ 桁数の少ない値（"5" や "12"）は度数・件数・ハウス番号と当たるので選んでいない。
 *   代わりに「その断り文が値を書き添えるなら必ず現れる形」＝ 25 / 61 / 1987-02-31 / 92.345 を使う
 *   （どれも、値を書かない固定文のほうには現れない ―― 受け付ける範囲の上限下限とも重ならない）。
 */
const BAD_BIRTH_CASES: {
  label: string;
  field: string;
  patch: Record<string, unknown>;
  tokens: string[];
}[] = [
  {
    label: "暦に無い日（2 月 31 日）",
    field: "day",
    patch: { year: 1987, month: 2, day: 31 },
    tokens: ["1987", "1987-02-31", "28日"],
  },
  { label: "年が小数", field: "year", patch: { year: 1987.5 }, tokens: ["1987"] },
  { label: "月が 13", field: "month", patch: { month: 13 }, tokens: ["13"] },
  { label: "日が 32", field: "day", patch: { day: 32 }, tokens: ["32"] },
  { label: "時が 25", field: "hour", patch: { hour: 25 }, tokens: ["25"] },
  { label: "分が 61", field: "minute", patch: { minute: 61 }, tokens: ["61"] },
  {
    label: "時差が ±14 の外",
    field: "utc_offset",
    patch: { utc_offset: 14.75 },
    tokens: ["14.75"],
  },
  { label: "緯度が範囲外", field: "lat", patch: { lat: 92.345 }, tokens: ["92.345"] },
  { label: "経度が範囲外", field: "lng", patch: { lng: 183.456 }, tokens: ["183.456"] },
];

/**
 * ツールの返事（content[*].text・structuredContent・isError）に禁止の文字列が無いか。
 *
 * ⚠ JSON-RPC の封筒（`id` など）は見ない ―― 連番の id がたまたま "25" になっただけで
 *   落ちてしまい、見張りとして役に立たなくなるため。見たいのは**返事の中身**。
 */
function assertResultLacks(json: any, tokens: readonly string[], where: string): void {
  const result = json?.result;
  expect(result, `${where}: result が返っていません`).toBeDefined();
  const dumped = JSON.stringify(result);
  for (const token of tokens) {
    if (dumped.includes(token)) {
      expect.fail(`${where}: 返事に「${token}」が出ました …${excerpt(dumped, token)}…`);
    }
  }
}

describe("出生の打ち間違いを返事に書き返さない", () => {
  for (const [name, fields] of Object.entries(BIRTH_PATH_FIELDS)) {
    it(`${name}（出生の引数を 1 つずつ壊す）`, async () => {
      for (const badCase of BAD_BIRTH_CASES) {
        if (!fields.includes(badCase.field)) continue;
        const bench = makeBench();
        const args = { ...BIRTH_PATH_BASE[name], ...badCase.patch };
        const json = await callTool(name, args, bench.context);
        const where = `${name} / ${badCase.label}`;

        expect(json?.result?.isError, `${where}: 断られていません`).toBe(true);
        assertResultLacks(json, badCase.tokens, where);
        assertNoLeak(json, where);
      }
    });
  }

  it("断り文には「値は返事に出しません」と書いてある（黙って消さない）", async () => {
    const bench = makeBench();
    const badDay = await callTool(
      "shukuyo",
      { ...BIRTH_PATH_BASE["shukuyo"], month: 2, day: 31 },
      bench.context,
    );
    expect(badDay.result.content[0].text).toContain("出生の年月日が暦に存在しない組み合わせです");
    expect(badDay.result.content[0].text).toContain("値は返事に出しません");

    const badHour = await callTool(
      "shukuyo",
      { ...BIRTH_PATH_BASE["shukuyo"], hour: 25 },
      bench.context,
    );
    expect(badHour.result.content[0].text).toContain("hour は 0 以上 23 以下");
    expect(badHour.result.content[0].text).toContain("値は返事に出しません");
  });

  it("対象日の側は今までどおり値を出す（直しようが無くなるので隠さない）", async () => {
    const bench = makeBench();
    const badDate = await callTool(
      "shukuyo",
      { chart_id: CHART_A, date: "2026-02-30" },
      bench.context,
    );
    expect(badDate.result.isError).toBe(true);
    expect(badDate.result.content[0].text).toContain("2026-02-30 は暦に存在しない日付です");
  });

  /**
   * 「birth の受付を使っている科が、上の表から抜けていないか」をソースで見張る。
   * 新しい誕生日系の科を足したとき、canary の表に 1 行足すまで落ちる（それが狙い）。
   */
  it("birth の受付を使っている科は全部この表にある（新しい科はここで落ちる）", () => {
    /** ソースを 1 枚読む（リポジトリ相対）。@types/node は入れない方針なので readFileSync だけで済ませる */
    const readSource = (relative: string): string =>
      new TextDecoder().decode(fs.readFileSync(new URL(`../${relative}`, import.meta.url)));

    // 科の一覧は入口（配線板）から採る ―― tools/*.ts を集めているのはここ 1 枚だけ、が約束
    const entrance = readSource("src/astro/astro-mcp.ts");
    const toolFiles = [...entrance.matchAll(/from "\.\/tools\/([\w-]+)"/g)].map(
      (hit) => `${hit[1] as string}.ts`,
    );
    expect(toolFiles.length, "入口から tools/*.ts を 1 枚も拾えていません").toBeGreaterThan(5);

    /** 出生の引数を受けている印（どれか 1 つでもあれば birth の経路を持つ） */
    const MARKERS = [
      "resolveBirthMoment",
      "assertBirthCalendarDay",
      "requireBirthInteger",
      "optionalBirthInteger",
      "requireBirthNumber",
      "optionalBirthNumber",
    ];

    const covered = new Set<string>();
    for (const file of toolFiles) {
      const source = readSource(`src/astro/tools/${file}`);
      if (!MARKERS.some((marker) => source.includes(marker))) continue;

      const names = [...source.matchAll(/^ {4}name: "(\w+)",$/gm)].map((hit) => hit[1] as string);
      const listed = names.filter((toolName) => toolName in BIRTH_PATH_FIELDS);
      if (listed.length === 0) {
        expect.fail(
          `${file} は出生の引数を受けているのに、canary の表（BIRTH_PATH_FIELDS）に 1 本もありません` +
            `（この科のツール: ${names.join(", ") || "なし"}）`,
        );
      }
      for (const toolName of listed) covered.add(toolName);
    }

    const stale = Object.keys(BIRTH_PATH_FIELDS).filter((toolName) => !covered.has(toolName));
    expect(stale, `表に残っているのに出生の引数を受けていない科: ${stale.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 台帳に混ぜた「余分な要素」も表に出ない（2026-08-27 査読 I-2）
// ---------------------------------------------------------------------------

/** 既知の配列に紛れ込ませる数値。度数と紛れないよう小数第 4 位まで書いてある */
const ARRAY_CANARIES = {
  planet: 111.2223,
  ascmc: 222.3334,
  cusp: 333.4445,
} as const;

/** 台帳のレコードを 1 か所だけ壊す（canary の数値を既知の配列に紛れ込ませる） */
const TAMPERINGS: {
  label: string;
  tamper: (record: Record<string, unknown>) => void;
  token: string;
}[] = [
  {
    label: "planets に 12 個目（未知 ID）",
    tamper: (record) => {
      (record["planets"] as unknown[]).push({ id: 12, lon: ARRAY_CANARIES.planet, speed: 1 });
    },
    token: String(ARRAY_CANARIES.planet),
  },
  {
    label: "planets に 12 個目（既知 ID の重複）",
    tamper: (record) => {
      (record["planets"] as unknown[]).push({ id: 0, lon: ARRAY_CANARIES.planet, speed: 1 });
    },
    token: String(ARRAY_CANARIES.planet),
  },
  {
    label: "ascmc に 9 個目",
    tamper: (record) => {
      (record["ascmc"] as unknown[]).push(ARRAY_CANARIES.ascmc);
    },
    token: String(ARRAY_CANARIES.ascmc),
  },
  {
    label: "cusps が 14 個",
    tamper: (record) => {
      (record["cusps"] as unknown[]).push(ARRAY_CANARIES.cusp);
    },
    token: String(ARRAY_CANARIES.cusp),
  },
  {
    label: "cusps が 12 個（足りないうえ 1 本が canary）",
    tamper: (record) => {
      const cusps = (record["cusps"] as number[]).slice(0, 12);
      cusps[5] = ARRAY_CANARIES.cusp;
      record["cusps"] = cusps;
    },
    token: String(ARRAY_CANARIES.cusp),
  },
];

describe("既知の配列に紛れ込ませた数値は表に出ない", () => {
  for (const tampering of TAMPERINGS) {
    it(`${tampering.label} → get_chart / transit / list_charts のどれにも出ない`, async () => {
      for (const tool of ["get_chart", "transit", "list_charts"]) {
        const bench = makeBench();
        const record = storedRecord(CHART_A, "いじった図");
        tampering.tamper(record);
        bench.kv.store.set(`chart:${OWNER.user}:${CHART_A}`, JSON.stringify(record));

        const args = tool === "list_charts" ? {} : { chart_id: CHART_A };
        const json = await callTool(tool, args, bench.context);
        const where = `${tool} / ${tampering.label}`;

        assertResultLacks(json, [tampering.token], where);
        assertNoLeak(json, where);
      }
    });
  }

  it("いじった 1 枚は壊れ扱いになる（素通りしていない＝見張りが空撃ちでない）", async () => {
    for (const tampering of TAMPERINGS) {
      const bench = makeBench();
      const record = storedRecord(CHART_A, "いじった図");
      tampering.tamper(record);
      const raw = JSON.stringify(record);
      // 打ち間違いの見張り ―― 探している canary が、そもそも台帳に入っていること
      expect(raw, `${tampering.label}: canary が台帳に無い`).toContain(tampering.token);
      bench.kv.store.set(`chart:${OWNER.user}:${CHART_A}`, raw);

      const json = await callTool("get_chart", { chart_id: CHART_A }, bench.context);
      expect(json.result.isError, tampering.label).toBe(true);
      expect(json.result.content[0].text, tampering.label).toContain(
        "台帳レコードが壊れていて読めません",
      );

      const listed = await callTool("list_charts", {}, bench.context);
      expect(listed.result.structuredContent.broken_chart_ids, tampering.label).toContain(CHART_A);
    }
  });
});
