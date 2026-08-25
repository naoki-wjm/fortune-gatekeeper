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

/**
 * サイデリアル計算の基準点（アヤナムシャ）＝ SE_SIDM_LAHIRI。
 *
 * 宿曜（src/shukuyo.ts）がサイデリアル黄経を要るので、engine.ts の初期化直後に
 * `swe_set_sid_mode(SIDEREAL_MODE_LAHIRI, 0, 0)` を一度だけ呼んである。
 * Lahiri は**式で出る**基準点なので、天文暦ファイルも恒星ファイルも要らない
 * （True Chitrapaksha のように恒星の位置を引くものは Moshier 固定と両立しない）。
 * ⚠ この設定が効くのは SEFLG_SIDEREAL を立てた計算だけで、CALC_FLAGS には入っていない
 *    ＝ホロスコープ側のトロピカル計算は 1 度も変わらない。
 */
export const SIDEREAL_MODE_LAHIRI = 1;

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
  /**
   * サイデリアル計算の基準点を選ぶ（宿曜は SIDEREAL_MODE_LAHIRI で固定）。
   * t0 / ayan_t0 は「自前の基準点」を渡すとき用で、既製の sid_mode では 0 を渡す。
   * ⚠ 呼ぶのは engine.ts の初期化直後に一度だけ。
   */
  swe_set_sid_mode(sidMode: number, t0: number, ayanT0: number): void;
  /**
   * その瞬間（UT のユリウス日）のアヤナムシャ（度）。
   * **サイデリアル黄経 = トロピカル黄経 − これ**（src/shukuyo.ts の toSidereal）。
   */
  swe_get_ayanamsa_ut(jd: number): number;
  /**
   * 次の日食（**global**＝地球上のどこかで起きるもの。場所は受けない）。
   * 戻りは tret 10 要素で [0] 食の最大・[2][3] 食の始まりと終わり・
   * [4][5] 皆既／金環の始まりと終わり・[6][7] 中心線の始まりと終わり。ifltype = 0 で全種類。
   * ⚠ **種類（SE_ECL_TOTAL などのビット）は C 関数の戻り値**で、wrapper がそれを捨てている。
   *    種類は tret と swe_sol_eclipse_where から導くこと（src/moon-calendar.ts の solarEclipseType）。
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
   * 皆既／部分／半影は [4] と [2] が 0 かどうかで分かる（日食と違って戻り値が要らない）。
   */
  swe_lun_eclipse_when(
    startJd: number,
    flags: number,
    ifltype: number,
    backward: boolean,
  ): number[];
  /**
   * その瞬間の日食を地表のどこで見るか＋属性。
   * `Array[1]` が月と太陽の視直径比で、1 より大きければ皆既・小さければ金環
   * （綴りが `Array` なのは wrapper のまま。複製ファイルには手を入れない方針）。
   */
  swe_sol_eclipse_where(jd: number, flags: number): { data: number[]; Array: number[] };
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

/**
 * 出生図の中のアスペクト（ネイタル内アスペクト）の既定オーブ（度）。
 * astro-viewer `shared/data.js` の `orbs.natal` と同じ値 ―― 止まった図は広めに取るのが通例。
 */
export const DEFAULT_NATAL_ORB = 5;

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

/** 1 枚の図の中のアスペクト（どちらが動く側でもない＝ a / b は対等） */
export interface NatalAspect {
  /** 点列で先に出てくる側 */
  a: string;
  /** 後に出てくる側 */
  b: string;
  aspect: AspectHit;
}

/**
 * 1 セットの中のアスペクト（出生図の中のアスペクト）。
 *
 * クロスと違って相手が同じ点列なので **i < j の組だけ**を見る
 * ―― 自分同士（必ず 0°）と、裏返しの重複を出さないため。
 * applying を付けないのは、ネイタルが止まった図だから ―― 誰も動いていない図に接近も離反もない。
 */
export function natalAspects(
  points: readonly AspectPoint[],
  orb: number = DEFAULT_NATAL_ORB,
): NatalAspect[] {
  const results: NatalAspect[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i] as AspectPoint;
      const b = points[j] as AspectPoint;
      const aspect = getAspect(a.lon, b.lon, orb);
      if (!aspect) continue;
      results.push({ a: a.name, b: b.name, aspect });
    }
  }
  results.sort((x, y) => x.aspect.orb - y.aspect.orb);
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

/** オーブの度数表記（「0.50°」）。クロスもネイタル内も同じ流儀で書く */
function orbText(orb: number): string {
  return `${(Math.round(orb * 100) / 100).toFixed(2)}°`;
}

/**
 * 「T.太陽 △ N.月 (0.3°) 接近」
 *
 * prefix は動いている側の頭文字。トランジット・リターン図は既定の "T."、
 * 二次進行は "P." を渡す（進行天体を "T." と書くと読み違えのもとなので）。
 */
export function formatCrossAspect(hit: CrossAspect, prefix = "T."): string {
  return `${prefix}${hit.transit} ${hit.aspect.symbol} N.${hit.natal}（${hit.aspect.name} / オーブ ${orbText(
    hit.aspect.orb,
  )} / ${hit.applying ? "接近" : "離反"}）`;
}

/**
 * 「太陽 □ 月（スクエア / オーブ 2.21°）」
 *
 * ネイタル内アスペクトの 1 行。クロスと違って T. / N. の札も接近・離反も付かない
 * ―― 同じ図の中の 2 点なので、どちらが動く側でもない。
 */
export function formatNatalAspect(hit: NatalAspect): string {
  return `${hit.a} ${hit.aspect.symbol} ${hit.b}（${hit.aspect.name} / オーブ ${orbText(hit.aspect.orb)}）`;
}

// ---------------------------------------------------------------------------
// シナストリー（2 枚の図の間）
// ---------------------------------------------------------------------------

/** 2 枚の図の間のアスペクト（A 側と B 側。どちらも止まった図なので対等） */
export interface SynastryAspect {
  /** A の図の点（天体名 / ASC / MC） */
  a: string;
  /** B の図の点 */
  b: string;
  aspect: AspectHit;
}

/**
 * 2 枚の図の間のアスペクト（シナストリー）。
 *
 * 相手が別の点列なので natalAspects の「i < j の組だけ」ではなく **総当たり**
 * ―― A.太陽 × B.月 と A.月 × B.太陽 は別の組で、どちらも要る（裏返しの重複ではない）。
 * applying を付けないのは crossAspects と違って**どちらの図も止まっている**から
 * ―― 出生図同士に接近も離反もない（速度はどちらも 0 で渡ってくる）。
 */
export function synastryAspects(
  a: readonly AspectPoint[],
  b: readonly AspectPoint[],
  orb: number = DEFAULT_NATAL_ORB,
): SynastryAspect[] {
  const results: SynastryAspect[] = [];
  for (const pointA of a) {
    for (const pointB of b) {
      const aspect = getAspect(pointA.lon, pointB.lon, orb);
      if (!aspect) continue;
      results.push({ a: pointA.name, b: pointB.name, aspect });
    }
  }
  results.sort((x, y) => x.aspect.orb - y.aspect.orb);
  return results;
}

/** 相手の図のハウスで数えた在ハウス（ハウスオーバーレイ）の 1 件 */
export interface HouseOverlayEntry {
  planet: string;
  house: number;
}

/**
 * 天体の並びを、渡されたカスプ（＝相手の図のハウス）で数え直す。
 *
 * getHouse を回すだけの薄い関数。ノードも落とさない
 * ―― アスペクトの相手には入れないが、どのハウスに居るかは一覧に出す方針（get_chart と同じ）。
 */
export function houseOverlay(
  planets: readonly { id: number; lon: number }[],
  cusps: readonly number[],
): HouseOverlayEntry[] {
  return planets.map((planet) => ({
    planet: planetName(planet.id),
    house: getHouse(planet.lon, cusps),
  }));
}

/**
 * 2 枚の図の間のアスペクトの 1 行。札（どちらの図の点か）を呼び出し側から渡す版。
 *
 * シナストリーは "A." / "B." だが、中点図（コンポジット）と第三者を突き合わせるときのように
 * 別の名札が要る場面もあるので、整形の実体はここ 1 つにまとめてある。
 */
export function formatPairAspect(hit: SynastryAspect, labelA: string, labelB: string): string {
  return `${labelA}${hit.a} ${hit.aspect.symbol} ${labelB}${hit.b}（${hit.aspect.name} / オーブ ${orbText(
    hit.aspect.orb,
  )}）`;
}

/**
 * 「A.太陽 ☌ B.月（コンジャンクション / オーブ 1.40°）」
 *
 * シナストリーの 1 行。クロス（T. / N.）と同じく**どちらの図の点か**を札で示すが、
 * 止まった図同士なので接近・離反は付かない。
 */
export function formatSynastryAspect(hit: SynastryAspect): string {
  return formatPairAspect(hit, "A.", "B.");
}

/** 「太陽 7H / 月 4H / …」（在ハウスの 1 行） */
export function formatHouseOverlay(overlay: readonly HouseOverlayEntry[]): string {
  return overlay.map((entry) => `${entry.planet} ${entry.house}H`).join(" / ");
}
