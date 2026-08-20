/**
 * sweph-wasm wrapper（sweph-wasm.js）の型。
 *
 * ⚠ 実体は astro-viewer / PoC からの**無改造コピー**（minify 済み）。
 *    ここでも「本実装が実際に呼ぶメソッドだけ」を宣言する。wrapper には
 *    swe_* が 100 本近く生えているが、宣言しなければ使えない＝使わない、で構わない。
 *
 * 注意: wrapper の `static async init()` は動的 import と locateFile を使う経路なので**使わない**。
 *       初期化済みの Emscripten モジュールを constructor に直接渡す（engine.ts 参照）。
 */
import type { EmscriptenModule } from "./swisseph.js";

/** swe_houses / swe_houses_ex の戻り。cusps は [0] ダミー＋1..12、ascmc は 8 要素 */
export interface HouseResult {
  cusps: number[];
  ascmc: number[];
}

export default class SwissEPH {
  constructor(emscripten: EmscriptenModule);

  /** 暦日 → ユリウス日。gregflag は 1 = グレゴリオ暦 */
  swe_julday(year: number, month: number, day: number, hour: number, gregflag: number): number;

  /** 天体位置（UT）。戻りは [黄経, 黄緯, 距離, 黄経速度, 黄緯速度, 距離速度] */
  swe_calc_ut(jd: number, planetId: number, flags: number): number[];

  /** ハウスカスプ。hsys は 1 文字（P / K / W / E など） */
  swe_houses(jd: number, lat: number, lng: number, hsys: string): HouseResult;

  /** Swiss Ephemeris のバージョン文字列 */
  swe_version(): string;
}
