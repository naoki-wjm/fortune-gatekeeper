/**
 * 内部障害の固定文（2026-08-27 査読対応）。
 *
 * 既知の入力エラーはそのまま返してよいが、それ以外の例外は `message` に何が混ざっているか
 * 分からない（呼び出し引数・chart_id・預かった出生データ）。返すのは固定文＋参照 ID だけで、
 * ログにも参照 ID・種別・例外クラス名の 3 つしか書かない、というのをここで固定する。
 *
 * 見張りの合言葉は CANARY_ENGINE_MESSAGE ―― 例外の言い分に入れておいて、
 * 返事にもログにも出てこないことを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineInitError, internalFailureMessage } from "../src/internal-error";
import { callTool as callCardTool } from "../src/mcp";
import { handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import { PLANETS } from "../src/astro/chart";
import { type AuthContext, type StoredChart } from "../src/astro/store";
import { FakeKv } from "./stubs/fake-kv";
import { makeFakeEngine, type FakeEngine } from "./stubs/fake-engine";

const CANARY = "CANARY_ENGINE_MESSAGE";
const OWNER: AuthContext = { user: "user1", name: "オーナー", role: "owner" };
const NOW = new Date("2026-08-20T02:15:00Z");
const CHART_ID = "aaaa1111";

const UNEXPECTED_TEXT = "内部処理で予期しないエラーが発生しました。参照ID: ";
const ENGINE_TEXT = "天体計算エンジンを初期化できませんでした。参照ID: ";
const REFERENCE_ID = /参照ID: ([0-9a-f]{8})/;

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

/** console.error に渡ったものをまとめて 1 本の文字列に（ログに何が載ったかの検算用） */
function loggedJson(): string {
  return JSON.stringify(consoleError.mock.calls);
}

function chartRecord(): StoredChart {
  return {
    label: "サンプル",
    house_system: "P",
    planets: PLANETS.map((planet, index) => ({
      id: planet.id,
      lon: (index * 30 + 10) % 360,
      speed: 1,
    })),
    cusps: [0, 90, 120, 150, 180, 210, 240, 270, 300, 330, 0, 30, 60],
    ascmc: [90, 300, 0, 0, 0, 0, 0, 0],
    default_location: { lat: 35, lng: 139 },
    birth: {
      year: 1990,
      month: 6,
      day: 15,
      hour: 12,
      minute: 0,
      utc_offset: 9,
      lat: 35.68,
      lng: 139.77,
    },
    created: "2026-08-01T00:00:00.000Z",
  };
}

function makeContext(engine: FakeEngine): AstroContext {
  const kv = new FakeKv();
  kv.store.set(`chart:${OWNER.user}:${CHART_ID}`, JSON.stringify(chartRecord()));
  return { auth: OWNER, kv, getEngine: async () => engine, now: () => NOW };
}

async function callAstro(name: string, args: unknown, context: AstroContext): Promise<any> {
  const response = await handleAstroMcpRequest(
    new Request("http://localhost/astro/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    context,
  );
  return JSON.parse(await response.text());
}

describe("internalFailureMessage", () => {
  it("固定文＋8 桁の参照 ID を返し、ログには 3 つしか書かない", () => {
    const message = internalFailureMessage(new Error(CANARY), "unexpected");
    expect(message).toContain(UNEXPECTED_TEXT);
    const matched = REFERENCE_ID.exec(message);
    expect(matched).not.toBeNull();

    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(logged).sort()).toEqual(["error_name", "kind", "reference_id"]);
    expect(logged["kind"]).toBe("unexpected");
    expect(logged["error_name"]).toBe("Error");
    // ログの参照 ID は返事のものと同じ（運用者が突き合わせるための札）
    expect(logged["reference_id"]).toBe(matched?.[1]);
    expect(loggedJson()).not.toContain(CANARY);
  });

  it("engine の固定文は別で、例外の中身はどちらにも出ない", () => {
    const message = internalFailureMessage(new EngineInitError(), "engine");
    expect(message).toContain(ENGINE_TEXT);
    expect(message).toMatch(REFERENCE_ID);
    expect(consoleError.mock.calls[0]?.[0]).toMatchObject({
      kind: "engine",
      error_name: "EngineInitError",
    });
  });

  it("Error でないものを投げられても型の名前だけ残す", () => {
    const message = internalFailureMessage(CANARY, "unexpected");
    expect(message).toContain(UNEXPECTED_TEXT);
    expect(consoleError.mock.calls[0]?.[0]).toMatchObject({ error_name: "string" });
    expect(loggedJson()).not.toContain(CANARY);
  });

  it("参照 ID は呼ぶたびに違う", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      ids.add(REFERENCE_ID.exec(internalFailureMessage(new Error("x"), "unexpected"))?.[1] ?? "");
    }
    expect(ids.size).toBeGreaterThan(15);
  });
});

describe("鍵つき層（/astro/mcp）", () => {
  it("計算の途中で例外が出ても、固定文だけを返す（transit）", async () => {
    const engine = makeFakeEngine();
    engine.swe_calc_ut = () => {
      throw new Error(CANARY);
    };
    const json = await callAstro("transit", { chart_id: CHART_ID }, makeContext(engine));

    expect(json.result.isError).toBe(true);
    const text: string = json.result.content[0].text;
    expect(text).toContain(UNEXPECTED_TEXT);
    expect(text).toMatch(REFERENCE_ID);
    expect(text).not.toContain(CANARY);
    expect(JSON.stringify(json)).not.toContain(CANARY);

    // ログにも例外の言い分は載らない（載るのは参照 ID・種別・クラス名だけ）
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = loggedJson();
    expect(logged).not.toContain(CANARY);
    expect(logged).toContain("reference_id");
    expect(logged).toContain('"kind":"unexpected"');
  });

  it("エンジンが立ち上がらないときは engine の固定文", async () => {
    const engine = makeFakeEngine();
    const context: AstroContext = {
      ...makeContext(engine),
      getEngine: async () => {
        throw new Error(CANARY);
      },
    };
    const json = await callAstro("transit", { chart_id: CHART_ID }, context);

    expect(json.result.isError).toBe(true);
    const text: string = json.result.content[0].text;
    expect(text).toContain(ENGINE_TEXT);
    expect(text).not.toContain(CANARY);
    expect(loggedJson()).toContain('"kind":"engine"');
    expect(loggedJson()).not.toContain(CANARY);
  });

  it("入力の間違い（AstroError）は今までどおりそのまま返る", async () => {
    const json = await callAstro("transit", { chart_id: "nosuchid" }, makeContext(makeFakeEngine()));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("nosuchid");
    expect(json.result.content[0].text).not.toContain("参照ID");
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("公開層（/mcp）", () => {
  it("moon_calendar の計算中に例外が出ても、固定文だけを返す", async () => {
    const engine = makeFakeEngine();
    engine.swe_calc_ut = () => {
      throw new Error(CANARY);
    };
    const result = await callCardTool("moon_calendar", { days: 3 }, {
      getEngine: async () => engine,
      now: () => NOW,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(UNEXPECTED_TEXT);
    expect(result.content[0]?.text).not.toContain(CANARY);
    expect(loggedJson()).not.toContain(CANARY);
    expect(loggedJson()).toContain('"kind":"unexpected"');
  });

  it("cast_hexagram（nakko: true）でエンジンが立ち上がらなければ engine の固定文", async () => {
    const result = await callCardTool("cast_hexagram", { nakko: true }, {
      getEngine: async () => {
        throw new Error(CANARY);
      },
      now: () => NOW,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(ENGINE_TEXT);
    expect(result.content[0]?.text).not.toContain(CANARY);
    expect(loggedJson()).toContain('"kind":"engine"');
    expect(loggedJson()).not.toContain(CANARY);
  });

  it("cast_hexagram（nakko: true）の計算中の例外も固定文", async () => {
    const engine = makeFakeEngine();
    engine.swe_calc_ut = () => {
      throw new Error(CANARY);
    };
    const result = await callCardTool("cast_hexagram", { nakko: true }, {
      getEngine: async () => engine,
      now: () => NOW,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(UNEXPECTED_TEXT);
    expect(result.content[0]?.text).not.toContain(CANARY);
    expect(loggedJson()).not.toContain(CANARY);
  });

  it("エンジンが配線されていない、は今までどおり理由を言う（内部障害ではない）", async () => {
    const result = await callCardTool("moon_calendar", {}, { now: () => NOW });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("天体計算エンジンが使えないため月まわりの暦を出せません");
    expect(result.content[0]?.text).not.toContain("参照ID");
    expect(consoleError).not.toHaveBeenCalled();
  });
});
