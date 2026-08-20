/**
 * 占星術の計算とテキスト整形。
 *
 * 背骨はカード側と同じ ―― **計算するのはサーバー、読むのは呼び出した側の Claude**。
 * ここには「射手座の人は〜」のたぐいの解釈を一切置かない。座標と角度だけを返す。
 *
 * 移植元は astro-viewer の `viewer/calc.js`（calculateNatal / calculateTransitPlanets /
 * calculateCrossAspects / getHouse / signOf / fmt）。向こうは読み取り専用の参照元で、
 * こちらは Workers 用に「SwissEPH インスタンスを引数で受け取る純関数寄り」に組み直したもの。
 * wasm には一切触らないので、テストは偽エンジンを渡すだけで回る（engine.ts が唯一の wasm 窓口）。
 */

/** 計算フラグ: SEFLG_MOSEPH(4) | SEFLG_SPEED(256)。Moshier モード固定＝天文暦ファイル不要 */
export const CALC_FLAGS = 260;

/** グレゴリオ暦（swe_julday の gregflag） */
const GREGORIAN = 1;

/**
 * このサーバーが使う SwissEPH の口（sweph-wasm wrapper の部分集合）。
 * テストではこの形の偽エンジンを渡す。
 */
export interface SwissEph {
  swe_julday(year: number, month: number, day: number, hour: number, gregflag: number): number;
  swe_calc_ut(jd: number, planetId: number, flags: number): number[];
  swe_houses(jd: number, lat: number, lng: number, hsys: string): { cusps: number[]; ascmc: number[] };
  /**
   * 月が指定黄経を通過する瞬間（UT のユリウス日）。startJd より後の最初の 1 回。
   * ⚠ wrapper 側のエラーチェックは壊れている（返り値ではなく flags を見ている）ので、
   *    **呼び出し側で「返り値が startJd より大きいか」を必ず確かめること**（returns.ts の crossUt）。
   */
  swe_mooncross_ut(targetLon: number, startJd: number, flags: number): number;
  /** 太陽版。壊れたエラーチェックの事情も同じ */
  swe_solcross_ut(targetLon: number, startJd: number, flags: number): number;
  /** ARMC（子午線の赤経）と黄道傾斜からハウスを立てる。進行 ASC / MC で使う */
  swe_houses_armc(
    armc: number,
    lat: number,
    eps: number,
    hsys: string,
  ): { cusps: number[]; ascmc: number[] };
}

/** 入力が受け付けられなかったときのエラー（JSON-RPC ではなく isError で返す） */
export class AstroError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AstroError";
  }
}

// ---------------------------------------------------------------------------
// 台帳（天体・星座・ハウス方式・アスペクト）
// ---------------------------------------------------------------------------

/** 11 天体。calc.js の PLANETS と同じ並び（11 = SE_TRUE_NODE） */
export const PLANETS: readonly { id: number; name: string }[] = [
  { id: 0, name: "太陽" },
  { id: 1, name: "月" },
  { id: 2, name: "水星" },
  { id: 3, name: "金星" },
  { id: 4, name: "火星" },
  { id: 5, name: "木星" },
  { id: 6, name: "土星" },
  { id: 7, name: "天王星" },
  { id: 8, name: "海王星" },
  { id: 9, name: "冥王星" },
  { id: 11, name: "Nノード" },
];

/** 12 星座（日本語名。0 = 牡羊座） */
export const SIGNS: readonly string[] = [
  "牡羊座",
  "牡牛座",
  "双子座",
  "蟹座",
  "獅子座",
  "乙女座",
  "天秤座",
  "蠍座",
  "射手座",
  "山羊座",
  "水瓶座",
  "魚座",
];

/** 対応するハウス方式 */
export const HOUSE_SYSTEMS: readonly { code: string; name: string }[] = [
  { code: "P", name: "プラシーダス" },
  { code: "K", name: "コッホ" },
  { code: "W", name: "ホールサイン" },
  { code: "E", name: "イコール" },
];

export const HOUSE_SYSTEM_CODES = HOUSE_SYSTEMS.map((system) => system.code);

/** メジャーアスペクト 5 種（マイナーは持たない） */
export const ASPECTS: readonly { angle: number; name: string; symbol: string }[] = [
  { angle: 0, name: "コンジャンクション", symbol: "☌" },
  { angle: 60, name: "セクスタイル", symbol: "⚹" },
  { angle: 90, name: "スクエア", symbol: "□" },
  { angle: 120, name: "トライン", symbol: "△" },
  { angle: 180, name: "オポジション", symbol: "☍" },
];

/** クロスアスペクトの既定オーブ（度）。トランジットは狭く取る */
export const DEFAULT_ORB = 1;

/** 天体 ID → 名前。知らない ID はそのまま番号で返す */
export function planetName(id: number): string {
  return PLANETS.find((planet) => planet.id === id)?.name ?? `天体${id}`;
}

/** ハウス方式のコード → 名前 */
export function houseSystemName(code: string): string {
  return HOUSE_SYSTEMS.find((system) => system.code === code)?.name ?? code;
}

// ---------------------------------------------------------------------------
// 度数まわり（純関数）
// ---------------------------------------------------------------------------

/** 0 以上 360 未満に畳む */
export function normalizeDegree(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  // 359.9999… が丸めで 360 になってしまう事故を防ぐ
  return wrapped >= 360 ? 0 : wrapped;
}

/** 黄経 → 星座インデックス（0-11） */
export function signIndex(deg: number): number {
  return Math.floor(normalizeDegree(deg) / 30);
}

/**
 * 黄経 → 「双子座 24°02′」形式。
 *
 * 分は素直に floor すると 29.9° が 29°53′ になる（29.9 % 1 が 0.8999…9 になる浮動小数の埃）。
 * 1e-6 分ぶんだけ底上げしてから切り捨て、星座の尻尾は 29°59′ で止める
 * ―― 星座をまたいで表示が 1 つずれるほうが害が大きいため。
 */
export function formatDegree(deg: number): string {
  const lon = normalizeDegree(deg);
  const index = signIndex(lon);
  const sign = SIGNS[index] as string;
  const minutesInSign = Math.min(1799, Math.floor((lon - index * 30) * 60 + 1e-6));
  const degreeInSign = Math.floor(minutesInSign / 60);
  const minute = minutesInSign % 60;
  return `${sign} ${degreeInSign}°${String(minute).padStart(2, "0")}′`;
}

/**
 * 黄経がどのハウスに落ちるか（1-12）。
 * calc.js の getHouse と同じ ―― カスプ間の角度差で見るので 0° またぎも自動で処理される。
 */
export function getHouse(lon: number, cusps: readonly number[]): number {
  for (let i = 1; i <= 12; i++) {
    const start = cusps[i] as number;
    const end = (i === 12 ? cusps[1] : cusps[i + 1]) as number;
    const houseSpan = (((end - start) % 360) + 360) % 360;
    const planetDist = (((lon - start) % 360) + 360) % 360;
    if (planetDist < houseSpan) return i;
  }
  return 1;
}

export interface AspectHit {
  angle: number;
  name: string;
  symbol: string;
  /** 正確な角度からのずれ（度） */
  orb: number;
  /** 実際の離角（度、0-180） */
  exact: number;
}

/** 2 天体間のメジャーアスペクト判定（オーブ内なら最初に当たったものを返す） */
export function getAspect(deg1: number, deg2: number, orb: number = DEFAULT_ORB): AspectHit | null {
  let diff = Math.abs(normalizeDegree(deg1) - normalizeDegree(deg2));
  if (diff > 180) diff = 360 - diff;

  for (const aspect of ASPECTS) {
    const distance = Math.abs(diff - aspect.angle);
    if (distance <= orb) {
      return {
        angle: aspect.angle,
        name: aspect.name,
        symbol: aspect.symbol,
        orb: distance,
        exact: diff,
      };
    }
  }
  return null;
}

/**
 * 接近中（applying）か。オーブが縮む向きに動いているか＝瞬間の変化率で判定する。
 *
 * 移植元 calc.js は「1 日後のオーブと今のオーブを比べる」方式だが、月（約 13°/日）のように
 * 1 日で離角がアスペクトを丸ごと通過する天体では、接近中でも「1 日後にはもう通過後で遠い」
 * ため常に離反と誤判定される（オーブ 1° 運用では月のアスペクトがほぼ全滅、太陽・水星・金星も
 * オーブが日速の半分未満だと同罪）。変化率なら足の速さに関係なく正しい（2026-08-20 修正）。
 */
export function isApplying(
  deg1: number,
  deg2: number,
  speed1: number,
  speed2: number,
  aspectAngle: number,
): boolean {
  let diff = deg1 - deg2;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;

  // |diff| の変化率。diff の符号で「差が開く向き」が決まる
  const absDiffRate = (diff >= 0 ? 1 : -1) * (speed1 - speed2);
  // オーブ＝| |diff| − アスペクト角 |。ぴったり成立の瞬間は「接近」とは言わない
  const orbSigned = Math.abs(diff) - aspectAngle;
  if (orbSigned === 0) return false;
  return (orbSigned > 0 ? absDiffRate : -absDiffRate) < 0;
}

/** アスペクトを探す相手（天体でも ASC/MC でもよい） */
export interface AspectPoint {
  name: string;
  lon: number;
  speed: number;
}

export interface CrossAspect {
  /** ネイタル側（天体名 / ASC / MC） */
  natal: string;
  /** トランジット側（天体名） */
  transit: string;
  aspect: AspectHit;
  applying: boolean;
}

/**
 * 2 セット間のクロスアスペクト（calc.js の calculateCrossAspects 相当）。
 * ASC / MC は速度 0 の擬似天体として natal 側に混ぜて渡す。
 */
export function crossAspects(
  natal: readonly AspectPoint[],
  transit: readonly AspectPoint[],
  orb: number = DEFAULT_ORB,
): CrossAspect[] {
  const results: CrossAspect[] = [];
  for (const n of natal) {
    for (const t of transit) {
      const aspect = getAspect(n.lon, t.lon, orb);
      if (!aspect) continue;
      results.push({
        natal: n.name,
        transit: t.name,
        aspect,
        applying: isApplying(n.lon, t.lon, n.speed, t.speed, aspect.angle),
      });
    }
  }
  results.sort((a, b) => a.aspect.orb - b.aspect.orb);
  return results;
}

// ---------------------------------------------------------------------------
// 天文計算（SwissEPH インスタンスを受け取る）
// ---------------------------------------------------------------------------

export interface PlanetPosition {
  id: number;
  /** 黄経（度） */
  lon: number;
  /** 黄経速度（度/日）。負なら逆行 */
  speed: number;
}

/** 出生（またはトランジット）の日時。utcOffset は時間単位（日本は 9） */
export interface MomentInput {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  utcOffset: number;
}

/** ローカル日時 → ユリウス日（UT）。calc.js と同じ「時に分と時差を溶かす」やり方 */
export function julianDay(swe: SwissEph, moment: MomentInput): number {
  const utcHour = moment.hour + moment.minute / 60 - moment.utcOffset;
  return swe.swe_julday(moment.year, moment.month, moment.day, utcHour, GREGORIAN);
}

/** ユリウス日（UT）= Unix 元期 1970-01-01 00:00 UT のときの値 */
const UNIX_EPOCH_JD = 2440587.5;

/**
 * ユリウス日（UT）→ UTC の Date。
 *
 * リターンの瞬間を人間の暦に戻すのに使う。秒より下は浮動小数の埃なので秒に丸める
 * （丸めないと 15:02:59.9999… が「15:02」と表示されてしまう）。
 */
export function dateFromJulianDay(jd: number): Date {
  const milliseconds = (jd - UNIX_EPOCH_JD) * 86_400_000;
  return new Date(Math.round(milliseconds / 1000) * 1000);
}

/** 一日一年法の「1 年」の長さ（日）。calc.js の PROGRESSION_YEAR_DAYS と同じ回帰年 */
export const PROGRESSION_YEAR_DAYS = 365.2422;

/**
 * 黄経 MC → ARMC（子午線の赤経）。calc.js の mcToArmc をそのまま移した。
 * 進行 ASC / カスプを swe_houses_armc で立てるために要る。
 */
export function mcToArmc(mc: number, eps: number): number {
  const rad = Math.PI / 180;
  const armc = Math.atan2(Math.sin(mc * rad) * Math.cos(eps * rad), Math.cos(mc * rad)) / rad;
  return normalizeDegree(armc);
}

/** 11 天体の黄経と速度 */
export function computePlanets(swe: SwissEph, jd: number): PlanetPosition[] {
  return PLANETS.map((planet) => {
    const result = swe.swe_calc_ut(jd, planet.id, CALC_FLAGS);
    return { id: planet.id, lon: result[0] as number, speed: result[3] as number };
  });
}

export interface ComputedChart {
  planets: PlanetPosition[];
  /** [0] はダミー、1..12 がカスプ */
  cusps: number[];
  /** [0]=ASC, [1]=MC, 以下 ARMC / Vertex … */
  ascmc: number[];
}

/** ユリウス日から図 1 枚（天体＋ハウス）。リターン図のように jd が先に決まる図で使う */
export function computeChartFromJd(
  swe: SwissEph,
  jd: number,
  place: { lat: number; lng: number; houseSystem: string },
): ComputedChart {
  const houses = swe.swe_houses(jd, place.lat, place.lng, place.houseSystem);
  return {
    planets: computePlanets(swe, jd),
    cusps: houses.cusps,
    ascmc: houses.ascmc,
  };
}

/** 出生図 1 枚（天体＋ハウス）。jd はここで捨てる ―― 保存もしない */
export function computeChart(
  swe: SwissEph,
  moment: MomentInput,
  place: { lat: number; lng: number; houseSystem: string },
): ComputedChart {
  return computeChartFromJd(swe, julianDay(swe, moment), place);
}

/** チャートの ASC / MC */
export function anglesOf(chart: { cusps: readonly number[]; ascmc: readonly number[] }): {
  asc: number;
  mc: number;
} {
  return { asc: chart.cusps[1] as number, mc: chart.ascmc[1] as number };
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/** 「太陽 双子座 24°02′ (10H)（逆行）」の 1 行 */
export function formatPlanetLine(
  position: PlanetPosition,
  options: { house?: number | null } = {},
): string {
  const house = options.house === undefined || options.house === null ? "" : ` (${options.house}H)`;
  const retrograde = position.speed < 0 ? "（逆行）" : "";
  return `${planetName(position.id)} ${formatDegree(position.lon)}${house}${retrograde}`;
}

/** 天体の並びをまとめて行にする */
export function formatPlanetLines(
  planets: readonly PlanetPosition[],
  cusps?: readonly number[],
): string[] {
  return planets.map((planet) =>
    formatPlanetLine(planet, { house: cusps ? getHouse(planet.lon, cusps) : null }),
  );
}

/** 「ASC 乙女座 12°30′ / MC 双子座 10°05′」 */
export function formatAngles(angles: { asc: number; mc: number }): string {
  return `ASC ${formatDegree(angles.asc)} / MC ${formatDegree(angles.mc)}`;
}

/** 「1H 蟹座 0°00′ / 2H 獅子座 0°00′ / …」の 1 行（cusps は [0] ダミー＋1..12） */
export function formatCuspLine(cusps: readonly number[]): string {
  return Array.from({ length: 12 }, (_unused, index) => {
    const house = index + 1;
    return `${house}H ${formatDegree(cusps[house] as number)}`;
  }).join(" / ");
}

/**
 * 「T.太陽 △ N.月 (0.3°) 接近」
 *
 * prefix は動いている側の頭文字。トランジット・リターン図は既定の "T."、
 * 二次進行は "P." を渡す（進行天体を "T." と書くと読み違えのもとなので）。
 */
export function formatCrossAspect(hit: CrossAspect, prefix = "T."): string {
  const orb = (Math.round(hit.aspect.orb * 100) / 100).toFixed(2);
  return `${prefix}${hit.transit} ${hit.aspect.symbol} N.${hit.natal}（${hit.aspect.name} / オーブ ${orb}° / ${
    hit.applying ? "接近" : "離反"
  }）`;
}
