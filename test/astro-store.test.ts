/**
 * 台帳（KV）の読み出しの検算（2026-08-27 査読対応）。
 *
 * `JSON.parse` の結果を型キャストで通していたのを `parseStoredChart` に置き換えたので、
 * 「何を通し、何を壊れ扱いにするか」をここで固定する。合格の側（旧レコード＝`birth` なし）も
 * 不合格の側（NaN・文字列の数値・部分レコード）も同じ数だけ並べておくこと ―― 検算を厳しくすると、
 * 直したいバグの代わりに**本物のレコードを壊れ扱いにする**事故が起きうるため。
 */
import { describe, expect, it } from "vitest";
import { AstroError } from "../src/astro/chart";
import {
  getChart,
  listCharts,
  parseStoredChart,
  putChart,
  type StoredChart,
} from "../src/astro/store";
import { FakeKv } from "./stubs/fake-kv";

const USER = "user1";

/** 素直に通るはずの 1 枚（save_chart が書く形そのまま） */
function validChart(overrides: Partial<StoredChart> = {}): StoredChart {
  return {
    label: "サンプル",
    house_system: "P",
    planets: [
      { id: 0, lon: 12.5, speed: 1 },
      { id: 1, lon: 300, speed: 13.2 },
    ],
    cusps: [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 359.9],
    ascmc: [30, 300, 0, 0, 0, 0, 0, 0],
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
    created: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

/** JSON を通した往復（本物の KV は文字列しか持てない） */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("parseStoredChart（通す側）", () => {
  it("save_chart が書いた形はそのまま通り、値が保たれる", () => {
    const chart = validChart();
    const parsed = parseStoredChart(roundTrip(chart));
    expect(parsed).toEqual(chart);
  });

  it("birth の無い旧レコード（原本を捨てていた時代のもの）も通る", () => {
    const legacy = validChart();
    delete legacy.birth;
    const parsed = parseStoredChart(roundTrip(legacy));
    expect(parsed).not.toBeNull();
    expect(parsed?.birth).toBeUndefined();
    expect(parsed?.label).toBe("サンプル");
  });

  it("いつもの場所は lat / lng / label だけを採る（余分なキーは落ちる）", () => {
    const parsed = parseStoredChart(
      roundTrip({
        ...validChart(),
        default_location: { lat: 35, lng: 139, label: "東京", memo: "余計なもの" },
      }),
    );
    expect(parsed?.default_location).toEqual({ lat: 35, lng: 139, label: "東京" });
  });

  it("label が空文字でも通す（ラベルの無い図は壊れているわけではない）", () => {
    const parsed = parseStoredChart(roundTrip(validChart({ label: "" })));
    expect(parsed?.label).toBe("");
  });

  it("知らないフィールドは落ちる＝二重の防波堤", () => {
    const parsed = parseStoredChart(
      roundTrip({
        ...validChart(),
        secret_canary: "CANARY_FIELD",
        notes: { deep: "CANARY_DEEP" },
        birth_raw: "1990-06-15 12:00",
      }),
    );
    expect(parsed).not.toBeNull();
    const dumped = JSON.stringify(parsed);
    expect(dumped).not.toContain("CANARY");
    expect(dumped).not.toContain("secret_canary");
    expect(dumped).not.toContain("birth_raw");
    expect(dumped).not.toContain("notes");
    // 天体も id / lon / speed の 3 つだけ写す
    const withExtraPlanet = parseStoredChart(
      roundTrip({
        ...validChart(),
        planets: [{ id: 0, lon: 1, speed: 1, lat: 51.4779, canary: "CANARY_PLANET" }],
      }),
    );
    expect(JSON.stringify(withExtraPlanet)).not.toContain("CANARY_PLANET");
    expect(withExtraPlanet?.planets[0]).toEqual({ id: 0, lon: 1, speed: 1 });
  });
});

describe("parseStoredChart（断る側）", () => {
  const cases: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["配列", [validChart()]],
    ["文字列", "チャートです"],
    ["数値", 42],
    ["空のオブジェクト", {}],
    ["label が無い", (() => { const c: any = validChart(); delete c.label; return c; })()],
    ["label が数値", validChart({ label: 12 as unknown as string })],
    ["label が 60 文字超", validChart({ label: "あ".repeat(61) })],
    ["house_system が 2 文字", validChart({ house_system: "PP" })],
    ["created が無い", (() => { const c: any = validChart(); delete c.created; return c; })()],
    ["created が数値", validChart({ created: 20260820 as unknown as string })],
    ["planets が空", validChart({ planets: [] })],
    ["planets が配列でない", validChart({ planets: {} as unknown as StoredChart["planets"] })],
    ["planets の id が小数", validChart({ planets: [{ id: 0.5, lon: 1, speed: 1 }] })],
    ["planets の lon が文字列", validChart({ planets: [{ id: 0, lon: "12" as unknown as number, speed: 1 }] })],
    ["planets の lon が NaN", validChart({ planets: [{ id: 0, lon: NaN, speed: 1 }] })],
    ["planets の speed が Infinity", validChart({ planets: [{ id: 0, lon: 1, speed: Infinity }] })],
    ["planets の speed が無い", validChart({ planets: [{ id: 0, lon: 1 } as unknown as StoredChart["planets"][0]] })],
    ["cusps が無い", (() => { const c: any = validChart(); delete c.cusps; return c; })()],
    ["cusps が 12 個", validChart({ cusps: [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] })],
    ["cusps が 14 個", validChart({ cusps: [...validChart().cusps, 0] })],
    ["cusps に null が混ざる", validChart({ cusps: [null as unknown as number, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 0] })],
    ["cusps に文字列の数値が混ざる", validChart({ cusps: ["0" as unknown as number, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 0] })],
    ["ascmc が無い", (() => { const c: any = validChart(); delete c.ascmc; return c; })()],
    ["ascmc が 1 個", validChart({ ascmc: [30] })],
    ["ascmc が NaN 入り", validChart({ ascmc: [30, NaN] })],
    ["default_location が null", validChart({ default_location: null as unknown as undefined })],
    ["default_location の lng が範囲外", validChart({ default_location: { lat: 35, lng: 200 } })],
    ["default_location の lat が文字列", validChart({ default_location: { lat: "35" as unknown as number, lng: 139 } })],
    ["birth が null", validChart({ birth: null as unknown as undefined })],
    ["birth の minute が無い", validChart({ birth: { year: 1990, month: 6, day: 15, hour: 12, utc_offset: 9, lat: 35, lng: 139 } as unknown as StoredChart["birth"] })],
    ["birth の year が文字列", validChart({ birth: { ...validChart().birth!, year: "1990" as unknown as number } })],
    ["birth の month が 13", validChart({ birth: { ...validChart().birth!, month: 13 } })],
    ["birth の day が 0", validChart({ birth: { ...validChart().birth!, day: 0 } })],
    ["birth の hour が 24", validChart({ birth: { ...validChart().birth!, hour: 24 } })],
    ["birth の minute が小数", validChart({ birth: { ...validChart().birth!, minute: 30.5 } })],
    ["birth の utc_offset が ±14 の外", validChart({ birth: { ...validChart().birth!, utc_offset: 20 } })],
    ["birth の lat が NaN", validChart({ birth: { ...validChart().birth!, lat: NaN } })],
    ["birth の lng が Infinity", validChart({ birth: { ...validChart().birth!, lng: Infinity } })],
  ];

  for (const [name, value] of cases) {
    it(`${name} は不合格`, () => {
      expect(parseStoredChart(value)).toBeNull();
    });
  }
});

describe("getChart", () => {
  it("見つからなければ null（従来どおり）", async () => {
    const kv = new FakeKv();
    await expect(getChart(kv, USER, "nosuchid")).resolves.toBeNull();
  });

  it("chart_id の見た目が違えば KV を引かずに null", async () => {
    const kv = new FakeKv();
    await expect(getChart(kv, USER, "ab")).resolves.toBeNull();
    expect(kv.store.size).toBe(0);
  });

  it("JSON として読めなければ壊れ扱いで投げる", async () => {
    const kv = new FakeKv();
    kv.store.set(`chart:${USER}:broken01`, "{ここで切れて");
    await expect(getChart(kv, USER, "broken01")).rejects.toBeInstanceOf(AstroError);
    await expect(getChart(kv, USER, "broken01")).rejects.toThrow(
      "チャート broken01 の台帳レコードが壊れていて読めません",
    );
  });

  it("形が違えば壊れ扱いで投げる（言い分に chart_id 以外は出さない）", async () => {
    const kv = new FakeKv();
    kv.store.set(
      `chart:${USER}:broken02`,
      JSON.stringify({ ...validChart({ label: "ひみつのラベル" }), cusps: [0, 30, 60, 90, 120] }),
    );
    const error = await getChart(kv, USER, "broken02").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AstroError);
    const message = (error as AstroError).message;
    expect(message).toContain("broken02");
    expect(message).toContain("delete_chart");
    expect(message).not.toContain("ひみつのラベル");
    expect(message).not.toContain("1990");
    expect(message).not.toContain("35.68");
  });
});

describe("listCharts", () => {
  it("壊れた 1 件は飛ばし、残りを返して ID だけ知らせる", async () => {
    const kv = new FakeKv();
    await putChart(kv, USER, "aaaa1111", validChart({ label: "いちまい", created: "2026-08-01T00:00:00.000Z" }));
    kv.store.set(`chart:${USER}:bbbb2222`, "{壊れている");
    await putChart(kv, USER, "cccc3333", validChart({ label: "さんまい", created: "2026-08-03T00:00:00.000Z" }));

    const { charts, broken } = await listCharts(kv, USER);
    expect(charts.map((chart) => chart.chart_id)).toEqual(["aaaa1111", "cccc3333"]);
    expect(broken).toEqual(["bbbb2222"]);
  });

  it("全部壊れていても一覧そのものは返る（消すための ID が要る）", async () => {
    const kv = new FakeKv();
    kv.store.set(`chart:${USER}:aaaa1111`, "{壊れている");
    kv.store.set(`chart:${USER}:bbbb2222`, JSON.stringify({ label: "だけ" }));

    const { charts, broken } = await listCharts(kv, USER);
    expect(charts).toEqual([]);
    expect(broken).toEqual(["aaaa1111", "bbbb2222"]);
  });

  it("他人のチャートは数えない（壊れていても）", async () => {
    const kv = new FakeKv();
    await putChart(kv, USER, "aaaa1111", validChart());
    kv.store.set("chart:tomodachi:bbbb2222", "{壊れている");

    const { charts, broken } = await listCharts(kv, USER);
    expect(charts).toHaveLength(1);
    expect(broken).toEqual([]);
  });

  it("KV の list が打ち切られてもページ送りで全件拾う", async () => {
    const kv = new FakeKv();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const chartId = `chart${String(i).padStart(3, "0")}`;
      ids.push(chartId);
      await putChart(
        kv,
        USER,
        chartId,
        validChart({ label: `図${i}`, created: `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z` }),
      );
    }
    kv.pageSize = 4; // 25 件を 4 件ずつ＝7 ページ

    const { charts, broken } = await listCharts(kv, USER);
    expect(charts).toHaveLength(25);
    expect(charts.map((chart) => chart.chart_id).sort()).toEqual([...ids].sort());
    expect(broken).toEqual([]);
  });

  it("ページ送りの途中に壊れた 1 件があっても止まらない", async () => {
    const kv = new FakeKv();
    for (let i = 0; i < 10; i++) {
      await putChart(kv, USER, `chart${String(i).padStart(3, "0")}`, validChart({ label: `図${i}` }));
    }
    kv.store.set(`chart:${USER}:chart005`, "{壊れている");
    kv.pageSize = 3;

    const { charts, broken } = await listCharts(kv, USER);
    expect(charts).toHaveLength(9);
    expect(broken).toEqual(["chart005"]);
  });
});
