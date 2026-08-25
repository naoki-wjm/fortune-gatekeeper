/**
 * 月まわりの暦（moon_calendar）を**偽エンジン**で。
 *
 * 見るのは配線と枝の分かれ方 ―― 引数の検算・エンジンが無いときの断り・
 * 「その星座でアスペクトが 1 つも無い」ボイド・食の種類の名前づけ。
 * 本物の空と突き合わせるのは test/moon-calendar-real.test.ts のほう。
 *
 * ⚠ 偽エンジンの既定は「天体が id×30° に等間隔で並ぶ」作りで、月（30°）と相手の離角が
 *    ちょうどアスペクトの角度（270° や 180° など）に居座ってしまう。そこで月だけ 37.5° に
 *    停めて、どの目標からも 7.5° 離す ―― こうするとアスペクトが 1 本も立たず、
 *    `last_aspect: null` の枝がまるごと通る。
 */
import { describe, expect, it } from "vitest";
import { callTool, handleMcpRequest, type ToolResult } from "../src/mcp";
import {
  MOON_CALENDAR_MAX_DAYS,
  formatOffsetSuffix,
  parseMoonCalendarArguments,
  type MoonCalendarResult,
} from "../src/moon-calendar";
import { makeFakeEngine, type FakeEngine } from "./stubs/fake-engine";

/** 期間の頭（2026-08-25 00:00 JST）に月の星座入りを合わせた偽エンジン */
function makeMoonEngine(): { fake: FakeEngine; startJd: number } {
  const fake = makeFakeEngine();
  const original = fake.swe_calc_ut;
  fake.swe_calc_ut = (jd: number, id: number, flags: number): number[] =>
    id === 1 ? [37.5, 0, 1, 13, 0, 0] : original(jd, id, flags);

  const startJd = fake.swe_julday(2026, 8, 25, -9, 1);
  // 星座入りを 2.3 日おき（本物と同じくらい）にして、期間の頭のひとつ前から始める
  fake.moonPeriod = 2.3;
  fake.moonAnchorJd = startJd;
  return { fake, startJd };
}

const NOW = new Date("2026-08-25T03:00:00Z");

async function call(args: unknown, fake?: FakeEngine): Promise<ToolResult> {
  const engine = fake ?? makeMoonEngine().fake;
  return await callTool("moon_calendar", args, {
    getEngine: async () => engine,
    now: () => NOW,
  });
}

function structured(result: ToolResult): MoonCalendarResult {
  return result.structuredContent as MoonCalendarResult;
}

describe("引数の検算（天体計算より先に断る）", () => {
  it("days は 1〜62 の整数", () => {
    for (const days of [0, -1, MOON_CALENDAR_MAX_DAYS + 1, 365]) {
      expect(() => parseMoonCalendarArguments({ days }, NOW)).toThrow(/days は 1 以上 62 以下/);
    }
    expect(() => parseMoonCalendarArguments({ days: 7.5 }, NOW)).toThrow(/days は整数/);
    expect(() => parseMoonCalendarArguments({ days: "7" }, NOW)).toThrow(/days は整数/);
    expect(parseMoonCalendarArguments({ days: 62 }, NOW).days).toBe(62);
    expect(parseMoonCalendarArguments({ days: 1 }, NOW).days).toBe(1);
  });

  it("days を省くと 14 日", () => {
    expect(parseMoonCalendarArguments({}, NOW).days).toBe(14);
    expect(parseMoonCalendarArguments(undefined, NOW).days).toBe(14);
  });

  it('start は "YYYY-MM-DD"。実在しない暦日も弾く', () => {
    expect(() => parseMoonCalendarArguments({ start: "2026/08/25" }, NOW)).toThrow(
      /YYYY-MM-DD/,
    );
    expect(() => parseMoonCalendarArguments({ start: "2026-8-25" }, NOW)).toThrow(/YYYY-MM-DD/);
    expect(() => parseMoonCalendarArguments({ start: 20260825 }, NOW)).toThrow(/YYYY-MM-DD/);
    expect(() => parseMoonCalendarArguments({ start: "2026-13-01" }, NOW)).toThrow(/暦の範囲/);
    // 2 月 31 日は黙って 3 月へ繰り上がる前に断る
    expect(() => parseMoonCalendarArguments({ start: "2026-02-31" }, NOW)).toThrow(
      /暦に存在しない日付/,
    );
    expect(parseMoonCalendarArguments({ start: "2026-02-28" }, NOW).start).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
  });

  it("start を省くと utc_offset の暦での今日（時差で日付が変わる）", () => {
    // 2026-08-25 03:00 UTC は、UTC+9 では同じ日の 12 時／UTC−9 では前日の 18 時
    expect(parseMoonCalendarArguments({}, NOW).start).toEqual({ year: 2026, month: 8, day: 25 });
    expect(parseMoonCalendarArguments({ utc_offset: -9 }, NOW).start).toEqual({
      year: 2026,
      month: 8,
      day: 24,
    });
  });

  it("utc_offset は -14〜14 の数値", () => {
    expect(() => parseMoonCalendarArguments({ utc_offset: 15 }, NOW)).toThrow(/-14 以上 14 以下/);
    expect(() => parseMoonCalendarArguments({ utc_offset: "9" }, NOW)).toThrow(/数値で/);
    expect(parseMoonCalendarArguments({}, NOW).utcOffset).toBe(9);
    expect(parseMoonCalendarArguments({ utc_offset: 5.5 }, NOW).utcOffset).toBe(5.5);
  });

  it("voc_bodies は modern / traditional のどちらか", () => {
    expect(() => parseMoonCalendarArguments({ voc_bodies: "hellenistic" }, NOW)).toThrow(
      /modern \/ traditional/,
    );
    expect(parseMoonCalendarArguments({}, NOW).vocBodies).toBe("modern");
    expect(parseMoonCalendarArguments({ voc_bodies: "traditional" }, NOW).vocBodies).toBe(
      "traditional",
    );
  });

  it("未知の引数は黙って無視せず断る", async () => {
    const result = await call({ day: 7 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("未知の引数");
  });
});

describe("時差の札", () => {
  it("+09:00 / -03:00 / +05:30 の形", () => {
    expect(formatOffsetSuffix(9)).toBe("+09:00");
    expect(formatOffsetSuffix(0)).toBe("+00:00");
    expect(formatOffsetSuffix(-3)).toBe("-03:00");
    expect(formatOffsetSuffix(5.5)).toBe("+05:30");
    expect(formatOffsetSuffix(-9.5)).toBe("-09:30");
    expect(formatOffsetSuffix(14)).toBe("+14:00");
  });
});

describe("エンジンが使えないとき", () => {
  it("getEngine が無ければ断る（納甲と同じ言い方）", async () => {
    const result = await callTool("moon_calendar", {}, { now: () => NOW });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "天体計算エンジンが使えないため月まわりの暦を出せません",
    );
  });

  it("初期化に失敗したらその中身も添える", async () => {
    const result = await callTool(
      "moon_calendar",
      {},
      {
        getEngine: () => Promise.reject(new Error("wasm が読めません")),
        now: () => NOW,
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("天体計算エンジンを初期化できませんでした");
    expect(result.content[0]?.text).toContain("wasm が読めません");
  });

  it("引数が変なときはエンジンを一度も呼ばない", async () => {
    let touched = false;
    const result = await callTool(
      "moon_calendar",
      { days: 999 },
      {
        getEngine: () => {
          touched = true;
          return Promise.reject(new Error("呼ばれてはいけない"));
        },
        now: () => NOW,
      },
    );
    expect(result.isError).toBe(true);
    expect(touched).toBe(false);
  });
});

describe("ボイドに 1 つもアスペクトが無いとき", () => {
  it("last_aspect は null で、星座入りから次の星座入りまで丸ごとボイド＋注記", async () => {
    const result = await call({ start: "2026-08-25", days: 7 });
    expect(result.isError).toBeUndefined();
    const data = structured(result);

    expect(data.void_of_course.length).toBeGreaterThan(0);
    for (const entry of data.void_of_course) {
      expect(entry.last_aspect).toBeNull();
      expect(entry.note).toContain("メジャーアスペクトが 1 つもありませんでした");
      expect(entry.clipped).toBe(false);
    }
    // 止まった月なので朔望も起きない（離角が動かない）
    expect(data.phases).toEqual([]);
    expect(result.content[0]?.text).toContain("この星座ではアスペクトなし");
  });

  it("星座入りは順送りで、ボイドの終わりは次の星座入りと同じ時刻", async () => {
    const data = structured(await call({ start: "2026-08-25", days: 7 }));
    const times = new Set(data.ingresses.map((entry) => entry.time));
    // 最後の 1 本だけは期間の外で終わってよい（切らない）
    for (const entry of data.void_of_course.slice(0, -1)) {
      expect(times.has(entry.end)).toBe(true);
    }
    for (const entry of data.ingresses) {
      expect(entry.sign).not.toBe(entry.from_sign);
    }
  });

  it("開始時点の月と、そのときボイド中かどうかを返す", async () => {
    const data = structured(await call({ start: "2026-08-25", days: 7 }));
    // 偽エンジンの月は 37.5°＝牡牛座 7.5°
    expect(data.moon_at_start.sign).toBe("牡牛座");
    expect(data.moon_at_start.degree).toBe(7.5);
    expect(data.moon_at_start.void_of_course).toBe(true);
    expect(data.range.utc_offset).toBe(9);
    expect(data.range.days).toBe(7);
    expect(data.range.start).toBe("2026-08-25 00:00+09:00");
    expect(data.range.end).toBe("2026-09-01 00:00+09:00");
  });

  it("規約は名前で返す", async () => {
    const result = await call({ start: "2026-08-25", days: 7, voc_bodies: "traditional" });
    const data = structured(result);
    expect(data.conventions).toEqual({
      void_of_course: "last_exact_major_aspect_to_next_ingress",
      voc_bodies: "traditional",
      aspects: [0, 60, 90, 120, 180],
      orb: 0,
      eclipses: "global",
      zodiac: "tropical",
      ephemeris: "moshier",
    });
    // 解釈は載せない（読みは呼び出した側）
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("ボイドの吉凶・過ごし方はこのサーバーに載っていません");
    expect(text).toContain("合算の根拠にはならない");
    expect(text).toContain("ボイドの定義は流派で割れます");
    expect(text).toContain("伝統式（太陽・水星・金星・火星・木星・土星の 7 天体）");
  });
});

describe("JSON-RPC の口から（POST /mcp のディスパッチ）", () => {
  it("tools/call で引ける（引数の綴りも入口で検問される）", async () => {
    const { fake } = makeMoonEngine();
    const response = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 71,
          method: "tools/call",
          params: {
            name: "moon_calendar",
            arguments: { start: "2026-08-25", days: 7, utc_offset: 9 },
          },
        }),
      }),
      { getEngine: async () => fake, now: () => NOW },
    );
    const json = (await response.json()) as {
      result: { isError?: boolean; content: { text: string }[]; structuredContent: MoonCalendarResult };
    };
    expect(json.result.isError).toBeUndefined();
    expect(json.result.structuredContent.range.days).toBe(7);
    expect(json.result.content[0]?.text).toContain("月まわりの暦");
  });
});

describe("食の種類を名前に直す", () => {
  it("日食は部分・金環・皆既・金環皆既を見分ける", async () => {
    const { fake, startJd } = makeMoonEngine();
    fake.solarEclipses = [
      { jd: startJd + 1, type: "partial" },
      { jd: startJd + 3, type: "annular" },
      { jd: startJd + 5, type: "total" },
      { jd: startJd + 7, type: "hybrid" },
    ];
    const data = structured(await call({ start: "2026-08-25", days: 14 }, fake));
    expect(data.eclipses.map((entry) => `${entry.kind}:${entry.type}`)).toEqual([
      "solar:partial",
      "solar:annular",
      "solar:total",
      "solar:hybrid",
    ]);
  });

  it("月食は半影・部分・皆既を見分ける（半影も落とさない）", async () => {
    const { fake, startJd } = makeMoonEngine();
    fake.lunarEclipses = [
      { jd: startJd + 2, type: "penumbral" },
      { jd: startJd + 4, type: "partial" },
      { jd: startJd + 6, type: "total" },
    ];
    const data = structured(await call({ start: "2026-08-25", days: 14 }, fake));
    expect(data.eclipses.map((entry) => `${entry.kind}:${entry.type}`)).toEqual([
      "lunar:penumbral",
      "lunar:partial",
      "lunar:total",
    ]);
  });

  it("期間の外の食は載せない", async () => {
    const { fake, startJd } = makeMoonEngine();
    fake.solarEclipses = [{ jd: startJd + 20, type: "total" }];
    fake.lunarEclipses = [{ jd: startJd - 1, type: "total" }];
    const data = structured(await call({ start: "2026-08-25", days: 14 }, fake));
    expect(data.eclipses).toEqual([]);
  });

  it("日食と月食は 1 本の時系列に混ぜて日付順に並ぶ", async () => {
    const { fake, startJd } = makeMoonEngine();
    fake.solarEclipses = [{ jd: startJd + 5, type: "total" }];
    fake.lunarEclipses = [{ jd: startJd + 2, type: "partial" }];
    const data = structured(await call({ start: "2026-08-25", days: 14 }, fake));
    expect(data.eclipses.map((entry) => entry.kind)).toEqual(["lunar", "solar"]);
    const text = (await call({ start: "2026-08-25", days: 14 }, fake)).content[0]?.text ?? "";
    expect(text).toContain("［部分月食］食の最大");
    expect(text).toContain("［皆既日食］食の最大");
    expect(text.indexOf("部分月食")).toBeLessThan(text.indexOf("皆既日食"));
  });
});
