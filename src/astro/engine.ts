/**
 * Swiss Ephemeris（sweph-wasm）の初期化 ―― **wasm を import する唯一のモジュール**。
 *
 * PoC（poc-astro/src/index.mjs）で workerd を通ることを確認した流儀をそのまま持ち込んでいる:
 *
 *  - workerd は `WebAssembly.instantiate(bytes)` 型の動的コンパイルを禁じている。
 *    そこで wasm を ES モジュールとして import して `WebAssembly.Module` を受け取り、
 *    Emscripten の `instantiateWasm` フック経由で同期 `new WebAssembly.Instance(module, imports)` を渡す。
 *    （念のため非同期フォールバックも残してある。PoC では同期パスが通っている）
 *  - `swe_set_ephe_path` は呼ばない。Moshier モード（SEFLG_MOSEPH）＝天文暦ファイル不要。
 *    パスを設定すると MEMFS 上の暦ファイルを探しに行ってしまう。
 *  - glue（sweph/swisseph.js）と wrapper（sweph/sweph-wasm.js）は astro-viewer からの**無改造コピー**。
 *    wrapper の `static async init()` は動的 import と locateFile を使うので使わず、
 *    初期化済み Emscripten モジュールを constructor に直接渡す。
 *
 * ⚠ 初期化は**モジュール評価時**に始める（下の `enginePromise`）。
 *    wasm の初期化は実測 +12.7ms かかるので、isolate 起動の予算（別枠）に載せてしまい、
 *    最初のリクエストの CPU 10ms 予算から外すのが狙い。
 *    未処理 rejection にならないよう `.catch` ガードを付け、失敗はハンドラ側の await で拾う。
 */
import wasmModule from "./sweph/swisseph.wasm";
import initGlue from "./sweph/swisseph.js";
import SwissEPH from "./sweph/sweph-wasm.js";
import { SIDEREAL_MODE_LAHIRI, type SwissEph } from "./chart";

/** 診断用。同期 `new WebAssembly.Instance` が弾かれた場合だけ中身が入る */
export const bootDiagnostics: { syncInstanceError: string | null } = { syncInstanceError: null };

/**
 * wrapper の実体には生えているのに `sweph/sweph-wasm.d.ts` が宣言していないメソッド
 * （swe_mooncross_ut / swe_solcross_ut / swe_houses_armc / swe_set_sid_mode /
 * swe_get_ayanamsa_ut）を、**複製ファイルに手を入れずに**
 * 型の上で足すための当て木。sweph/ 配下は astro-viewer からの無改造コピーなので触らない方針。
 */
type SwephInstance = InstanceType<typeof SwissEPH> &
  Pick<
    SwissEph,
    | "swe_mooncross_ut"
    | "swe_solcross_ut"
    | "swe_houses_armc"
    | "swe_set_sid_mode"
    | "swe_get_ayanamsa_ut"
  >;

function boot(): Promise<SwissEph> {
  return new Promise<SwissEph>((resolve, reject) => {
    initGlue({
      instantiateWasm(imports, successCallback) {
        try {
          // workerd が許可している同期パス
          const instance = new WebAssembly.Instance(wasmModule, imports);
          successCallback(instance, wasmModule);
          return instance.exports;
        } catch (error) {
          // 同期が弾かれたら module オーバーロードの非同期版へフォールバック。
          // Emscripten の instantiateWasm 規約では、後から successCallback を呼ぶ場合
          // 空オブジェクトを返してよい。
          bootDiagnostics.syncInstanceError = String(error);
          WebAssembly.instantiate(wasmModule, imports).then(
            (instance) => successCallback(instance, wasmModule),
            reject,
          );
          return {};
        }
      },
    }).then((emscripten) => {
      const swe = new SwissEPH(emscripten) as SwephInstance;
      // 宿曜が使うサイデリアル黄経の基準点を Lahiri に固定する（初期化直後に一度だけ）。
      // SEFLG_SIDEREAL を立てた計算にしか効かないので、CALC_FLAGS で回している
      // ホロスコープ側のトロピカル計算はここでは 1 度も変わらない。
      swe.swe_set_sid_mode(SIDEREAL_MODE_LAHIRI, 0, 0);
      resolve(swe);
    }, reject);
  });
}

/**
 * モジュール評価時に走り出す初期化。
 * ここで `.catch` を付けておかないと、失敗したときに未処理 rejection として
 * isolate ごと落ちる（ハンドラが await するまで誰も見ていないため）。
 */
const enginePromise: Promise<SwissEph> = boot();
enginePromise.catch(() => {
  /* 失敗の中身は getEngine() を await した側が受け取る */
});

/** 初期化済みの SwissEPH を受け取る。初期化に失敗していればここで throw する */
export function getEngine(): Promise<SwissEph> {
  return enginePromise;
}
