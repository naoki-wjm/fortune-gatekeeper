/**
 * コンポジット（中点図）の計算。
 *
 * chart.ts / returns.ts と同じ流儀 ―― **計算するのはサーバー、読むのは呼び出した側の Claude**。
 * ここにも解釈は一切置かない。返すのは中点の座標とハウスだけ。
 *
 * 採ったのは**中点法**（A と B の同じ天体どうしの中点を取る）。
 * ダヴィソン（2 人の出生時刻・出生地の中間で図を 1 枚立て直す方式）ではない ―― 別物なので、
 * `method: "midpoint"` として名前で固定して返す（読む側が「この鯖はこの流派」と分かるように）。
 *
 * wasm に触るのは ASC / カスプを立てる 1 か所だけ（`swe_calc_ut` で黄道傾斜、
 * `swe_houses_armc` でハウス）。SwissEPH インスタンスは引数で受け取るので、
 * テストは偽エンジンを渡すだけで回る。
 */
import {
  AstroError,
  CALC_FLAGS,
  formatDegree,
  getHouse,
  mcToArmc,
  normalizeDegree,
  planetName,
  type SwissEph,
} from "./chart";

/**
 * 中点図に載せる天体（太陽〜冥王星の 10 天体）。
 *
 * ノード（id 11）は**扱わない** ―― シナストリーがアスペクトの相手から外しているのと同じ理由で、
 * 中点図では位置の一覧にも出さない（2 人のノードの中点に定まった読みが無いため）。
 */
export const COMPOSITE_PLANET_IDS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * 「ぴったり 180°」とみなす幅（度）。
 *
 * 対向のときだけ中点が 2 つ（A+90° と A+270°）に割れるので、規約でどちらかに決める必要がある。
 * 保存済みの座標は倍精度なので、ちょうど 180.0 になることは実際にはまず無いが、
 * 3.6 µ秒角ぶんの遊びを持たせておかないと「概念上は対向」の組でどちらに落ちるかが
 * 浮動小数の埃で決まってしまう（規約が規約として働かない）。
 */
const OPPOSITION_EPSILON = 1e-9;

/**
 * 立て直した MC が中点 MC と一致しているとみなす幅（度）。
 *
 * `mcToArmc` → `swe_houses_armc` は数学的にちょうど往復するので、本物の wasm では
 * 実測 1.1e-13° までしかずれない（`test/astro-composite-real.test.ts` で確かめている）。
 * ここが見張っているのは埃ではなく**壊れた返り値**のほう。
 */
const MC_TOLERANCE = 1e-6;

/** 黄道傾斜として受け付ける範囲（度）。±10000 年でも 22〜24.5° に収まる */
const EPS_MIN = 20;
const EPS_MAX = 27;

/**
 * 2 つの黄経の中点（短い方の弧の真ん中）。
 *
 * ぴったり 180°（対向）のときだけ中点が定まらないので、**A から黄経が増える向きに 90°** の点を採る
 * （規約名は `opposition_tiebreak: "clockwise_from_a"`。ホロスコープの円は黄経が増える向きに
 * 反時計回りで描くので、名前の「時計回り」は円の見た目ではなく**A から先へ進む向き**を指している）。
 * この規約のせいで対向のときだけ `midpointLon(a, b)` と `midpointLon(b, a)` が 180° 違う。
 */
export function midpointLon(a: number, b: number): number {
  const from = normalizeDegree(a);
  const to = normalizeDegree(b);
  const gap = normalizeDegree(to - from);
  if (Math.abs(gap - 180) <= OPPOSITION_EPSILON) return normalizeDegree(from + 90);
  const signed = gap > 180 ? gap - 360 : gap;
  return normalizeDegree(from + signed / 2);
}

/** 中点図の天体 1 つ（速度は持たない ―― 中点図に「動き」の概念がない） */
export interface CompositePosition {
  id: number;
  lon: number;
}

/** 天体の並びから id 引きの表を作る（同じ id が 2 つあれば先に出てきたほうを採る） */
function longitudeById(planets: readonly { id: number; lon: number }[]): Map<number, number> {
  const table = new Map<number, number>();
  for (const planet of planets) {
    if (!table.has(planet.id) && Number.isFinite(planet.lon)) table.set(planet.id, planet.lon);
  }
  return table;
}

/**
 * 10 天体の中点（太陽〜冥王星）。並びは COMPOSITE_PLANET_IDS のまま。
 *
 * どちらかに欠けている天体があれば断る ―― 黙って 9 天体の図を返すと、
 * 読む側が「この人には金星が無い」と受け取ってしまう。
 */
export function midpointPositions(
  a: readonly { id: number; lon: number }[],
  b: readonly { id: number; lon: number }[],
): CompositePosition[] {
  const tableA = longitudeById(a);
  const tableB = longitudeById(b);
  return COMPOSITE_PLANET_IDS.map((id) => {
    const lonA = tableA.get(id);
    const lonB = tableB.get(id);
    if (lonA === undefined || lonB === undefined) {
      throw new AstroError(
        `中点図に要る天体（${planetName(id)}）が保存済みの座標に入っていません。` +
          "delete_chart で消して save_chart で登録し直すと引けます。",
      );
    }
    return { id, lon: midpointLon(lonA, lonB) };
  });
}

/**
 * 2 枚のハウス方式から中点図のハウス方式を決める。
 * 同じならそれを引き継ぎ、違えばプラシーダス（P）に寄せる ―― どちらか片方を採る理由が無いため。
 */
export function compositeHouseSystem(a: string, b: string): string {
  return a === b ? a : "P";
}

/** ASC から 30° 等分（イコール）のカスプ。[0] はダミー、1..12 が実体 */
export function equalHouseCusps(asc: number): number[] {
  const cusps = [0];
  for (let house = 0; house < 12; house++) cusps.push(normalizeDegree(asc + house * 30));
  return cusps;
}

/** ASC とカスプの立て方（名前で固定して返す） */
export type CompositeAscMethod = "derived_from_mc_midpoint" | "asc_midpoint_equal_houses";

/** 中点図の材料 1 枚ぶん（台帳のチャートから配線側が組む） */
export interface CompositeSide {
  planets: readonly { id: number; lon: number }[];
  /** [0] はダミー、1..12 がカスプ */
  cusps: readonly number[];
  /** [0]=ASC, [1]=MC, … */
  ascmc: readonly number[];
  houseSystem: string;
  /**
   * 出生の瞬間（UT のユリウス日）と出生緯度。
   * 出生データを預かっていない古い登録では undefined ―― そのときは簡易方式に落ちる。
   */
  birth?: { jd: number; lat: number };
}

export interface CompositeChart {
  planets: CompositePosition[];
  /** [0] はダミー、1..12 がカスプ */
  cusps: number[];
  /** [0]=ASC, [1]=MC, …（swe_houses_armc の返りをそのまま／簡易方式では自前で組む） */
  ascmc: number[];
  houseSystem: string;
  ascMethod: CompositeAscMethod;
}

/**
 * その瞬間の真黄道傾斜（度）。SE_ECL_NUT(-1) の [0]（returns.ts の二次進行と同じ引き方）。
 * 中点図には「時刻」が無いので、**2 人の出生 jd の中間**で引く（規約名 `at_mean_birth_jd`）。
 */
function obliquityAt(swe: SwissEph, jd: number): number {
  const result = swe.swe_calc_ut(jd, -1, CALC_FLAGS);
  const eps = Array.isArray(result) ? result[0] : undefined;
  if (typeof eps !== "number" || !Number.isFinite(eps) || eps < EPS_MIN || eps > EPS_MAX) {
    throw new AstroError(
      "中点図に要る黄道傾斜を計算できませんでした（天体計算が妥当な値を返しませんでした）。" +
        "しばらく置いてからもう一度呼んでください。",
    );
  }
  return eps;
}

/**
 * ARMC からハウスを立てる（wasm に触る唯一の場所）。
 *
 * ⚠ `swe_houses_armc` の返り値は**呼び出し側で検算する**（sweph の wrapper は複製で手を入れない方針）。
 *    ここでは「12 本のカスプと ASC / MC が数として揃っているか」に加えて、
 *    **立て直した MC が中点 MC と一致するか**を見る ―― mcToArmc の往復が本当に閉じている証拠になる。
 */
function housesFromArmc(
  swe: SwissEph,
  armc: number,
  lat: number,
  eps: number,
  houseSystem: string,
  expectedMc: number,
): { cusps: number[]; ascmc: number[] } {
  let houses: { cusps: number[]; ascmc: number[] };
  try {
    houses = swe.swe_houses_armc(armc, lat, eps, houseSystem);
  } catch {
    // wrapper は失敗を投げてくる（中身は "swe_houses_armc" の一言だけ）。
    // プラシーダス・コッホは緯度によっては定義できないので、そこだけ言い添えて返す
    // ―― 緯度そのものは書かない（出生データは返事に出さない）。
    throw new AstroError(
      `ハウス方式 ${houseSystem} では中点図のハウスを立てられませんでした` +
        "（プラシーダス・コッホは緯度によっては定義できません）。" +
        "2 枚をホールサイン（W）かイコール（E）で登録し直すと引けます。",
    );
  }

  const broken = new AstroError(
    "中点図のハウスを立てられませんでした（天体計算が壊れた値を返しました）。" +
      "しばらく置いてからもう一度呼んでください。",
  );
  if (!Array.isArray(houses?.cusps) || houses.cusps.length < 13) throw broken;
  if (!Array.isArray(houses?.ascmc) || houses.ascmc.length < 2) throw broken;
  for (let house = 1; house <= 12; house++) {
    if (!Number.isFinite(houses.cusps[house])) throw broken;
  }
  if (!Number.isFinite(houses.ascmc[0]) || !Number.isFinite(houses.ascmc[1])) throw broken;

  const gap = normalizeDegree((houses.ascmc[1] as number) - expectedMc);
  const signed = gap > 180 ? gap - 360 : gap;
  if (Math.abs(signed) > MC_TOLERANCE) {
    throw new AstroError(
      "中点図の MC を立て直せませんでした（ARMC から戻した MC が中点と一致しません）。" +
        "しばらく置いてからもう一度呼んでください。",
    );
  }
  return { cusps: houses.cusps, ascmc: houses.ascmc };
}

/**
 * 中点図を組み立てる。
 *
 * 天体は 10 天体の中点、MC は 2 枚の MC の中点。ASC とカスプの立て方は 2 通り:
 *
 *   - `derived_from_mc_midpoint`（既定・2 枚とも出生データを預かっているとき）
 *     中点 MC を ARMC に直し、**2 人の出生緯度の平均**で `swe_houses_armc` を立てる。
 *     黄道傾斜は 2 人の出生 jd の中間時点のもの。出来上がった MC は中点 MC と一致する（検算済み）。
 *   - `asc_midpoint_equal_houses`（片方でも出生データが無い古い登録のとき）
 *     ASC は 2 枚の ASC の中点、カスプは ASC から 30° 等分。エラーにはせず簡易方式で返す
 *     （このときの MC は 10 カスプと一致しない ―― ASC と MC を別々に中点で取っているため）。
 */
export function buildComposite(
  swe: SwissEph | null,
  a: CompositeSide,
  b: CompositeSide,
): CompositeChart {
  const planets = midpointPositions(a.planets, b.planets);
  const mc = midpointLon(a.ascmc[1] as number, b.ascmc[1] as number);

  if (a.birth && b.birth) {
    if (!swe) {
      // 配線の取り違え（出生データが揃っているのにエンジンを渡していない）。利用者の落ち度ではない
      throw new AstroError("中点図のハウスを立てる天体計算エンジンが渡されていません");
    }
    const houseSystem = compositeHouseSystem(a.houseSystem, b.houseSystem);
    const meanJd = (a.birth.jd + b.birth.jd) / 2;
    const eps = obliquityAt(swe, meanJd);
    const lat = (a.birth.lat + b.birth.lat) / 2;
    const houses = housesFromArmc(swe, mcToArmc(mc, eps), lat, eps, houseSystem, mc);
    // MC は中点そのものを返す（往復で戻ってきた値は上で検算済み＝一致している）。
    // 立て直した側をそのまま返すと 299.99999999999994 のような往復の埃が表に出るため。
    const ascmc = [...houses.ascmc];
    ascmc[1] = mc;
    return {
      planets,
      cusps: houses.cusps,
      ascmc,
      houseSystem,
      ascMethod: "derived_from_mc_midpoint",
    };
  }

  const asc = midpointLon(a.cusps[1] as number, b.cusps[1] as number);
  return {
    planets,
    cusps: equalHouseCusps(asc),
    // swe_houses の返りと同じ 8 要素の形に揃える（[0]=ASC, [1]=MC。以降は持たない）
    ascmc: [asc, mc, 0, 0, 0, 0, 0, 0],
    houseSystem: "E",
    ascMethod: "asc_midpoint_equal_houses",
  };
}

/**
 * 「太陽 双子座 24°02′ (10H)」の並び。
 *
 * chart.ts の formatPlanetLines と同じ形だが、**逆行の印を付けない**
 * ―― 中点図は速度を持たない（2 人の天体の中点に「動き」が無い）。
 */
export function formatCompositePlanetLines(
  planets: readonly CompositePosition[],
  cusps: readonly number[],
): string[] {
  return planets.map(
    (planet) =>
      `${planetName(planet.id)} ${formatDegree(planet.lon)} (${getHouse(planet.lon, cusps)}H)`,
  );
}

/** 採った規約（名前で固定して返り値にも書く）。ASC の立て方だけは図によって変わる */
export function compositeConventions(chart: CompositeChart): Record<string, string> {
  const conventions: Record<string, string> = {
    method: "midpoint",
    midpoint: "shorter_arc",
    opposition_tiebreak: "clockwise_from_a",
    bodies: "10_planets_plus_asc_mc",
    nodes: "excluded",
    asc: chart.ascMethod,
    house_system: chart.houseSystem,
  };
  if (chart.ascMethod === "derived_from_mc_midpoint") {
    conventions["latitude"] = "mean_of_birth_latitudes";
    conventions["obliquity"] = "at_mean_birth_jd";
  } else {
    conventions["houses"] = "equal_from_asc";
  }
  return conventions;
}

/** 規約を 1 行の日本語に（テキストの末尾に置く） */
export function formatCompositeConventions(chart: CompositeChart): string {
  const common =
    "規約: 中点法（ダヴィソンではない）／中点は短い方の弧" +
    "／ぴったり 180° のときは A から黄経が増える向きに 90°" +
    "／10 天体＋ASC・MC（ノードは扱わない）";
  if (chart.ascMethod === "derived_from_mc_midpoint") {
    return (
      common +
      "／ASC とカスプは中点 MC から立て直し（緯度は 2 人の出生緯度の平均・" +
      "黄道傾斜は 2 人の出生時刻の中間時点のもの）"
    );
  }
  return common + "／ASC は 2 枚の ASC の中点・カスプは ASC から 30° 等分（簡易方式）";
}
