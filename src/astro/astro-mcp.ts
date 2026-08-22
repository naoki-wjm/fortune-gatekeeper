/**
 * 占星術層の MCP ハンドラ（`POST /astro/mcp`＝ OAuth の門の内側）。
 *
 * カード層（src/mcp.ts）と同じ流儀 ―― ステートレスな Streamable HTTP、JSON-RPC 2.0 単発、
 * ツールの失敗は isError。違うのは 2 点だけ:
 *   - 門で確かめた身元（AuthContext）で人を見分ける（誰の chart_id か、を分けるためだけの仕切り）
 *   - KV に「計算済みのチャート」と、預かった出生データを置く
 *     （**出生データは返事に出さない** ―― 表に出すときは publicChart で落とす）
 *
 * ここも解釈層を持たない。返すのは座標と角度で、読むのは会話中の Claude。
 * wasm には触らない（エンジンは `getEngine` として外から注入される）＝ Node のテストでも回る。
 */
import {
  SERVER_NAME,
  SERVER_VERSION,
  allowedArgumentKeys,
  jsonRpcError,
  jsonRpcResult,
  negotiateProtocolVersion,
  readJsonRpcRequest,
  toolError,
  unknownArgumentMessage,
  type ToolResult,
} from "../mcp";
import {
  AstroError,
  CALC_FLAGS,
  DEFAULT_NATAL_ORB,
  DEFAULT_ORB,
  HOUSE_SYSTEM_CODES,
  SIDEREAL_MODE_LAHIRI,
  anglesOf,
  computeChart,
  computeChartFromJd,
  computePlanets,
  crossAspects,
  dateFromJulianDay,
  formatAngles,
  formatCrossAspect,
  formatCuspLine,
  formatDegree,
  formatHouseOverlay,
  formatNatalAspect,
  formatPlanetLines,
  formatSynastryAspect,
  getHouse,
  houseOverlay,
  houseSystemName,
  julianDay,
  natalAspects,
  normalizeDegree,
  planetName,
  synastryAspects,
  type AspectPoint,
  type ComputedChart,
  type MomentInput,
  type PlanetPosition,
  type SwissEph,
} from "./chart";
import {
  DEFAULT_MASTERS,
  MASTERS_OPTIONS,
  NumerologyError,
  calculateNumerology,
  formatNumerologyText,
  type MastersOption,
  type NumerologyResult,
} from "../numerology";
import {
  FourPillarsError,
  SOLAR_TERMS,
  calculateDateFortune,
  calculateFourPillars,
  formatDateFortuneText,
  formatFourPillarsText,
  solarTermSpanFromJd,
  type DateFortuneResult,
  type FourPillarsResult,
  type SolarTermSpan,
} from "../four-pillars";
import {
  fourPillars,
  isBeforeRisshun,
  julianDayNumber,
  momentFromDate,
  monthBranchOrder,
  sunLongitude,
  type NakkoMoment,
  type Pillar,
} from "../nakko";
import {
  KYUSEI_CONVENTIONS,
  KyuseiError,
  board,
  dayStar,
  formatBoardText,
  formatSatsuText,
  monthStar,
  satsu,
  starOf,
  yearStar,
  type BoardCell,
  type BoardKind,
  type DayStarView,
  type Dun,
  type Satsu,
  type SolsticeDay,
  type Star,
} from "../kyusei";
import {
  AYANAMSA_NAME,
  SHUKU_COUNT,
  SHUKU_SPAN,
  ShukuyoError,
  compatOf,
  formatCompatLines,
  formatShukuLines,
  formatShukuName,
  formatRelation,
  parseShuku,
  relationOf,
  shukuAt,
  shukuIndexOf,
  shukuOf,
  toSidereal,
  type Shuku,
  type ShukuPosition,
} from "../shukuyo";
import {
  BODY_SET_LABEL,
  MAX_DAYS,
  TICK_MINUTES,
  assertDaysInRange,
  formatEventsText,
  scanTransitEvents,
  type BodySet,
} from "./events";
import {
  computeProgression,
  crossUt,
  crossingsInRange,
  formatAge,
  formatArc,
  type ReturnKind,
} from "./returns";
import {
  createChart,
  deleteChart,
  getChart,
  isChartId,
  listCharts,
  putChart,
  type AstroKv,
  type AuthContext,
  type StoredChart,
} from "./store";
import { formatYearlyText, scanYearlyRange } from "./yearly";

export { type AstroKv, type AuthContext };

/** 占星術層の initialize に載せる注意書き（カード層とは別文） */
const ASTRO_INSTRUCTIONS =
  "ホロスコープ（西洋占星術）の天体位置を計算するサーバーです。" +
  "計算するのはサーバー、読むのは会話中のあなた——返すのは天体の黄経・ハウス・アスペクトといった" +
  "座標と角度だけで、解釈は一切しません。読み解きはあなた自身の知識で行ってください。" +
  "自分で「計算したふり」をせず、天体の位置が要る場面では必ずこのツールを呼ぶこと。\n" +
  "チャートは save_chart で一度登録すると chart_id で何度でも呼び出せます。" +
  "保存されるのは計算済みの座標（天体の黄経と速度・ハウスカスプ・ASC/MC・ラベル・ハウス方式）で、" +
  "**出生データ（日時・時差・緯度経度）も計算済みの座標と一緒にこの鍵の台帳に預かります**" +
  "（鍵を持つ人だけが使え、delete_chart で消えます。返事には出生データそのものは出しません）。" +
  "ハウス方式を変えたいときは delete_chart して save_chart で登録し直してください。\n" +
  "使い分け: save_chart=出生データを登録して chart_id を得る / list_charts=登録済みの一覧 / " +
  "get_chart=登録済みの出生図を読み直す（天体・ASC/MC・カスプ・出生図の中のアスペクト。" +
  "transit は今の空、こちらは生まれたときの空） / " +
  "transit=登録したチャートに対する任意時刻（省略時は現在）の天体・在ハウス・アスペクト" +
  "（ネイタルへのアスペクトと、空の中のアスペクトの両方） / " +
  "synastry=登録済みの出生図 2 枚の間のアスペクトと、互いのハウスに相手の天体がどう入るか" +
  "（2 人の関係を見るときはこれ。a / b とも自分の台帳の chart_id なので、" +
  "相手の出生データを会話に出さずに済みます） / " +
  "delete_chart=登録の取り消し / " +
  "update_default_location=「いつもの場所」だけの差し替え（引っ越したときなど。" +
  "出生データの再入力は要らず、計算済みの座標にも触りません） / " +
  "lunar_return=ネイタルの月に空の月が戻る瞬間（約27.3日に1回）とその図（図の中のアスペクトつき） / " +
  "solar_return=ネイタルの太陽に空の太陽が戻る瞬間（年に1回・誕生日のころ）とその図" +
  "（図の中のアスペクトつき） / " +
  "progressions=二次進行（一日一年法） / " +
  "yearly_overview=ソーラーリターンから次のソーラーリターンまでの 1 年の逆行期間・イングレス・" +
  "ネイタルへの外惑星トランジットの一覧（1 日刻み。" +
  "「今日だけの配置か、数週間続く背景か、次に動くのはいつか」を見るならこれ） / " +
  "transit_events=期間内（既定は今日から 7 日）のアスペクトの entering・exact・leaving、留、" +
  "イングレスを分単位の時刻つきで時系列に" +
  "（「今週 exact になるのは」「明日いちばんタイトな時間帯は」はこれ）/ " +
  "calculate_numerology=数秘術" +
  "（ライフパス 4 経路・バースデー・アティチュード・パーソナルイヤー／マンス／デイ）。" +
  "chart_id か生年月日の直接指定（year / month / day）のどちらかで呼べます" +
  "（登録せずに一度だけ見るときは直接指定を使ってください）。" +
  "数秘術は誕生日を使うので公開のカード層には無く、この鍵つきの入口だけにあります。 / " +
  "shukuyo=宿曜占星術（二十七宿）の本命宿とその日の宿" +
  "（天文方式＝出生時刻の月のサイデリアル黄経・基準点は Lahiri 固定・27 宿。" +
  "chart_id か生年月日＋出生時刻の直接指定で呼べます。date で過去も未来も見られます） / " +
  "shukuyo_compat=2 人の宿の関係（三九の秘法。chart_id でも宿名だけでも呼べるので、" +
  "相手の出生データを会話に出さずに済みます） / " +
  "four_pillars=四柱推命（子平）の命式（年月日時の四柱・通変星・十二運・蔵干・空亡・" +
  "大運は順行と逆行の両方）と、date（省略すると今）の流年・月運・日運。" +
  "日界 0 時・節気は太陽黄経・時刻の補正なしで、chart_id か生年月日＋出生時刻の直接指定で呼べます" +
  "（時柱が要るので時刻の分からない出生では引けません）。 / " +
  "kyusei=九星気学の本命星・月命星・日命星と、date（省略すると今）の年盤・月盤・日盤と殺。" +
  "年界は立春・月界は節・日界は 0 時・陽遁陰遁は冬至／夏至に最も近い甲子日で切り替え。" +
  "**出生時刻は任意**で、chart_id か生年月日の直接指定で呼べます" +
  "（立春・節入りの当日の生まれのときだけ時刻で星が変わるので、両方の候補を添えます）。" +
  "九星・殺・方位の意味も吉方位も載せていません" +
  "——ホロスコープ・宿曜・四柱・九星はそれぞれ別の体系です。\n" +
  "宿曜も四柱も九星も誕生日を使うのでこの鍵つきの入口だけにあり、" +
  "**宿の意味はサーバーに載せていません**——読みはあなた自身の知識で。" +
  "四柱推命も同じで、通変星・十二運・蔵干・大運の意味は載せていません。\n" +
  "progressions も chart_id で呼べます（出生データを預かっているチャートが要ります）。\n" +
  "⚠ ホロスコープ・宿曜・四柱・九星はそれぞれ別の体系です。並べて眺めるのはよいのですが、" +
  "**四体系（ホロスコープ・宿曜・四柱・九星）を合算する根拠はありません**" +
  "——点数を足したり多数決を取ったりしないでください。";

// ---------------------------------------------------------------------------
// ツール定義
// ---------------------------------------------------------------------------

const HOUSE_SYSTEM_DESCRIPTION =
  "ハウス方式（既定 P）。P=プラシーダス / K=コッホ / W=ホールサイン / E=イコール。" +
  "出生時刻がはっきりしない場合はホールサイン（W）が無難。";

export const ASTRO_TOOLS = [
  {
    name: "save_chart",
    title: "出生図を登録する",
    description:
      "出生データからネイタルチャート（出生図）を計算し、chart_id を付けて保存する。" +
      "以後は chart_id だけでトランジットなどを引ける。\n" +
      "保存されるのは計算結果の座標（天体の黄経と速度・ハウスカスプ・ASC/MC・ラベル・ハウス方式）と、" +
      "**渡された出生データそのもの**（年月日・時刻・時差・緯度経度）。" +
      "出生データは誕生日から引く占術と progressions のために預かるもので、" +
      "この鍵の台帳にだけ入り、**どのツールの返事にも出さない**（delete_chart で消える）。\n" +
      "ハウス方式を変えて計算し直したいときは、delete_chart で消してからもう一度このツールを呼ぶ" +
      "（同じ chart_id への上書き登録は無い）。\n" +
      "日時は**出生地の現地時刻**で渡し、utc_offset にその土地の時差を書く（日本は 9）。" +
      "緯度・経度は北緯・東経が正、南緯・西経が負。\n" +
      "default_lat / default_lng は「いつもの場所」（現在の居住地など）で、" +
      "後々のリターン計算で使う。分からなければ省略してよい。",
    inputSchema: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "チャートの呼び名（一覧に出る）。本人の名前でも「わたし」「Aさん」でもよい。",
        },
        year: { type: "integer", description: "出生年（西暦）" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "出生月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "出生日（1-31）" },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "出生時刻の「時」（0-23、出生地の現地時刻）",
        },
        minute: {
          type: "integer",
          minimum: 0,
          maximum: 59,
          description: "出生時刻の「分」（0-59、出生地の現地時刻）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "出生地の UTC からの時差（時間単位。日本は 9、インドのような 30 分刻みは 5.5 のように小数で）",
        },
        lat: { type: "number", minimum: -90, maximum: 90, description: "出生地の緯度（北緯が正）" },
        lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "出生地の経度（東経が正）",
        },
        house_system: {
          type: "string",
          enum: HOUSE_SYSTEM_CODES,
          default: "P",
          description: HOUSE_SYSTEM_DESCRIPTION,
        },
        default_lat: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "「いつもの場所」の緯度（任意。リターン計算で使う）",
        },
        default_lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "「いつもの場所」の経度（任意）",
        },
        default_location_label: {
          type: "string",
          description: "「いつもの場所」の呼び名（任意。例: 東京）",
        },
      },
      required: ["label", "year", "month", "day", "hour", "minute", "utc_offset", "lat", "lng"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_charts",
    title: "登録済みチャートの一覧",
    description:
      "この URL に登録されているチャートの一覧を返す（chart_id・ラベル・ハウス方式・" +
      "「いつもの場所」・出生データを預かっているか・登録日時）。" +
      "transit を呼ぶ前に chart_id を確かめたいときに使う。" +
      "出生データは「あり / なし」だけを返し、値そのものは出さない。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_chart",
    title: "出生図を読み直す",
    description:
      "save_chart で登録したネイタルチャート（出生図）を chart_id から読み直す。" +
      "返るのは (1) ネイタル天体の星座・度数・逆行と在ハウス、(2) ASC / MC とハウスカスプ、" +
      "(3) **出生図の中のアスペクト**（ネイタル内アスペクト。10 天体＋ASC / MC の総当たり、" +
      "メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション）。\n" +
      "保存済みの座標を読むだけで計算し直さないので、ハウス方式を変えたいときは " +
      "delete_chart してから save_chart で登録し直すこと。" +
      "預かっている出生データはここには出さない（値を読み戻す口は無い）。\n" +
      "ネイタルの読み直し・出生図そのものを話題にするときはこれ（transit は「今の空」用）。\n" +
      "このツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "ネイタル内アスペクトのオーブ（度）。省略すると 5°" +
            "（出生図は広めに取るのが通例。トランジットの 1° とは別）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "delete_chart",
    title: "登録済みチャートを消す",
    description:
      "chart_id を指定して登録を取り消す。計算済みの座標も、預かっている出生データも" +
      "一緒に消える（戻せないので、必要ならもう一度 save_chart で登録し直すこと）。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: { type: "string", description: "消すチャートの ID（list_charts で確認できる）" },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "transit",
    title: "トランジットを見る",
    description:
      "登録済みのチャートに対して、指定時刻の天体（トランジット）を計算する。" +
      "返るのは (1) トランジット天体の星座・度数・逆行、(2) それがネイタルのカスプで見て" +
      "第何ハウスに入っているか、(3) ネイタル天体および ASC / MC とのアスペクト" +
      "（メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション、オーブ 1°）、" +
      "(4) **空の中のアスペクト**（トランジット天体同士。10 天体の総当たり、メジャー5種、" +
      "既定オーブ 5°＝orb で変えられる。ノードは除く）。\n" +
      "日時をすべて省略すると**現在時刻（UTC）**で計算する。" +
      "特定の日を見たいときは year / month / day を指定し、必要なら hour / minute と " +
      "utc_offset（その時刻がどの時差の土地の時計か）を添える。\n" +
      "このツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        year: { type: "integer", description: "見たい日の年（省略すると現在時刻）" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "見たい日の月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "見たい日の日（1-31）" },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "見たい時刻の「時」（0-23、省略すると 0 時）",
        },
        minute: {
          type: "integer",
          minimum: 0,
          maximum: 59,
          description: "見たい時刻の「分」（0-59、省略すると 0 分）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "指定した日時がどの時差の土地の時計か（時間単位。日本時間なら 9。省略すると UTC 扱い）",
        },
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "空の中のアスペクト（トランジット天体同士）のオーブ（度）。省略すると 5°" +
            "（1 枚の図の中は広めに取るのが通例）。" +
            "**ネイタルへのアスペクト（オーブ 1°）には効かない**",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "lunar_return",
    title: "ルナリターン（月の帰還）",
    description:
      "登録済みチャートの**ネイタルの月**と同じ黄経に、空の月が戻ってくる瞬間（ルナリターン）を求め、" +
      "その瞬間のホロスコープ一式を返す。約27.3日に1回めぐってくる。\n" +
      "year と month を指定すると**その月に入るリターンをすべて**返す（たいてい1回、暦月の並びによっては2回、" +
      "まれに0回）。両方省略すると**現在時刻から見て次の1回**。year と month はそろえて指定すること。\n" +
      "返るのは (1) リターンの瞬間（UTC。utc_offset を渡せばその土地の時計でも）、" +
      "(2) リターン図の11天体（星座・度数・逆行・在ハウスはリターン図自身のカスプで）、" +
      "(3) リターン図の ASC / MC とハウスカスプ、" +
      "(4) ネイタルの天体・ASC / MC とのアスペクト（メジャー5種・オーブ 1°）、" +
      "(5) **リターン図の中のアスペクト**（リターン図の 10 天体＋ASC / MC の総当たり。" +
      "メジャー5種、既定オーブ 5°＝orb で変えられる。ノードは除く）。\n" +
      "リターン図を立てる場所は lat / lng で指定する。省略するとチャートに登録された「いつもの場所」" +
      "（save_chart の default_lat / default_lng）を使う。どちらも無いときは場所を教えてほしい旨を返す。\n" +
      "このツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        year: {
          type: "integer",
          description: "見たい年（month とそろえて指定。省略すると現在時刻から見て次の1回）",
        },
        month: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "見たい月（1-12。year とそろえて指定）",
        },
        lat: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "リターン図を立てる場所の緯度（省略するとチャートの「いつもの場所」）",
        },
        lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "リターン図を立てる場所の経度（lat とそろえて指定）",
        },
        location_label: {
          type: "string",
          description: "その場所の呼び名（任意。例: 東京）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "表示に使う時差（時間単位。日本時間なら 9。省略すると UTC だけで表示する）。" +
            "year / month を指定したときは、暦月の区切りもこの時差の土地の暦で見る。",
        },
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "リターン図の中のアスペクトのオーブ（度）。省略すると 5°" +
            "（1 枚の図の中は広めに取るのが通例）。" +
            "**ネイタルへのアスペクト（オーブ 1°）には効かない**",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "solar_return",
    title: "ソーラーリターン（太陽の帰還）",
    description:
      "登録済みチャートの**ネイタルの太陽**と同じ黄経に、空の太陽が戻ってくる瞬間（ソーラーリターン）を求め、" +
      "その瞬間のホロスコープ一式を返す。年に1回、誕生日の前後1日ほどの範囲でめぐってくる。\n" +
      "year を指定するとその年の1回を返す（その年の1月1日から探す）。省略すると" +
      "**現在時刻から見て次の1回**。\n" +
      "返るものは lunar_return と同じ形——リターンの瞬間、リターン図の11天体（在ハウスはリターン図自身のカスプ）、" +
      "ASC / MC とハウスカスプ、ネイタルとのアスペクト（メジャー5種・オーブ 1°）、" +
      "**リターン図の中のアスペクト**（リターン図の 10 天体＋ASC / MC の総当たり。" +
      "メジャー5種、既定オーブ 5°＝orb で変えられる。ノードは除く）。\n" +
      "リターン図を立てる場所は lat / lng で指定する。省略するとチャートに登録された「いつもの場所」を使う。\n" +
      "このツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        year: {
          type: "integer",
          description: "見たい年（省略すると現在時刻から見て次の1回）",
        },
        lat: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "リターン図を立てる場所の緯度（省略するとチャートの「いつもの場所」）",
        },
        lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "リターン図を立てる場所の経度（lat とそろえて指定）",
        },
        location_label: {
          type: "string",
          description: "その場所の呼び名（任意。例: 東京）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "表示に使う時差（時間単位。日本時間なら 9。省略すると UTC だけで表示する）",
        },
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "リターン図の中のアスペクトのオーブ（度）。省略すると 5°" +
            "（1 枚の図の中は広めに取るのが通例）。" +
            "**ネイタルへのアスペクト（オーブ 1°）には効かない**",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "progressions",
    title: "プログレッション（二次進行）",
    description:
      "二次進行（セカンダリー・プログレッション／一日一年法）を計算する。" +
      "出生の翌日の空を1歳、翌々日を2歳と読む技法で、進行天体・進行 ASC / MC と、" +
      "それらがネイタルに落とすアスペクト（メジャー5種・オーブ 1°）を返す。\n" +
      "chart_id で呼ぶ。**出生データ（日時・場所）を預かっているチャートが要る**——" +
      "二次進行は出生の瞬間そのものから毎回ネイタルを引き直すため。" +
      "出生データを保存しない時代に登録されたチャートでは使えないので、その旨だけを返す" +
      "（delete_chart して save_chart で登録し直せば使える）。\n" +
      "year / month / day を省略すると今日で計算する。返却テキストに出生日時・出生地そのものは出さない。\n" +
      "このツールは解釈をしない——出た座標と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        year: {
          type: "integer",
          description: "見たい日の年（month / day とそろえて指定。省略すると今日）",
        },
        month: { type: "integer", minimum: 1, maximum: 12, description: "見たい日の月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "見たい日の日（1-31）" },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "表示に使う時差（時間単位。日本時間なら 9）。日付を省略したときの「今日」も" +
            "この時差の土地の暦で決める（省略すると UTC）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "update_default_location",
    title: "いつもの場所を差し替える",
    description:
      "登録済みチャートの「いつもの場所」（リターン計算で使う土地）だけを差し替える。" +
      "**出生データの再入力は不要で、保存済みの計算結果（天体・カスプ・ASC/MC）には一切触れない**——" +
      "「いつもの場所」は出生データとは無関係の覚え書きなので、差し替えても図は変わらない。\n" +
      "引っ越したとき、あるいはリターンをこれから別の土地で立てたくなったときに使う。" +
      "lat と lng は両方そろえて指定すること。\n" +
      "clear: true にすると「いつもの場所」を削除する" +
      "（以後、lunar_return / solar_return は呼び出しのたびに lat / lng の指定が必要になる）。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description: "対象のチャート ID（list_charts で確認できる）",
        },
        lat: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "新しい「いつもの場所」の緯度（北緯が正。lng とそろえて指定）",
        },
        lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "新しい「いつもの場所」の経度（東経が正。lat とそろえて指定）",
        },
        location_label: {
          type: "string",
          description: "その場所の呼び名（任意。例: 東京）",
        },
        clear: {
          type: "boolean",
          default: false,
          description:
            "true にすると「いつもの場所」を削除する（lat / lng と同時には指定できない）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "yearly_overview",
    title: "年間概要（ソーラーリターン年の天体イベント）",
    description:
      "登録済みチャートの**ソーラーリターンから次のソーラーリターンまでの 1 年**を 1 日刻みで走査し、" +
      "その年に起きる天体イベントを一覧にする。返るのは (1) 水星〜冥王星の逆行期間、" +
      "(2) 木星〜冥王星の星座イングレス（逆行で前の星座へ戻るものも含む）、" +
      "(3) 木星〜冥王星がネイタルの ASC / MC に作るメジャーアスペクトの期間、" +
      "(4) 同じくネイタルの 10 天体（ノードを除く）に作るメジャーアスペクトの期間" +
      "（メジャー5種・オーブ 1°、各期間には最接近の日も添える）。\n" +
      "year を指定するとその年のソーラーリターンから始まる 1 年。省略すると**現在を含むソーラーリターン年**" +
      "（直近のソーラーリターンから次のソーラーリターンまで）。\n" +
      "日付の解像度は 1 日。start はその状態に入った最初の日、end は外れた最初の日" +
      "（Web 版 Astro Tool の年間概要と同じ数え方）。utc_offset を渡すとその土地の暦で日付を出す。\n" +
      "速い天体（太陽・月・水星・金星・火星）のトランジットや時刻単位の精度が要るときは transit を使うこと。" +
      "このツールは解釈をしない——出た期間と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: { type: "string", description: "対象のチャート ID（list_charts で確認できる）" },
        year: {
          type: "integer",
          description:
            "ソーラーリターンの年（その年の 1 月 1 日以降に来るリターンから 1 年。省略すると現在を含むソーラーリターン年）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description: "日付に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "transit_events",
    title: "期間内のトランジットイベント（時刻つき）",
    description:
      "登録済みチャートに対して、指定した期間（既定は今日から 7 日間）に起きるトランジットのイベントを" +
      "**時刻つき（分単位）**で時系列に並べる。返るのは (1) トランジット天体がネイタルの 10 天体（ノード除く）と " +
      "ASC / MC に作るメジャーアスペクト（合・セクスタイル・スクエア・トライン・オポジション、オーブ 1°）の" +
      "**入った時刻（entering）・ぴったりの時刻（exact）・外れた時刻（leaving）**と最小オーブ、" +
      "(2) 留（逆行の始まり・終わり）の時刻、(3) 星座イングレスの時刻。\n" +
      "bodies で動く側の天体を選ぶ: all＝太陽〜冥王星の 10 天体（最長 31 日）／no_moon＝月を除く（最長 93 日）／" +
      "outer＝木星〜冥王星（最長 366 日）。月は 1 か月に 60 本ほどアスペクトを作るので、長い期間は no_moon か outer で。\n" +
      'start は "YYYY-MM-DD"（utc_offset の暦でその日の 0 時から）。省略すると utc_offset の暦での今日。\n' +
      "1 年を日単位で俯瞰するなら yearly_overview、ある一瞬の配置を見るなら transit。" +
      "このツールは解釈をしない——出た時刻と角度をどう読むかは呼び出した側の仕事。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: { type: "string", description: "対象のチャート ID（list_charts で確認できる）" },
        start: {
          type: "string",
          pattern: "^-?\\d{1,5}-\\d{2}-\\d{2}$",
          description: '開始日 "YYYY-MM-DD"（utc_offset の暦。省略すると今日）',
        },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 366,
          description: "日数（省略すると 7。上限は bodies による: all 31 / no_moon 93 / outer 366）",
        },
        bodies: {
          type: "string",
          enum: ["all", "no_moon", "outer"],
          default: "all",
          description: "動く側の天体の組",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description: "暦と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC）",
        },
      },
      required: ["chart_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "calculate_numerology",
    title: "数秘術（生年月日から）",
    description:
      "生年月日から数秘術（ピタゴラス式）を計算する。" +
      "**登録済みチャートの chart_id か、生年月日の直接指定（year / month / day）のどちらか一方**で呼ぶ" +
      "——chart_id なら台帳が預かっている出生データを使うので生年月日を渡し直さなくてよく、" +
      "直接指定は登録せずに一度だけ見るときに使う。\n" +
      "数秘術は誕生日を使うので公開のカード層には置いていない。この鍵つきの入口だけにある。\n" +
      "乱数は使わない——ここでのサーバーの仕事は規約を固定すること。" +
      "ライフパスは流派（還元の規約）によって同じ生年月日から違う数が出る" +
      "（1986-12-29 は 11 にも 2 にもなる）ため、単一の答えではなく" +
      "名前つきの 4 経路と途中式を返す——" +
      "full_sum=全桁をまとめて足し最後の和でマスターを保持 / " +
      "component_reduce=年・月・日を 1 桁まで還元してから足す / " +
      "component_keep=年・月・日を還元するときマスターは保持して足す / " +
      "no_master=マスターを認めず 1 桁まで還元。\n" +
      "ほかにバースデーナンバー、アティチュードナンバー（サンナンバー＝月＋日）、" +
      "パーソナルイヤー／マンス／デイ（暦年起点＝1 月 1 日で切り替わる）も返す。" +
      "名前数秘（表現数・魂数など）・ピナクル・チャレンジは範囲外。\n" +
      "**出生データそのものは返事に出さない**（直接指定で呼んだときも同じ。" +
      "生まれた日だけはバースデーナンバーとして数字で出る。年と月は還元したあとの値しか出ない）。" +
      "chart_id で呼ぶとき、出生データを預かっていないチャート（保存しない時代の登録）では使えないので、" +
      "その旨だけを返す（delete_chart して save_chart で登録し直せば使える）。\n" +
      "このツールは解釈をしない——どの経路で読むかは呼び出した側" +
      "（あるいは占われる本人の流派）で決めること。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description:
            "対象のチャート ID（list_charts で確認できる）。" +
            "year / month / day とはどちらか一方だけを指定する",
        },
        year: {
          type: "integer",
          minimum: 1,
          maximum: 9999,
          description:
            "生年月日の年（西暦）。登録せずに一度だけ見るときの直接指定で、" +
            "year / month / day は 3 つそろえて指定する（chart_id とは併用できない）",
        },
        month: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "生年月日の月（1-12）",
        },
        day: {
          type: "integer",
          minimum: 1,
          maximum: 31,
          description: "生年月日の日（1-31）。暦に存在しない日付（2026-02-31 など）は断る",
        },
        target_year: {
          type: "integer",
          minimum: 1,
          maximum: 9999,
          description:
            "パーソナルイヤー／マンス／デイを見る基準日の年。" +
            "target_year / target_month / target_day は 3 つそろえて指定する。" +
            "3 つとも省略すると今日で見る。",
        },
        target_month: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "基準日の月（1-12）",
        },
        target_day: {
          type: "integer",
          minimum: 1,
          maximum: 31,
          description: "基準日の日（1-31）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "基準日を省いたとき「今日」をどの土地の暦で決めるか（時間単位。日本時間なら 9。" +
            "省略すると UTC）。target_* を指定したときは使わない",
        },
        masters: {
          type: "string",
          enum: MASTERS_OPTIONS,
          default: DEFAULT_MASTERS,
          description:
            "マスターナンバーとして扱う数（既定 11_22_33）。" +
            "11_22 にすると 33 を認めず 6 まで還元する。",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "shukuyo",
    title: "宿曜（本命宿とその日の宿）",
    description:
      "宿曜占星術（二十七宿）の本命宿と、指定した日の宿（日運）を計算する。\n" +
      "**天文方式**——宿は出生時刻の月のサイデリアル黄経を 13°20′ で割って決める。" +
      "基準点（アヤナムシャ）は **Lahiri** に固定（式で出るので天文暦・恒星ファイルが要らない）。" +
      "暦方式（旧暦の日付から宿を引くやり方）は**採らない**" +
      "——旧暦は 2033 年問題のように裁定者のいない未解決の規約を含むため。" +
      "27 宿（牛宿を含まない）で、サイデリアル 0° を**婁宿（Ashvini）**の始まりに置く。" +
      "『宿曜経』の列挙が昴宿から始まるのは「表の並び」であって、位置の起点ではない。\n" +
      "**chart_id か、生年月日＋出生時刻の直接指定（year / month / day / hour / minute）の" +
      "どちらか一方**で呼ぶ。月は 1 日でほぼ 1 宿ぶん動くので、**出生時刻は必須**" +
      "（時刻の分からない出生では引かない）。\n" +
      "返るのは (1) 本命宿（漢字の宿名・サンスクリット名・1〜27 の番号）と宿内の位置・両隣の宿・" +
      "前後の境界までの距離、(2) date（省略すると今日）の月の宿と、本命宿から見た三九の秘法の関係" +
      "（命・栄・衰・安・危・成・壊・友・親・業・胎＋近距離／中距離／遠距離）、" +
      "(3) その日のうちに宿が切り替わる時刻。date は**過去も未来も受ける**" +
      "（日記の日付を後から引き直すときなど）。\n" +
      "**このツールは解釈をしない**——宿の意味も吉凶もサーバーに載せていないので、" +
      "読みはあなた自身の知識で。ホロスコープ・宿曜・四柱はそれぞれ別の体系で、" +
      "**三体系を合算する根拠はない**（並べて眺めるのはよいが、点数を足したり多数決を取ったりしない）。\n" +
      "出生データそのものは返事に出さない（宿・サイデリアル黄経のような派生値だけを返す）。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description:
            "対象のチャート ID（list_charts で確認できる）。" +
            "生年月日の直接指定とはどちらか一方だけを指定する",
        },
        year: {
          type: "integer",
          description:
            "出生年（西暦）。登録せずに一度だけ見るときの直接指定で、" +
            "year / month / day / hour / minute は 5 つそろえて指定する（chart_id とは併用できない）",
        },
        month: { type: "integer", minimum: 1, maximum: 12, description: "出生月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "出生日（1-31）" },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "出生時刻の「時」（0-23、出生地の現地時刻）。宿は月の位置で決まるので必須",
        },
        minute: {
          type: "integer",
          minimum: 0,
          maximum: 59,
          description: "出生時刻の「分」（0-59、出生地の現地時刻）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "出生地の UTC からの時差（時間単位。日本は 9。省略すると UTC 扱い）。" +
            "直接指定のときだけ使う（chart_id では預かっている時差を使う）",
        },
        date: {
          type: "string",
          pattern: "^-?\\d{1,5}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2})?$",
          description:
            '日運を見る日 "YYYY-MM-DD"、時刻まで見たいときは "YYYY-MM-DD HH:MM"' +
            "（省略すると今）。過去も未来も受ける。" +
            "時刻を省いたときはその日の 0 時の月の宿を返し、切り替わり時刻を別に添える",
        },
        date_utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "date と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）。" +
            "「その日の 0 時〜24 時」の区切りもこの時差の土地の暦で見る",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "shukuyo_compat",
    title: "宿曜の相性（三九の秘法）",
    description:
      "2 つの宿の関係（三九の秘法）を計算する。\n" +
      "a / b はそれぞれ**登録済みの chart_id か、宿の名前**" +
      "（漢字「亢宿」「亢」／サンスクリット名「Swati」／1〜27 の番号）。" +
      "相手の宿名だけでも呼べるので、**相手の出生データを会話に出さずに済む**" +
      "（まず台帳を chart_id として引き、見つからなければ宿名として読む）。\n" +
      "返るのは A→B と B→A の関係（本命宿を 1 として数えた距離 1〜27 と、" +
      "命／栄／衰／安／危／成／壊／友／親／業／胎、近距離・中距離・遠距離）と、" +
      "向きによらない**組の名前**（命・栄親・友衰・安壊・危成・業胎）。" +
      "三九の秘法は向きで名前が変わる（A から見て栄なら B から見ると親）ので両方向を返す。\n" +
      "**このツールは解釈をしない**——関係の意味はサーバーに載せていないので、" +
      "読みはあなた自身の知識で。ホロスコープ・宿曜・四柱を合算する根拠はない。\n" +
      "chart_id で呼んだときも出生データは返事に出さない。",
    inputSchema: {
      type: "object",
      properties: {
        a: {
          type: "string",
          description:
            "片方（chart_id か宿名。「亢宿」「亢」「Swati」「15」のいずれの書き方でもよい）",
        },
        b: {
          type: "string",
          description: "もう片方（同じ書き方）",
        },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "four_pillars",
    title: "四柱推命（命式と流年・月運・日運）",
    description:
      "四柱推命（子平）の命式と、指定した日の流年・月運・日運を計算する。\n" +
      "**chart_id か、生年月日＋出生時刻の直接指定（year / month / day / hour / minute）の" +
      "どちらか一方**で呼ぶ。時柱は 2 時間ごとの区切りで決まるので**出生時刻は必須**" +
      "（時刻の分からない出生では引かない）。\n" +
      "返るのは (1) 命式（年柱・月柱・日柱・時柱の干支と五行・陰陽、日干から見た通変星と十二運、" +
      "蔵干＝本気／中気／余気、空亡）、(2) 日主・空亡・節入りからの日数・大運（順行と逆行を 10 柱ずつ）、" +
      "(3) date（省略すると今）の流年・月運・日運と、命式との天干五合・六合・六沖。" +
      "date に時刻を付ければ時運（時柱）も出し、日付だけなら年・月・日の三柱で見る。" +
      "date は**過去も未来も受ける**。\n" +
      "**採った規約は名前で固定して返り値にも書く**（流派で割れるところが多いので、" +
      "読む側が「この鯖はこの流派」と分かるように）——" +
      "日界は 0 時（23 時台生まれのときだけ「日界 23 時」「夜子時」の 2 通りを alternatives に添える）/ " +
      "時刻の補正なし（経度補正も均時差もかけない。時辰の境から 15 分以内のときだけ印を出し、" +
      "境からの分数そのものは出さない）/ " +
      "節気は太陽黄経（立春 315°、30° ごとに月柱が替わる。年柱も立春で切り替える）/ " +
      "蔵干は本気・中気・余気を全部並べ、通変星は本気で代表する" +
      "（月律分野表は採らない。代わりに節入りからの日数を返すので、その表で絞りたければ読む側で絞れる）/ " +
      "十二運は陰干逆行（陽生陰死方式は採らない）/ 空亡は日柱の旬から / " +
      "大運は性別を預からないので順行・逆行の両方を返し、起運（日数 ÷ 3）は" +
      "切り上げ・満年齢といった流派の丸めを採らない" +
      "（返す精度は 0.1 年まで＝出生時刻を約 7 時間の粗さでしか含まない）/ " +
      "巡りと命式の関係は天干五合・六合・六沖のみ（三合・刑・害は範囲外）。\n" +
      "**このツールは解釈をしない**——通変星も十二運も蔵干も大運も名前を並べるだけで、" +
      "格局・用神・強弱・吉凶はサーバーに載せていない。読みはあなた自身の知識で。" +
      "ホロスコープ・宿曜・四柱はそれぞれ別の体系で、**三体系を合算する根拠はない**" +
      "（並べて眺めるのはよいが、点数を足したり多数決を取ったりしない）。\n" +
      "出生データそのものは返事に出さない（命式・蔵干・大運のような派生値だけを返す）。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description:
            "対象のチャート ID（list_charts で確認できる）。" +
            "生年月日の直接指定とはどちらか一方だけを指定する",
        },
        year: {
          type: "integer",
          minimum: 1,
          maximum: 9999,
          description:
            "出生年（西暦）。登録せずに一度だけ見るときの直接指定で、" +
            "year / month / day / hour / minute は 5 つそろえて指定する（chart_id とは併用できない）",
        },
        month: { type: "integer", minimum: 1, maximum: 12, description: "出生月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "出生日（1-31）" },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description:
            "出生時刻の「時」（0-23、出生地の現地時刻）。時柱を立てるので必須。" +
            "23 時台のときは日界の代替（日界 23 時・夜子時）も添える",
        },
        minute: {
          type: "integer",
          minimum: 0,
          maximum: 59,
          description: "出生時刻の「分」（0-59、出生地の現地時刻）",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "出生地の UTC からの時差（時間単位。日本は 9。省略すると UTC 扱い）。" +
            "直接指定のときだけ使う（chart_id では預かっている時差を使う）",
        },
        date: {
          type: "string",
          pattern: "^-?\\d{1,5}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2})?$",
          description:
            '流年・月運・日運を見る日 "YYYY-MM-DD"、時運（時柱）まで見たいときは' +
            ' "YYYY-MM-DD HH:MM"（省略すると今）。過去も未来も受ける',
        },
        date_utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "date と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）。" +
            "日運の日界（0 時）もこの時差の土地の暦で見る",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "synastry",
    title: "シナストリー（2 枚の出生図の間のアスペクトと在ハウス）",
    description:
      "登録済みの出生図 2 枚を突き合わせ、その間のアスペクト（シナストリー）と、" +
      "互いのハウスに相手の天体がどう入るか（ハウスオーバーレイ）を計算する。\n" +
      "a / b は**どちらも呼び出した人の台帳の chart_id**（list_charts で確認できる）。" +
      "相手のぶんも先に save_chart で登録しておけば、" +
      "**相手の出生データを会話に出さずに済む**（他人の台帳のチャートは見えない）。\n" +
      "返るのは (1) A の 10 天体＋ASC / MC と B の 10 天体＋ASC / MC の総当たりアスペクト" +
      "（メジャー5種＝合・セクスタイル・スクエア・トライン・オポジション、既定オーブ 5°＝" +
      "orb で変えられる。ノードは除く）、(2) A の天体（ノード込みの 11 天体）が B のハウスの" +
      "どこに入るか、(3) その逆＝B の天体が A のハウスのどこに入るか。\n" +
      "どちらも止まった図なので接近・離反は付かない。天体の黄経そのものは返さないので、" +
      "位置が要るときは get_chart で 1 枚ずつ読むこと" +
      "（1 枚の図の中のアスペクトも get_chart の持ち場）。\n" +
      "このツールは解釈をしない——相性の良し悪しも組み合わせの意味もサーバーに載せていないので、" +
      "読みはあなた自身の知識で。\n" +
      "出生データそのものは返事に出さない（アスペクトと在ハウスの派生値だけを返す）。",
    inputSchema: {
      type: "object",
      properties: {
        a: {
          type: "string",
          description: "片方のチャート ID（list_charts で確認できる）",
        },
        b: {
          type: "string",
          description: "もう片方のチャート ID（a とは別の ID）",
        },
        orb: {
          type: "number",
          minimum: 0.5,
          maximum: 10,
          description:
            "アスペクトのオーブ（度）。省略すると 5°" +
            "（止まった図同士は広めに取るのが通例。トランジットの 1° とは別）",
        },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "kyusei",
    title: "九星気学（本命星・月命星・日命星と年盤・月盤・日盤）",
    description:
      "九星気学の本命星・月命星・日命星と、指定した日の年盤・月盤・日盤を計算する。\n" +
      "**chart_id か、生年月日の直接指定（year / month / day）のどちらか一方**で呼ぶ。" +
      "**出生時刻は任意**——hour / minute が無くても本命星・月命星は出る" +
      "（時刻の分からない出生でも引ける。省いたときはその日の 12 時を仮に置いている）。" +
      "ただし**立春・節入りの当日**に生まれた人は時刻で星が変わるので、" +
      "そのときだけ両方の候補を alternatives に添える（hour / minute を付ければ確定する）。\n" +
      "返るのは (1) 本命星（立春で切った年）・月命星（節で切った月）・日命星（陽遁／陰遁）、" +
      "(2) date（省略すると今）の年盤・月盤・日盤" +
      "（後天定位に中宮からの差を配ったもの。9 宮は 北・北東・東・南東・南・南西・西・北西・中宮 の順、" +
      "図は南を上・東を左に描く）と、各盤に立つ殺 9 種" +
      "（五黄殺・暗剣殺・歳破／月破／日破・本命殺・本命的殺・月命殺・月命的殺）。" +
      "date は**過去も未来も受ける**。\n" +
      "**採った規約は名前で固定して返り値にも書く**（流派で割れるところが多いので、" +
      "読む側が「この鯖はこの流派」と分かるように）——" +
      "年界は立春（節分までは 1 つ前の年の星）/ 月界は節（太陽黄経 30° ごと）/ 日界は 0 時 / " +
      "陽遁・陰遁は**冬至・夏至に最も近い甲子日**で切り替え（前後が同距離なら後の甲子）/ " +
      "**閏遁は置かない**（切り替えの間隔が 240 日になる期間もそのまま続ける）/ " +
      "破は支の対冲を**八方位に丸めた**もの（四隅の宮では 60° のうち 30° だけが実際の破に当たる）/ " +
      "**時盤は持たない**。" +
      "⚠ **日盤の切り替えは流派で割れる**ので、暦によっては日の星がこのサーバーと違う日がある。\n" +
      "**このツールは解釈をしない**——吉方位も凶方位も相性も、九星や殺の意味もサーバーに載せていない" +
      "（「五黄殺」「歳破」は計算上の名前で、吉凶の言葉は 1 語も足していない）。" +
      "読みはあなた自身の知識で。" +
      "ホロスコープ・宿曜・四柱・九星はそれぞれ別の体系で、**四体系を合算する根拠はない**" +
      "（並べて眺めるのはよいが、点数を足したり多数決を取ったりしない）。\n" +
      "九星気学も誕生日を使うので公開のカード層には置いていない。この鍵つきの入口だけにある。" +
      "出生データそのものは返事に出さない（星・盤・殺のような派生値だけを返す）。",
    inputSchema: {
      type: "object",
      properties: {
        chart_id: {
          type: "string",
          description:
            "対象のチャート ID（list_charts で確認できる）。" +
            "生年月日の直接指定とはどちらか一方だけを指定する",
        },
        year: {
          type: "integer",
          minimum: 1,
          maximum: 9999,
          description:
            "出生年（西暦）。登録せずに一度だけ見るときの直接指定で、" +
            "year / month / day は 3 つそろえて指定する（chart_id とは併用できない）",
        },
        month: { type: "integer", minimum: 1, maximum: 12, description: "出生月（1-12）" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "出生日（1-31）" },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description:
            "出生時刻の「時」（0-23、出生地の現地時刻）。**任意**——" +
            "省くとその日の 12 時で見る（立春・節入りの当日の生まれのときだけ星が変わるので、" +
            "そのときは両方の候補を添える）",
        },
        minute: {
          type: "integer",
          minimum: 0,
          maximum: 59,
          description: "出生時刻の「分」（0-59、出生地の現地時刻）。任意",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "出生地の UTC からの時差（時間単位。日本は 9。省略すると UTC 扱い）。" +
            "直接指定のときだけ使う（chart_id では預かっている時差を使う）",
        },
        date: {
          type: "string",
          pattern: "^-?\\d{1,5}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2})?$",
          description:
            '年盤・月盤・日盤を見る日 "YYYY-MM-DD"、時刻まで決めたいときは "YYYY-MM-DD HH:MM"' +
            "（省略すると今）。過去も未来も受ける。時盤は無いので、時刻は月界・日界の境の判定にだけ効く",
        },
        date_utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          description:
            "date と表示に使う時差（時間単位。日本時間なら 9。省略すると UTC の暦）。" +
            "日盤の日界（0 時）も陽遁・陰遁の切り替えの甲子日も、この時差の土地の暦で見る",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// ---------------------------------------------------------------------------
// 引数の検算（型と範囲だけ見る。天文学的な妥当性はエンジンに任せる）
// ---------------------------------------------------------------------------

function argsOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AstroError("arguments はオブジェクトで渡してください");
  }
  return raw as Record<string, unknown>;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AstroError(`${key} は数値で指定してください`);
  }
  if (value < min || value > max) {
    throw new AstroError(`${key} は ${min} 以上 ${max} 以下で指定してください: ${value}`);
  }
  return value;
}

function requireNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = optionalNumber(args, key, min, max);
  if (value === undefined) throw new AstroError(`${key} は必須です`);
  return value;
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = optionalNumber(args, key, min, max);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new AstroError(`${key} は整数で指定してください: ${value}`);
  return value;
}

function requireInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = optionalInteger(args, key, min, max);
  if (value === undefined) throw new AstroError(`${key} は必須です`);
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new AstroError(`${key} は文字列で指定してください`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new AstroError(`${key} は ${maxLength} 文字以内にしてください`);
  }
  return trimmed;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new AstroError(`${key} は true / false で指定してください`);
  return value;
}

function requireString(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = optionalString(args, key, maxLength);
  if (value === undefined) throw new AstroError(`${key} は必須です（空文字は不可）`);
  return value;
}

const BODY_SETS: readonly BodySet[] = ["all", "no_moon", "outer"];

/** transit_events の bodies（動く側の天体の組）。既定は all */
function requireBodySet(args: Record<string, unknown>): BodySet {
  const value = optionalString(args, "bodies", 12) ?? "all";
  if (!BODY_SETS.includes(value as BodySet)) {
    throw new AstroError(
      `bodies は ${BODY_SETS.join(" / ")} のいずれかにしてください: ${value}` +
        `（all＝太陽〜冥王星の 10 天体 / no_moon＝月を除く 9 天体 / outer＝木星〜冥王星）`,
    );
  }
  return value as BodySet;
}

/** calculate_numerology の masters（マスターナンバーの規約）。既定は 11_22_33 */
function requireMasters(args: Record<string, unknown>): MastersOption {
  const value = optionalString(args, "masters", 16) ?? DEFAULT_MASTERS;
  if (!MASTERS_OPTIONS.includes(value as MastersOption)) {
    throw new AstroError(
      `masters は ${MASTERS_OPTIONS.join(" / ")} のどちらかです: ${value}`,
    );
  }
  return value as MastersOption;
}

function requireHouseSystem(args: Record<string, unknown>): string {
  const value = optionalString(args, "house_system", 4) ?? "P";
  if (!HOUSE_SYSTEM_CODES.includes(value)) {
    throw new AstroError(
      `house_system は ${HOUSE_SYSTEM_CODES.join(" / ")} のいずれかにしてください: ${value}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// 日時まわり
// ---------------------------------------------------------------------------

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** 各月の日数（[0] は 1 月。2 月だけうるう年で伸びる） */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** グレゴリオ暦のうるう年（4 で割り切れ、100 で割り切れない、または 400 で割り切れる） */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** その月の日数（swe_julday はグレゴリオ暦固定＝GREGORIAN で呼んでいるので暦もそれに合わせる） */
function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] as number;
}

/** その年月日が暦に実在するか（月は 1〜12 で検算済みという前提） */
function isCalendarDay(year: number, month: number, day: number): boolean {
  return day >= 1 && day <= daysInMonth(year, month);
}

/**
 * 実在しない暦日を弾く。
 *
 * 日の範囲（1〜31）だけでは 2026-02-31 が通ってしまい、`swe_julday` はそれを黙って
 * 3 月 3 日に繰り上げる ―― 打ち間違いが「別の日の図」として静かに返ってくるのが困る。
 * ⚠ 呼ぶ相手を選ぶこと: **利用者が渡した引数**にだけ使う（メッセージに日付が出る）。
 *    台帳に預かっている出生データには使わない（値を出さない言い方で断る）。
 */
function assertCalendarDay(year: number, month: number, day: number): void {
  if (isCalendarDay(year, month, day)) return;
  throw new AstroError(
    `${year}-${pad(month)}-${pad(day)} は暦に存在しない日付です` +
      `（${year}年${month}月は${daysInMonth(year, month)}日まで）`,
  );
}

/** UTC の Date を「2026-08-20 02:15 UTC」に */
function formatUtcMoment(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** 時差 → 「UTC+9」「UTC+5.5」 */
function formatOffsetLabel(utcOffset: number): string {
  const sign = utcOffset >= 0 ? "+" : "-";
  const absolute = Math.abs(utcOffset);
  const label = Number.isInteger(absolute) ? String(absolute) : absolute.toFixed(1);
  return `UTC${sign}${label}`;
}

/** UTC の Date ＋ 時差を「2026-08-20 11:15」に（時差の札は付けない） */
function formatPlainMoment(utcDate: Date, utcOffset: number): string {
  const shifted = new Date(utcDate.getTime() + utcOffset * 3_600_000);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/** UTC の Date ＋ 時差を「2026-08-20 11:15（UTC+9）」に */
function formatLocalMoment(utcDate: Date, utcOffset: number): string {
  return `${formatPlainMoment(utcDate, utcOffset)}（${formatOffsetLabel(utcOffset)}）`;
}

/** 「YYYY-MM-DD」だけの開始日（transit_events の start）。月日の範囲もここで弾く */
function parseStartDate(raw: string): { year: number; month: number; day: number } {
  const matched = /^(-?\d{1,5})-(\d{2})-(\d{2})$/.exec(raw);
  if (!matched) {
    throw new AstroError(
      `start は "YYYY-MM-DD" の形で指定してください（例: 2026-08-20）: ${raw}`,
    );
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new AstroError(`start の月日が暦の範囲を外れています（月は 1〜12、日は 1〜31）: ${raw}`);
  }
  assertCalendarDay(year, month, day);
  return { year, month, day };
}

/** Date（UTC）→ julianDay に渡せる MomentInput（時差 0） */
function momentFromUtcDate(date: Date): MomentInput {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes() + date.getUTCSeconds() / 60,
    utcOffset: 0,
  };
}

/** ローカルの暦日時から UTC の Date を作る（year < 100 でも 1900 年台に化けないように） */
function utcDateFromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  utcOffset: number,
): Date {
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, 0, 0);
  return new Date(local.getTime() - utcOffset * 3_600_000);
}

/** その瞬間を utcOffset の暦で見た日の 0 時（UTC の Date で返す） */
function startOfLocalDay(now: Date, utcOffset: number): Date {
  const shifted = new Date(now.getTime() + utcOffset * 3_600_000);
  return utcDateFromLocal(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    0,
    0,
    utcOffset,
  );
}

// ---------------------------------------------------------------------------
// ツール実装
// ---------------------------------------------------------------------------

export interface AstroContext {
  auth: AuthContext;
  kv: AstroKv;
  getEngine: () => Promise<SwissEph>;
  /** テストから時刻を固定するための差し込み口（既定は現在時刻） */
  now?: () => Date;
}

/**
 * 台帳のチャートから、表に出してよい部分だけを取り出す。
 *
 * 落とすのは `birth`（預かっている出生データ）ひとつ ―― structuredContent に
 * `...stored` を撒くところは必ずこれを通すこと。**出生データは返事に出さない**が約束で、
 * 呼び出し側は登録時に自分で渡しているので読み戻す必要もない。
 */
function publicChart(chart: StoredChart): Omit<StoredChart, "birth"> {
  const { birth: _birth, ...rest } = chart;
  return rest;
}

async function engineOf(context: AstroContext): Promise<SwissEph> {
  try {
    return await context.getEngine();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AstroError(`天体計算エンジンを初期化できませんでした: ${detail}`);
  }
}

/**
 * 天体の並びを、アスペクト探索用の点に均す（ASC/MC は付けない）。
 *
 * 速度を 0 で置くのは意図的 ―― 「1 枚の図の中のアスペクト」は止まった図の話なので、
 * 接近／離反を持たない（natalAspects は速度を見ない）。動く側として使うときは
 * 呼び出し側で本物の速度を持つ点を組むこと（runTransit の transitPoints）。
 *
 * excludeNodes: true でノース ノード（id 11）を落とす。図の中のアスペクトは
 * events.ts と同じ方針で **ノードを相手にも動く側にも入れない**（位置は一覧に出す）。
 */
function planetPointsOf(
  planets: readonly { id: number; lon: number }[],
  options: { excludeNodes?: boolean } = {},
): AspectPoint[] {
  const kept = options.excludeNodes ? planets.filter((planet) => planet.id !== 11) : planets;
  return kept.map((planet) => ({ name: planetName(planet.id), lon: planet.lon, speed: 0 }));
}

/**
 * ネイタル天体＋ASC/MC を、アスペクト探索用の点に均す。
 *
 * 速度を 0 で置くのは意図的 ―― ネイタルは「止まっている図」なので、接近／離反は
 * 動いているトランジット側だけで決まる。移植元の calc.js はネイタルの速度もそのまま
 * 渡していて、同じ速度の天体同士だと接近判定が常に false になる（実害の小さい癖）。
 *
 * excludeNodes の扱いは planetPointsOf と同じ（ASC/MC は常に入る）。
 */
function aspectPointsOf(
  chart: {
    planets: readonly { id: number; lon: number }[];
    cusps: readonly number[];
    ascmc: readonly number[];
  },
  options: { excludeNodes?: boolean } = {},
): AspectPoint[] {
  const points = planetPointsOf(chart.planets, options);
  const angles = anglesOf(chart);
  points.push({ name: "ASC", lon: angles.asc, speed: 0 });
  points.push({ name: "MC", lon: angles.mc, speed: 0 });
  return points;
}

async function runSaveChart(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);

  const label = requireString(args, "label", 60);
  const moment: MomentInput = {
    year: requireInteger(args, "year", -5000, 5000),
    month: requireInteger(args, "month", 1, 12),
    day: requireInteger(args, "day", 1, 31),
    hour: requireInteger(args, "hour", 0, 23),
    minute: requireInteger(args, "minute", 0, 59),
    utcOffset: requireNumber(args, "utc_offset", -14, 14),
  };
  assertCalendarDay(moment.year, moment.month, moment.day);
  const lat = requireNumber(args, "lat", -90, 90);
  const lng = requireNumber(args, "lng", -180, 180);
  const houseSystem = requireHouseSystem(args);

  const defaultLat = optionalNumber(args, "default_lat", -90, 90);
  const defaultLng = optionalNumber(args, "default_lng", -180, 180);
  const defaultLabel = optionalString(args, "default_location_label", 40);
  if ((defaultLat === undefined) !== (defaultLng === undefined)) {
    throw new AstroError("default_lat と default_lng は両方そろえて指定してください");
  }

  const swe = await engineOf(context);
  const computed = computeChart(swe, moment, { lat, lng, houseSystem });

  const stored: StoredChart = {
    label,
    house_system: houseSystem,
    planets: computed.planets,
    cusps: computed.cusps,
    ascmc: computed.ascmc,
    // 出生データはこの台帳が預かる（返事には出さない。publicChart で落としてから返す）
    birth: {
      year: moment.year,
      month: moment.month,
      day: moment.day,
      hour: moment.hour,
      minute: moment.minute,
      utc_offset: moment.utcOffset,
      lat,
      lng,
    },
    created: new Date().toISOString(),
  };
  if (defaultLat !== undefined && defaultLng !== undefined) {
    stored.default_location = { lat: defaultLat, lng: defaultLng };
    if (defaultLabel) stored.default_location.label = defaultLabel;
  }

  // ID は空きを確かめてから発行する（衝突すると他人の図・自分の古い図を黙って上書きしてしまう）
  const chartId = await createChart(context.kv, context.auth.user, stored);

  const angles = anglesOf(stored);
  const lines: string[] = [
    "チャートを保存しました。",
    `chart_id: ${chartId}（transit などにこの ID を渡してください）`,
    `ラベル: ${label}`,
    `ハウス方式: ${houseSystemName(houseSystem)}（${houseSystem}）`,
  ];
  if (stored.default_location) {
    const place = stored.default_location;
    const name = place.label ? `${place.label} ` : "";
    lines.push(`いつもの場所: ${name}緯度 ${place.lat} / 経度 ${place.lng}`);
  }
  lines.push("");
  lines.push("■ ネイタル天体（カッコ内は在ハウス）");
  lines.push(...formatPlanetLines(stored.planets, stored.cusps));
  lines.push("");
  lines.push(formatAngles(angles));
  lines.push("");
  lines.push("■ ハウスカスプ");
  lines.push(formatCuspLine(stored.cusps));
  lines.push("");
  lines.push(
    "出生データ（日時・時差・緯度経度）はこのチャートに預かりました。返事には出しません。delete_chart で消えます。",
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { chart_id: chartId, ...publicChart(stored) },
  };
}

async function runListCharts(context: AstroContext): Promise<ToolResult> {
  const charts = await listCharts(context.kv, context.auth.user);

  if (charts.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "保存済みのチャートはまだありません。\n" +
            "save_chart に出生データ（年月日・時刻・その土地の時差・緯度経度）を渡すと chart_id が発行され、" +
            "以後はその ID だけでトランジットを引けます。" +
            "出生データは計算済みの座標と一緒にこの鍵の台帳に預かります" +
            "（鍵を持つ人だけが使え、返事には出さず、delete_chart で消えます）。",
        },
      ],
      structuredContent: { charts },
    };
  }

  const lines: string[] = [`保存済みチャート（${charts.length}件）`];
  for (const chart of charts) {
    const parts = [
      `- ${chart.chart_id}: ${chart.label}`,
      `${houseSystemName(chart.house_system)}（${chart.house_system}）`,
    ];
    if (chart.default_location) {
      const place = chart.default_location;
      const name = place.label ? `${place.label}（${place.lat}, ${place.lng}）` : `${place.lat}, ${place.lng}`;
      parts.push(`いつもの場所: ${name}`);
    }
    // 値そのものは出さず、あるかないかだけ（無ければ progressions などが使えない）
    parts.push(
      chart.has_birth
        ? "出生データ: あり"
        : "出生データ: なし（登録し直すと progressions などが使えます）",
    );
    parts.push(`登録 ${chart.created}`);
    lines.push(parts.join(" / "));
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { charts },
  };
}

/**
 * 保存済みチャートの読み直し。
 *
 * 天体計算はしない ―― KV に入っている座標をそのまま整形するだけなので wasm を呼ばない
 * （engineOf も通らない）。save_chart の返り値では見えないもの、すなわち
 * **出生図の中のアスペクト**を足すのがこのツールの持ち場。
 */
async function runGetChart(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
        "save_chart で登録してください。",
    );
  }

  const orb = optionalNumber(args, "orb", 0.5, 10) ?? DEFAULT_NATAL_ORB;
  // ノードはアスペクトの相手にも入れない（位置は下の天体一覧に出る）
  const aspects = natalAspects(aspectPointsOf(chart, { excludeNodes: true }), orb);

  const angles = anglesOf(chart);
  const lines: string[] = [
    "出生図（ネイタル）",
    `チャート: ${chart.label}（${chartId}） / ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}） / 登録 ${chart.created}`,
  ];
  if (chart.default_location) {
    const place = chart.default_location;
    const name = place.label ? `${place.label}（${place.lat}, ${place.lng}）` : `${place.lat}, ${place.lng}`;
    lines.push(`いつもの場所: ${name}`);
  }
  lines.push("");

  lines.push("■ ネイタル天体（カッコ内は在ハウス）");
  lines.push(...formatPlanetLines(chart.planets, chart.cusps));
  lines.push(formatAngles(angles));
  lines.push("");

  lines.push("■ ハウスカスプ");
  lines.push(formatCuspLine(chart.cusps));
  lines.push("");

  lines.push(
    `■ ネイタル内アスペクト（メジャー5種・オーブ ${orb.toFixed(1)}°・10 天体＋ASC/MC、ノード除く）`,
  );
  if (aspects.length === 0) {
    lines.push(`該当なし（オーブ ${orb.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    lines.push(...aspects.map((hit) => formatNatalAspect(hit)));
  }

  const structuredPlanets = chart.planets.map((planet: PlanetPosition) => ({
    id: planet.id,
    name: planetName(planet.id),
    lon: planet.lon,
    speed: planet.speed,
    retrograde: planet.speed < 0,
    position: formatDegree(planet.lon),
    house: getHouse(planet.lon, chart.cusps),
  }));

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      chart_id: chartId,
      label: chart.label,
      house_system: chart.house_system,
      created: chart.created,
      ...(chart.default_location ? { default_location: chart.default_location } : {}),
      planets: structuredPlanets,
      angles,
      // 保存形は [0] がダミーなので、返すのは 1..12 の 12 要素だけ
      cusps: chart.cusps.slice(1, 13),
      orb,
      natal_aspects: aspects,
    },
  };
}

async function runDeleteChart(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const existing = await getChart(context.kv, context.auth.user, chartId);
  const removed = existing ? await deleteChart(context.kv, context.auth.user, chartId) : false;
  if (!removed || !existing) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめてください。`,
    );
  }

  // 出生データを預かっていた図だけ、それも消えたと言い添える（無かった図に言うと嘘になる）
  const removedBirth = existing.birth !== undefined;
  const text =
    `チャート ${chartId}（${existing.label}）を削除しました。` +
    (removedBirth ? "預かっていた出生データも一緒に消えました。" : "");

  return {
    content: [{ type: "text", text }],
    structuredContent: { chart_id: chartId, deleted: true, birth_removed: removedBirth },
  };
}

/**
 * 「いつもの場所」だけの差し替え。
 *
 * 出生地とは別の覚え書きなので、出生データにも計算済みの座標（planets / cusps / ascmc）にも
 * label / house_system / created にも触らず、default_location だけを置き換える（または消す）。
 * 再計算も要らない。
 */
async function runUpdateDefaultLocation(
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
        "save_chart で登録してください。",
    );
  }

  const clear = optionalBoolean(args, "clear") ?? false;
  const lat = optionalNumber(args, "lat", -90, 90);
  const lng = optionalNumber(args, "lng", -180, 180);
  const label = optionalString(args, "location_label", 40);

  if (clear) {
    if (lat !== undefined || lng !== undefined || label !== undefined) {
      throw new AstroError(
        "clear と場所の指定は同時にできません" +
          "（消すなら clear: true だけ、差し替えるなら lat / lng を指定してください）",
      );
    }
    delete chart.default_location;
  } else {
    if ((lat === undefined) !== (lng === undefined)) {
      throw new AstroError("lat と lng は両方そろえて指定してください");
    }
    if (lat === undefined || lng === undefined) {
      throw new AstroError(
        "新しい「いつもの場所」を lat / lng で指定してください" +
          "（登録を消したいときは clear: true）",
      );
    }
    const place: { lat: number; lng: number; label?: string } = { lat, lng };
    if (label) place.label = label;
    chart.default_location = place;
  }

  await putChart(context.kv, context.auth.user, chartId, chart);

  const place = chart.default_location;
  const lines = [`チャート ${chartId}（${chart.label}）の「いつもの場所」を更新しました。`];
  if (place) {
    const name = place.label ? `${place.label} ` : "";
    lines.push(`いつもの場所: ${name}緯度 ${place.lat} / 経度 ${place.lng}`);
  } else {
    lines.push("いつもの場所: 未設定（リターンは呼び出し時に場所を指定してください）");
  }
  lines.push("保存済みの計算結果（天体・カスプ・ASC/MC）はそのままです。");

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { chart_id: chartId, default_location: place ?? null },
  };
}

async function runTransit(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
        "save_chart で登録してください。",
    );
  }

  const year = optionalInteger(args, "year", -5000, 5000);
  const month = optionalInteger(args, "month", 1, 12);
  const day = optionalInteger(args, "day", 1, 31);
  const hour = optionalInteger(args, "hour", 0, 23);
  const minute = optionalInteger(args, "minute", 0, 59);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);
  // 空の中のアスペクトだけのオーブ。ネイタルへのアスペクト（DEFAULT_ORB＝1°）には効かない
  const chartOrb = optionalNumber(args, "orb", 0.5, 10) ?? DEFAULT_NATAL_ORB;

  const hasDate =
    year !== undefined ||
    month !== undefined ||
    day !== undefined ||
    hour !== undefined ||
    minute !== undefined;

  const now = context.now ? context.now() : new Date();
  let utcDate: Date;
  let isNow = false;
  if (hasDate) {
    if (year === undefined || month === undefined || day === undefined) {
      throw new AstroError(
        "日時を指定するときは year / month / day をそろえてください" +
          "（hour・minute を省くと 0 時 0 分、utc_offset を省くと UTC 扱い）",
      );
    }
    // Date も swe_julday も 2 月 31 日を黙って翌月へ繰り上げるので、その前に断る
    assertCalendarDay(year, month, day);
    utcDate = utcDateFromLocal(year, month, day, hour ?? 0, minute ?? 0, utcOffset ?? 0);
  } else {
    utcDate = now;
    isNow = true;
  }

  const swe = await engineOf(context);
  const jd = julianDay(swe, momentFromUtcDate(utcDate));
  const transitPlanets = computePlanets(swe, jd);

  const natalPoints = aspectPointsOf(chart);
  const transitPoints: AspectPoint[] = transitPlanets.map((planet) => ({
    name: planetName(planet.id),
    lon: planet.lon,
    speed: planet.speed,
  }));
  const aspects = crossAspects(natalPoints, transitPoints, DEFAULT_ORB);
  // 空の中のアスペクト（トランジット天体同士）。transit は空側の ASC/MC を立てないので天体だけ
  const chartAspects = natalAspects(
    planetPointsOf(transitPlanets, { excludeNodes: true }),
    chartOrb,
  );

  const angles = anglesOf(chart);
  const lines: string[] = [
    "トランジット",
    `チャート: ${chart.label}（${chartId}） / ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}）`,
  ];
  const when = [`日時: ${formatUtcMoment(utcDate)}${isNow ? "（現在時刻）" : ""}`];
  if (utcOffset !== undefined) {
    when.push(`ローカル ${formatLocalMoment(utcDate, utcOffset)}`);
  }
  lines.push(when.join(" / "));
  lines.push("");

  lines.push("■ トランジット天体（カッコ内はネイタルのカスプで見た在ハウス）");
  lines.push(...formatPlanetLines(transitPlanets, chart.cusps));
  lines.push("");

  lines.push("■ ネイタル天体（参考）");
  lines.push(...formatPlanetLines(chart.planets, chart.cusps));
  lines.push(formatAngles(angles));
  lines.push("");

  lines.push(`■ ネイタルへのアスペクト（メジャー5種・オーブ ${DEFAULT_ORB.toFixed(1)}°）`);
  if (aspects.length === 0) {
    lines.push(`該当なし（オーブ ${DEFAULT_ORB.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    // 直接 map に渡さないこと（第 2 引数の prefix に添字が飛び込む）
    lines.push(...aspects.map((hit) => formatCrossAspect(hit)));
  }
  lines.push("");

  // 個人向けの読み（ネイタルへ）が先、その日の空そのものの背景が後
  lines.push(
    `■ 空の中のアスペクト（トランジット天体同士・メジャー5種・オーブ ${chartOrb.toFixed(1)}°・ノード除く）`,
  );
  if (chartAspects.length === 0) {
    lines.push(`該当なし（オーブ ${chartOrb.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    lines.push(...chartAspects.map((hit) => formatNatalAspect(hit)));
  }

  const structuredTransit = transitPlanets.map((planet: PlanetPosition) => ({
    id: planet.id,
    name: planetName(planet.id),
    lon: planet.lon,
    speed: planet.speed,
    retrograde: planet.speed < 0,
    position: formatDegree(planet.lon),
    house: getHouse(planet.lon, chart.cusps),
  }));

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      chart_id: chartId,
      label: chart.label,
      house_system: chart.house_system,
      utc: utcDate.toISOString(),
      is_now: isNow,
      transit_planets: structuredTransit,
      aspects,
      chart_aspects: chartAspects,
    },
  };
}

// ---------------------------------------------------------------------------
// シナストリー（2 枚の出生図の間）
// ---------------------------------------------------------------------------

/** シナストリーの末尾に置く 1 行（解釈はサーバーの仕事ではない） */
const SYNASTRY_NO_READING_NOTE =
  "（相性の良し悪しも組み合わせの意味もこのサーバーに載っていません。読みはあなた自身の知識で）";

/** 「a に指定したチャート … が見つかりませんでした」（どちら側の引数かを言い添える） */
function missingSynastryChart(key: "a" | "b", chartId: string): ToolResult {
  return toolError(
    `${key} に指定したチャート ${chartId} が見つかりませんでした。` +
      "list_charts で登録済みの ID を確かめるか、save_chart で登録してください。",
  );
}

/**
 * シナストリー（2 枚の出生図の間のアスペクトと在ハウス）。
 *
 * 天体計算はしない ―― 2 枚とも KV に入っている座標を突き合わせるだけ（get_chart と同じで
 * engineOf も通らない）。どちらも止まった図なので接近・離反は持たない。
 *
 * 出生データは返事に出さない。ここは publicChart すら撒かず、**天体の黄経も載せない**
 * ―― 出すのはアスペクトと在ハウスの派生値だけで、位置は get_chart の持ち場（返事も短く済む）。
 */
async function runSynastry(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const idA = requireString(args, "a", 32);
  const idB = requireString(args, "b", 32);
  if (idA === idB) {
    return toolError(
      "同じチャート同士です。出生図の中のアスペクトは get_chart で見てください" +
        "（synastry は別々の 2 枚を突き合わせるツールです）。",
    );
  }

  // どちらも「呼び出した人の台帳」しか引かない＝他人のチャートは存在ごと見えない
  const chartA = await getChart(context.kv, context.auth.user, idA);
  if (!chartA) return missingSynastryChart("a", idA);
  const chartB = await getChart(context.kv, context.auth.user, idB);
  if (!chartB) return missingSynastryChart("b", idB);

  const orb = optionalNumber(args, "orb", 0.5, 10) ?? DEFAULT_NATAL_ORB;
  // ノードはアスペクトの相手にも入れない（在ハウスの一覧には出る）
  const aspects = synastryAspects(
    aspectPointsOf(chartA, { excludeNodes: true }),
    aspectPointsOf(chartB, { excludeNodes: true }),
    orb,
  );
  const aInB = houseOverlay(chartA.planets, chartB.cusps);
  const bInA = houseOverlay(chartB.planets, chartA.cusps);

  const nameOf = (chart: StoredChart, chartId: string): string =>
    chart.label ? `${chart.label}（${chartId}）` : chartId;
  const systemOf = (chart: StoredChart): string =>
    `${houseSystemName(chart.house_system)}（${chart.house_system}）`;

  const lines: string[] = [
    "シナストリー",
    `A: ${nameOf(chartA, idA)} / B: ${nameOf(chartB, idB)}`,
    `ハウス方式: A ${systemOf(chartA)} / B ${systemOf(chartB)}`,
  ];
  if (chartA.house_system !== chartB.house_system) {
    // 在ハウスは「相手の図の方式のカスプ」で数えている＝2 枚で物差しが違うことを言い添える
    lines.push(
      "※ 2 枚でハウス方式が違います（在ハウスはそれぞれ相手の図の方式のカスプで数えています）。",
    );
  }
  lines.push("");

  lines.push(
    `■ 2 枚の間のアスペクト（メジャー5種・オーブ ${orb.toFixed(1)}°・10 天体＋ASC/MC の総当たり、ノード除く）`,
  );
  if (aspects.length === 0) {
    lines.push(`該当なし（オーブ ${orb.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    lines.push(...aspects.map((hit) => formatSynastryAspect(hit)));
  }
  lines.push("");

  lines.push("■ A の天体が B のハウスで（ノード込みの 11 天体）");
  lines.push(formatHouseOverlay(aInB));
  lines.push("");

  lines.push("■ B の天体が A のハウスで（同上）");
  lines.push(formatHouseOverlay(bInA));
  lines.push("");

  lines.push(SYNASTRY_NO_READING_NOTE);

  const describe = (chart: StoredChart, chartId: string) => ({
    chart_id: chartId,
    label: chart.label,
    house_system: chart.house_system,
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "synastry",
      a: describe(chartA, idA),
      b: describe(chartB, idB),
      orb,
      aspects,
      overlays: { a_in_b: aInB, b_in_a: bInA },
    },
  };
}

// ---------------------------------------------------------------------------
// リターン（ルナリターン・ソーラーリターン）
// ---------------------------------------------------------------------------

/** リターン図を立てる場所 */
interface ReturnPlace {
  lat: number;
  lng: number;
  label?: string;
}

/** 引数の lat / lng → 無ければチャートの「いつもの場所」→ それも無ければ丁寧に断る */
function resolvePlace(args: Record<string, unknown>, chart: StoredChart): ReturnPlace {
  const lat = optionalNumber(args, "lat", -90, 90);
  const lng = optionalNumber(args, "lng", -180, 180);
  const label = optionalString(args, "location_label", 40);

  if ((lat === undefined) !== (lng === undefined)) {
    throw new AstroError("lat と lng は両方そろえて指定してください");
  }
  if (lat !== undefined && lng !== undefined) {
    const place: ReturnPlace = { lat, lng };
    if (label) place.label = label;
    return place;
  }
  if (chart.default_location) {
    const place: ReturnPlace = {
      lat: chart.default_location.lat,
      lng: chart.default_location.lng,
    };
    const name = label ?? chart.default_location.label;
    if (name) place.label = name;
    return place;
  }
  throw new AstroError(
    "リターン図を立てる場所が分かりません。lat / lng で場所を指定するか、" +
      "save_chart で default_lat / default_lng（いつもの場所）を登録してください。",
  );
}

/** 「東京（緯度 35.6895 / 経度 139.6917）」 */
function formatPlace(place: ReturnPlace): string {
  const coordinates = `緯度 ${place.lat} / 経度 ${place.lng}`;
  return place.label ? `${place.label}（${coordinates}）` : coordinates;
}

/** その暦月の頭（0 時 0 分）の jd。utcOffset を渡すとその土地の暦での月初になる */
function monthStartJd(swe: SwissEph, year: number, month: number, utcOffset: number): number {
  return julianDay(swe, { year, month, day: 1, hour: 0, minute: 0, utcOffset });
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** リターン 1 回ぶん（瞬間とその図） */
interface ReturnMoment {
  jd: number;
  date: Date;
  chart: ComputedChart;
  /** リターン図 → ネイタル（オーブ 1° 固定） */
  aspects: ReturnType<typeof crossAspects>;
  /** リターン図の中のアスペクト（10 天体＋ASC/MC。オーブは orb 引数） */
  chartAspects: ReturnType<typeof natalAspects>;
}

/**
 * ルナリターン / ソーラーリターン。中身はほぼ同じなので 1 本にまとめてある
 * （違うのは戻る天体・期間の指定の仕方・見出しだけ）。
 */
async function runReturn(
  kind: ReturnKind,
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
        "save_chart で登録してください。",
    );
  }

  const isLunar = kind === "moon";
  const targetId = isLunar ? 1 : 0;
  const targetName = planetName(targetId);
  const target = chart.planets.find((planet) => planet.id === targetId);
  if (!target) {
    return toolError(
      `このチャートには${targetName}の位置が入っていません。save_chart で登録し直してください。`,
    );
  }

  const place = resolvePlace(args, chart);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);
  // リターン図の中のアスペクトだけのオーブ。ネイタルへのアスペクト（1°）には効かない
  const chartOrb = optionalNumber(args, "orb", 0.5, 10) ?? DEFAULT_NATAL_ORB;
  const boundaryOffset = utcOffset ?? 0;
  const year = optionalInteger(args, "year", -5000, 5000);
  const month = isLunar ? optionalInteger(args, "month", 1, 12) : undefined;

  if (isLunar && (year === undefined) !== (month === undefined)) {
    throw new AstroError(
      "year と month はそろえて指定してください" +
        "（両方省略すると現在時刻から見て次のリターンを返します）",
    );
  }

  const swe = await engineOf(context);
  const now = context.now ? context.now() : new Date();
  const nowJd = julianDay(swe, momentFromUtcDate(now));
  const calendarNote = utcOffset === undefined ? "UTC の暦" : `${formatOffsetLabel(utcOffset)} の暦`;

  let jds: number[];
  let periodLabel: string;
  let isNext = false;
  if (year === undefined) {
    // 期間の指定なし ＝ 今から見て次の 1 回
    jds = [crossUt(swe, kind, target.lon, nowJd)];
    periodLabel = `${formatUtcMoment(now)}（現在）より後の次の 1 回`;
    isNext = true;
  } else if (isLunar && month !== undefined) {
    const start = monthStartJd(swe, year, month, boundaryOffset);
    const following = nextMonth(year, month);
    const end = monthStartJd(swe, following.year, following.month, boundaryOffset);
    jds = crossingsInRange(swe, kind, target.lon, start, end);
    periodLabel = `${year}年${month}月（${calendarNote}）`;
  } else {
    // ソーラーリターンはその年の 1 月 1 日から 1 回だけ探せば足りる（年に 1 回しか無い）
    jds = [crossUt(swe, kind, target.lon, monthStartJd(swe, year, 1, boundaryOffset))];
    periodLabel = `${year}年（${calendarNote}）`;
  }

  const natalPoints = aspectPointsOf(chart);
  const moments: ReturnMoment[] = jds.map((jd) => {
    const returnChart = computeChartFromJd(swe, jd, {
      lat: place.lat,
      lng: place.lng,
      houseSystem: chart.house_system,
    });
    const returnPoints: AspectPoint[] = returnChart.planets.map((planet) => ({
      name: planetName(planet.id),
      lon: planet.lon,
      speed: planet.speed,
    }));
    return {
      jd,
      date: dateFromJulianDay(jd),
      chart: returnChart,
      aspects: crossAspects(natalPoints, returnPoints, DEFAULT_ORB),
      // リターン図自身の ASC/MC も点に入れる（ノードは相手にも入れない）
      chartAspects: natalAspects(aspectPointsOf(returnChart, { excludeNodes: true }), chartOrb),
    };
  });

  const lines: string[] = [
    isLunar ? "ルナリターン（月の帰還）" : "ソーラーリターン（太陽の帰還）",
    `チャート: ${chart.label}（${chartId}） / ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}）`,
    `ネイタルの${targetName}: ${formatDegree(target.lon)}`,
    `リターン図を立てた場所: ${formatPlace(place)}`,
    isNext ? `対象: ${periodLabel}` : `対象: ${periodLabel} ― ${moments.length}件`,
  ];

  if (moments.length === 0) {
    lines.push("");
    lines.push(
      `この期間に${targetName}のリターンはありませんでした` +
        "（ルナリターンは約27.3日に1回めぐるので、暦月の並びによっては1回も入らない月があります）。" +
        "前後の月も見てみてください。",
    );
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        kind: isLunar ? "lunar_return" : "solar_return",
        chart_id: chartId,
        label: chart.label,
        house_system: chart.house_system,
        natal_target: { id: targetId, name: targetName, lon: target.lon },
        location: place,
        is_next: isNext,
        returns: [],
      },
    };
  }

  lines.push("（T.＝リターン図の天体 / N.＝ネイタル）");

  moments.forEach((moment, index) => {
    lines.push("");
    if (moments.length > 1) lines.push(`■ ${index + 1} 回目`);
    const when = [`リターンの瞬間: ${formatUtcMoment(moment.date)}`];
    if (utcOffset !== undefined) {
      when.push(`ローカル ${formatLocalMoment(moment.date, utcOffset)}`);
    }
    lines.push(when.join(" / "));
    lines.push("");
    lines.push("□ リターン図の天体（カッコ内はリターン図自身のカスプで見た在ハウス）");
    lines.push(...formatPlanetLines(moment.chart.planets, moment.chart.cusps));
    lines.push(formatAngles(anglesOf(moment.chart)));
    lines.push("□ リターン図のハウスカスプ");
    lines.push(formatCuspLine(moment.chart.cusps));
    lines.push(`□ ネイタルへのアスペクト（メジャー5種・オーブ ${DEFAULT_ORB.toFixed(1)}°）`);
    if (moment.aspects.length === 0) {
      lines.push(
        `該当なし（オーブ ${DEFAULT_ORB.toFixed(1)}° の範囲にメジャーアスペクトはありません）`,
      );
    } else {
      lines.push(...moment.aspects.map((hit) => formatCrossAspect(hit)));
    }
    // 個人向けの読み（ネイタルへ）が先、リターン図そのものの背景が後
    lines.push(
      `□ リターン図の中のアスペクト（メジャー5種・オーブ ${chartOrb.toFixed(1)}°・10 天体＋ASC/MC、ノード除く）`,
    );
    if (moment.chartAspects.length === 0) {
      lines.push(
        `該当なし（オーブ ${chartOrb.toFixed(1)}° の範囲にメジャーアスペクトはありません）`,
      );
    } else {
      lines.push(...moment.chartAspects.map((hit) => formatNatalAspect(hit)));
    }
  });

  const returns = moments.map((moment) => {
    const angles = anglesOf(moment.chart);
    return {
      utc: moment.date.toISOString(),
      jd: moment.jd,
      planets: moment.chart.planets.map((planet: PlanetPosition) => ({
        id: planet.id,
        name: planetName(planet.id),
        lon: planet.lon,
        speed: planet.speed,
        retrograde: planet.speed < 0,
        position: formatDegree(planet.lon),
        house: getHouse(planet.lon, moment.chart.cusps),
      })),
      asc: angles.asc,
      mc: angles.mc,
      cusps: moment.chart.cusps,
      aspects: moment.aspects,
      chart_aspects: moment.chartAspects,
    };
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: isLunar ? "lunar_return" : "solar_return",
      chart_id: chartId,
      label: chart.label,
      house_system: chart.house_system,
      natal_target: {
        id: targetId,
        name: targetName,
        lon: target.lon,
        position: formatDegree(target.lon),
      },
      location: place,
      period: isNext ? null : isLunar ? { year, month } : { year },
      is_next: isNext,
      returns,
    },
  };
}

// ---------------------------------------------------------------------------
// 二次進行
// ---------------------------------------------------------------------------

/**
 * 二次進行（一日一年法）。
 *
 * ほかのツールと違って**出生の瞬間そのもの**が要る ―― 計算済みの座標からは逆算できないため、
 * 台帳に預かっている出生データ（`birth`）を使う。出生データを持たない古い登録では使えないので、
 * その場合は値に触れずに「登録し直してください」とだけ返す。
 */
async function runProgressions(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
        "save_chart で登録してください。",
    );
  }
  const birth = chart.birth;
  if (!birth) {
    return toolError(
      "このチャートには出生データが入っていません（出生データを保存しない時代の登録です）。" +
        "delete_chart で消して save_chart で登録し直すと使えます。",
    );
  }
  const natalMoment: MomentInput = {
    year: birth.year,
    month: birth.month,
    day: birth.day,
    hour: birth.hour,
    minute: birth.minute,
    utcOffset: birth.utc_offset,
  };

  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);
  const year = optionalInteger(args, "year", -5000, 5000);
  const month = optionalInteger(args, "month", 1, 12);
  const day = optionalInteger(args, "day", 1, 31);
  const given = [year, month, day].filter((value) => value !== undefined).length;
  if (given !== 0 && given !== 3) {
    throw new AstroError(
      "year / month / day はそろえて指定してください（すべて省略すると今日で計算します）",
    );
  }
  if (given === 3) {
    assertCalendarDay(year as number, month as number, day as number);
  }

  const now = context.now ? context.now() : new Date();
  const shifted = new Date(now.getTime() + (utcOffset ?? 0) * 3_600_000);
  const isToday = given === 0;
  const target = isToday
    ? {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
      }
    : { year: year as number, month: month as number, day: day as number };

  const swe = await engineOf(context);
  const result = computeProgression(swe, {
    natal: natalMoment,
    lat: birth.lat,
    lng: birth.lng,
    houseSystem: chart.house_system,
    target,
  });

  const natalPoints = aspectPointsOf(result.natalChart);
  const progressedPoints: AspectPoint[] = result.progressedPlanets.map((planet) => ({
    name: planetName(planet.id),
    lon: planet.lon,
    speed: planet.speed,
  }));
  const aspects = crossAspects(natalPoints, progressedPoints, DEFAULT_ORB);

  const natalAngles = anglesOf(result.natalChart);
  const dateLabel = `${target.year}-${pad(target.month)}-${pad(target.day)}`;
  const calendarNote = isToday
    ? `（今日・${utcOffset === undefined ? "UTC" : formatOffsetLabel(utcOffset)} の暦）`
    : "";

  const lines: string[] = [
    "プログレッション（二次進行・一日一年法）",
    `チャート: ${chart.label}（${chartId}）`,
    `対象日: ${dateLabel}${calendarNote} / ${formatAge(result.ageYears)}`,
    `ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}） / ソーラーアーク ${formatArc(result.solarArc)}`,
    "（P.＝進行天体 / N.＝ネイタル。出生の日時・場所そのものはここには出しません）",
    "",
    "■ 進行天体（カッコ内は出生図のカスプで見た在ハウス）",
    ...formatPlanetLines(result.progressedPlanets, result.natalChart.cusps),
    "",
    "■ 進行 ASC / MC（ソーラーアークで動かした MC から ARMC 方式で立てたもの）",
    formatAngles(result.progressedAngles),
    "■ 進行図のハウスカスプ",
    formatCuspLine(result.progressedCusps),
    "",
    "■ ネイタル（参考）",
    ...formatPlanetLines(result.natalChart.planets, result.natalChart.cusps),
    formatAngles(natalAngles),
    "",
    `■ 進行天体からネイタルへのアスペクト（メジャー5種・オーブ ${DEFAULT_ORB.toFixed(1)}°）`,
  ];
  if (aspects.length === 0) {
    lines.push(`該当なし（オーブ ${DEFAULT_ORB.toFixed(1)}° の範囲にメジャーアスペクトはありません）`);
  } else {
    lines.push(...aspects.map((hit) => formatCrossAspect(hit, "P.")));
  }

  const describe = (planet: PlanetPosition, cusps: readonly number[]) => ({
    id: planet.id,
    name: planetName(planet.id),
    lon: planet.lon,
    speed: planet.speed,
    retrograde: planet.speed < 0,
    position: formatDegree(planet.lon),
    house: getHouse(planet.lon, cusps),
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      // jd（＝出生の瞬間そのもの）は載せない。預かっている出生データは返事に出さないため
      chart_id: chartId,
      label: chart.label,
      target_date: dateLabel,
      is_today: isToday,
      age_years: result.ageYears,
      age_label: formatAge(result.ageYears),
      house_system: chart.house_system,
      solar_arc: result.solarArc,
      progressed_planets: result.progressedPlanets.map((planet) =>
        describe(planet, result.natalChart.cusps),
      ),
      progressed_angles: {
        asc: result.progressedAngles.asc,
        mc: result.progressedAngles.mc,
        asc_position: formatDegree(result.progressedAngles.asc),
        mc_position: formatDegree(result.progressedAngles.mc),
      },
      progressed_cusps: result.progressedCusps,
      natal_planets: result.natalChart.planets.map((planet) =>
        describe(planet, result.natalChart.cusps),
      ),
      natal_angles: {
        asc: natalAngles.asc,
        mc: natalAngles.mc,
        asc_position: formatDegree(natalAngles.asc),
        mc_position: formatDegree(natalAngles.mc),
      },
      aspects,
    },
  };
}

// ---------------------------------------------------------------------------
// 数秘術（誕生日から引く占術の 1 本目）
// ---------------------------------------------------------------------------

/** 数秘術に渡す生年月日と、その出どころ（返事の見出しと印に使う） */
interface NumerologyBirth {
  year: number;
  month: number;
  day: number;
  /** chart=台帳が預かっているぶん / direct=呼び出しで直接指定されたぶん */
  source: "chart" | "direct";
  /** source が chart のときだけ入る */
  chartId?: string;
  label?: string;
}

/**
 * 生年月日をどこから取るかを決める。
 *
 * **chart_id か year / month / day のどちらか一方**で、両方来たら断る（どちらを見るか勝手に決めない）。
 * 直接指定のときだけ暦の検算をここでする ―― 呼び出した側が打った値なので日付を出して断ってよい。
 * 預かっているぶんは登録時に検算済みで、こちらは値を返事に出さない約束がある。
 *
 * 見つからない・出生データが無いといった「断り」は toolError をそのまま包んで返す
 * （呼び出し側で `"error" in …` を見て素通しする）。
 */
async function resolveNumerologyBirth(
  args: Record<string, unknown>,
  context: AstroContext,
): Promise<NumerologyBirth | { error: ToolResult }> {
  const chartId = optionalString(args, "chart_id", 32);
  const year = optionalInteger(args, "year", 1, 9999);
  const month = optionalInteger(args, "month", 1, 12);
  const day = optionalInteger(args, "day", 1, 31);
  const givenBirth = [year, month, day].filter((value) => value !== undefined).length;

  if (chartId !== undefined && givenBirth > 0) {
    throw new AstroError(
      "chart_id と生年月日（year / month / day）は、どちらか一方にしてください" +
        "（登録済みのチャートから引くなら chart_id、登録せずに一度だけ見るなら生年月日）",
    );
  }

  if (chartId === undefined) {
    if (givenBirth === 0) {
      throw new AstroError(
        "chart_id か year / month / day を指定してください" +
          "（登録済みのチャートから引くなら chart_id、登録せずに一度だけ見るなら生年月日）",
      );
    }
    if (givenBirth !== 3) {
      throw new AstroError(
        "生年月日は year / month / day の 3 つをそろえて指定してください",
      );
    }
    assertCalendarDay(year as number, month as number, day as number);
    return {
      year: year as number,
      month: month as number,
      day: day as number,
      source: "direct",
    };
  }

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return {
      error: toolError(
        `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
          "save_chart で登録してください。",
      ),
    };
  }
  const birth = chart.birth;
  if (!birth) {
    return {
      error: toolError(
        "このチャートには出生データが入っていません（出生データを保存しない時代の登録です）。" +
          "delete_chart で消して save_chart で登録し直すと使えます。",
      ),
    };
  }
  return {
    year: birth.year,
    month: birth.month,
    day: birth.day,
    source: "chart",
    chartId,
    label: chart.label,
  };
}

/**
 * 数秘術を計算する（誕生日から引く占術の 1 本目）。
 *
 * 算法は純関数（src/numerology.ts）で、ここがやるのは**生年月日の出どころ**を決めることだけ ――
 * 台帳が預かっている出生データ（chart_id）か、呼び出しでの直接指定（year / month / day）。
 * 出生データを返事に出さない約束はどちらでも同じで、途中式に出るのは
 * 還元したあとの値と「生まれた日」（＝バースデーナンバー）だけ。年と月の生の数字は出ない。
 */
async function runCalculateNumerology(
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const resolved = await resolveNumerologyBirth(args, context);
  if ("error" in resolved) return resolved.error;

  const masters = requireMasters(args);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);
  const year = optionalInteger(args, "target_year", 1, 9999);
  const month = optionalInteger(args, "target_month", 1, 12);
  const day = optionalInteger(args, "target_day", 1, 31);
  const given = [year, month, day].filter((value) => value !== undefined).length;
  if (given !== 0 && given !== 3) {
    throw new AstroError(
      "基準日は target_year / target_month / target_day を 3 つそろえて指定してください" +
        "（3 つとも省くと今日で見ます）",
    );
  }
  if (given === 3) {
    assertCalendarDay(year as number, month as number, day as number);
  }

  // 基準日を省いたときだけ「今日」を決める（時差はそのためだけに使う）
  const now = context.now ? context.now() : new Date();
  const shifted = new Date(now.getTime() + (utcOffset ?? 0) * 3_600_000);
  const target =
    given === 3
      ? { year: year as number, month: month as number, day: day as number }
      : {
          year: shifted.getUTCFullYear(),
          month: shifted.getUTCMonth() + 1,
          day: shifted.getUTCDate(),
        };

  let result: NumerologyResult;
  try {
    result = calculateNumerology({
      year: resolved.year,
      month: resolved.month,
      day: resolved.day,
      target,
      masters,
    });
  } catch (error) {
    // 純関数の言い分には生年月日の値が混じり得るので、そのままは返さない
    if (error instanceof NumerologyError) {
      throw new AstroError(
        "その生年月日からは数秘術を計算できませんでした" +
          "（数秘術は西暦 1〜9999 年の生年月日で計算します。値は返事に出しません）。",
      );
    }
    throw error;
  }

  // 見出しの 1 行。直接指定のときは「どこから来た数か」だけを言い、生年月日の値は書かない
  const heading =
    resolved.source === "chart"
      ? `チャート: ${resolved.label}（${resolved.chartId}）`
      : "生年月日: 直接指定（値は返事に出しません）";

  return {
    content: [{ type: "text", text: `${heading}\n${formatNumerologyText(result)}` }],
    structuredContent:
      resolved.source === "chart"
        ? { source: resolved.source, chart_id: resolved.chartId, label: resolved.label, ...result }
        : { source: resolved.source, ...result },
  };
}

// ---------------------------------------------------------------------------
// 宿曜（二十七宿）
// ---------------------------------------------------------------------------

/** 月の天体 ID（PLANETS の並びと同じ） */
const MOON_ID = 1;

/** 1 日のうちに宿が切り替わる回数の上限（月は 1 宿に 21〜27 時間いるので、多くて 2 回） */
const MAX_SHUKU_CHANGES = 3;

/** その瞬間の月のトロピカル黄経 */
function moonLongitude(swe: SwissEph, jd: number): number {
  return normalizeDegree(swe.swe_calc_ut(jd, MOON_ID, CALC_FLAGS)[0] as number);
}

/**
 * その瞬間の月の宿（サイデリアル）。
 *
 * ⚠ **アヤナムシャの値は呼び出し側へ返さないこと**（出生の瞬間で引いたぶんは）。
 *    Lahiri は 50″/年ほどで動くので、小数 4 桁まで出すと値そのものが「生まれた年月」の目盛りになる
 *    ――出生データを返事に出さない約束に触れる。日運のように**呼び出し側が日付を指定した瞬間**の
 *    アヤナムシャは、その日付がもともと会話に出ているので返してよい。
 */
function shukuAtJd(swe: SwissEph, jd: number): { position: ShukuPosition; ayanamsa: number } {
  const ayanamsa = swe.swe_get_ayanamsa_ut(jd);
  return { position: shukuOf(toSidereal(moonLongitude(swe, jd), ayanamsa)), ayanamsa };
}

/**
 * 窓（startJd 以上 endJd 未満）の中で月が宿の境界を越える瞬間を拾う。
 *
 * 月は逆行しないので、境界は必ず前から順に 1 つずつ越える。探索は returns.ts の crossUt
 * （＝壊れた wrapper のエラーチェックを呼び出し側で検算するやつ）を借りる。
 * ⚠ `swe_mooncross_ut` が探すのは**トロピカル黄経**なので、サイデリアルの境界に
 *    アヤナムシャを足し戻してから渡す。アヤナムシャは 1 日で 4e-5° しか動かず、
 *    月足（13°/日）に直すと 0.3 秒未満なので、窓の頭の値を使い回して構わない。
 */
function moonShukuChanges(
  swe: SwissEph,
  startJd: number,
  endJd: number,
  ayanamsa: number,
): { jd: number; from: Shuku; to: Shuku }[] {
  let index = shukuIndexOf(toSidereal(moonLongitude(swe, startJd), ayanamsa));
  const changes: { jd: number; from: Shuku; to: Shuku }[] = [];
  let cursor = startJd;

  for (let guard = 0; guard < MAX_SHUKU_CHANGES; guard++) {
    const nextIndex = (index + 1) % SHUKU_COUNT;
    const targetTropical = normalizeDegree(nextIndex * SHUKU_SPAN + ayanamsa);
    const jd = crossUt(swe, "moon", targetTropical, cursor);
    if (jd >= endJd) break;
    changes.push({ jd, from: shukuAt(index), to: shukuAt(nextIndex) });
    index = nextIndex;
    cursor = jd;
  }
  return changes;
}

/** 出生の瞬間と、その出どころ（返事の見出しに使う。値そのものは出さない） */
interface BirthMoment {
  moment: MomentInput;
  /** chart=台帳が預かっているぶん / direct=呼び出しで直接指定されたぶん */
  source: "chart" | "direct";
  chartId?: string;
  label?: string;
  /**
   * 出生時刻が分かっているか。
   * timeOptional のツールで hour を省かれたときだけ false（moment には仮の 12 時が入っている）。
   */
  timeKnown: boolean;
}

/** 出生の瞬間の取り方をツールごとに変えるところ（断り文と、直接指定で受ける年の範囲） */
interface BirthMomentOptions {
  /** 断り文に挟む理由（なぜ時刻まで要るのか／何が出生の日時で決まるのか） */
  reason: string;
  /** 直接指定で受ける年の下限・上限 */
  yearMin: number;
  yearMax: number;
  /**
   * 出生時刻を任意にする（既定は必須）。
   *
   * true のときは year / month / day の 3 つだけで受け、hour / minute が無ければ
   * **その日の 12 時**を仮の瞬間に置く（`timeKnown` に false を立てるので、
   * 呼び出し側は「時刻で答えが変わるか」を自分で確かめられる）。
   */
  timeOptional?: boolean;
}

/** 出生の 12 時（時刻不明のときに置く仮の瞬間。日の真ん中なので前後に丸め幅が等しい） */
const BIRTH_NOON_HOUR = 12;

/** 宿曜（月は 1 日でほぼ 1 宿ぶん動く） */
const SHUKUYO_BIRTH_OPTIONS: BirthMomentOptions = {
  reason: "宿は出生時刻の月の位置で決まり、月は 1 日でほぼ 1 宿ぶん動くので",
  yearMin: -5000,
  yearMax: 5000,
};

/** 四柱推命（時柱は 2 時間ごと。純関数が西暦 1〜9999 でしか立てないので範囲もそろえる） */
const FOUR_PILLARS_BIRTH_OPTIONS: BirthMomentOptions = {
  reason: "時柱は出生時刻の 2 時間ごとの区切りで決まるので",
  yearMin: 1,
  yearMax: 9999,
};

/** 九星気学（星は年と月と日で決まる＝出生時刻は任意。年の範囲は四柱と同じ） */
const KYUSEI_BIRTH_OPTIONS: BirthMomentOptions = {
  reason: "本命星は立春で切った年、月命星は節で切った月、日命星は暦日で決まるので",
  yearMin: 1,
  yearMax: 9999,
  timeOptional: true,
};

/** 「どちらか一方を指定してください」の断り文（時刻が任意かどうかで挙げる引数が変わる） */
function missingBirthSourceMessage(options: BirthMomentOptions): string {
  if (options.timeOptional) {
    return (
      "chart_id か year / month / day を指定してください" +
      "（登録済みのチャートから引くなら chart_id、登録せずに一度だけ見るなら生年月日。" +
      "出生時刻 hour / minute は分かれば添えてください）"
    );
  }
  return (
    "chart_id か year / month / day / hour / minute を指定してください" +
    "（登録済みのチャートから引くなら chart_id、登録せずに一度だけ見るなら生年月日と出生時刻）"
  );
}

/** 「そろえて指定してください」の断り文（同上） */
function missingBirthFieldsMessage(options: BirthMomentOptions): string {
  if (options.timeOptional) {
    return (
      "生年月日は year / month / day の 3 つをそろえて指定してください" +
      `（${options.reason}）。` +
      `出生時刻（hour / minute）は任意で、省くとその日の ${BIRTH_NOON_HOUR} 時で見ます` +
      "（立春・節入りの当日の生まれのときだけ時刻で星が変わるので、両方の候補を添えます）。" +
      "utc_offset も省略でき、そのときは UTC 扱いです"
    );
  }
  return (
    "生年月日と出生時刻は year / month / day / hour / minute の 5 つをそろえて指定してください" +
    `（${options.reason}、` +
    "時刻の分からない出生では引けません。utc_offset だけは省略でき、そのときは UTC 扱いです）"
  );
}

/**
 * 出生の瞬間（時刻まで）をどこから取るかを決める。宿曜と四柱推命の共通の入り口。
 *
 * calculate_numerology の resolveNumerologyBirth と同じ規則（chart_id か直接指定のどちらか一方）だが、
 * **時刻まで要る**のが違い ―― 宿も時柱も出生時刻で変わるので、時刻不明の出生は受けない。
 * 「なぜ時刻が要るのか」だけツールごとに違うので options.reason で差し替える。
 *
 * 例外は `options.timeOptional`（九星気学）―― 星は年・月・日で決まるので時刻不明でも引ける。
 * その場合だけ hour / minute を省いてよく、省かれたら 12 時を仮に置いて `timeKnown` を false にする。
 */
async function resolveBirthMoment(
  args: Record<string, unknown>,
  context: AstroContext,
  options: BirthMomentOptions,
): Promise<BirthMoment | { error: ToolResult }> {
  const chartId = optionalString(args, "chart_id", 32);
  const year = optionalInteger(args, "year", options.yearMin, options.yearMax);
  const month = optionalInteger(args, "month", 1, 12);
  const day = optionalInteger(args, "day", 1, 31);
  const hour = optionalInteger(args, "hour", 0, 23);
  const minute = optionalInteger(args, "minute", 0, 59);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);
  const givenBirth = [year, month, day, hour, minute, utcOffset].filter(
    (value) => value !== undefined,
  ).length;

  if (chartId !== undefined && givenBirth > 0) {
    throw new AstroError(
      "chart_id と出生データ（year / month / day / hour / minute / utc_offset）は、" +
        "どちらか一方にしてください" +
        "（登録済みのチャートから引くなら chart_id、登録せずに一度だけ見るなら生年月日と時刻）",
    );
  }

  if (chartId === undefined) {
    if (givenBirth === 0) {
      throw new AstroError(missingBirthSourceMessage(options));
    }
    if (year === undefined || month === undefined || day === undefined) {
      throw new AstroError(missingBirthFieldsMessage(options));
    }
    if (!options.timeOptional && (hour === undefined || minute === undefined)) {
      throw new AstroError(missingBirthFieldsMessage(options));
    }
    assertCalendarDay(year, month, day);
    return {
      moment: {
        year,
        month,
        day,
        // 時刻任意のツールで hour が無いときだけ、日の真ん中（12 時）を仮に置く
        hour: hour ?? BIRTH_NOON_HOUR,
        minute: minute ?? 0,
        utcOffset: utcOffset ?? 0,
      },
      source: "direct",
      timeKnown: hour !== undefined,
    };
  }

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return {
      error: toolError(
        `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
          "save_chart で登録してください。",
      ),
    };
  }
  const birth = chart.birth;
  if (!birth) {
    return {
      error: toolError(
        "このチャートには出生データが入っていません（出生データを保存しない時代の登録です）。" +
          "delete_chart で消して save_chart で登録し直すと使えます。",
      ),
    };
  }
  return {
    moment: {
      year: birth.year,
      month: birth.month,
      day: birth.day,
      hour: birth.hour,
      minute: birth.minute,
      utcOffset: birth.utc_offset,
    },
    source: "chart",
    chartId,
    label: chart.label,
    // 台帳は時刻まで預かっている（save_chart が hour / minute を必須にしている）
    timeKnown: true,
  };
}

/**
 * 日運を見る瞬間（date / date_utc_offset から決めたもの）。
 * 宿曜と四柱推命で共用する（どちらも「date は省略すると今、時刻を省けばその日の 0 時」の流儀）。
 */
interface FortuneDay {
  /** 見る瞬間（UTC） */
  at: Date;
  /** その瞬間を含む暦日（date_utc_offset の暦） */
  date: { year: number; month: number; day: number };
  /** 時刻まで指定されたか（date に時刻が無ければ 0 時で見る） */
  hasTime: boolean;
  /** date を省いて「今」になったか */
  isNow: boolean;
  utcOffset: number;
}

/** "YYYY-MM-DD" または "YYYY-MM-DD HH:MM"（区切りは半角空白でも T でもよい） */
function parseFortuneDate(raw: string, utcOffset: number): FortuneDay {
  const matched = /^(-?\d{1,5})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(raw);
  if (!matched) {
    throw new AstroError(
      `date は "YYYY-MM-DD" か "YYYY-MM-DD HH:MM" の形で指定してください` +
        `（例: 2026-08-22 / 2026-08-22 08:30）: ${raw}`,
    );
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new AstroError(`date の月日が暦の範囲を外れています（月は 1〜12、日は 1〜31）: ${raw}`);
  }
  assertCalendarDay(year, month, day);

  const hasTime = matched[4] !== undefined;
  const hour = hasTime ? Number(matched[4]) : 0;
  const minute = hasTime ? Number(matched[5]) : 0;
  if (hour > 23 || minute > 59) {
    throw new AstroError(`date の時刻が範囲を外れています（時は 0〜23、分は 0〜59）: ${raw}`);
  }

  return {
    at: utcDateFromLocal(year, month, day, hour, minute, utcOffset),
    date: { year, month, day },
    hasTime,
    isNow: false,
    utcOffset,
  };
}

/** date を省いたとき＝「今」。暦日は date_utc_offset の土地の暦で決める */
function fortuneDayFromNow(now: Date, utcOffset: number): FortuneDay {
  const shifted = new Date(now.getTime() + utcOffset * 3_600_000);
  return {
    at: now,
    date: {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    },
    hasTime: true,
    isNow: true,
    utcOffset,
  };
}

/** 返り値に添える「このサーバーが採った規約」。名前で書くのは読む側が流派を確かめられるように */
const SHUKUYO_SYSTEM = {
  method: "astronomical",
  method_label: "天文方式（出生時刻の月のサイデリアル黄経 ÷ 13°20′）",
  ayanamsa: AYANAMSA_NAME,
  ayanamsa_id: SIDEREAL_MODE_LAHIRI,
  mansions: SHUKU_COUNT,
  span_degrees: SHUKU_SPAN,
  origin: "婁宿（Ashvini）＝サイデリアル 0°",
  calendar_note:
    "暦方式（旧暦の日付から宿を引くやり方）は採らない" +
    "（旧暦は 2033 年問題のように裁定者のいない未解決の規約を含むため）",
  note: "『宿曜経』の列挙は昴宿から始まるが、それは表の並びであって位置の起点ではない",
} as const;

const SHUKUYO_NO_READING_NOTE =
  "（宿の意味・吉凶はこのサーバーに載っていません。読みはあなた自身の知識で。" +
  "ホロスコープ・宿曜・四柱は別々の体系で、合算する根拠はありません）";

/** 規約の 1 行（テキストの末尾に置く） */
const SHUKUYO_SYSTEM_LINE =
  `規約: ${SHUKUYO_SYSTEM.method_label} / 基準点 ${AYANAMSA_NAME}（SE_SIDM_LAHIRI）/ ` +
  `${SHUKU_COUNT} 宿・${SHUKUYO_SYSTEM.origin} / ${SHUKUYO_SYSTEM.calendar_note}`;

/**
 * 宿曜（本命宿とその日の宿）。
 *
 * 出生データは返事に出さない ―― 出すのは派生値（宿・宿内の位置・サイデリアル黄経）だけ。
 * 出生時のアヤナムシャも出さない（値そのものが生まれた年月の目盛りになるため）。
 */
async function runShukuyo(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const resolved = await resolveBirthMoment(args, context, SHUKUYO_BIRTH_OPTIONS);
  if ("error" in resolved) return resolved.error;

  const dateOffset = optionalNumber(args, "date_utc_offset", -14, 14) ?? 0;
  const rawDate = optionalString(args, "date", 24);
  const now = context.now ? context.now() : new Date();
  const day = rawDate === undefined
    ? fortuneDayFromNow(now, dateOffset)
    : parseFortuneDate(rawDate, dateOffset);

  const swe = await engineOf(context);

  // 本命宿（アヤナムシャは受け取るだけで返さない）
  const natal = shukuAtJd(swe, julianDay(swe, resolved.moment)).position;

  // その日の宿
  const dayJd = julianDay(swe, momentFromUtcDate(day.at));
  const today = shukuAtJd(swe, dayJd);
  const relation = relationOf(natal.shuku.number - 1, today.position.shuku.number - 1);

  // その暦日（0 時〜24 時）の切り替わり
  const windowStart = utcDateFromLocal(day.date.year, day.date.month, day.date.day, 0, 0, dateOffset);
  const windowStartJd = julianDay(swe, momentFromUtcDate(windowStart));
  const changes = moonShukuChanges(swe, windowStartJd, windowStartJd + 1, today.ayanamsa);

  const dateLabel = `${day.date.year}-${pad(day.date.month)}-${pad(day.date.day)}`;
  const calendarNote = dateOffset === 0 ? "UTC の暦" : `${formatOffsetLabel(dateOffset)} の暦`;
  const heading =
    resolved.source === "chart"
      ? `チャート: ${resolved.label}（${resolved.chartId}）`
      : "出生データ: 直接指定（値は返事に出しません）";

  const lines: string[] = [
    `宿曜（天文方式・${AYANAMSA_NAME} アヤナムシャ・二十七宿）`,
    heading,
    SHUKUYO_NO_READING_NOTE,
    "",
    "■ 本命宿（出生時刻の月）",
    ...formatShukuLines(natal),
    "（月は 1 日でほぼ 1 宿ぶん動きます。宿内の位置が境界に近いときは、隣の宿も併せて見てください）",
    "",
    `■ その日の宿 ${dateLabel}（${calendarNote}）`,
    `対象の瞬間: ${formatUtcMoment(day.at)}` +
      (dateOffset === 0 ? "" : ` / ローカル ${formatLocalMoment(day.at, dateOffset)}`) +
      (day.isNow ? "（現在時刻）" : day.hasTime ? "" : "（時刻の指定が無いので 0 時で見ています）"),
    ...formatShukuLines(today.position),
    `本命宿から: ${formatRelation(relation)}`,
    `アヤナムシャ ${today.ayanamsa.toFixed(4)}°（${AYANAMSA_NAME}）`,
    "",
    `□ この日の宿の切り替わり（${calendarNote}の 0 時〜24 時）`,
  ];
  if (changes.length === 0) {
    lines.push("この 24 時間のうちに宿は変わりません（月は 1 宿に 21〜27 時間ほど留まります）");
  } else {
    for (const change of changes) {
      const at = dateFromJulianDay(change.jd);
      lines.push(
        `${dateOffset === 0 ? formatUtcMoment(at) : formatLocalMoment(at, dateOffset)} ` +
          `${change.from.name} → ${formatShukuName(change.to)}`,
      );
    }
  }
  lines.push("");
  lines.push(SHUKUYO_SYSTEM_LINE);

  const describe = (position: ShukuPosition) => ({
    shuku: position.shuku,
    sidereal_lon: position.sidereal_lon,
    degrees_in: position.degrees_in,
    position: position.position,
    degrees_to_next: position.degrees_to_next,
    prev: position.prev,
    next: position.next,
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "shukuyo",
      source: resolved.source,
      ...(resolved.source === "chart"
        ? { chart_id: resolved.chartId, label: resolved.label }
        : {}),
      system: SHUKUYO_SYSTEM,
      // 出生時のアヤナムシャは載せない（生まれた年月の目盛りになるため）
      natal: describe(natal),
      day: {
        date: dateLabel,
        utc: day.at.toISOString(),
        local: formatPlainMoment(day.at, dateOffset),
        utc_offset: dateOffset,
        is_now: day.isNow,
        has_time: day.hasTime,
        ayanamsa: today.ayanamsa,
        ...describe(today.position),
        relation,
        changes: changes.map((change) => {
          const at = dateFromJulianDay(change.jd);
          return {
            utc: at.toISOString(),
            local: formatPlainMoment(at, dateOffset),
            from: change.from,
            to: change.to,
          };
        }),
      },
    },
  };
}

/** shukuyo_compat の片側（chart_id から引いたか、宿名で渡されたか） */
interface CompatParty {
  shuku: Shuku;
  source: "chart" | "name";
  chartId?: string;
  label?: string;
  /** テキストの見出しに使う札 */
  display: string;
}

/**
 * a / b の片側を宿に直す。
 *
 * **先に台帳を chart_id として引き、載っていなければ宿名として読む**（この順に意味がある
 * ―― サンスクリット名は "hasta" のように chart_id の形と見分けが付かないので、
 * 実在する登録を優先し、無ければ名前と解釈する）。
 */
async function resolveCompatParty(
  raw: string,
  key: "a" | "b",
  context: AstroContext,
  engine: () => Promise<SwissEph>,
): Promise<CompatParty | { error: ToolResult }> {
  if (isChartId(raw)) {
    const chart = await getChart(context.kv, context.auth.user, raw);
    if (chart) {
      if (!chart.birth) {
        return {
          error: toolError(
            `${key} に指定したチャート ${raw} には出生データが入っていません` +
              "（出生データを保存しない時代の登録です）。" +
              "delete_chart で消して save_chart で登録し直すか、宿名を直接指定してください。",
          ),
        };
      }
      const swe = await engine();
      const moment: MomentInput = {
        year: chart.birth.year,
        month: chart.birth.month,
        day: chart.birth.day,
        hour: chart.birth.hour,
        minute: chart.birth.minute,
        utcOffset: chart.birth.utc_offset,
      };
      return {
        shuku: shukuAtJd(swe, julianDay(swe, moment)).position.shuku,
        source: "chart",
        chartId: raw,
        label: chart.label,
        display: `チャート ${chart.label}（${raw}）`,
      };
    }
  }

  // 宿名として読む（読めなければ ShukuyoError → 呼び出し側で AstroError に着替えさせる）
  const shuku = parseShuku(raw, `${key} の宿`);
  return { shuku, source: "name", display: "宿名指定" };
}

/**
 * 宿曜の相性（三九の秘法）。
 *
 * 天体計算をするのは chart_id で呼ばれた側だけ ―― 両方が宿名なら wasm には触らない。
 */
async function runShukuyoCompat(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const rawA = requireString(args, "a", 40);
  const rawB = requireString(args, "b", 40);

  // エンジンは chart_id が来たときだけ起こす（宿名だけなら天体計算は 1 回も走らない）
  const engine = () => engineOf(context);
  const partyA = await resolveCompatParty(rawA, "a", context, engine);
  if ("error" in partyA) return partyA.error;
  const partyB = await resolveCompatParty(rawB, "b", context, engine);
  if ("error" in partyB) return partyB.error;

  const compat = compatOf(partyA.shuku.number - 1, partyB.shuku.number - 1);

  const lines = [
    "宿曜の相性（三九の秘法）",
    ...formatCompatLines(compat, partyA.display, partyB.display),
    SHUKUYO_NO_READING_NOTE,
    SHUKUYO_SYSTEM_LINE,
  ];

  const describe = (party: CompatParty) => ({
    source: party.source,
    ...(party.source === "chart" ? { chart_id: party.chartId, label: party.label } : {}),
    shuku: party.shuku,
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "shukuyo_compat",
      a: describe(partyA),
      b: describe(partyB),
      a_to_b: compat.a_to_b,
      b_to_a: compat.b_to_a,
      pair: compat.pair,
      same: compat.same,
      system: SHUKUYO_SYSTEM,
    },
  };
}

// ---------------------------------------------------------------------------
// 四柱推命（子平）
// ---------------------------------------------------------------------------

/**
 * 節入り探索の遡り幅（日）。
 *
 * 節の帯（節入りから次の節入り）は太陽が 30° 進む時間＝ 29〜32 日なので、
 * 40 日戻れば「直前の節入り」が必ず 1 本だけ窓に入る（1 年前の同じ節はもっとずっと手前）。
 */
const TERM_LOOKBACK_DAYS = 40;

/**
 * 節の帯として辻褄が合う長さ（日）。
 *
 * 実際は 29〜32 日（近日点まわりの冬が短く、遠日点まわりの夏が長い。
 * `test/four-pillars-real.test.ts` が本物の wasm で毎回確かめている）。
 * ここは「壊れた答えを弾く網」なので、実測の外側に少し余裕を持たせてある。
 */
const TERM_SPAN_MIN_DAYS = 28;
const TERM_SPAN_MAX_DAYS = 33;

/** 浮動小数の埃ぶんだけ「節入りちょうどの生まれ」を許す幅（日）＝ 0.1 秒 */
const TERM_EPSILON_DAYS = 1e-6;

/**
 * 出生の瞬間を挟む 2 本の節入りから、節の帯の中の位置（＝大運の起運のもと）を出す。
 *
 * 太陽黄経 30° ごとの境をそのまま探すので、暦の節入り表は引かない。
 * ⚠ `swe_solcross_ut` は wrapper のエラーチェックが壊れている（returns.ts の crossUt 参照）。
 *    crossUt が「開始 jd より後か」を見たうえで、ここでも**帯の形**を検算する
 *    ―― 前の節入り ≦ 出生 ＜ 次の節入り、帯の長さが節らしいか、の 2 つ。
 */
function solarTermSpanAt(swe: SwissEph, birthJd: number, sunLon: number): SolarTermSpan {
  const order = monthBranchOrder(sunLon);
  const previousTerm = SOLAR_TERMS[order] as (typeof SOLAR_TERMS)[number];
  const nextTerm = SOLAR_TERMS[(order + 1) % 12] as (typeof SOLAR_TERMS)[number];

  const nextJd = crossUt(swe, "sun", nextTerm.longitude, birthJd);
  const previousJd = crossUt(swe, "sun", previousTerm.longitude, birthJd - TERM_LOOKBACK_DAYS);

  const span = nextJd - previousJd;
  if (
    previousJd > birthJd + TERM_EPSILON_DAYS ||
    nextJd <= birthJd ||
    span < TERM_SPAN_MIN_DAYS ||
    span > TERM_SPAN_MAX_DAYS
  ) {
    // 断り文に jd を出さない（出生の瞬間そのものなので）
    throw new AstroError(
      "節入り（月柱の境）を計算できませんでした" +
        "（天体計算が節の帯として辻褄の合う答えを返しませんでした）。" +
        "しばらく置いてからもう一度呼んでください。",
    );
  }

  const raw = solarTermSpanFromJd(birthJd, previousJd, nextJd);
  // 節入りちょうどの生まれで −1e-12 のような値になるのを均す（純関数は 0 以上しか受けない）
  return {
    days_since_previous: Math.max(0, raw.days_since_previous),
    days_until_next: raw.days_until_next,
  };
}

const FOUR_PILLARS_NO_READING_NOTE =
  "（通変星・十二運・蔵干・空亡・大運の意味はこのサーバーに載っていません。読みはあなた自身の知識で。" +
  "ホロスコープ・宿曜・四柱は別々の体系で、合算する根拠はありません）";

/**
 * 四柱推命（命式と、指定日の流年・月運・日運）。
 *
 * 算法は純関数（src/four-pillars.ts と src/nakko.ts）で、ここがやるのは 3 つだけ ――
 * 出生の瞬間の出どころを決める / wasm で太陽黄経と前後の節入りを出す / 見る日を決める。
 * エンジンを叩くのは `swe_calc_ut` 2 回（出生と対象日の太陽）と `swe_solcross_ut` 2 回だけ。
 *
 * 出生データは返事に出さない ―― 出すのは派生値（干支・蔵干・十二運・空亡・大運）だけ。
 * jd も出生の瞬間そのものなので、テキストにも structuredContent にも混ぜない。
 */
async function runFourPillars(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const resolved = await resolveBirthMoment(args, context, FOUR_PILLARS_BIRTH_OPTIONS);
  if ("error" in resolved) return resolved.error;

  const dateOffset = optionalNumber(args, "date_utc_offset", -14, 14) ?? 0;
  const rawDate = optionalString(args, "date", 24);
  const now = context.now ? context.now() : new Date();
  const day = rawDate === undefined
    ? fortuneDayFromNow(now, dateOffset)
    : parseFortuneDate(rawDate, dateOffset);

  const swe = await engineOf(context);

  // MomentInput と NakkoMoment は同じ形（現地の時計の読み＋時差）
  const birthMoment: NakkoMoment = resolved.moment;
  const birthJd = julianDay(swe, birthMoment);
  const birthSunLon = sunLongitude(swe, birthMoment);
  const term = solarTermSpanAt(swe, birthJd, birthSunLon);

  let natal: FourPillarsResult;
  try {
    natal = calculateFourPillars({ moment: birthMoment, sun_longitude: birthSunLon, term });
  } catch (error) {
    // 純関数の言い分には出生データの値が混じり得るので、そのままは返さない
    if (error instanceof FourPillarsError) {
      throw new AstroError(
        "その出生データからは命式を立てられませんでした" +
          "（四柱推命は西暦 1〜9999 年の生年月日で立てます。値は返事に出しません）。",
      );
    }
    throw error;
  }

  // 対象日は「その土地の時計の読み」で見る（日運の日界 0 時も時運の 2 時間区切りもここで決まる）
  const targetMoment = momentFromDate(day.at, dateOffset);
  const targetSunLon = sunLongitude(swe, targetMoment);

  let fortune: DateFortuneResult;
  try {
    fortune = calculateDateFortune(natal, {
      moment: targetMoment,
      sun_longitude: targetSunLon,
      include_hour: day.hasTime,
    });
  } catch (error) {
    // こちらの言い分に出るのは**呼び出した側が打った日付**なので、そのまま返してよい
    if (error instanceof FourPillarsError) throw new AstroError(error.message);
    throw error;
  }

  const dateLabel = `${day.date.year}-${pad(day.date.month)}-${pad(day.date.day)}`;
  const calendarNote = dateOffset === 0 ? "UTC の暦" : `${formatOffsetLabel(dateOffset)} の暦`;
  const heading =
    resolved.source === "chart"
      ? `チャート: ${resolved.label}（${resolved.chartId}）`
      : "出生データ: 直接指定（値は返事に出しません）";

  const lines: string[] = [
    "四柱推命（子平・日界 0 時・節気は太陽黄経・時刻の補正なし）",
    heading,
    FOUR_PILLARS_NO_READING_NOTE,
    "",
    formatFourPillarsText(natal),
    "",
    `■ 対象日 ${dateLabel}（${calendarNote}）`,
    `対象の瞬間: ${formatUtcMoment(day.at)}` +
      (dateOffset === 0 ? "" : ` / ローカル ${formatLocalMoment(day.at, dateOffset)}`) +
      (day.isNow
        ? "（現在時刻）"
        : day.hasTime
          ? ""
          : "（時刻の指定が無いので 0 時で見ています＝時運は出しません）"),
    formatDateFortuneText(fortune),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "four_pillars",
      source: resolved.source,
      ...(resolved.source === "chart"
        ? { chart_id: resolved.chartId, label: resolved.label }
        : {}),
      natal,
      target: {
        date: dateLabel,
        utc: day.at.toISOString(),
        local: formatPlainMoment(day.at, dateOffset),
        utc_offset: dateOffset,
        is_now: day.isNow,
        has_time: day.hasTime,
      },
      date_fortune: fortune,
    },
  };
}

// ---------------------------------------------------------------------------
// 九星気学
// ---------------------------------------------------------------------------

/**
 * 至の探索の遡り幅（日）。
 *
 * 冬至も夏至も 1 年に 1 回なので、400 日戻れば必ず 1 本ずつ手前に入る
 * （回帰年 365.24 日 ＋ 余裕）。
 */
const SOLSTICE_LOOKBACK_DAYS = 400;

/** 2 本目の至を探し始める幅（日）。1 本目の 300 日後から探せば、次の同じ至だけが窓に入る */
const SOLSTICE_STEP_DAYS = 300;

/** 同じ至どうしの間隔として辻褄が合う長さ（日）＝回帰年 365.2422 の前後 */
const SOLSTICE_GAP_MIN_DAYS = 364;
const SOLSTICE_GAP_MAX_DAYS = 367;

/** 至の瞬間（UT のユリウス日）を**その土地の暦日**へ丸める（日界 0 時＝暦は現地の時計で読む） */
function solsticeDayOf(kind: SolsticeDay["kind"], jd: number, utcOffset: number): SolsticeDay {
  const local = dateFromJulianDay(jd + utcOffset / 24);
  return {
    kind,
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

/**
 * 対象日の前後を挟む冬至・夏至を 4 つ（冬 2・夏 2）。
 *
 * 九星の日盤は「至に最も近い甲子日」で陽遁・陰遁が切り替わるので、
 * 純関数（kyusei.ts の `dayStar`）に渡す至の一覧をここで作る。
 * 探索は 400 日戻ってから 1 本目、その 300 日後から 2 本目 ―― 冬・夏それぞれ 2 本ずつで、
 * **対象日より前に 2 本以上・後に 1 本以上**が必ず入る並びになる
 * （1 本目は対象日の 400〜35 日前、2 本目はその 365 日後なので対象日の 147 日後より先）。
 *
 * ⚠ `swe_solcross_ut` は wrapper のエラーチェックが壊れている（returns.ts の crossUt 参照）ので、
 *    crossUt が「開始 jd より後か」を見たうえで、ここでも**同じ至どうしの間隔**を検算する。
 *    断り文に jd を出さない（出生の瞬間そのものになり得るため）。
 */
function solsticesAround(swe: SwissEph, jd: number, utcOffset: number): SolsticeDay[] {
  const kinds: readonly (readonly [SolsticeDay["kind"], number])[] = [
    ["winter", 270],
    ["summer", 90],
  ];
  const found: SolsticeDay[] = [];

  for (const [kind, longitude] of kinds) {
    const first = crossUt(swe, "sun", longitude, jd - SOLSTICE_LOOKBACK_DAYS);
    const second = crossUt(swe, "sun", longitude, first + SOLSTICE_STEP_DAYS);
    const gap = second - first;
    if (gap < SOLSTICE_GAP_MIN_DAYS || gap > SOLSTICE_GAP_MAX_DAYS) {
      throw new AstroError(
        "冬至・夏至を計算できませんでした" +
          "（天体計算が 1 年の間隔として辻褄の合う答えを返しませんでした）。" +
          "しばらく置いてからもう一度呼んでください。",
      );
    }
    found.push(solsticeDayOf(kind, first, utcOffset), solsticeDayOf(kind, second, utcOffset));
  }

  // 純関数は「古い順・冬と夏が交互」でしか受け取らない
  return found.sort(
    (left, right) =>
      julianDayNumber(left.year, left.month, left.day) -
      julianDayNumber(right.year, right.month, right.day),
  );
}

/** 本命星・月命星（立春で切った年の星と、節で切った月の星） */
interface NatalStars {
  honmei: number;
  getsumei: number;
}

/**
 * その瞬間の本命星・月命星。
 *
 * 年界も月界も太陽黄経で切る（暦の節入り表は引かない）＝ 四柱推命の年柱・月柱と同じ物差し。
 * 時刻を差し替えて呼べるようにしてあるのは、**立春・節入りの当日の生まれ**で
 * 「0 時と 23:59 で星が変わるか」を確かめるため。
 */
function natalStarsAt(swe: SwissEph, moment: NakkoMoment): NatalStars {
  const lon = sunLongitude(swe, moment);
  const solarYear = isBeforeRisshun(lon, moment.month) ? moment.year - 1 : moment.year;
  const honmei = yearStar(solarYear);
  return { honmei, getsumei: monthStar(honmei, monthBranchOrder(lon)) };
}

/** 時刻が分からないときの両候補（その暦日の 0 時と 23:59） */
interface KyuseiAlternatives {
  note: string;
  start: { local_time: string; honmei: Star; getsumei: Star };
  end: { local_time: string; honmei: Star; getsumei: Star };
}

/** 出生側の返り値（日命星は star と dun だけ＝下のコメント参照） */
interface KyuseiBirthView {
  honmei: Star;
  getsumei: Star;
  nichimei: { star: Star; dun: Dun };
  alternatives?: KyuseiAlternatives;
}

/**
 * 出生側の三星（本命星・月命星・日命星）。
 *
 * ⚠ 日命星は **star と dun だけ**を返し、切り替えの甲子日（`switch`）と経過日数
 *    （`days_since_switch`）は落とす ―― この 2 つが揃うと**出生日そのものが復元できる**ため
 *    （純関数は全部返してくるので、落とすのはこの配線の仕事。kyusei.ts の冒頭コメント参照）。
 *    星（9 通り）と遁（2 通り）だけなら日付には戻らない。
 */
function computeKyuseiBirth(
  swe: SwissEph,
  moment: NakkoMoment,
  timeKnown: boolean,
): KyuseiBirthView {
  const stars = natalStarsAt(swe, moment);
  const nichimei = dayStar(
    { year: moment.year, month: moment.month, day: moment.day },
    solsticesAround(swe, julianDay(swe, moment), moment.utcOffset),
  );
  const view: KyuseiBirthView = {
    honmei: starOf(stars.honmei),
    getsumei: starOf(stars.getsumei),
    nichimei: { star: starOf(nichimei.star), dun: nichimei.dun },
  };
  if (timeKnown) return view;

  // 時刻不明のときだけ、その暦日の端と端で星が動くかを見る（動くのは立春・節入りの当日だけ）
  const start = natalStarsAt(swe, { ...moment, hour: 0, minute: 0 });
  const end = natalStarsAt(swe, { ...moment, hour: 23, minute: 59 });
  if (start.honmei === end.honmei && start.getsumei === end.getsumei) return view;

  view.alternatives = {
    note:
      "立春／節入りの当日の生まれで出生時刻が分からないため、時刻によって星が変わります" +
      "（hour / minute を付けると確定します）",
    start: { local_time: "00:00", honmei: starOf(start.honmei), getsumei: starOf(start.getsumei) },
    end: { local_time: "23:59", honmei: starOf(end.honmei), getsumei: starOf(end.getsumei) },
  };
  return view;
}

/** 盤 1 枚ぶんの返り値（中宮・その盤の干支・9 升・立った殺） */
interface KyuseiBoardView {
  center: Star;
  ganzhi: string;
  branch: string;
  cells: BoardCell[];
  satsu: Satsu[];
}

/** 盤を 1 枚組み立てる（殺は破の名前が要るので kind と支を一緒に渡す） */
function buildKyuseiBoard(
  kind: BoardKind,
  centerStar: number,
  pillar: Pillar,
  stars: NatalStars,
): KyuseiBoardView {
  const target = board(centerStar);
  return {
    center: target.center,
    ganzhi: pillar.ganzhi,
    branch: pillar.branch,
    cells: target.cells,
    satsu: satsu(target, {
      kind,
      branch: pillar.branch,
      honmei: stars.honmei,
      getsumei: stars.getsumei,
    }),
  };
}

/**
 * 殺の行。
 *
 * `formatSatsuText` は殺が 1 つも立たないときだけ「殺: なし」と見出しごと返すので、
 * そこで見出しを二重にしないための薄皮（破は必ず立つので、実際にはまず通らない道）。
 */
function formatKyuseiSatsuLine(list: readonly Satsu[]): string {
  const text = formatSatsuText(list);
  return text.startsWith("殺") ? text : `殺: ${text}`;
}

/** 盤 1 枚ぶんのテキスト（3×3 の升目＋殺の行） */
function kyuseiBoardText(title: string, view: KyuseiBoardView): string {
  return [
    formatBoardText({ center: view.center, cells: view.cells }, title),
    formatKyuseiSatsuLine(view.satsu),
  ].join("\n");
}

const KYUSEI_NO_READING_NOTE =
  "（九星・殺・方位の意味も吉方位もこのサーバーに載っていません。読みはあなた自身の知識で。" +
  "ホロスコープ・宿曜・四柱・九星はそれぞれ別の体系で、合算する根拠はありません）";

/** 規約の 1 行（テキストの末尾に置く。structuredContent には KYUSEI_CONVENTIONS が丸ごと入る） */
const KYUSEI_SYSTEM_LINE =
  "規約: 年界＝立春／月界＝節（太陽黄経）／日界＝0 時／" +
  "陽遁・陰遁＝冬至・夏至に最も近い甲子（同距離なら後）／閏遁なし／" +
  "破は八方位に丸め／時盤なし" +
  "（日盤の切り替えは流派で割れます。暦によっては日の星が違う日があります）";

/**
 * 九星気学（本命星・月命星・日命星と、指定日の年盤・月盤・日盤）。
 *
 * 算法は純関数（src/kyusei.ts）で、ここがやるのは 4 つだけ ――
 * 出生の瞬間の出どころを決める / wasm で太陽黄経と前後の至を出す / 見る日を決める /
 * **出生側から `switch`・`days_since_switch` を落とす**。
 * エンジンを叩くのは `swe_calc_ut` 2〜4 回（出生と対象日の太陽、時刻不明ならその日の端 2 つ）と
 * `swe_solcross_ut` 8 回（出生側と対象日側で冬至・夏至を 2 本ずつ）。
 *
 * 出生データは返事に出さない ―― 出すのは派生値（星・遁・盤・殺）だけ。
 */
async function runKyusei(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const resolved = await resolveBirthMoment(args, context, KYUSEI_BIRTH_OPTIONS);
  if ("error" in resolved) return resolved.error;

  const dateOffset = optionalNumber(args, "date_utc_offset", -14, 14) ?? 0;
  const rawDate = optionalString(args, "date", 24);
  const now = context.now ? context.now() : new Date();
  const day = rawDate === undefined
    ? fortuneDayFromNow(now, dateOffset)
    : parseFortuneDate(rawDate, dateOffset);

  const swe = await engineOf(context);

  // MomentInput と NakkoMoment は同じ形（現地の時計の読み＋時差）
  const birthMoment: NakkoMoment = resolved.moment;
  let birth: KyuseiBirthView;
  try {
    birth = computeKyuseiBirth(swe, birthMoment, resolved.timeKnown);
  } catch (error) {
    // 純関数の言い分には出生データの値が混じり得るので、そのままは返さない
    if (error instanceof KyuseiError) {
      throw new AstroError(
        "その出生データからは九星を出せませんでした" +
          "（九星気学は西暦 1〜9999 年の生年月日で見ます。値は返事に出しません）。",
      );
    }
    throw error;
  }
  const natalStars: NatalStars = { honmei: birth.honmei.number, getsumei: birth.getsumei.number };

  // 対象日は「その土地の時計の読み」で見る（日盤の日界 0 時も、至を丸める暦もここで決まる）
  const targetMoment = momentFromDate(day.at, dateOffset);
  const targetJd = julianDay(swe, momentFromUtcDate(day.at));
  const targetSunLon = sunLongitude(swe, targetMoment);
  const pillars = fourPillars(targetMoment, targetSunLon);

  let yearBoard: KyuseiBoardView;
  let monthBoard: KyuseiBoardView;
  let dayBoard: KyuseiBoardView;
  let dayView: DayStarView;
  try {
    const solarYear = isBeforeRisshun(targetSunLon, targetMoment.month)
      ? targetMoment.year - 1
      : targetMoment.year;
    const yearCenter = yearStar(solarYear);
    const monthCenter = monthStar(yearCenter, monthBranchOrder(targetSunLon));
    dayView = dayStar(day.date, solsticesAround(swe, targetJd, dateOffset));
    yearBoard = buildKyuseiBoard("year", yearCenter, pillars.year, natalStars);
    monthBoard = buildKyuseiBoard("month", monthCenter, pillars.month, natalStars);
    dayBoard = buildKyuseiBoard("day", dayView.star, pillars.day, natalStars);
  } catch (error) {
    // こちらの言い分に出るのは**呼び出した側が打った日付**なので、そのまま返してよい
    if (error instanceof KyuseiError) throw new AstroError(error.message);
    throw error;
  }

  const dateLabel = `${day.date.year}-${pad(day.date.month)}-${pad(day.date.day)}`;
  const calendarNote = dateOffset === 0 ? "UTC の暦" : `${formatOffsetLabel(dateOffset)} の暦`;
  const heading =
    resolved.source === "chart"
      ? `チャート: ${resolved.label}（${resolved.chartId}）`
      : "出生データ: 直接指定（値は返事に出しません）";
  const switchLabel =
    `${dayView.switch.kind === "winter" ? "冬至" : "夏至"}に最も近い甲子 ` +
    `${dayView.switch.year}-${pad(dayView.switch.month)}-${pad(dayView.switch.day)} から ` +
    `${dayView.days_since_switch} 日（切り替え当日が 0）`;

  const lines: string[] = [
    "九星気学（年界 立春・月界 節・日界 0 時・陽遁陰遁は至に最も近い甲子）",
    heading,
    KYUSEI_NO_READING_NOTE,
    "",
    "■ 本命星・月命星・日命星",
    `本命星: ${birth.honmei.name} / 月命星: ${birth.getsumei.name} / ` +
      `日命星: ${birth.nichimei.star.name}（${birth.nichimei.dun}）`,
  ];
  const alternatives = birth.alternatives;
  if (alternatives) {
    const candidates: string[] = [];
    if (alternatives.start.honmei.number !== alternatives.end.honmei.number) {
      candidates.push(`本命星は ${alternatives.start.honmei.name} か ${alternatives.end.honmei.name}`);
    }
    if (alternatives.start.getsumei.number !== alternatives.end.getsumei.number) {
      candidates.push(
        `月命星は ${alternatives.start.getsumei.name} か ${alternatives.end.getsumei.name}`,
      );
    }
    lines.push(
      `※ 立春／節入りの当日の生まれで出生時刻が無いため、${candidates.join("、")} のどちらか。` +
        "hour / minute を付けると確定します",
    );
  }

  lines.push(
    "",
    `■ 対象日 ${dateLabel}（${calendarNote}）`,
    `対象の瞬間: ${formatUtcMoment(day.at)}` +
      (dateOffset === 0 ? "" : ` / ローカル ${formatLocalMoment(day.at, dateOffset)}`) +
      (day.isNow
        ? "（現在時刻）"
        : day.hasTime
          ? ""
          : "（時刻の指定が無いので 0 時で見ています）"),
    "",
    kyuseiBoardText(`年盤 ${yearBoard.ganzhi}年`, yearBoard),
    "",
    kyuseiBoardText(`月盤 ${monthBoard.ganzhi}月`, monthBoard),
    "",
    kyuseiBoardText(`日盤 ${dayBoard.ganzhi}日`, dayBoard),
    `遁: ${dayView.dun}（${switchLabel}）`,
    "",
    KYUSEI_SYSTEM_LINE,
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "kyusei",
      source: resolved.source,
      ...(resolved.source === "chart"
        ? { chart_id: resolved.chartId, label: resolved.label }
        : {}),
      birth,
      date: {
        date: dateLabel,
        utc: day.at.toISOString(),
        local: formatPlainMoment(day.at, dateOffset),
        utc_offset: dateOffset,
        is_now: day.isNow,
        has_time: day.hasTime,
        year: yearBoard,
        month: monthBoard,
        day: {
          ...dayBoard,
          dun: dayView.dun,
          switch: dayView.switch,
          days_since_switch: dayView.days_since_switch,
        },
      },
      conventions: KYUSEI_CONVENTIONS,
    },
  };
}

// ---------------------------------------------------------------------------
// 年間概要（ソーラーリターン年）
// ---------------------------------------------------------------------------

/**
 * ソーラーリターン年 1 年ぶんの天体イベント一覧。
 *
 * 走査そのものは yearly.ts の純関数（疎サンプル＋補間で Workers の CPU 予算に収めてある）。
 * ここがやるのは「どの 1 年か」を決めることと、jd を**表示時差の暦**の日付に直すことだけ。
 */
async function runYearlyOverview(
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
        "save_chart で登録してください。",
    );
  }

  const sun = chart.planets.find((planet) => planet.id === 0);
  if (!sun) {
    return toolError(
      `このチャートには${planetName(0)}の位置が入っていません。save_chart で登録し直してください。`,
    );
  }

  const year = optionalInteger(args, "year", -5000, 5000);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14);
  const displayOffset = utcOffset ?? 0;

  const swe = await engineOf(context);
  const now = context.now ? context.now() : new Date();
  const nowJd = julianDay(swe, momentFromUtcDate(now));

  // year あり＝その年の 1 月 1 日から最初のリターン（solar_return と同じ起点）。
  // year 省略＝1 年前から探せば「現在を含むリターン年」の頭が取れる
  // （リターンの間隔は 365.24〜365.26 日なので、366 日前から数えた 1 回目は必ず現在以前に落ちる）
  const srJd =
    year === undefined
      ? crossUt(swe, "sun", sun.lon, nowJd - 366)
      : crossUt(swe, "sun", sun.lon, monthStartJd(swe, year, 1, displayOffset));
  const nextJd = crossUt(swe, "sun", sun.lon, srJd + 1);

  const scan = scanYearlyRange(swe, {
    startJd: srJd,
    endJd: nextJd,
    natalPlanets: chart.planets,
    cusps: chart.cusps,
    angles: anglesOf(chart),
  });

  /** jd → 表示時差の暦での Date（時刻は捨てて日付だけ使う） */
  const localDate = (jd: number): Date =>
    new Date(dateFromJulianDay(jd).getTime() + displayOffset * 3_600_000);
  const dateOf = (jd: number): string => {
    const shifted = localDate(jd);
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  };

  const startDate = dateFromJulianDay(srJd);
  const endDate = dateFromJulianDay(nextJd);
  const momentText = (date: Date): string => {
    const parts = [formatUtcMoment(date)];
    if (utcOffset !== undefined) parts.push(`ローカル ${formatLocalMoment(date, utcOffset)}`);
    return parts.join(" / ");
  };
  const calendarNote = utcOffset === undefined ? "UTC の暦" : `${formatOffsetLabel(utcOffset)} の暦`;
  const isCurrent = year === undefined;

  const lines: string[] = [
    "年間概要（ソーラーリターン年）",
    `チャート: ${chart.label}（${chartId}） / ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}）`,
    `ネイタルの${planetName(0)}: ${formatDegree(sun.lon)}`,
    `期間: ${momentText(startDate)} 〜 ${momentText(endDate)}（${scan.days} 日）`,
    `対象: ${
      isCurrent
        ? `現在（${formatUtcMoment(now)}）を含むソーラーリターン年`
        : `${year}年のソーラーリターンから 1 年`
    }`,
    `日付は ${calendarNote} で 1 日刻み。start は入った最初の日、end は外れた最初の日（Web 版の年間概要と同じ数え方）`,
    "対象天体: 逆行＝水星〜冥王星 / イングレス・トランジット＝木星〜冥王星 → " +
      `ネイタル 10 天体（ノード除く）と ASC / MC（メジャー5種・オーブ ${DEFAULT_ORB.toFixed(1)}°）`,
    "（t.＝トランジット / n.＝ネイタル）",
    "",
    ...formatYearlyText(scan, dateOf),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "yearly_overview",
      chart_id: chartId,
      label: chart.label,
      house_system: chart.house_system,
      period: {
        solar_return_year: localDate(srJd).getUTCFullYear(),
        start_utc: startDate.toISOString(),
        end_utc: endDate.toISOString(),
        start_jd: srJd,
        end_jd: nextJd,
        start_date: dateOf(srJd),
        end_date: dateOf(nextJd),
        days: scan.days,
        is_current: isCurrent,
      },
      utc_offset: displayOffset,
      orb: DEFAULT_ORB,
      resolution: "day",
      date_note:
        "start は条件を満たした最初の日、end は外れた最初の日（Web 版の年間概要と同じ数え方）",
      retrogrades: scan.retrogrades.map((period) => ({
        planet: period.planet,
        id: period.id,
        start: dateOf(period.startJd),
        end: dateOf(period.endJd),
        ...(period.clipped ? { clipped: period.clipped } : {}),
      })),
      ingresses: scan.ingresses.map((ingress) => ({
        planet: ingress.planet,
        id: ingress.id,
        date: dateOf(ingress.jd),
        sign: ingress.sign,
        sign_index: ingress.signIndex,
        retrograde: ingress.retrograde,
      })),
      angle_aspects: scan.angleAspects.map((window) => ({
        transit: window.transit,
        transit_id: window.transitId,
        angle: window.angle,
        aspect: window.aspect,
        start: dateOf(window.startJd),
        end: dateOf(window.endJd),
        exact: dateOf(window.exactJd),
        min_orb: window.minOrb,
        ...(window.clipped ? { clipped: window.clipped } : {}),
      })),
      natal_aspects: scan.natalAspects.map((window) => ({
        transit: window.transit,
        transit_id: window.transitId,
        natal: window.natal,
        natal_id: window.natalId,
        house: window.house,
        aspect: window.aspect,
        start: dateOf(window.startJd),
        end: dateOf(window.endJd),
        exact: dateOf(window.exactJd),
        min_orb: window.minOrb,
        ...(window.clipped ? { clipped: window.clipped } : {}),
      })),
      diagnostics: { ephemeris_calls: scan.ephemerisCalls },
    },
  };
}

// ---------------------------------------------------------------------------
// 期間内のトランジットイベント（時刻つき）
// ---------------------------------------------------------------------------

/**
 * 数日〜1 か月ぶんのトランジットを**分単位の時刻つき**で並べる。
 *
 * 走査そのものは events.ts の純関数（疎サンプル＋3 次エルミート補間＋10 分刻み＋二分法）。
 * ここがやるのは「どの期間か」を決めることと、jd を**表示時差の時計**に直すことだけ。
 * 年間概要（1 日刻み）の隣に置く道具で、一点を見る顕微鏡は transit のまま。
 */
async function runTransitEvents(rawArguments: unknown, context: AstroContext): Promise<ToolResult> {
  const args = argsOf(rawArguments);
  const chartId = requireString(args, "chart_id", 32);

  const chart = await getChart(context.kv, context.auth.user, chartId);
  if (!chart) {
    return toolError(
      `チャート ${chartId} が見つかりませんでした。list_charts で登録済みの ID を確かめるか、` +
        "save_chart で登録してください。",
    );
  }

  const start = optionalString(args, "start", 12);
  const days = optionalInteger(args, "days", 1, MAX_DAYS.outer) ?? 7;
  const bodies = requireBodySet(args);
  const utcOffset = optionalNumber(args, "utc_offset", -14, 14) ?? 0;
  // 期間の上限は**天体計算より先に**弾く（走査側でも見ているが、ここで止めれば wasm にも触らない）
  assertDaysInRange(days, bodies);

  const swe = await engineOf(context);
  const startMoment =
    start === undefined
      ? momentFromUtcDate(startOfLocalDay(context.now ? context.now() : new Date(), utcOffset))
      : { ...parseStartDate(start), hour: 0, minute: 0, utcOffset };
  const startJd = julianDay(swe, startMoment);

  const scan = scanTransitEvents(swe, {
    startJd,
    days,
    bodies,
    natalPlanets: chart.planets,
    cusps: chart.cusps,
    angles: anglesOf(chart),
  });

  /** jd → 表示時差の時計で「MM-DD HH:mm」（年は見出しに出してあるので行では省く） */
  const when = (jd: number): string => {
    const shifted = new Date(dateFromJulianDay(jd).getTime() + utcOffset * 3_600_000);
    return (
      `${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
      `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
    );
  };
  const isoOf = (jd: number): string => dateFromJulianDay(jd).toISOString();

  const startDate = dateFromJulianDay(scan.startJd);
  const endDate = dateFromJulianDay(scan.endJd);
  const exacts = scan.windows.reduce((total, window) => total + window.exact.length, 0);

  const lines: string[] = [
    "トランジットイベント（時刻つき）",
    `チャート: ${chart.label}（${chartId}） / ハウス方式: ${houseSystemName(chart.house_system)}（${chart.house_system}）`,
    `期間: ${formatLocalMoment(startDate, utcOffset)} 〜 ${formatLocalMoment(endDate, utcOffset)}` +
      `（${days} 日、UTC では ${formatPlainMoment(startDate, 0)} 〜 ${formatPlainMoment(endDate, 0)}）`,
    `動く側: ${BODY_SET_LABEL[bodies]}、相手: ネイタル 10 天体（ノード除く）と ASC / MC、` +
      `メジャー5種・オーブ ${DEFAULT_ORB.toFixed(1)}°`,
    `時刻は ${formatOffsetLabel(utcOffset)}、分単位（細かさ ${TICK_MINUTES} 分刻み＋二分法）`,
    "",
    ...formatEventsText(scan, when),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "transit_events",
      chart_id: chartId,
      label: chart.label,
      house_system: chart.house_system,
      period: {
        start_utc: startDate.toISOString(),
        end_utc: endDate.toISOString(),
        start_local: formatPlainMoment(startDate, utcOffset),
        end_local: formatPlainMoment(endDate, utcOffset),
        days,
      },
      utc_offset: utcOffset,
      bodies,
      orb: DEFAULT_ORB,
      tick_minutes: TICK_MINUTES,
      windows: scan.windows.map((window) => ({
        transit: window.transit,
        transit_id: window.transitId,
        target: {
          kind: window.target.kind,
          name: window.target.name,
          id: window.target.id,
          house: window.target.house,
        },
        aspect: window.aspect,
        entering: window.entering === null ? null : isoOf(window.entering),
        exact: window.exact.map(isoOf),
        leaving: window.leaving === null ? null : isoOf(window.leaving),
        min_orb: window.minOrb,
        min_orb_at: isoOf(window.minOrbAt),
        applying_at_start: window.applyingAtStart,
        ...(window.clipped ? { clipped: window.clipped } : {}),
      })),
      stations: scan.stations.map((station) => ({
        transit: station.name,
        id: station.id,
        at: isoOf(station.jd),
        to: station.to,
        lon: station.lon,
        position: formatDegree(station.lon),
      })),
      ingresses: scan.ingresses.map((ingress) => ({
        transit: ingress.name,
        id: ingress.id,
        at: isoOf(ingress.jd),
        sign: ingress.sign,
        sign_index: ingress.signIndex,
        retrograde: ingress.retrograde,
      })),
      counts: {
        windows: scan.windows.length,
        exacts,
        stations: scan.stations.length,
        ingresses: scan.ingresses.length,
      },
      diagnostics: { ephemeris_calls: scan.ephemerisCalls },
    },
  };
}

/** 占星術層のツールごとの許可キー（ツール定義から自動で導く） */
const ASTRO_ARGUMENT_KEYS = allowedArgumentKeys(ASTRO_TOOLS);

/** 綴り違い・余分なキーは黙って無視せず断る（知らないツール名は素通し＝下で名前を弾く） */
function assertKnownAstroArguments(name: unknown, rawArguments: unknown): void {
  if (typeof name !== "string") return;
  const allowed = ASTRO_ARGUMENT_KEYS.get(name);
  if (allowed === undefined) return;
  const message = unknownArgumentMessage(allowed, rawArguments);
  if (message !== null) throw new AstroError(message);
}

async function callAstroTool(
  name: unknown,
  rawArguments: unknown,
  context: AstroContext,
): Promise<ToolResult> {
  try {
    assertKnownAstroArguments(name, rawArguments);
    if (name === "save_chart") return await runSaveChart(rawArguments, context);
    if (name === "list_charts") return await runListCharts(context);
    if (name === "get_chart") return await runGetChart(rawArguments, context);
    if (name === "delete_chart") return await runDeleteChart(rawArguments, context);
    if (name === "update_default_location") {
      return await runUpdateDefaultLocation(rawArguments, context);
    }
    if (name === "transit") return await runTransit(rawArguments, context);
    if (name === "synastry") return await runSynastry(rawArguments, context);
    if (name === "lunar_return") return await runReturn("moon", rawArguments, context);
    if (name === "solar_return") return await runReturn("sun", rawArguments, context);
    if (name === "progressions") return await runProgressions(rawArguments, context);
    if (name === "yearly_overview") return await runYearlyOverview(rawArguments, context);
    if (name === "transit_events") return await runTransitEvents(rawArguments, context);
    if (name === "calculate_numerology") {
      return await runCalculateNumerology(rawArguments, context);
    }
    if (name === "shukuyo") return await runShukuyo(rawArguments, context);
    if (name === "shukuyo_compat") return await runShukuyoCompat(rawArguments, context);
    if (name === "four_pillars") return await runFourPillars(rawArguments, context);
    if (name === "kyusei") return await runKyusei(rawArguments, context);
    return toolError(`知らないツールです: ${String(name)}`);
  } catch (error) {
    if (error instanceof AstroError) return toolError(error.message);
    // 宿曜の純関数の言い分（宿名が読めない・表が壊れている）も、そのまま利用者へ返してよい
    // ―― 出生データは含まれず、書いてあるのは「渡された名前」だけなので
    if (error instanceof ShukuyoError) return toolError(error.message);
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC ディスパッチ
// ---------------------------------------------------------------------------

/** POST /astro/mcp（OAuth の門の内側）の本体。身元の確認は呼び出し側＝ src/auth/oauth.ts で済ませてある */
export async function handleAstroMcpRequest(
  request: Request,
  context: AstroContext,
): Promise<Response> {
  const parsed = await readJsonRpcRequest(request);
  if (!parsed.ok) return parsed.response;
  const { id, method, params } = parsed.value;

  switch (method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: ASTRO_INSTRUCTIONS,
      });

    case "ping":
      return jsonRpcResult(id, {});

    case "tools/list":
      return jsonRpcResult(id, { tools: ASTRO_TOOLS });

    case "tools/call": {
      const callParams = (params ?? {}) as { name?: unknown; arguments?: unknown };
      return jsonRpcResult(id, await callAstroTool(callParams.name, callParams.arguments, context));
    }

    default:
      return jsonRpcError(id, -32601, `知らないメソッドです: ${method}`);
  }
}
