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

/**
 * swe_sol_eclipse_where の戻り。data は地表の位置（[0] 経度・[1] 緯度…）、
 * Array は食の属性 11 要素（[0] 太陽直径の食された割合・**[1] 月と太陽の視直径比**…）。
 * 名前が `Array` なのは wrapper 側の綴りそのまま（複製ファイルには手を入れない方針）。
 */
export interface SolarEclipseWhere {
  data: number[];
  Array: number[];
}

export default class SwissEPH {
  constructor(emscripten: EmscriptenModule);

  /** 暦日 → ユリウス日。gregflag は 1 = グレゴリオ暦 */
  swe_julday(year: number, month: number, day: number, hour: number, gregflag: number): number;

  /** 天体位置（UT）。戻りは [黄経, 黄緯, 距離, 黄経速度, 黄緯速度, 距離速度] */
  swe_calc_ut(jd: number, planetId: number, flags: number): number[];

  /** ハウスカスプ。hsys は 1 文字（P / K / W / E など） */
  swe_houses(jd: number, lat: number, lng: number, hsys: string): HouseResult;

  /**
   * 次の日食（**global**＝地球上のどこかで起きるもの）を探す。戻りは tret 10 要素で
   * [0] 食の最大・[2][3] 食の始まりと終わり・[4][5] 皆既／金環の始まりと終わり・
   * [6][7] 中心線の始まりと終わり。ifltype = 0 で種類を問わない。
   * ⚠ **C 関数の戻り値（SE_ECL_TOTAL などの種類のビット）は wrapper が捨てている**ので、
   *    種類は tret と swe_sol_eclipse_where から導く（src/moon-calendar.ts の eclipseTypeOf）。
   */
  swe_sol_eclipse_when_glob(
    startJd: number,
    flags: number,
    ifltype: number,
    backward: boolean,
  ): number[];

  /**
   * 次の月食。戻りは tret 8 要素で [0] 食の最大・[2][3] 部分食の始まりと終わり・
   * [4][5] 皆既の始まりと終わり・[6][7] 半影食の始まりと終わり。
   * こちらは 0 かどうかだけで皆既／部分／半影が分かる。
   */
  swe_lun_eclipse_when(
    startJd: number,
    flags: number,
    ifltype: number,
    backward: boolean,
  ): number[];

  /** その瞬間の日食を地表のどこで見るか＋属性（金環と皆既の見分けに Array[1] を使う） */
  swe_sol_eclipse_where(jd: number, flags: number): SolarEclipseWhere;

  /** Swiss Ephemeris のバージョン文字列 */
  swe_version(): string;
}
