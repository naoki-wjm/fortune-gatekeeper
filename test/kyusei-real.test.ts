/**
 * 九星気学の「至を挟む」ところを**本物の Swiss Ephemeris（wasm）**で確かめる。
 *
 * 純関数（src/kyusei.ts）は冬至・夏至の暦日を**引数で受け取る**ので、
 * その暦日を作るのは配線（src/astro/astro-mcp.ts の solsticesAround）の仕事になる ――
 * 400 日戻って 1 本目、その 300 日後から 2 本目を探し、現地の時差で暦日へ丸める、という手順。
 * 偽エンジンのテスト（test/astro-kyusei.test.ts）では等速太陽の格子しか見ていないので、
 * **本物の至が本当にその暦日に落ちるか・陽遁陰遁の切り替えが実日付と合うか**をここで実物に当てる。
 *
 * ⚠ wrapper の `swe_solcross_ut` はエラーチェックが壊れている（返り値ではなく flags を見ている）ので、
 *    探索は returns.ts の `crossUt`（返り値を検算する側）を通す ―― 配線と同じ道具立て。
 *
 * 本物の wasm の読み方は test/four-pillars-real.test.ts と同じ流儀
 * （本番の src/astro/engine.ts は workerd 流の wasm import なので Node では読めない。
 *   glue に wasmBinary を直接渡せば Node でも初期化できる）。
 *
 * ⚠ 出生の実例は**公開された日付**を使う（テストの中にも本物の出生データを置かない）。
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { dateFromJulianDay, julianDay, type SwissEph } from "../src/astro/chart";
import { crossUt } from "../src/astro/returns";
import { handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import type { AuthContext } from "../src/astro/store";
import { starOf } from "../src/kyusei";
import { FakeKv } from "./stubs/fake-kv";

let swe: SwissEph;
let context: AstroContext;

const OWNER: AuthContext = { user: "user1", name: "オーナー", role: "owner" };

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
    now: () => new Date("2026-08-20T02:15:00Z"),
  };
});

let nextId = 1;

/** 本物のエンジンを積んだまま kyusei を 1 発呼ぶ */
async function callKyusei(args: Record<string, unknown>): Promise<any> {
  const response = await handleAstroMcpRequest(
    new Request("http://localhost/astro/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: "kyusei", arguments: args },
      }),
    }),
    context,
  );
  const json = JSON.parse(await response.text());
  expect(json.result.isError).toBeUndefined();
  return json.result;
}

/**
 * 見本の出生（Claude 公開日 2023-03-14 10:00・UTC−7）。
 *
 * 時刻の 10 時は架空、時差は米国太平洋夏時間（2023 年は 3/12 から夏時間）。
 * 人の誕生日と紛れない公開された日付を見本にする、という取り決めです。
 */
const BIRTH = { year: 2023, month: 3, day: 14, hour: 10, minute: 0, utc_offset: -7 };

/** 至の瞬間を、その土地の時差で読んだ暦日に（配線の solsticesAround と同じ丸め方） */
function solsticeLocalDay(
  year: number,
  longitude: number,
  utcOffset: number,
): { year: number; month: number; day: number } {
  const start = julianDay(swe, { year, month: 1, day: 1, hour: 0, minute: 0, utcOffset });
  const local = dateFromJulianDay(crossUt(swe, "sun", longitude, start) + utcOffset / 24);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

describe("九星気学（本物の Swiss Ephemeris で検算）", () => {
  it("冬至・夏至は日本時間の暦日でその日に落ちる", () => {
    // 2025 年の冬至は UTC では 12/21 15:03 ＝ **日本時間では 12/22 の 0 時すぎ**。
    // 至の瞬間を現地の時差で丸める、という規約がそのまま日付に出るところ
    expect(solsticeLocalDay(2025, 270, 9)).toEqual({ year: 2025, month: 12, day: 22 });
    // 同じ至を UTC の暦で読むと 12/21（土地が変われば暦日も変わる）
    expect(solsticeLocalDay(2025, 270, 0)).toEqual({ year: 2025, month: 12, day: 21 });

    expect(solsticeLocalDay(2026, 90, 9)).toEqual({ year: 2026, month: 6, day: 21 });
    expect(solsticeLocalDay(2026, 270, 9)).toEqual({ year: 2026, month: 12, day: 22 });
  });

  it("2026-08-22（日本時間）の日の星は八白・陰遁で、切り替えは 2026-06-19 から 64 日目", async () => {
    const result = await callKyusei({ ...BIRTH, date: "2026-08-22", date_utc_offset: 9 });
    const day = result.structuredContent.date.day;

    // 手計算: 2026 年の夏至は日本時間 6/21。その日の JDN は 2461213 で
    //   日干支の index は (2461213 + 49) mod 60 = 2 ＝ 丙寅。2 < 30 なので手前の甲子が近く、
    //   切り替えは 2461213 − 2 = 2461211 ＝ **2026-06-19**（この日がちょうど甲子）。
    //   2026-08-22 の JDN は 2461275 なので 2461275 − 2461211 = 64 日目。
    //   夏至側なので陰遁＝ 9 から 1 日ずつ下がって wrapStar(9 − 64) = 8 ＝ 八白。
    expect(day.switch).toEqual({ kind: "summer", year: 2026, month: 6, day: 19 });
    expect(day.days_since_switch).toBe(64);
    expect(day.dun).toBe("陰遁");
    expect(day.center).toEqual(starOf(8));

    // 年盤・月盤の中宮も手計算どおり（2026 は数字根 1 で 11 − 1 = 10 → 一白、
    // 8/22 は申月＝寅月 八白 から 6 か月ぶん下がって 二黒）
    expect(result.structuredContent.date.year.center).toEqual(starOf(1));
    expect(result.structuredContent.date.year.ganzhi).toBe("丙午");
    expect(result.structuredContent.date.month.center).toEqual(starOf(2));
    expect(result.structuredContent.date.month.ganzhi).toBe("丙申");
    expect(result.content[0].text).toContain(
      "遁: 陰遁（夏至に最も近い甲子 2026-06-19 から 64 日（切り替え当日が 0））",
    );
  });

  it("立春（2026-02-04 05:02 JST）をまたぐと年の星も月の星も切り替わる", async () => {
    // 2/3 はまだ前年（2025）の星。数字根 2+0+2+5 = 9 で 11 − 9 = 2 ＝ 二黒、
    // 月は丑月（寅月の 11 か月あと）なので wrapStar(2 − 11) = 9 ＝ 九紫
    const before = await callKyusei({ ...BIRTH, date: "2026-02-03 12:00", date_utc_offset: 9 });
    expect(before.structuredContent.date.year.center).toEqual(starOf(2));
    expect(before.structuredContent.date.year.ganzhi).toBe("乙巳");
    expect(before.structuredContent.date.month.center).toEqual(starOf(9));
    expect(before.structuredContent.date.month.ganzhi).toBe("己丑");

    // 2/4 の 12 時は立春（05:02 JST）のあと。2026 の年の星 一白、寅月なので 八白
    const after = await callKyusei({ ...BIRTH, date: "2026-02-04 12:00", date_utc_offset: 9 });
    expect(after.structuredContent.date.year.center).toEqual(starOf(1));
    expect(after.structuredContent.date.year.ganzhi).toBe("丙午");
    expect(after.structuredContent.date.month.center).toEqual(starOf(8));
    expect(after.structuredContent.date.month.ganzhi).toBe("庚寅");

    // 同じ 2/4 でも 0 時はまだ立春の前（年界は暦日ではなく太陽黄経で切る）
    const midnight = await callKyusei({ ...BIRTH, date: "2026-02-04 00:00", date_utc_offset: 9 });
    expect(midnight.structuredContent.date.year.center).toEqual(starOf(2));
    expect(midnight.structuredContent.date.month.center).toEqual(starOf(9));
    // 日盤は日界 0 時なので、同じ 2/4 なら時刻に依らず同じ星
    expect(midnight.structuredContent.date.day.center).toEqual(
      after.structuredContent.date.day.center,
    );
  });

  it("切り替えの間隔が 240 日になる期間でも閏遁を置かない（2019 冬至 → 2020 夏至）", async () => {
    // 2019 年の冬至は日本時間 12/22（甲子は 29 日手前の 2019-11-23）、
    // 2020 年の夏至は 6/21（甲子は 29 日あとの 2020-07-20）＝ 切り替えの間隔が 240 日になる巡り。
    // 至の間隔は約 182 日、甲子のずれは ±30 日なので、間隔は 180 日か 240 日のどちらかになる
    expect(solsticeLocalDay(2019, 270, 9)).toEqual({ year: 2019, month: 12, day: 22 });
    expect(solsticeLocalDay(2020, 90, 9)).toEqual({ year: 2020, month: 6, day: 21 });

    // 陽遁の 239 日目（2020-07-19）。閏遁を挟まないので、九紫の次はただ一白へ戻るだけ ――
    // wrapStar(1 + 239) = 6 ＝ 六白
    const last = await callKyusei({ ...BIRTH, date: "2020-07-19", date_utc_offset: 9 });
    expect(last.structuredContent.date.day.switch).toEqual({
      kind: "winter",
      year: 2019,
      month: 11,
      day: 23,
    });
    expect(last.structuredContent.date.day.days_since_switch).toBe(239);
    expect(last.structuredContent.date.day.dun).toBe("陽遁");
    expect(last.structuredContent.date.day.center).toEqual(starOf(6));

    // 翌日が切り替えの甲子。陰遁の 0 日目＝九紫から下り始める
    const turn = await callKyusei({ ...BIRTH, date: "2020-07-20", date_utc_offset: 9 });
    expect(turn.structuredContent.date.day.switch).toEqual({
      kind: "summer",
      year: 2020,
      month: 7,
      day: 20,
    });
    expect(turn.structuredContent.date.day.days_since_switch).toBe(0);
    expect(turn.structuredContent.date.day.dun).toBe("陰遁");
    expect(turn.structuredContent.date.day.center).toEqual(starOf(9));
  });

  it("見本の出生の三星（本命星 四緑・月命星 七赤・日命星 五黄）", async () => {
    const result = await callKyusei({ ...BIRTH, date: "2026-08-22", date_utc_offset: 9 });
    const birth = result.structuredContent.birth;

    // 手計算:
    //   本命星 … 2023-03-14 の太陽黄経は 353° 台で立春（315°）を過ぎているので年は 2023。
    //            数字根 2+0+2+3 = 7、11 − 7 = 4 ＝ 四緑。
    //   月命星 … monthBranchOrder(353.6) = floor((353.6 − 315) / 30) = 1 ＝ 卯月。
    //            年の星 四緑 は組 一四七 なので寅月が 八白、1 か月ぶん下がって 七赤。
    //   日命星 … 2022 年の冬至は現地（UTC−7）の暦で 12/21。その日の JDN 2459935 の
    //            日干支 index は (2459935 + 49) mod 60 = 44 ≧ 30 なので次の甲子が近く、
    //            切り替えは 2459935 − 44 + 60 = 2459951 ＝ 2023-01-06。
    //            出生日 2023-03-14 の JDN は 2460018 なので 67 日目、
    //            冬至側＝陽遁で wrapStar(1 + 67) = 5 ＝ 五黄。
    expect(birth.honmei).toEqual(starOf(4));
    expect(birth.getsumei).toEqual(starOf(7));
    expect(birth.nichimei).toEqual({ star: starOf(5), dun: "陽遁" });

    // 出生側は切り替えの甲子日も経過日数も出さない（2 つ揃うと出生日が復元できるため）
    expect(Object.keys(birth.nichimei)).toEqual(["star", "dun"]);
    // 出生データそのものも返事に出さない
    const json = JSON.stringify(result.structuredContent);
    for (const secret of ["2023", "03-14", "10:00"]) {
      expect(result.content[0].text, secret).not.toContain(secret);
      expect(json, secret).not.toContain(secret);
    }
  });
});
