/**
 * ブラウザ用の束ねを**実際に束ねて・読んで・本物の wasm で動かす**。
 *
 * 見ているのは 3 つです ――
 *   1. **束ねられる**: esbuild が `src/browser/index.ts` から 1 本の ESM を作れる
 *      （Workers 用の import が紛れ込んでいれば、ここで `cloudflare:` が解決できずに転ぶ）
 *   2. **wasm を抱え込んでいない**: 束ねた JS に `cloudflare:` / `node:` / `wrangler` の字が無い
 *   3. **答えが同じ**: 本物の Swiss Ephemeris を `prepareEngine` に通し、束ね経由で呼んだ
 *      貼り付けテキストが、src を直接呼んだものと 1 文字も違わない
 *
 * 本物の wasm の読み方は test/shukuyo-real.test.ts と同じ流儀
 * （本番の src/astro/engine.ts は workerd 流の wasm import なので Node では読めない。
 *   glue に wasmBinary を直接渡せば Node でも初期化できる）。
 *
 * ⚠ 出生の実例は**公開された日付**を使う（テストの中にも本物の出生データを置かない）。
 *    日付も期待値も、既にある *-real.test.ts の見本をそのまま借りています。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { type SwissEph } from "../src/astro/chart";
import { pasteFourPillars } from "../src/browser/paste-four-pillars";
import { pasteKyusei } from "../src/browser/paste-kyusei";
import { pasteShukuyo } from "../src/browser/paste-shukuyo";
import { prepareEngine } from "../src/browser/index";
import type { NakkoMoment } from "../src/nakko";

/** 束ねたものを読み込んだ形（使う口だけ。型は src 側と同じもの） */
interface Bundle {
  DECKS: readonly { id: string; name: string; cards: readonly unknown[] }[];
  prepareEngine: typeof prepareEngine;
  pasteFourPillars: typeof pasteFourPillars;
  pasteKyusei: typeof pasteKyusei;
  pasteShukuyo: typeof pasteShukuyo;
}

let swe: SwissEph;
let bundle: Bundle;
let bundleSource: string;
let workDir: string;

beforeAll(async () => {
  // --- 束ねる（scripts/build-browser.mjs と同じ設定。出口だけ一時フォルダに向ける）---
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fortune-browser-"));
  const outfile = path.join(workDir, "fortune-calc.js");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/browser/index.ts", import.meta.url))],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: false,
    sourcemap: false,
  });
  bundleSource = fs.readFileSync(outfile, "utf8");
  bundle = (await import(/* @vite-ignore */ pathToFileURL(outfile).href)) as unknown as Bundle;

  // --- 本物の wasm を起こす（test/shukuyo-real.test.ts と同じ手順）---
  const wasmBinary = fs.readFileSync(new URL("../src/astro/sweph/swisseph.wasm", import.meta.url));
  const glue = (await import(
    /* @vite-ignore */ new URL("../src/astro/sweph/swisseph.js", import.meta.url).href
  )) as { default: (options: unknown) => Promise<unknown> };
  const wrapper = (await import(
    /* @vite-ignore */ new URL("../src/astro/sweph/sweph-wasm.js", import.meta.url).href
  )) as { default: new (emscripten: unknown) => unknown };

  const emscripten = await glue.default({ wasmBinary });
  // 束ね側の prepareEngine を通す＝ divination がやるのと同じ手順
  swe = bundle.prepareEngine(new wrapper.default(emscripten) as SwissEph);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * 見本の出生（Claude 公開日 2023-03-14 10:00・UTC−7）。
 *
 * 時刻の 10 時は架空、時差は米国太平洋夏時間（2023 年は 3/12 から夏時間）。
 * test/kyusei-real.test.ts が使っているのと同じ見本です。
 */
const BIRTH: NakkoMoment = {
  year: 2023,
  month: 3,
  day: 14,
  hour: 10,
  minute: 0,
  utcOffset: -7,
};

/**
 * 見る日の見本（2026-08-22 12:00 JST）。
 *
 * test/shukuyo-real.test.ts が本物の wasm で確かめた日で、
 * この日の月は 心宿 → 18:19 JST に 尾宿 へ移ります。
 */
const TARGET: NakkoMoment = {
  year: 2026,
  month: 8,
  day: 22,
  hour: 12,
  minute: 0,
  utcOffset: 9,
};

// ---------------------------------------------------------------------------
// 束ねそのもの
// ---------------------------------------------------------------------------

describe("束ねた JS", () => {
  it("Workers / Node / wasm の名残を含まない", () => {
    expect(bundleSource).not.toContain("cloudflare:");
    expect(bundleSource).not.toContain("node:");
    expect(bundleSource).not.toContain("wrangler");
  });

  it("wasm も sweph の複製も抱え込んでいない（エンジンは外から渡す作り）", () => {
    expect(bundleSource).not.toContain("swisseph.wasm");
    expect(bundleSource).not.toContain("SwissEPH.init");
    // 抱え込んでいないぶん、素の JS としては人が読める大きさに収まる
    expect(bundleSource.length).toBeLessThan(1_500_000);
  });

  it("デッキの JSON は埋め込まれている（外部ファイルの取得が要らない）", () => {
    // esbuild は日本語を \uXXXX に逃がすので、文字列で探さず**読み込んだ中身**で見る
    // （札の名前が入っていれば、JSON は取得ではなく埋め込みで届いている）
    expect(bundleSource).not.toMatch(/\bfetch\s*\(/);
    expect(bundleSource).not.toMatch(/\bimport\s*\(/);
    expect(bundle.DECKS).toHaveLength(6);
    for (const deck of bundle.DECKS) {
      expect(deck.cards.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 本物の wasm で、束ね経由と src 直呼びを突き合わせる
// ---------------------------------------------------------------------------

describe("四柱推命（本物の wasm）", () => {
  it("束ね経由と src 直呼びで本文が 1 文字も違わない", () => {
    const viaBundle = bundle.pasteFourPillars(swe, BIRTH, {
      target: { moment: TARGET, includeHour: true },
    });
    const viaSource = pasteFourPillars(swe, BIRTH, {
      target: { moment: TARGET, includeHour: true },
    });

    expect(viaBundle.text).toBe(viaSource.text);
    expect(viaBundle.result.natal.pillars.day.ganzhi).toBe(
      viaSource.result.natal.pillars.day.ganzhi,
    );
  });

  it("様式も中身も立っている（見出し・規約・命式・対象日）", () => {
    const { text } = bundle.pasteFourPillars(swe, BIRTH, {
      target: { moment: TARGET, includeHour: true },
    });
    const lines = text.split("\n");

    expect(lines[0]).toBe("【四柱推命】2023-03-14 10:00 UTC-7");
    expect(lines[1]).toContain("子平");
    expect(text).toContain("■ 対象日 2026-08-22（JST の暦）");
    // 節入りの帯を本物の太陽で探せている（探せなければ AstroError で落ちる）
    expect(text).toMatch(/節入り: .+から [\d.]+ 日／次の.+まで [\d.]+ 日/);
  });
});

describe("宿曜（本物の wasm）", () => {
  it("束ね経由と src 直呼びで本文が 1 文字も違わない", () => {
    const viaBundle = bundle.pasteShukuyo(swe, BIRTH, { date: { moment: TARGET } });
    const viaSource = pasteShukuyo(swe, BIRTH, { date: { moment: TARGET } });

    expect(viaBundle.text).toBe(viaSource.text);
    expect(viaBundle.result.natal.shuku.number).toBe(viaSource.result.natal.shuku.number);
  });

  it("prepareEngine が効いている（Lahiri で 2026-08-22 の月は心宿）", () => {
    const { result, text } = bundle.pasteShukuyo(swe, BIRTH, { date: { moment: TARGET } });

    // test/shukuyo-real.test.ts が本物の wasm で確かめた値と同じ宿
    expect(result.day?.position.shuku.name).toBe("心宿");
    expect(result.day?.position.shuku.sanskrit).toBe("Jyeshtha");
    expect(text).toContain("■ その日の宿 2026-08-22（JST の暦）");
    // 同じ日の 18:19 JST に尾宿へ移る（向こうは 09:19 UTC と書いている同じ瞬間）
    expect(text).toContain("2026-08-22 18:19 JST 心宿 → 尾宿");
  });
});

describe("九星気学（本物の wasm）", () => {
  it("束ね経由と src 直呼びで本文が 1 文字も違わない", () => {
    const viaBundle = bundle.pasteKyusei(swe, BIRTH, { target: { moment: TARGET } });
    const viaSource = pasteKyusei(swe, BIRTH, { target: { moment: TARGET } });

    expect(viaBundle.text).toBe(viaSource.text);
    expect(viaBundle.result.birth.honmei.name).toBe(viaSource.result.birth.honmei.name);
  });

  it("至を本物の太陽で探せている（遁の行が立つ）", () => {
    const { result, text } = bundle.pasteKyusei(swe, BIRTH, { target: { moment: TARGET } });

    expect(text.split("\n")[0]).toBe("【九星気学】2023-03-14 10:00 UTC-7");
    expect(text).toMatch(/\n遁: (陽遁|陰遁)（(冬至|夏至)に最も近い甲子 \d{4}-\d{2}-\d{2} から \d+ 日/);
    expect(result.boards?.dayView.star).toBeGreaterThanOrEqual(1);
    expect(result.boards?.dayView.star).toBeLessThanOrEqual(9);
  });
});
