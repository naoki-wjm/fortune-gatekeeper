/**
 * 九星気学（kyusei）の配線。
 *
 * 純関数の検算は test/kyusei.test.ts の担当で、ここは
 * 「出生の瞬間の出どころを決め、wasm から太陽黄経と前後の至を取り、
 *   出生データを漏らさずに盤を返すか」を見る。
 * 偽 KV と偽エンジンだけで回る（本物の wasm は test/kyusei-real.test.ts の担当）。
 *
 * 偽エンジンの太陽は `sunMotionAnchorJd` を立てて**等速**にしてある
 * ―― 素のままだと太陽が止まったまま通過だけ格子で返るので、
 * 「太陽の位置」と「至の時刻」が食い違い、至の間隔の検算に引っかかる（four_pillars と同じ細工）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import type { AuthContext, StoredChart } from "../src/astro/store";
import { board, formatSatsuText, satsu, starOf, type BoardKind } from "../src/kyusei";
import { FakeKv } from "./stubs/fake-kv";
import {
  FAKE_ASCMC,
  FAKE_CUSPS,
  FAKE_TROPICAL_YEAR,
  makeFakeEngine,
  type FakeEngine,
} from "./stubs/fake-engine";

const OWNER: AuthContext = { user: "user1", name: "オーナー", role: "owner" };
const FRIEND: AuthContext = { user: "friend1", name: "ともだち", role: "friend" };

let kv: FakeKv;
let engine: FakeEngine;
let context: AstroContext;

/** 偽エンジンの swe_julday と同じ式（現地時刻ではなく UTC の時で渡す） */
function fakeJd(year: number, month: number, day: number, utcHour: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 2440587.5 + utcHour / 24;
}

/**
 * 見本の出生（2022-11-30 10:00・UTC−8）。
 *
 * **ChatGPT の公開日**を借りています ―― 時刻の 10 時は架空、時差は米国太平洋時間（PST）。
 * 人の誕生日と紛れない公開された日付を見本にする、という取り決めです。
 * 返事に混じったら "2022" や "11-30" ですぐ見つかります。
 */
const BIRTH = {
  label: "九星の見本",
  year: 2022,
  month: 11,
  day: 30,
  hour: 10,
  minute: 0,
  utc_offset: -8,
  lat: 35.6895,
  lng: 139.6917,
};

/** 出生の瞬間（現地 10:00・UTC−8 → UTC では同じ日の 18:00） */
const NATAL_JD = fakeJd(2022, 11, 30, 10 + 8);

/** 出生の瞬間に置く太陽黄経（立冬 225° と大雪 255° のあいだ＝亥月。実物も 11 月末は 248° 前後） */
const NATAL_SUN = 247.98;

/** 出生データの生の値（返事に混ざっていないことを見る札） */
const BIRTH_TRACES = ["2022", "11-30", "10:00", "35.6895", "139.6917", "UTC-8"];

beforeEach(() => {
  kv = new FakeKv();
  engine = makeFakeEngine();
  // 等速太陽（回帰年 1 周）。出生の瞬間がちょうど 247.98° になるように位相を合わせる
  engine.sunMotionAnchorJd = NATAL_JD - (NATAL_SUN / 360) * FAKE_TROPICAL_YEAR;
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

async function saveChart(): Promise<string> {
  const saved = await call("save_chart", BIRTH);
  expect(saved.isError).toBeUndefined();
  return saved.structuredContent.chart_id as string;
}

/** 出生データを預からなかった時代の登録を再現する（台帳へ直接置く） */
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

// ---------------------------------------------------------------------------
// 期待値（手計算の過程はコメントに残す）
// ---------------------------------------------------------------------------

/**
 * 見本の出生の本命星＝五黄土星。
 *
 * 手計算: 2022-11-30 の太陽黄経は 248°（立春 315° の前ではないので年はそのまま 2022）。
 *   数字根 2+0+2+2 = 6、11 − 6 = 5 ＝ 五黄。
 */
const NATAL_HONMEI = 5;

/**
 * 同じく月命星＝二黒土星。
 *
 * 手計算: 月支は monthBranchOrder(248) = floor((248 − 315 + 360) / 30) = 9 ＝ 亥月。
 *   年の星 五黄 は組 二五八 なので寅月が 二黒、そこから 9 か月ぶん下がって
 *   wrapStar(2 − 9) = 2 ＝ 二黒（一周して同じ星に戻る）。
 *   気学暦の「寅申巳亥の年は寅月が二黒」とも合う（2022 年は壬寅＝寅年）。
 */
const NATAL_GETSUMEI = 2;

/**
 * 同じく日命星＝一白水星（陰遁）。
 *
 * 手計算: 偽エンジンの等速太陽では夏至（黄経 90°）が 2022-06-23（現地 UTC−8）に来る。
 *   その日の JDN は 2459754、日干支の index は (2459754 + 49) mod 60 = 43 ＝ 丁未。
 *   43 ≧ 30 なので手前の甲子より次の甲子が近く、切り替えは 2459754 − 43 + 60 = 2459771 ＝ 2022-07-10。
 *   出生日 2022-11-30 の JDN は 2459914 なので 143 日目、陰遁は 9 から 1 日ずつ下がって
 *   wrapStar(9 − 143) = 1 ＝ 一白（次の冬至は 12 月なので、まだ陰遁のまま）。
 */
const NATAL_NICHIMEI = 1;

/**
 * 対象日 2026-08-22（UTC+9 の暦）の三盤の中宮。
 *
 * 手計算:
 *   年 … 2026 の数字根 2+0+2+6 = 10 → 1、11 − 1 = 10 → 10 − 9 = 1 ＝ 一白。
 *   月 … 太陽黄経は 149° 前後で monthBranchOrder = floor((149 − 315 + 360) / 30) = 6 ＝ 申月。
 *        年の星 一白 は組 一四七 なので寅月が 八白、6 か月ぶん下がって wrapStar(8 − 6) = 2 ＝ 二黒。
 *   日 … 2026 年の夏至（6/21）に最も近い甲子は 2026-06-19（JDN 2461211、
 *        (2461211 + 49) mod 60 = 0 ＝ 甲子そのもの）。2026-08-22 の JDN は 2461275 なので 64 日目、
 *        陰遁で wrapStar(9 − 64) = 8 ＝ 八白。
 */
const DATE_CENTERS = { year: 1, month: 2, day: 8 } as const;

/** その日の四柱（年支・月支・日支）。四柱推命の見本と同じ 2026-08-22 ＝ 丙午年・丙申月・戊辰日 */
const DATE_BRANCHES = { year: "午", month: "申", day: "辰" } as const;

/** 配線と同じ道具立てで、期待する盤と殺を純関数から直に組む */
function expectedBoard(kind: BoardKind, center: number, branch: string) {
  const target = board(center);
  return {
    center: target.center,
    branch,
    cells: target.cells,
    satsu: satsu(target, {
      kind,
      branch,
      honmei: NATAL_HONMEI,
      getsumei: NATAL_GETSUMEI,
    }),
  };
}

// ---------------------------------------------------------------------------

describe("kyusei", () => {
  it("預かっている出生データから三星と、指定日の年盤・月盤・日盤を返す", async () => {
    const chartId = await saveChart();
    const result = await call("kyusei", {
      chart_id: chartId,
      date: "2026-08-22",
      date_utc_offset: 9,
    });
    expect(result.isError).toBeUndefined();

    const text: string = result.content[0].text;
    expect(text).toContain("九星気学（年界 立春・月界 節・日界 0 時・陽遁陰遁は至に最も近い甲子）");
    expect(text).toContain(`チャート: 九星の見本（${chartId}）`);
    expect(text).toContain("本命星: 五黄土星 / 月命星: 二黒土星 / 日命星: 一白水星（陰遁）");

    // 対象日は呼び出し側が指定した日なので、そのまま書く
    expect(text).toContain("■ 対象日 2026-08-22（UTC+9 の暦）");
    expect(text).toContain("■ 年盤 丙午年（中宮 一白水星／南が上・東が左）");
    expect(text).toContain("■ 月盤 丙申月（中宮 二黒土星／南が上・東が左）");
    expect(text).toContain("■ 日盤 戊辰日（中宮 八白土星／南が上・東が左）");
    expect(text).toContain("遁: 陰遁（夏至に最も近い甲子 2026-06-19 から 64 日（切り替え当日が 0））");
    // 盤は南が上・東が左（3 行 × 3 升）
    expect(text).toContain("南東 九紫");
    expect(text).toContain("中宮 一白");

    const structured = result.structuredContent;
    expect(structured.kind).toBe("kyusei");
    expect(structured.source).toBe("chart");
    expect(structured.chart_id).toBe(chartId);
    expect(structured.label).toBe("九星の見本");

    expect(structured.birth.honmei).toEqual(starOf(NATAL_HONMEI));
    expect(structured.birth.getsumei).toEqual(starOf(NATAL_GETSUMEI));
    expect(structured.birth.nichimei).toEqual({ star: starOf(NATAL_NICHIMEI), dun: "陰遁" });
    // 境の日ではないので候補は添えない
    expect(structured.birth.alternatives).toBeUndefined();

    expect(structured.date).toMatchObject({
      date: "2026-08-22",
      utc: "2026-08-21T15:00:00.000Z",
      local: "2026-08-22 00:00",
      utc_offset: 9,
      is_now: false,
      has_time: false,
    });
    expect(structured.conventions.day_boundary).toContain("日界は 0 時");
    expect(structured.conventions.leap_dun).toContain("閏遁は置かない");
  });

  it("年盤・月盤・日盤の中宮と 9 升と殺が純関数と一致する", async () => {
    const chartId = await saveChart();
    const result = await call("kyusei", {
      chart_id: chartId,
      date: "2026-08-22",
      date_utc_offset: 9,
    });

    const boards = result.structuredContent.date;
    expect(boards.year).toMatchObject(expectedBoard("year", DATE_CENTERS.year, DATE_BRANCHES.year));
    expect(boards.month).toMatchObject(
      expectedBoard("month", DATE_CENTERS.month, DATE_BRANCHES.month),
    );
    expect(boards.day).toMatchObject(expectedBoard("day", DATE_CENTERS.day, DATE_BRANCHES.day));

    // 干支は四柱推命の見本と同じ日（丙午年・丙申月・戊辰日）
    expect(boards.year.ganzhi).toBe("丙午");
    expect(boards.month.ganzhi).toBe("丙申");
    expect(boards.day.ganzhi).toBe("戊辰");
    // 破はその盤の支の**対冲**（午→子・申→寅・辰→戌）
    expect(boards.year.satsu).toContainEqual({ name: "歳破", direction: "北", branch: "子" });
    expect(boards.month.satsu).toContainEqual({ name: "月破", direction: "北東", branch: "寅" });
    expect(boards.day.satsu).toContainEqual({ name: "日破", direction: "北西", branch: "戌" });

    // テキストの殺の行も純関数の整形そのまま
    const text: string = result.content[0].text;
    expect(text).toContain(`殺: ${formatSatsuText(boards.year.satsu)}`);
    expect(text).toContain(`殺: ${formatSatsuText(boards.day.satsu)}`);

    // 日盤の中宮はその日の星（陽遁・陰遁の数え）と同じ
    expect(boards.day.center).toEqual(starOf(DATE_CENTERS.day));
    expect(boards.day.dun).toBe("陰遁");
  });

  it("生年月日の直接指定でも引ける（時刻ありは登録と同じ答え）", async () => {
    const chartId = await saveChart();
    const viaChart = await call("kyusei", { chart_id: chartId, date: "2026-08-22" });
    const direct = await call("kyusei", {
      year: 2022,
      month: 11,
      day: 30,
      hour: 10,
      minute: 0,
      utc_offset: -8,
      date: "2026-08-22",
    });
    expect(direct.isError).toBeUndefined();

    const text: string = direct.content[0].text;
    expect(text.split("\n")[1]).toBe("出生データ: 直接指定（値は返事に出しません）");
    expect(direct.structuredContent.source).toBe("direct");
    expect(Object.keys(direct.structuredContent)).not.toContain("chart_id");
    expect(Object.keys(direct.structuredContent)).not.toContain("label");
    // 台帳を通した場合とまったく同じ三星（違うのは出どころだけ）
    expect(direct.structuredContent.birth).toEqual(viaChart.structuredContent.birth);
  });

  it("出生時刻は任意（省くとその日の 12 時で見る）", async () => {
    const noTime = await call("kyusei", {
      year: 2022,
      month: 11,
      day: 30,
      utc_offset: -8,
      date: "2026-08-22",
    });
    expect(noTime.isError).toBeUndefined();
    expect(noTime.structuredContent.birth.honmei).toEqual(starOf(NATAL_HONMEI));
    expect(noTime.structuredContent.birth.getsumei).toEqual(starOf(NATAL_GETSUMEI));
    expect(noTime.structuredContent.birth.nichimei.star).toEqual(starOf(NATAL_NICHIMEI));
    // 境の日ではないので、時刻が無くても候補は添えない
    expect(noTime.structuredContent.birth.alternatives).toBeUndefined();

    // 仮に置くのは 12 時＝正午の太陽を引いている（0 時でも 23 時でもない）
    const noon = await call("kyusei", {
      year: 2022,
      month: 11,
      day: 30,
      hour: 12,
      minute: 0,
      utc_offset: -8,
      date: "2026-08-22",
    });
    expect(noTime.structuredContent.birth).toEqual(noon.structuredContent.birth);
  });

  it("立春当日で時刻が無いときだけ、両方の候補を添える", async () => {
    // 偽エンジンの等速太陽では、立春（黄経 315°）は 2023-02-06 の 10:04（現地 UTC−8）に来る。
    // 手計算: 0 時（立春前）は年が 2022 のままで 五黄・丑月なので 月命星 九紫、
    //         23:59（立春後）は年が 2023（数字根 7 → 11 − 7 = 4）で 四緑・寅月なので 八白。
    const boundary = await call("kyusei", { year: 2023, month: 2, day: 6, utc_offset: -8 });
    expect(boundary.isError).toBeUndefined();

    const alternatives = boundary.structuredContent.birth.alternatives;
    expect(alternatives.start).toMatchObject({
      local_time: "00:00",
      honmei: starOf(5),
      getsumei: starOf(9),
    });
    expect(alternatives.end).toMatchObject({
      local_time: "23:59",
      honmei: starOf(4),
      getsumei: starOf(8),
    });
    expect(alternatives.note).toContain("hour / minute を付けると確定します");
    // 仮の 12 時は立春のあとなので、本文は 23:59 側と同じ
    expect(boundary.structuredContent.birth.honmei).toEqual(starOf(4));
    expect(boundary.content[0].text).toContain(
      "※ 立春／節入りの当日の生まれで出生時刻が無いため、" +
        "本命星は 五黄土星 か 四緑木星、月命星は 九紫火星 か 八白土星 のどちらか。",
    );

    // 時刻を付ければ確定する（3 時は立春の前なので 五黄・九紫）
    const fixed = await call("kyusei", {
      year: 2023,
      month: 2,
      day: 6,
      hour: 3,
      minute: 0,
      utc_offset: -8,
    });
    expect(fixed.structuredContent.birth.alternatives).toBeUndefined();
    expect(fixed.structuredContent.birth.honmei).toEqual(starOf(5));
    expect(fixed.structuredContent.birth.getsumei).toEqual(starOf(9));
    expect(fixed.content[0].text).not.toContain("どちらか");

    // 境の日でなければ、時刻が無くても候補は出ない（前日・翌日）
    for (const day of [5, 7]) {
      const plain = await call("kyusei", { year: 2023, month: 2, day, utc_offset: -8 });
      expect(plain.structuredContent.birth.alternatives, String(day)).toBeUndefined();
    }
  });

  it("出生側の日命星には切り替えの甲子日も経過日数も出さない（出生日が復元できるため）", async () => {
    const chartId = await saveChart();
    const result = await call("kyusei", { chart_id: chartId, date: "2026-08-22" });

    const nichimei = result.structuredContent.birth.nichimei;
    expect(Object.keys(nichimei)).toEqual(["star", "dun"]);
    expect(nichimei.switch).toBeUndefined();
    expect(nichimei.days_since_switch).toBeUndefined();

    // 指定日側は呼び出した側が打った日なので、切り替えの甲子日も日数も出してよい
    expect(result.structuredContent.date.day.switch).toEqual({
      kind: "summer",
      year: 2026,
      month: 6,
      day: 19,
    });
    expect(result.structuredContent.date.day.days_since_switch).toBe(64);
  });

  it("date を省くと今で見る（date_utc_offset で暦が変わる）。日付だけなら 0 時・時刻つきも受ける", async () => {
    const chartId = await saveChart();

    // 現在は 2026-08-20 02:15 UTC
    const now = await call("kyusei", { chart_id: chartId });
    expect(now.structuredContent.date.date).toBe("2026-08-20");
    expect(now.structuredContent.date.is_now).toBe(true);
    expect(now.structuredContent.date.has_time).toBe(true);
    expect(now.content[0].text).toContain("（現在時刻）");

    // UTC+9 の土地ではもう 8/20 の 11 時（暦日は同じ）、UTC−9 ではまだ 8/19
    const shifted = await call("kyusei", { chart_id: chartId, date_utc_offset: -9 });
    expect(shifted.structuredContent.date.date).toBe("2026-08-19");
    expect(shifted.content[0].text).toContain("（UTC-9 の暦）");

    const dateOnly = await call("kyusei", { chart_id: chartId, date: "2026-08-22" });
    expect(dateOnly.structuredContent.date.has_time).toBe(false);
    expect(dateOnly.structuredContent.date.local).toBe("2026-08-22 00:00");
    expect(dateOnly.content[0].text).toContain("（時刻の指定が無いので 0 時で見ています）");

    const withTime = await call("kyusei", {
      chart_id: chartId,
      date: "2026-08-22 12:30",
      date_utc_offset: 9,
    });
    expect(withTime.structuredContent.date.has_time).toBe(true);
    expect(withTime.structuredContent.date.utc).toBe("2026-08-22T03:30:00.000Z");
    expect(withTime.structuredContent.date.local).toBe("2026-08-22 12:30");
    // 時盤は無いので、盤は日付だけで呼んだときと同じ
    expect(withTime.structuredContent.date.day.center).toEqual(
      dateOnly.structuredContent.date.day.center,
    );

    for (const date of ["1999-12-31", "2087-03-01"]) {
      const result = await call("kyusei", { chart_id: chartId, date });
      expect(result.isError, date).toBeUndefined();
      expect(result.structuredContent.date.date).toBe(date);
    }
  });

  it("chart_id と直接指定はどちらか一方（両方・どちらも無しは断る）", async () => {
    const chartId = await saveChart();

    const both = await call("kyusei", { chart_id: chartId, year: 2022, month: 11, day: 30 });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain("どちらか一方にしてください");
    expect(both.content[0].text).not.toContain("本命星");

    const neither = await call("kyusei", {});
    expect(neither.isError).toBe(true);
    expect(neither.content[0].text).toContain("chart_id か year / month / day を指定してください");
    expect(neither.content[0].text).toContain("出生時刻 hour / minute は分かれば添えてください");

    // 年月日の一部だけでは断る（時刻は任意でも、生年月日は 3 つそろえる）
    for (const partial of [
      { year: 2022, month: 11 },
      { month: 11, day: 30 },
      { year: 2022, hour: 10, minute: 0 },
    ]) {
      const result = await call("kyusei", partial);
      expect(result.isError, JSON.stringify(partial)).toBe(true);
      expect(result.content[0].text).toContain(
        "生年月日は year / month / day の 3 つをそろえて指定してください",
      );
      expect(result.content[0].text).toContain("省くとその日の 12 時で見ます");
    }

    // utc_offset だけは省いてよい（UTC 扱い）
    const utcBirth = await call("kyusei", { year: 2022, month: 11, day: 30 });
    expect(utcBirth.isError).toBeUndefined();
  });

  it("知らない ID・他人のチャート・出生データの無い古い登録を断る", async () => {
    const unknown = await call("kyusei", { chart_id: "nosuchid" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("チャート nosuchid が見つかりませんでした");

    const chartId = await saveChart();
    const other: AstroContext = { ...context, auth: FRIEND };
    const peek = await call("kyusei", { chart_id: chartId }, other);
    expect(peek.isError).toBe(true);
    expect(peek.content[0].text).toContain("見つかりませんでした");

    const legacy = await call("kyusei", { chart_id: putLegacyChart() });
    expect(legacy.isError).toBe(true);
    expect(legacy.content[0].text).toContain("このチャートには出生データが入っていません");
    expect(legacy.content[0].text).toContain("delete_chart で消して save_chart で登録し直す");
    // 断るだけで星は 1 つも出さない
    expect(legacy.content[0].text).not.toContain("本命星");
  });

  it("出生データそのものは返事に出さない", async () => {
    const chartId = await saveChart();
    const result = await call("kyusei", {
      chart_id: chartId,
      date: "2026-08-22",
      date_utc_offset: 9,
    });

    const text: string = result.content[0].text;
    const json = JSON.stringify(result.structuredContent);
    for (const secret of BIRTH_TRACES) {
      expect(text, secret).not.toContain(secret);
      expect(json, secret).not.toContain(secret);
    }
    expect(Object.keys(result.structuredContent)).not.toContain("birth_data");
    expect(json).not.toContain('"lat"');
    // 出生の瞬間のユリウス日も出さない（日時そのものなので）
    expect(json).not.toContain(String(Math.floor(NATAL_JD)));
    // 返事に出る utc_offset は「対象日を見た暦」のぶんだけ
    expect(result.structuredContent.date.utc_offset).toBe(9);

    // 直接指定でも同じ（打った本人にも echo しない）
    const direct = await call("kyusei", {
      year: 2022,
      month: 11,
      day: 30,
      hour: 10,
      minute: 0,
      utc_offset: -8,
      date: "2026-08-22",
    });
    for (const secret of BIRTH_TRACES) {
      expect(direct.content[0].text, secret).not.toContain(secret);
      expect(JSON.stringify(direct.structuredContent), secret).not.toContain(secret);
    }
  });

  it("暦に無い日・壊れた date・未知の引数を断る", async () => {
    const chartId = await saveChart();

    const badBirth = await call("kyusei", { year: 2022, month: 2, day: 31 });
    expect(badBirth.isError).toBe(true);
    expect(badBirth.content[0].text).toContain("2022-02-31 は暦に存在しない日付です");

    const badDate = await call("kyusei", { chart_id: chartId, date: "2026-02-30" });
    expect(badDate.isError).toBe(true);
    expect(badDate.content[0].text).toContain("2026-02-30 は暦に存在しない日付です");

    const shapeless = await call("kyusei", { chart_id: chartId, date: "2026/08/22" });
    expect(shapeless.isError).toBe(true);
    expect(shapeless.content[0].text).toContain("date は");

    const badOffset = await call("kyusei", { chart_id: chartId, date_utc_offset: 20 });
    expect(badOffset.isError).toBe(true);
    expect(badOffset.content[0].text).toContain("date_utc_offset は -14 以上 14 以下");

    // 綴り違いは黙って無視しない（許可キーはツール定義から作っている）
    const typo = await call("kyusei", { chart_id: chartId, dates: "2026-08-22" });
    expect(typo.isError).toBe(true);
    expect(typo.content[0].text).toContain("未知の引数です: dates");
    expect(typo.content[0].text).toContain("date_utc_offset");
  });

  it("至として辻褄が合わない答えは断る（壊れた wrapper の受け止め）", async () => {
    const chartId = await saveChart();
    // 太陽の動きだけ素に戻すと、通過は 365.24 日の格子のまま返るが……
    engine.sunMotionAnchorJd = null;
    // 周期を半年に縮めると「同じ至どうしが 1 年離れていない」形になる
    engine.sunPeriod = 180;

    const result = await call("kyusei", { chart_id: chartId, date: "2026-08-22" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("冬至・夏至を計算できませんでした");
    // 断り文に jd（＝出生の瞬間そのもの）は出さない
    expect(result.content[0].text).not.toContain("24");
  });

  it("tools/list に 17 本目として並ぶ", async () => {
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
    // 2026-08-24 のスーパーセット化でカード層 5 本が、2026-08-25 に composite が 18 本目・
    // pillars_relations が 19 本目に入ったので全 24 本。kyusei は 17 番目のまま
    expect(tools).toHaveLength(24);
    expect(tools[16]?.name).toBe("kyusei");

    const tool: any = tools[16];
    expect(tool.title).toBe("九星気学（本命星・月命星・日命星と年盤・月盤・日盤）");
    expect(Object.keys(tool.inputSchema.properties)).toEqual([
      "chart_id",
      "year",
      "month",
      "day",
      "hour",
      "minute",
      "utc_offset",
      "date",
      "date_utc_offset",
    ]);
    // 出生時刻は任意なので required は無い（chart_id との二択もサーバー側で見ている）
    expect(tool.inputSchema.required).toBeUndefined();
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    // 採った規約と「解釈しない」を description で約束している
    expect(tool.description).toContain("**出生時刻は任意**");
    expect(tool.description).toContain("冬至・夏至に最も近い甲子日");
    expect(tool.description).toContain("**閏遁は置かない**");
    expect(tool.description).toContain("日盤の切り替えは流派で割れる");
    expect(tool.description).toContain("**このツールは解釈をしない**");
    expect(tool.description).toContain("四体系を合算する根拠はない");
    expect(tool.description).toContain("出生データそのものは返事に出さない");
  });
});
