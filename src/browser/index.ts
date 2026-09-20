/**
 * ブラウザ用の束ねの入口（divination 向け）。
 *
 * 姉妹企画 divination（静的サイト）が、このリポの純関数を**ブラウザの中で直接動かして**
 * LLM に貼るテキストを作るための口です。計算の正本はこのリポの 1 か所のままで、
 * 向こうには写しを置きません ―― `npm run build:browser` で束ねた 1 本の JS を参照してもらいます。
 *
 * ⚠ **天体計算（sweph-wasm）は束ねに含めません**。divination 側は Astro Tool（astro-viewer）と
 *    同じ `sweph-wasm.js` を読み、`SwissEPH.init()` で得た `swe` をここの関数に渡します
 *    （astro-viewer の複製は当リポ `src/astro/sweph/` と SHA-256 が一致することを確認済み）。
 *    したがってこの入口は `SwissEph` 型を**引数で受けるだけ**で、
 *    `src/astro/engine.ts` も `src/astro/sweph/**` も import しません。
 *
 * ⚠ **このファイルはロジックを書かない**（列挙だけ）。
 *    そして台帳（store.ts）・鍵つきツール（astro/tools/**）・身元（auth/**）・Workers の入口
 *    （worker.ts / index.ts / astro-mcp.ts / mcp.ts）には**道を通さない**
 *    ―― `test/import-boundary.test.ts` が依存グラフで機械的に見張っています。
 *    個人データはブラウザの中だけで完結し、どこにも送られません（貼るかどうかは利用者が決める）。
 */

// ---------------------------------------------------------------------------
// 鯖の憲法（貼り付けテキストを読む側に、毎回同じ言い方で伝えるための文）
// ---------------------------------------------------------------------------
export {
  PRINCIPLE_SERVER_COMPUTES,
  PRINCIPLE_CONVENTIONS_ARE_NAMED,
  PRINCIPLE_NO_SUMMING,
  READ_WITH_YOUR_OWN_KNOWLEDGE,
} from "../phrases";

// ---------------------------------------------------------------------------
// エンジンの準備
// ---------------------------------------------------------------------------
import { SIDEREAL_MODE_LAHIRI, type SwissEph } from "../astro/chart";

/**
 * 受け取った `swe` を、このリポの計算が前提にしている状態にする。
 *
 * やるのは 1 つだけ ―― サイデリアルの基準点を **Lahiri** に固定する
 * （本番の `src/astro/engine.ts` が wasm の初期化直後に呼んでいるのと同じ設定）。
 * 宿曜がサイデリアル黄経を使うので、これを通し忘れると既定の Fagan-Bradley で計算され、
 * 宿が 1 つずれることがあります。何度呼んでも害はないので、初期化のたびに通してください。
 */
export function prepareEngine(swe: SwissEph): SwissEph {
  swe.swe_set_sid_mode(SIDEREAL_MODE_LAHIRI, 0, 0);
  return swe;
}

// ---------------------------------------------------------------------------
// 占術ごとの純関数（引く・立てる・整形する）
// ---------------------------------------------------------------------------

/** カード */
export { DECKS, DECK_IDS, getDeck } from "../decks";
export { SPREADS, SPREAD_IDS, getSpread } from "../spreads";
export { drawCards, formatDrawResult, DrawError } from "../draw";

/** 易占（＋納甲） */
export { castHexagram, formatCastResult, CastError } from "../iching";
export {
  buildNakko,
  formatNakkoText,
  sunLongitude,
  momentFromDate,
  DEFAULT_UTC_OFFSET,
} from "../nakko";

/** ジオマンシー */
export { castGeomancy, formatShieldChartText, FIGURES } from "../geomancy";

/** アストロダイス */
export {
  rollAstroDice,
  formatAstroDiceText,
  MAX_DICE_COUNT,
  DiceError,
} from "../astro-dice";

/** 数秘術 */
export {
  calculateNumerology,
  formatNumerologyText,
  DEFAULT_MASTERS,
  MASTERS_OPTIONS,
  NumerologyError,
} from "../numerology";

/** 宿曜（純関数＋エンジンを受けるグルー） */
export {
  shukuOf,
  shukuAt,
  parseShuku,
  relationOf,
  compatOf,
  formatShukuLines,
  formatCompatLines,
  formatRelation,
  formatShukuName,
  toSidereal,
  SHUKU,
  SHUKU_COUNT,
  SHUKU_SPAN,
  AYANAMSA_NAME,
  ShukuyoError,
} from "../shukuyo";
export {
  shukuAtJd,
  moonShukuChanges,
  moonLongitude,
  SHUKUYO_SYSTEM,
  SHUKUYO_SYSTEM_LINE,
} from "../astro/shukuyo-engine";

/** 四柱推命（純関数＋エンジンを受けるグルー） */
export {
  calculateFourPillars,
  calculateDateFortune,
  formatFourPillarsText,
  formatDateFortuneText,
  orderedPillars,
  FOUR_PILLARS_CONVENTIONS,
  DATE_FORTUNE_CONVENTIONS,
  FourPillarsError,
} from "../four-pillars";
export {
  calculatePillarsRelations,
  formatPillarsRelationsText,
  PILLARS_RELATIONS_CONVENTIONS,
  MIN_PARTIES,
  MAX_PARTIES,
  PillarsRelationsError,
} from "../pillars-relations";
export {
  computeFourPillarsNatal,
  computeDateFortune,
  solarTermSpanAt,
} from "../astro/four-pillars-engine";

/** 九星気学（純関数＋エンジンを受けるグルー） */
export {
  yearStar,
  monthStar,
  dayStar,
  board,
  satsu,
  starOf,
  formatBoardText,
  formatSatsuText,
  KYUSEI_CONVENTIONS,
  KyuseiError,
} from "../kyusei";
export {
  computeKyuseiBirth,
  computeKyuseiBoards,
  kyuseiBoardText,
  solsticesAround,
  KYUSEI_SYSTEM_LINE,
} from "../astro/kyusei-engine";

/** サビアン度数 */
export { sabianDegreeOf, SABIAN_CONVENTION } from "../sabian";

/** 暦・角度・星座の札（Astro Tool 側と同じ道具立て） */
export {
  julianDay,
  dateFromJulianDay,
  normalizeDegree,
  signIndex,
  formatDegree,
  SIGNS,
  SIDEREAL_MODE_LAHIRI,
  CALC_FLAGS,
  PLANETS,
  AstroError,
} from "../astro/chart";

// ---------------------------------------------------------------------------
// 貼り付けテキスト（Astro Tool 様式。1 行目【種別】・2 行目 規約・■ 節）
// ---------------------------------------------------------------------------
export {
  tzLabel,
  momentLabel,
  pasteHeader,
  calendarLabel,
  dateLabelOf,
  jdLocalLabel,
  conventionsOf,
} from "./paste-common";
export { pasteFourPillars, FOUR_PILLARS_CONVENTION_LINE } from "./paste-four-pillars";
export { pasteKyusei } from "./paste-kyusei";
export { pasteShukuyo, pasteShukuyoCompat } from "./paste-shukuyo";
export { pasteNumerology } from "./paste-numerology";
export {
  pasteHexagram,
  ICHING_CONVENTION_LINE,
  NAKKO_CONVENTION_SUFFIX,
} from "./paste-iching";
export { pasteGeomancy, GEOMANCY_CONVENTION_LINE } from "./paste-geomancy";
export { pasteDraw } from "./paste-cards";
export { pasteAstroDice, ASTRO_DICE_CONVENTION_LINE } from "./paste-astro-dice";
export { pasteSabian, SABIAN_CONVENTION_LINE } from "./paste-sabian";

// ---------------------------------------------------------------------------
// 型（呼び出し側が引数と返り値を組み立てるのに要るもの）
// ---------------------------------------------------------------------------
export type { SwissEph, MomentInput, PlanetPosition } from "../astro/chart";
export type { NakkoMoment, NakkoView, Pillar } from "../nakko";
export type { CastResult, CastMethodId, HexagramView } from "../iching";
export type { ShieldChart, Figure } from "../geomancy";
export type { AstroDiceRoll } from "../astro-dice";
export type { DrawResult, DrawOptions, DrawnCard, Orientation } from "../draw";
export type { Deck, DeckId } from "../decks";
export type { Spread, SpreadId } from "../spreads";
export type {
  NumerologyResult,
  NumerologyInput,
  MastersOption,
  TargetDate,
} from "../numerology";
export type { Shuku, ShukuPosition, ShukuCompat, Relation } from "../shukuyo";
export type {
  FourPillarsResult,
  DateFortuneResult,
  FourPillarsView,
  SolarTermSpan,
} from "../four-pillars";
export type { PillarsRelationsResult, PartyInput } from "../pillars-relations";
export type { Star, Board, BoardCell, Satsu, DayStarView, Dun } from "../kyusei";
export type {
  KyuseiBirthView,
  KyuseiBoards,
  KyuseiBoardView,
  NatalStars,
} from "../astro/kyusei-engine";
export type { SabianDegree } from "../sabian";
export type {
  FourPillarsPaste,
  FourPillarsPasteOptions,
  FourPillarsPasteTarget,
} from "./paste-four-pillars";
export type { KyuseiPaste, KyuseiPasteOptions, KyuseiPasteTarget } from "./paste-kyusei";
export type {
  ShukuyoPaste,
  ShukuyoPasteOptions,
  ShukuyoPasteDate,
  ShukuyoPasteDay,
  ShukuyoCompatPaste,
  ShukuyoCompatParty,
} from "./paste-shukuyo";
export type { NumerologyPaste, NumerologyPasteOptions } from "./paste-numerology";
export type { HexagramPaste, HexagramPasteOptions, HexagramPasteNakko } from "./paste-iching";
export type { GeomancyPaste } from "./paste-geomancy";
export type { DrawPaste } from "./paste-cards";
export type { AstroDicePaste } from "./paste-astro-dice";
export type { SabianPaste, SabianEntry } from "./paste-sabian";
