/**
 * ネイタルに重ねた月の暦（natal_moon_calendar）を**本物の Swiss Ephemeris（wasm）**で確かめる。
 *
 * 偽エンジンのテスト（test/astro-mcp.test.ts）が見るのは配線と枝で、そこでの月は
 * 「13°/日 でまっすぐ走る」作り物 ―― 本物の月は 11.8〜15.4°/日 で振れるので、
 * 「その時刻に月が本当にそこに居るのか」はここで実物に当てる。
 *
 * 本物の wasm の読み方は test/moon-calendar-real.test.ts と同じ流儀
 * （本番の src/astro/engine.ts は workerd 流の wasm import なので Node では読めない。
 *   glue に wasmBinary を直接渡せば Node でも初期化できる）。
 *
 * 突き合わせるのは**このサーバーの中の別経路**:
 *
 *   - 個人朔望の「ネイタル月との 0°」＝ lunar_return（`swe_mooncross_ut` の一発計算）と同じ瞬間か
 *   - ハウス入りの時刻に、月の黄経が本当にそのカスプに居るか
 *   - exact の時刻に、月とネイタルの離角が本当にその角度か
 *   - 空の暦の部分が、公開層の moon_calendar と 1 バイトも違わないか
 *
 * ⚠ 許容は 0.01°。返す時刻は**分に丸めて**あるので、丸めだけで最大 30 秒＝ 0.005° ずれる
 *    （月は 1 分で 0.009° 進む）。0.01° はその丸めぶんを飲み込むぎりぎりの幅で、
 *    補間や二分法が緩めば必ずはみ出す。
 *
 * 出生データは架空（実在の誰かのものではない）。
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import { CALC_FLAGS, julianDay, normalizeDegree, type SwissEph } from "../src/astro/chart";
import { wrap180 } from "../src/astro/events";
import { type AuthContext } from "../src/astro/store";
import { FakeKv } from "./stubs/fake-kv";

const OWNER: AuthContext = { user: "user1", name: "オーナー", role: "owner" };

/** 架空の出生（1990-06-15 12:00 JST・東京） */
const BIRTH = {
  label: "サンプル",
  year: 1990,
  month: 6,
  day: 15,
  hour: 12,
  minute: 0,
  utc_offset: 9,
  lat: 35.6895,
  lng: 139.6917,
  default_lat: 35.6895,
  default_lng: 139.6917,
  default_location_label: "東京",
};

/** 月の id（SE_MOON） */
const MOON_ID = 1;

let swe: SwissEph;
let context: AstroContext;
let chartId: string;
let nextId = 1;

async function call(name: string, args: unknown = {}): Promise<any> {
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
    context,
  );
  const json = JSON.parse(await response.text());
  expect(json.result.isError).toBeUndefined();
  return json.result;
}

beforeAll(async () => {
  const wasmBinary = fs.readFileSync(new URL("../src/astro/sweph/swisseph.wasm", import.meta.url));
  const glue = (await import(
    /* @vite-ignore */ new URL("../src/astro/sweph/swisseph.js", import.meta.url).href
  )) as { default: (options: unknown) => Promise<unknown> };
  const wrapper = (await import(
    /* @vite-ignore */ new URL("../src/astro/sweph/sweph-wasm.js", import.meta.url).href
  )) as { default: new (emscripten: unknown) => unknown };

  const emscripten = await glue.default({ wasmBinary });
  swe = new wrapper.default(emscripten) as SwissEph;

  context = {
    auth: OWNER,
    kv: new FakeKv(),
    getEngine: async () => swe,
    now: () => new Date("2026-08-25T00:00:00Z"),
  };
  chartId = (await call("save_chart", BIRTH)).structuredContent.chart_id as string;
});

/** 返り値の時刻の札（"2026-08-26 12:55+09:00"）→ ユリウス日（分どまり） */
function jdOf(time: string, utcOffset: number): number {
  const [date, clock] = time.split(" ");
  const [year, month, day] = (date as string).split("-").map(Number);
  const [hour, minute] = (clock as string).slice(0, 5).split(":").map(Number);
  return julianDay(swe, {
    year: year as number,
    month: month as number,
    day: day as number,
    hour: hour as number,
    minute: minute as number,
    utcOffset,
  });
}

/** その瞬間の月の黄経（本物の計算） */
function moonLonAt(jd: number): number {
  return normalizeDegree(swe.swe_calc_ut(jd, MOON_ID, CALC_FLAGS)[0] as number);
}

/** 分に丸めたぶんの許容（度）。0.01° ＝月の 1.1 分ぶん */
const TOLERANCE_DEGREES = 0.01;

describe("空の暦の部分は公開層の moon_calendar と同一", () => {
  it("62 日ぶんで deepEqual（同じ start / days / utc_offset）", async () => {
    const args = { start: "2026-08-25", days: 62, utc_offset: 9 };
    const natal = await call("natal_moon_calendar", { chart_id: chartId, ...args });
    const sky = await call("moon_calendar", args);

    expect(natal.structuredContent.range).toEqual(sky.structuredContent.range);
    expect(natal.structuredContent.phases).toEqual(sky.structuredContent.phases);
    expect(natal.structuredContent.ingresses).toEqual(sky.structuredContent.ingresses);
    expect(natal.structuredContent.void_of_course).toEqual(sky.structuredContent.void_of_course);
    expect(natal.structuredContent.eclipses).toEqual(sky.structuredContent.eclipses);
    // moon_at_start に増えたのは house の 1 つだけ
    const { house, ...atStart } = natal.structuredContent.moon_at_start;
    expect(atStart).toEqual(sky.structuredContent.moon_at_start);
    expect(house).toBeGreaterThanOrEqual(1);
    expect(house).toBeLessThanOrEqual(12);
    // 空の暦の規約もそのまま（この科のぶんが 4 つ増えるだけ）
    for (const [key, value] of Object.entries(sky.structuredContent.conventions)) {
      expect(natal.structuredContent.conventions[key]).toEqual(value);
    }
    // テキストも公開層のものが頭にそのまま乗る
    expect((natal.content[0].text as string).startsWith(sky.content[0].text as string)).toBe(true);
  });
});

describe("ハウス入り", () => {
  it("その時刻に月の黄経がカスプと 0.01° 以内で一致する", async () => {
    const result = await call("natal_moon_calendar", {
      chart_id: chartId,
      start: "2026-08-25",
      days: 62,
      utc_offset: 9,
    });
    const cusps = (await call("get_chart", { chart_id: chartId })).structuredContent
      .cusps as number[];

    const ingresses = result.structuredContent.house_ingresses as {
      time: string;
      house: number;
      from_house: number;
    }[];
    // 月は 27.3 日で 12 ハウスをひとめぐり。62 日なら 27 回前後
    expect(ingresses.length).toBeGreaterThanOrEqual(26);
    expect(ingresses.length).toBeLessThanOrEqual(28);

    for (const entry of ingresses) {
      const cusp = cusps[entry.house - 1] as number;
      const gap = Math.abs(wrap180(moonLonAt(jdOf(entry.time, 9)) - cusp));
      expect(gap).toBeLessThan(TOLERANCE_DEGREES);
      expect(entry.from_house).toBe(entry.house === 1 ? 12 : entry.house - 1);
    }
  });

  it("ハウスは 1 つずつ順送り（月は順行しかしないので飛ばない）", async () => {
    const result = await call("natal_moon_calendar", {
      chart_id: chartId,
      start: "2026-08-25",
      days: 62,
      utc_offset: 9,
    });
    const houses = (result.structuredContent.house_ingresses as { house: number }[]).map(
      (entry) => entry.house,
    );
    for (let index = 1; index < houses.length; index++) {
      const previous = houses[index - 1] as number;
      expect(houses[index]).toBe((previous % 12) + 1);
    }
    // 期間の頭のハウスの次から始まる
    expect(houses[0]).toBe((result.structuredContent.moon_at_start.house % 12) + 1);
  });
});

describe("ネイタルへの exact", () => {
  it("その時刻の離角が目標の角度と 0.01° 以内で一致する", async () => {
    const result = await call("natal_moon_calendar", {
      chart_id: chartId,
      start: "2026-08-25",
      days: 62,
      utc_offset: 9,
    });
    const chart = (await call("get_chart", { chart_id: chartId })).structuredContent;
    const natalLon = new Map<string, number>(
      (chart.planets as { name: string; lon: number }[]).map((planet) => [planet.name, planet.lon]),
    );
    natalLon.set("ASC", chart.angles.asc as number);
    natalLon.set("MC", chart.angles.mc as number);

    const aspects = result.structuredContent.natal_aspects as {
      time: string;
      target: string;
      angle: number;
      moon_sign: string;
      moon_degree: number;
    }[];
    // 12 点 × メジャー 5 種（60/90/120 は前後 2 か所）× 2.27 周ぶん
    expect(aspects.length).toBeGreaterThan(150);

    for (const entry of aspects) {
      const target = natalLon.get(entry.target);
      expect(target).toBeDefined();
      const moon = moonLonAt(jdOf(entry.time, 9));
      const separation = Math.abs(wrap180(moon - (target as number)));
      expect(Math.abs(separation - entry.angle)).toBeLessThan(TOLERANCE_DEGREES);
      // 返している星座と度数も、その離角から出る黄経と一致する
      expect(Math.abs(wrap180(moon - (entry.moon_degree + degreeToSignBase(entry.moon_sign))))).
        toBeLessThan(TOLERANCE_DEGREES);
    }

    // ノードは相手に入れない
    expect(aspects.every((entry) => entry.target !== "Nノード")).toBe(true);
    // 時系列（同じ瞬間に 2 本立つこともあるので「後戻りしない」で見る）
    const times = aspects.map((entry) => entry.time);
    expect([...times].sort()).toEqual(times);
  });
});

/** 星座名 → その星座の始まりの黄経（度） */
function degreeToSignBase(sign: string): number {
  const signs = [
    "牡羊座",
    "牡牛座",
    "双子座",
    "蟹座",
    "獅子座",
    "乙女座",
    "天秤座",
    "蠍座",
    "射手座",
    "山羊座",
    "水瓶座",
    "魚座",
  ];
  const index = signs.indexOf(sign);
  expect(index).toBeGreaterThanOrEqual(0);
  return index * 30;
}

describe("個人朔望", () => {
  it("ネイタル月との 0° は lunar_return と 1 分以内で同じ瞬間", async () => {
    // 期間の頭（UTC 0 時）を context.now とそろえて、「now より後の次の 1 回」を同じ土俵に乗せる
    const result = await call("natal_moon_calendar", {
      chart_id: chartId,
      start: "2026-08-25",
      days: 30,
      utc_offset: 0,
    });
    const conjunctions = (
      result.structuredContent.personal_phases as {
        kind: string;
        relative_to: string;
        time: string;
      }[]
    ).filter((entry) => entry.kind === "new_moon_equivalent" && entry.relative_to === "natal_moon");
    // 30 日なら 1 回か 2 回（27.3 日周期）
    expect(conjunctions.length).toBeGreaterThanOrEqual(1);

    const lunar = await call("lunar_return", { chart_id: chartId });
    expect(lunar.structuredContent.is_next).toBe(true);
    const returnJd = lunar.structuredContent.returns[0].jd as number;

    const minutes = Math.abs(jdOf(conjunctions[0]?.time as string, 0) - returnJd) * 24 * 60;
    expect(minutes).toBeLessThan(1);
  });

  it("0° と 180° は同じ瞬間の合・衝としても natal_aspects に並ぶ（重複は承知のうえ）", async () => {
    const result = await call("natal_moon_calendar", {
      chart_id: chartId,
      start: "2026-08-25",
      days: 30,
      utc_offset: 9,
    });
    const phases = result.structuredContent.personal_phases as {
      kind: string;
      relative_to: string;
      time: string;
    }[];
    const aspects = result.structuredContent.natal_aspects as {
      time: string;
      target: string;
      angle: number;
    }[];

    const pairs = [
      { kind: "new_moon_equivalent", angle: 0 },
      { kind: "full_moon_equivalent", angle: 180 },
    ];
    for (const anchor of [
      { relative_to: "natal_sun", target: "太陽" },
      { relative_to: "natal_moon", target: "月" },
    ]) {
      for (const pair of pairs) {
        for (const phase of phases.filter(
          (entry) => entry.relative_to === anchor.relative_to && entry.kind === pair.kind,
        )) {
          expect(
            aspects.some(
              (entry) =>
                entry.target === anchor.target &&
                entry.angle === pair.angle &&
                entry.time === phase.time,
            ),
          ).toBe(true);
        }
      }
    }

    // 上弦・下弦のほうは「向き」があって初めて言えるので、合・衝には出てこない
    const quarters = phases.filter(
      (entry) =>
        entry.kind === "first_quarter_equivalent" || entry.kind === "last_quarter_equivalent",
    );
    expect(quarters.length).toBeGreaterThan(0);
  });

  it("4 相はネイタルの一点ごとに順にめぐる（新月→上弦→満月→下弦）", async () => {
    const result = await call("natal_moon_calendar", {
      chart_id: chartId,
      start: "2026-08-25",
      days: 62,
      utc_offset: 9,
    });
    const order = [
      "new_moon_equivalent",
      "first_quarter_equivalent",
      "full_moon_equivalent",
      "last_quarter_equivalent",
    ];
    for (const anchor of ["natal_sun", "natal_moon"]) {
      const mine = (
        result.structuredContent.personal_phases as { kind: string; relative_to: string }[]
      ).filter((entry) => entry.relative_to === anchor);
      // 62 日なら 2 周ぶん＝ 8 つ前後
      expect(mine.length).toBeGreaterThanOrEqual(8);
      for (let index = 1; index < mine.length; index++) {
        const previous = order.indexOf(mine[index - 1]?.kind as string);
        expect(order.indexOf(mine[index]?.kind as string)).toBe((previous + 1) % 4);
      }
    }
  });
});
