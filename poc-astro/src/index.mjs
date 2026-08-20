/**
 * PoC: Swiss Ephemeris（sweph-wasm）が Cloudflare Workers（workerd）で動くかの検証。
 *
 * ⚠ 検証専用。本番の src/ とは無関係で、デプロイしない。
 *
 * 勘所:
 *  - workerd は `WebAssembly.instantiate(bytes)` 型の動的コンパイルを禁止している。
 *    そこで wasm を ES モジュールとして import して `WebAssembly.Module` を受け取り、
 *    Emscripten の `instantiateWasm` フック経由で同期 `new WebAssembly.Instance(module, imports)` を渡す。
 *  - `swe_set_ephe_path` は呼ばない。Moshier モード（SEFLG_MOSEPH=4）＝天文暦ファイル不要。
 *    パスを設定すると MEMFS 上の暦ファイルを探しに行ってしまう。
 *  - glue（swisseph.js）と wrapper（sweph-wasm.js）は astro-viewer からの無改造コピー。
 *    wrapper の `static async init()` は動的 import と locateFile を使うので使わず、
 *    初期化済み Emscripten モジュールを constructor に直接渡す。
 */

import wasmModule from "./swisseph.wasm";
import initGlue from "./swisseph.js";
import SwissEPH from "./sweph-wasm.js";

// ── 固定テストデータ（1990-06-15 12:00 UTC・東京） ──
const TEST = {
  year: 1990,
  month: 6,
  day: 15,
  hour: 12, // UTC
  lat: 35.6895,
  lng: 139.6917,
  houseSystem: "P",
};

// SEFLG_MOSEPH(4) | SEFLG_SPEED(256)
const CALC_FLAGS = 260;

// 太陽〜冥王星＋平均ノード類。11 = SE_TRUE_NODE（calc.js と同じ並び）
const PLANET_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11];

const MAX_N = 500;

// ── 初期化（グローバルにキャッシュする lazy singleton） ──
let swePromise = null;
let initMs = null;
/** 同期 Instance 化が弾かれた場合の記録（診断用） */
let syncInstanceError = null;

function bootSwissEph() {
  const t0 = Date.now();

  return initGlue({
    instantiateWasm(imports, successCallback) {
      try {
        // workerd が許可している同期パス
        const instance = new WebAssembly.Instance(wasmModule, imports);
        successCallback(instance, wasmModule);
        return instance.exports;
      } catch (e) {
        // 同期が弾かれたら module オーバーロードの非同期版へフォールバック。
        // Emscripten の instantiateWasm 規約では、後から successCallback を呼ぶ場合
        // 空オブジェクトを返してよい。
        syncInstanceError = String(e);
        WebAssembly.instantiate(wasmModule, imports).then((instance) => {
          successCallback(instance, wasmModule);
        });
        return {};
      }
    },
  }).then((emscripten) => {
    // 注: workerd の Date.now は I/O を挟むまで凍結気味なので、この値は参考値
    initMs = Date.now() - t0;
    return new SwissEPH(emscripten);
  });
}

function getSwissEph() {
  if (!swePromise) swePromise = bootSwissEph();
  return swePromise;
}

// ── ネイタル1枚分の計算 ──
/**
 * @param swe SwissEPH インスタンス
 * @param dayOffset 日数のずらし幅。0 なら固定テストデータそのもの。
 *   ⚠ Swiss Ephemeris は同じ jd・同じ天体の計算結果を内部にキャッシュするため、
 *   同一 jd で n 回まわすと2回目以降がキャッシュヒットになり「1枚あたり」を過小評価する。
 *   毎回ちがう jd を渡すと素の計算コストが測れる。
 */
function computeNatal(swe, dayOffset = 0) {
  const jd = swe.swe_julday(TEST.year, TEST.month, TEST.day + dayOffset, TEST.hour, 1);

  const houses = swe.swe_houses(jd, TEST.lat, TEST.lng, TEST.houseSystem);

  const planets = [];
  for (const id of PLANET_IDS) {
    const r = swe.swe_calc_ut(jd, id, CALC_FLAGS);
    planets.push({ id, lon: r[0], speed: r[3] });
  }

  return { jd, planets, cusps: houses.cusps, ascmc: houses.ascmc };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // wasm に一切触らないベースライン（タイミング測定の下駄を測るため）
      return new Response("ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/natal") {
      try {
        const raw = Number(url.searchParams.get("n") ?? "1");
        const n = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), MAX_N) : 1;

        // vary=1 で毎回ちがう日付を計算する（暦キャッシュを外して素の計算コストを測る用）
        const vary = url.searchParams.get("vary") === "1";

        const swe = await getSwissEph();

        let last = null;
        for (let i = 0; i < n; i++) last = computeNatal(swe, vary ? i : 0);

        return Response.json({
          ok: true,
          version: swe.swe_version(),
          n,
          vary,
          jd: last.jd,
          planets: last.planets,
          cusps: last.cusps,
          ascmc: last.ascmc,
          initMs,
          syncInstanceError, // null なら同期 new WebAssembly.Instance が通っている
        });
      } catch (e) {
        return Response.json(
          { ok: false, error: String(e), stack: e && e.stack ? e.stack : null },
          { status: 500 },
        );
      }
    }

    return new Response("fortune-astro-poc: GET /health or GET /natal?n=COUNT\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
