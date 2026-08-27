/**
 * 逆引きホロスコープ（reverse_horoscope）を**偽エンジン**で。
 *
 * 見るのは配線と枝の分かれ方 ―― 引数の検算・エンジンが無いときの断り・窓の交差・暦日への丸め・
 * optional の並べ替え・上限で切ったときの印。本物の空と突き合わせるのは
 * test/reverse-horoscope-real.test.ts のほう。
 *
 * ⚠ 偽エンジンの作り（test/stubs/fake-engine.ts）:
 *    - `swe_calc_ut` は天体を id×30° に**止めて**返す（水星＝60°＝双子座、金星＝90°＝蟹座で逆行）。
 *      つまり「水星 双子座」は範囲まるごと当たり・「水星 牡羊座」は 1 日も当たらない、という
 *      両極端を作れる。
 *    - `swe_solcross_ut` / `swe_mooncross_ut` は**目標の黄経を見ずに**周期の格子を返す。
 *      入口→出口→入口…と交互に読むので、`sunPeriod` を 400 にすれば「範囲の頭から 100 日」の
 *      窓が 1 本だけ、という形が作れる（下の makeReverseEngine）。
 */
import { describe, expect, it } from "vitest";
import { callTool, handleMcpRequest, type ToolResult } from "../src/mcp";
import {
  MAX_CANDIDATES,
  REVERSE_MAX_SPAN_YEARS,
  parseReverseHoroscopeArguments,
  type ReverseHoroscopeResult,
} from "../src/reverse-horoscope";
import { makeFakeEngine, type FakeEngine } from "./stubs/fake-engine";

/** 2000-01-01 00:00 UT のユリウス日（偽エンジンの swe_julday は本物と同じ式） */
const RANGE_START_JD = 2451544.5;

/** 太陽の窓が「2000-01-01 から 100 日ぶん」の 1 本だけになる偽エンジン */
function makeReverseEngine(): FakeEngine {
  const fake = makeFakeEngine();
  // 入口 → 出口の間隔がそのまま窓の長さになる（400 日ごとの格子＝範囲に入るのは 1 本だけ）
  fake.sunPeriod = 400;
  fake.sunAnchorJd = RANGE_START_JD + 100;
  // 月は既定の 27.32 日周期のまま、位相だけ範囲の頭に合わせる
  fake.moonAnchorJd = RANGE_START_JD + 5;
  return fake;
}

/** 太陽の窓が「2000-01-01 から 20 日ぶん」だけになる偽エンジン（切られない小さい形） */
function makeShortEngine(): FakeEngine {
  const fake = makeFakeEngine();
  fake.sunPeriod = 360;
  fake.sunAnchorJd = RANGE_START_JD + 20;
  return fake;
}

async function call(args: unknown, fake?: FakeEngine): Promise<ToolResult> {
  const engine = fake ?? makeReverseEngine();
  return await callTool("reverse_horoscope", args, { getEngine: async () => engine });
}

function structured(result: ToolResult): ReverseHoroscopeResult {
  return result.structuredContent as ReverseHoroscopeResult;
}

/** 太陽だけの条件（2000 年・UT）。偽エンジンでは範囲の頭から 100 日ぶんが当たる */
const SUN_ONLY = {
  conditions: [{ body: "sun", sign: "aries" }],
  year_from: 2000,
  year_to: 2000,
  utc_offset: 0,
};

describe("引数の検算（天体計算より先に断る）", () => {
  it("conditions は配列で、空なら断る", () => {
    expect(() => parseReverseHoroscopeArguments({ year_from: 2000, year_to: 2000 })).toThrow(
      /conditions は条件の配列/,
    );
    expect(() =>
      parseReverseHoroscopeArguments({ conditions: [], year_from: 2000, year_to: 2000 }),
    ).toThrow(/conditions が空/);
    expect(() =>
      parseReverseHoroscopeArguments({ conditions: "sun", year_from: 2000, year_to: 2000 }),
    ).toThrow(/conditions は条件の配列/);
  });

  it("sign は日本語でも英語でも受ける（同じ番号になる）", () => {
    const japanese = parseReverseHoroscopeArguments({
      conditions: [{ body: "sun", sign: "牡羊座" }],
      year_from: 2000,
      year_to: 2000,
    });
    const english = parseReverseHoroscopeArguments({
      conditions: [{ body: "sun", sign: "ARIES" }],
      year_from: 2000,
      year_to: 2000,
    });
    expect(japanese.conditions[0]?.signIndex).toBe(0);
    expect(english.conditions[0]?.signIndex).toBe(0);

    const fish = parseReverseHoroscopeArguments({
      conditions: [{ body: "moon", sign: "pisces" }],
      year_from: 2000,
      year_to: 2000,
    });
    expect(fish.conditions[0]?.signIndex).toBe(11);
  });

  it("知らない星座は断る", () => {
    for (const sign of ["蛇遣座", "ophiuchus", "aries座", 3]) {
      expect(() =>
        parseReverseHoroscopeArguments({
          conditions: [{ body: "sun", sign }],
          year_from: 2000,
          year_to: 2000,
        }),
      ).toThrow(/星座/);
    }
  });

  it("body は英語でも日本語でも受け、知らない天体は断る", () => {
    const english = parseReverseHoroscopeArguments({
      conditions: [{ body: "pluto", sign: "aries" }],
      year_from: 2000,
      year_to: 2000,
    });
    expect(english.conditions[0]?.body).toBe("pluto");

    const japanese = parseReverseHoroscopeArguments({
      conditions: [{ body: "冥王星", sign: "aries" }],
      year_from: 2000,
      year_to: 2000,
    });
    expect(japanese.conditions[0]?.body).toBe("pluto");

    // ノード・アングル・キロンのたぐいは持たない
    for (const body of ["node", "chiron", "asc", "Nノード", 0]) {
      expect(() =>
        parseReverseHoroscopeArguments({
          conditions: [{ body, sign: "aries" }],
          year_from: 2000,
          year_to: 2000,
        }),
      ).toThrow(/天体/);
    }
  });

  it("同じ天体を 2 回は指定できない", () => {
    expect(() =>
      parseReverseHoroscopeArguments({
        conditions: [
          { body: "sun", sign: "aries" },
          { body: "sun", sign: "taurus" },
        ],
        year_from: 2000,
        year_to: 2000,
      }),
    ).toThrow(/同じ天体を 2 回/);
  });

  it("条件の中の綴り違いも黙って無視せず断る", () => {
    expect(() =>
      parseReverseHoroscopeArguments({
        conditions: [{ body: "sun", sign: "aries", priorty: "optional" }],
        year_from: 2000,
        year_to: 2000,
      }),
    ).toThrow(/未知のキー/);
    expect(() =>
      parseReverseHoroscopeArguments({
        conditions: [{ body: "sun", sign: "aries", priority: "できれば" }],
        year_from: 2000,
        year_to: 2000,
      }),
    ).toThrow(/required \/ optional/);
  });

  it("required が 1 本も無ければ断る", () => {
    expect(() =>
      parseReverseHoroscopeArguments({
        conditions: [{ body: "sun", sign: "aries", priority: "optional" }],
        year_from: 2000,
        year_to: 2000,
      }),
    ).toThrow(/required の条件が 1 本もありません/);
  });

  it("year_from / year_to は必須の整数で、暦の範囲と 30 年ぶんの枠がある", () => {
    const conditions = [{ body: "sun", sign: "aries" }];
    expect(() => parseReverseHoroscopeArguments({ conditions, year_to: 2000 })).toThrow(
      /year_from は必須/,
    );
    expect(() => parseReverseHoroscopeArguments({ conditions, year_from: 2000 })).toThrow(
      /year_to は必須/,
    );
    expect(() =>
      parseReverseHoroscopeArguments({ conditions, year_from: 2000.5, year_to: 2000 }),
    ).toThrow(/西暦の整数/);
    expect(() =>
      parseReverseHoroscopeArguments({ conditions, year_from: 1700, year_to: 1710 }),
    ).toThrow(/1800 以上 2200 以下/);
    expect(() =>
      parseReverseHoroscopeArguments({ conditions, year_from: 2190, year_to: 2210 }),
    ).toThrow(/1800 以上 2200 以下/);
    expect(() =>
      parseReverseHoroscopeArguments({ conditions, year_from: 2010, year_to: 2000 }),
    ).toThrow(/year_to は year_from 以上/);
    // 両端を含めて 30 年ぶんまで（2000〜2029 は通る・2000〜2030 は 31 年で断る）
    expect(
      parseReverseHoroscopeArguments({ conditions, year_from: 2000, year_to: 2029 }).yearTo,
    ).toBe(2029);
    expect(() =>
      parseReverseHoroscopeArguments({ conditions, year_from: 2000, year_to: 2030 }),
    ).toThrow(new RegExp(`${REVERSE_MAX_SPAN_YEARS} 年ぶんまで`));
  });

  it("utc_offset は -14〜14 の数値（既定 9）", () => {
    const conditions = [{ body: "sun", sign: "aries" }];
    expect(
      parseReverseHoroscopeArguments({ conditions, year_from: 2000, year_to: 2000 }).utcOffset,
    ).toBe(9);
    expect(
      parseReverseHoroscopeArguments({ conditions, year_from: 2000, year_to: 2000, utc_offset: 5.5 })
        .utcOffset,
    ).toBe(5.5);
    expect(() =>
      parseReverseHoroscopeArguments({ conditions, year_from: 2000, year_to: 2000, utc_offset: 15 }),
    ).toThrow(/-14 以上 14 以下/);
    expect(() =>
      parseReverseHoroscopeArguments({ conditions, year_from: 2000, year_to: 2000, utc_offset: "9" }),
    ).toThrow(/数値で/);
  });

  it("未知の引数（入口の検問）も黙って無視せず断る", async () => {
    const result = await call({ ...SUN_ONLY, years: 3 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("未知の引数");
  });

  it("引数の言い分はそのまま返る（固定文に丸めない）", async () => {
    const result = await call({ ...SUN_ONLY, year_to: 2050 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("30 年ぶんまで");
    expect(result.content[0]?.text).not.toContain("参照ID");
  });
});

describe("エンジンが使えないとき", () => {
  it("getEngine が無ければ断る（納甲・月の暦と同じ言い方）", async () => {
    const result = await callTool("reverse_horoscope", SUN_ONLY, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "天体計算エンジンが使えないため逆引きホロスコープを出せません",
    );
  });

  it("初期化に失敗したときは固定文だけ返す（中身は添えない）", async () => {
    const result = await callTool("reverse_horoscope", SUN_ONLY, {
      getEngine: () => Promise.reject(new Error("wasm が読めません")),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("天体計算エンジンを初期化できませんでした");
    expect(result.content[0]?.text).toMatch(/参照ID: [0-9a-f]{8}$/);
    expect(result.content[0]?.text).not.toContain("wasm が読めません");
  });

  it("引数が変なときはエンジンを一度も呼ばない", async () => {
    let touched = false;
    const result = await callTool(
      "reverse_horoscope",
      { ...SUN_ONLY, year_from: 1500 },
      {
        getEngine: () => {
          touched = true;
          return Promise.reject(new Error("呼ばれてはいけない"));
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(touched).toBe(false);
  });

  it("通過計算が壊れた答えを返したら断る（壊れた wrapper の検算）", async () => {
    const fake = makeReverseEngine();
    fake.crossFails = true;
    const result = await call(SUN_ONLY, fake);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("探索開始より後の答えを返しませんでした");
  });
});

describe("窓の交差と暦日への丸め", () => {
  it("太陽だけ＝範囲の頭から 100 日ぶんが候補（上限で切って印を付ける）", async () => {
    const result = await call(SUN_ONLY);
    expect(result.isError).toBeUndefined();
    const data = structured(result);

    // 窓は 2000-01-01 00:00 から 100 日ぶん＝1/1 〜 4/9（4/10 の 0 時ちょうどで終わるので 4/10 は入らない）
    expect(data.total).toBe(100);
    expect(data.truncated).toBe(true);
    expect(data.candidates).toHaveLength(MAX_CANDIDATES);
    expect(data.candidates[0]?.date).toBe("2000-01-01");
    expect(data.candidates[0]?.all_day).toBe(true);
    // 2000 年はうるう年なので、頭から 60 日目は 2 月 29 日
    expect(data.candidates[MAX_CANDIDATES - 1]?.date).toBe("2000-02-29");
    expect(data.range).toEqual({ year_from: 2000, year_to: 2000, years: 1, utc_offset: 0 });
  });

  it("上限を超えたときはテキストにも「絞り方」を書く", async () => {
    const text = (await call(SUN_ONLY)).content[0]?.text ?? "";
    expect(text).toContain("候補: 100 日（一致の多い順→日付順に 60 日だけ載せています）");
    expect(text).toContain("条件を足す");
    expect(text).toContain("年代の範囲を狭める");
  });

  it("月と交差させると窓が短くなり、端の日には時刻の範囲が付く", async () => {
    const result = await call({
      conditions: [
        { body: "sun", sign: "aries" },
        { body: "moon", sign: "taurus" },
      ],
      year_from: 2000,
      year_to: 2000,
      utc_offset: 0,
    });
    const data = structured(result);

    // 偽エンジンの月は 27.32 日おきに入って 27.32 日で出る（範囲に 3 本かかる）ので、
    // 太陽の 100 日と重なるのは 47 日ぶん ―― 太陽だけのときの 100 日より必ず短くなる
    expect(data.total).toBe(47);
    expect(data.truncated).toBe(false);

    // まる 1 日ぶん条件が続く日は「終日」
    const first = data.candidates[0];
    expect(first?.date).toBe("2000-01-01");
    expect(first?.all_day).toBe(true);
    expect(first?.time_ranges).toHaveLength(1);

    // 日の途中で始まる日には、その日の中の時刻の範囲が分単位で付く
    const partial = data.candidates.find((candidate) => candidate.date === "2000-02-02");
    expect(partial?.all_day).toBe(false);
    expect(partial?.time_ranges).toEqual([
      { start: "2000-02-02 07:41+00:00", end: "2000-02-03 00:00+00:00" },
    ]);
    // テキストでは日の尻を 24:00 と書く（翌日の 00:00 と読ませない）
    expect(result.content[0]?.text).toContain("2000-02-02  07:41〜24:00");
  });

  it("止まっている天体（偽エンジン）でも当たり／外れがそのまま出る", async () => {
    // 偽エンジンの水星は 60°＝双子座に止まっている
    const hit = structured(
      await call({
        conditions: [
          { body: "sun", sign: "aries" },
          { body: "mercury", sign: "gemini" },
        ],
        year_from: 2000,
        year_to: 2000,
        utc_offset: 0,
      }),
    );
    expect(hit.total).toBe(100);

    const miss = structured(
      await call({
        conditions: [
          { body: "sun", sign: "aries" },
          { body: "mercury", sign: "牡羊座" },
        ],
        year_from: 2000,
        year_to: 2000,
        utc_offset: 0,
      }),
    );
    expect(miss.total).toBe(0);
    expect(miss.candidates).toEqual([]);
    expect(miss.truncated).toBe(false);
  });

  it("1 日も無いときはテキストで「緩め方」を案内する", async () => {
    const text =
      (
        await call({
          conditions: [
            { body: "sun", sign: "aries" },
            { body: "mercury", sign: "aries" },
          ],
          year_from: 2000,
          year_to: 2000,
          utc_offset: 0,
        })
      ).content[0]?.text ?? "";
    expect(text).toContain("条件がそろう日はありませんでした");
    expect(text).toContain("外惑星");
  });

  it("utc_offset を変えると暦日の切り方が変わる", async () => {
    // 窓が 20 日ぶんだけの偽エンジン（切られないので尻の日まで見られる）
    const utc = structured(await call(SUN_ONLY, makeShortEngine()));
    const tokyo = structured(await call({ ...SUN_ONLY, utc_offset: 9 }, makeShortEngine()));

    // UT で見ると 1/1 0 時から 1/21 0 時ちょうどまで＝20 日、どれも終日
    expect(utc.total).toBe(20);
    expect(utc.candidates.every((candidate) => candidate.all_day)).toBe(true);
    expect(utc.candidates[19]?.date).toBe("2000-01-20");

    // 日本時間で見ると窓の尻が 1/21 の 9 時になるので、1 日増えてその日は途中で終わる
    expect(tokyo.total).toBe(21);
    const last = tokyo.candidates[20];
    expect(last?.date).toBe("2000-01-21");
    expect(last?.all_day).toBe(false);
    expect(last?.time_ranges).toEqual([
      { start: "2000-01-21 00:00+09:00", end: "2000-01-21 09:00+09:00" },
    ]);
  });
});

describe("optional（できれば）の扱い", () => {
  it("候補日は required だけで決まり、optional は数と札で添える", async () => {
    const result = await call({
      conditions: [
        { body: "sun", sign: "aries" },
        { body: "moon", sign: "taurus", priority: "optional" },
      ],
      year_from: 2000,
      year_to: 2000,
      utc_offset: 0,
    });
    const data = structured(result);

    // 候補日の数は太陽だけのときと同じ（optional は絞らない）
    expect(data.total).toBe(100);
    // 並びは「成り立つ数の多い順 → 日付順」＝月もそろう日が先に来る
    expect(data.candidates[0]?.match_count).toBe(2);
    expect(data.candidates[0]?.matched_optional).toEqual(["moon"]);
    expect(data.candidates[0]?.unmatched_optional).toEqual([]);
    expect(data.candidates[0]?.date).toBe("2000-01-01");

    const weaker = data.candidates.find((candidate) => candidate.match_count === 1);
    expect(weaker?.matched_optional).toEqual([]);
    expect(weaker?.unmatched_optional).toEqual(["moon"]);
    // 一致の多い日が先（並べ替えが効いている）
    expect(data.candidates.map((candidate) => candidate.match_count)).toEqual(
      [...data.candidates.map((candidate) => candidate.match_count)].sort((a, b) => b - a),
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("月 牡牛座（できれば）");
    expect(text).toContain("／できれば: moon");
  });

  it("optional だけでは候補日を決められないので断る（required 0 本）", async () => {
    const result = await call({
      conditions: [{ body: "sun", sign: "aries", priority: "optional" }],
      year_from: 2000,
      year_to: 2000,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("required の条件が 1 本もありません");
  });
});

describe("候補日に添える正午の空", () => {
  it("10 天体ぶん・星座の名前と逆行の印だけ（度数は返さない）", async () => {
    const data = structured(await call(SUN_ONLY));
    const positions = data.candidates[0]?.positions ?? [];
    expect(positions).toHaveLength(10);
    expect(positions.map((position) => position.body)).toEqual([
      "sun",
      "moon",
      "mercury",
      "venus",
      "mars",
      "jupiter",
      "saturn",
      "uranus",
      "neptune",
      "pluto",
    ]);
    // 偽エンジンは天体を id×30° に止めるので、太陽＝牡羊座・月＝牡牛座・水星＝双子座…
    expect(positions[0]).toEqual({ body: "sun", name: "太陽", sign: "牡羊座", retrograde: false });
    expect(positions[2]?.sign).toBe("双子座");
    // 金星（id 3）だけ偽エンジンが逆行させている
    expect(positions[3]).toEqual({ body: "venus", name: "金星", sign: "蟹座", retrograde: true });
    // 度数は 1 つも出さない
    expect(JSON.stringify(positions)).not.toContain("degree");

    const text = (await call(SUN_ONLY)).content[0]?.text ?? "";
    expect(text).toContain("正午の空: 太陽 牡羊座 / 月 牡牛座 / 水星 双子座 / 金星 蟹座R");
  });
});

describe("規約と解釈のなさ", () => {
  it("conventions は名前で返す", async () => {
    const data = structured(await call(SUN_ONLY));
    expect(data.conventions).toEqual({
      zodiac: "tropical",
      ephemeris: "moshier",
      sign_boundaries: "every_30_degrees",
      candidate_day: "any_instant_in_the_local_calendar_day_meets_all_required",
      sun_windows: "swe_solcross_ut",
      moon_windows: "swe_mooncross_ut",
      other_bodies: "sparse_samples_with_cubic_hermite",
      positions_at: "local_noon",
      utc_offset: 0,
    });
  });

  it("読みは呼び出した側（解釈は 1 文字も載せない）", async () => {
    const text = (await call(SUN_ONLY)).content[0]?.text ?? "";
    expect(text).toContain("その配置の意味・日の吉凶はこのサーバーに載っていません");
    expect(text).toContain("読みはあなた自身の知識で");
    expect(text).toContain("合算の根拠にはならない");
    // 体系の数は書かない（占術は増えるので）
    expect(text).not.toContain("三体系");
    expect(text).not.toContain("四体系");
  });
});

describe("JSON-RPC の口から（POST /mcp のディスパッチ）", () => {
  it("tools/call で引ける", async () => {
    const fake = makeReverseEngine();
    const response = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 81,
          method: "tools/call",
          params: { name: "reverse_horoscope", arguments: SUN_ONLY },
        }),
      }),
      { getEngine: async () => fake },
    );
    const json = (await response.json()) as {
      result: {
        isError?: boolean;
        content: { text: string }[];
        structuredContent: ReverseHoroscopeResult;
      };
    };
    expect(json.result.isError).toBeUndefined();
    expect(json.result.structuredContent.total).toBe(100);
    expect(json.result.content[0]?.text).toContain("逆引きホロスコープ");
  });
});
