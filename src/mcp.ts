/**
 * MCP（Model Context Protocol）ハンドラ。
 *
 * ステートレスな Streamable HTTP：POST /mcp に JSON-RPC 2.0 の単発リクエストが来て、
 * その場で application/json を返す。セッションを持たないので Mcp-Session-Id は発行せず、
 * SSE ストリームも開かない。秘密も認証も無い（誰が呼んでも同じ答えが返る）。
 */
import packageJson from "../package.json";
import { DECKS, DECK_IDS } from "./decks";
import { SPREADS, SPREAD_IDS } from "./spreads";
import { DrawError, drawCards, formatDrawResult, type DrawOptions } from "./draw";
import {
  CAST_METHOD_IDS,
  CastError,
  castHexagram,
  formatCastResult,
  type CastOptions,
} from "./iching";
import {
  DiceError,
  MAX_DICE_COUNT,
  formatAstroDiceText,
  rollAstroDice,
} from "./astro-dice";
import { castGeomancy, formatShieldChartText } from "./geomancy";
import {
  MOON_CALENDAR_DEFAULT_DAYS,
  MOON_CALENDAR_DEFAULT_UTC_OFFSET,
  MOON_CALENDAR_MAX_DAYS,
  MOON_CALENDAR_MIN_DAYS,
  VOC_BODY_SETS,
  moonCalendar,
  parseMoonCalendarArguments,
} from "./moon-calendar";
import {
  MAX_CANDIDATES,
  REVERSE_BODY_KEYS,
  REVERSE_DEFAULT_UTC_OFFSET,
  REVERSE_MAX_SPAN_YEARS,
  REVERSE_MAX_YEAR,
  REVERSE_MIN_YEAR,
  REVERSE_PRIORITIES,
  REVERSE_SIGN_NAMES,
  parseReverseHoroscopeArguments,
  reverseHoroscope,
} from "./reverse-horoscope";
import { PRINCIPLE_NO_SUMMING, READ_WITH_YOUR_OWN_KNOWLEDGE } from "./phrases";
import {
  DEFAULT_UTC_OFFSET,
  assertCalendarDay,
  buildNakko,
  formatNakkoText,
  momentFromDate,
  sunLongitude,
  type NakkoMoment,
} from "./nakko";
import { AstroError, type SwissEph } from "./astro/chart";
import { EngineInitError, internalFailureMessage } from "./internal-error";

/** serverInfo.name。占星術層（astro-mcp.ts）も同じ名前を名乗る */
export const SERVER_NAME = "fortune-gatekeeper";
export const SERVER_VERSION: string = packageJson.version;

/** デッキごとに同梱物が違う理由（instructions・list_decks・draw_cards の3箇所で同じ線引きを言う） */
const DECK_POLICY_NOTE =
  "空オラクルとエニグマオラクルはこのサーバーの作者の自作オラクルデッキで、" +
  "あなたの学習データには無いため一言と解説を同梱しています。" +
  "タロットとルーンは広く知られた体系なのでカード名だけを返します——そちらはあなた自身の知識で読んでください。" +
  "ルノルマンも同じ理由でカード名だけです（番号と対応トランプは名前の一部として添えます）。";

/** initialize 応答に載せる、サーバー全体の注意書き（Claude が最初に読む一文） */
const SERVER_INSTRUCTIONS =
  "占い用のカードを「引く」だけのサーバーです。シャッフル・正逆・飛び出しはすべてサーバー側の乱数で決まり、" +
  "解釈は一切しません——引いた結果の読み解きは会話中のあなたが行ってください。" +
  "自分で「引いたふり」をせず、占う場面では必ず draw_cards を呼ぶこと。" +
  "空オラクルは創作のお題出しにも使われ、題の形式は「カード名『メッセージ』」です。" +
  DECK_POLICY_NOTE +
  "カードのほかに易占（周易）も立てられます——cast_hexagram が六爻を乱数で出し、" +
  "本卦・変爻・之卦・互卦を返します。卦辞・爻辞は載せていないので、そこもあなたの知識で読んでください。" +
  "cast_hexagram は nakko: true で納甲（四柱と各爻の干支・世応・六親・六獣）も付けられます。" +
  "アストロダイス（roll_astro_dice）も振れます——天体 × 星座 × ハウスの名前の組だけを返すので、" +
  "意味はあなたの知識で。" +
  "ジオマンシー（cast_geomancy）も立てられます——16 図形の名前と点の並びだけを返すので、" +
  "意味はあなたの知識で。" +
  "月まわりの暦（moon_calendar）も引けます——朔望・月の星座入り・ボイドタイム・食の時刻だけを" +
  "期間でまとめて返すので、意味はあなたの知識で。" +
  "逆引きホロスコープ（reverse_horoscope）もあります——" +
  "「太陽が牡羊座で月が蟹座」のような配置のほうを先に決めて、" +
  "その配置になる日を年代範囲から逆に引きます（返すのは日付と時刻の範囲と星座の名前だけ）。";

/** 相手が名乗ってきたバージョンがこの中にあればそれに合わせる */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** ブラウザからも叩けるように全許可（守るべき API キーもコストも無い） */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** JSON レスポンス（CORS 付き） */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

/** JSON-RPC のエラー応答 */
export function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  status = 200,
): Response {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

/** ツール実行の失敗は JSON-RPC エラーではなく isError で返す（MCP 仕様） */
export function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: `エラー: ${message}` }], isError: true };
}

/** 引数の形が受け付けられなかったときのエラー（デッキにも易にも属さない、入口の門番） */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

/**
 * ツール定義（inputSchema.properties）から「使ってよいキー」の表を作る。
 *
 * 許可リストを手で書き写すと定義とずれるので、**定義そのものから導く**。
 * inputSchema には additionalProperties: false と書いてあるが、これを守らせる
 * クライアントばかりではないので（`default_lat` の綴り違いが黙って無視されると、
 * 指定したはずの「いつもの場所」が入っていない図が返る）、サーバー側でも見る。
 */
export function allowedArgumentKeys(
  tools: readonly { name: string; inputSchema: { properties: object } }[],
): Map<string, string[]> {
  return new Map(tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties)]));
}

/**
 * 未知のキーが混ざっていれば言い分（メッセージ）を、無ければ null を返す。
 * 投げる例外の種類は層ごとに違う（カード層は ArgumentError、占星術層は AstroError）ので、
 * ここは文面だけ作る。arguments の形そのものの間違いは各層の検算器の持ち場。
 */
export function unknownArgumentMessage(allowed: readonly string[], raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;

  const strays = Object.keys(raw as Record<string, unknown>).filter(
    (key) => !allowed.includes(key),
  );
  if (strays.length === 0) return null;

  return allowed.length === 0
    ? `未知の引数です: ${strays.join(", ")}（このツールは引数を取りません）`
    : `未知の引数です: ${strays.join(", ")}（使えるのは ${allowed.join(" / ")}）`;
}

// ---------------------------------------------------------------------------
// ツール定義
// ---------------------------------------------------------------------------

/**
 * カード層のツール定義（5 本）。公開層 `POST /mcp` の全部であり、鍵つき層 `POST /astro/mcp` にも
 * まるごと同居する（スーパーセット構成、2026-08-24）。定義（name / schema / description）を
 * ここ 1 か所に置き両入口が同じ配列を参照することで、片側だけ文言が古くなる事故を防ぐ。
 */
export const TOOLS = [
  {
    name: "list_decks",
    title: "デッキとスプレッドの一覧",
    description:
      "引けるカードデッキ（空オラクル／エニグマオラクル／タロット大アルカナ／タロット78枚／ルーン／ルノルマン）と、" +
      "使えるスプレッド（並べ方）の一覧を返す。draw_cards を呼ぶ前に、どのデッキが" +
      "意味テキストを持っているか・どのスプレッドが何枚引くかを確かめたいときに使う。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "draw_cards",
    title: "カードを引く",
    description:
      "カードを実際に引く（シャッフル・正逆・飛び出しはすべてサーバー側の乱数で決まる）。" +
      "このツールは解釈をしない——引いた結果を返すだけなので、読み解きは呼び出した側で行うこと。\n" +
      "デッキ: sky=空オラクル（16枚・正逆なし・意味テキストあり）、" +
      "enigma=エニグマオラクル（32枚・正逆あり・意味テキストあり）、" +
      "tarot=タロット大アルカナ（22枚・正逆あり・意味テキストなし）、" +
      "tarot_full=タロット78枚（大アルカナ22＋小アルカナ56・正逆あり・意味テキストなし）、" +
      "rune=ルーン エルダーフサルク（25枚・正逆はカードによる・意味テキストなし）、" +
      "lenormand=ルノルマン（36枚・正逆なし・意味テキストなし）。\n" +
      "sky と enigma はこのサーバーの作者の自作オラクルデッキ（学習データに無い）なので一言＋解説を同梱、" +
      "tarot と tarot_full と rune は広く知られた体系なのでカード名と正逆だけを返す——" +
      "その3つは自分の知識で読むこと。\n" +
      "lenormand も同じ理由でカード名だけ（札番号と対応トランプは添える）——これも自分の知識で読むこと。\n" +
      "空オラクルは小説のこぼれ話のお題出し係も兼ねていて、題の形式は「カード名『メッセージ』」。" +
      "創作のお題として使うときはこの形を崩さないこと。\n" +
      "spread を指定すると枚数はスプレッドに合わせて固定され、各札に位置（過去・現在・未来など）が付く。" +
      "count と両方指定した場合は spread が優先される。" +
      "「飛び出しカード」はシャッフル中に落ちた札の再現で、低い確率で 0〜3 枚付く（本引きとは別枠）。",
    inputSchema: {
      type: "object",
      properties: {
        deck: {
          type: "string",
          enum: DECK_IDS,
          description:
            "引くデッキ。sky / enigma / tarot（大アルカナ22枚） / tarot_full（78枚） / rune / lenormand（36枚）",
        },
        count: {
          type: "integer",
          minimum: 1,
          description:
            "引く枚数（既定 1）。デッキの枚数を超えるとエラー。spread を指定した場合は無視される。",
        },
        spread: {
          type: "string",
          enum: SPREAD_IDS,
          description:
            "並べ方。single=1枚引き / two=2枚引き（Yes-No） / three=3枚引き（過去・現在・未来） / " +
            "hexagram=ヘキサグラム（6枚） / celtic=ケルト十字（10枚） / horoscope=ホロスコープ（12枚） / " +
            "grand_tableau=グランタブロー（36枚・8列×4行＋5行目に4枚。ルノルマンの全展開）",
        },
        allow_reversed: {
          type: "boolean",
          default: true,
          description:
            "逆位置を許すか（既定 true）。false にすると全部正位置。もともと正逆の無いカードは常に正位置。",
        },
        jump_out: {
          type: "boolean",
          default: true,
          description: "飛び出しカードを起こすか（既定 true）。false にすると必ず 0 枚。",
        },
      },
      required: ["deck"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "cast_hexagram",
    title: "易占で卦を立てる",
    description:
      "易占（周易）の卦を立てる（六爻はすべてサーバー側の乱数で決まる）。" +
      "立てるのはサーバー、読むのは呼び出した側——卦辞・爻辞・彖伝のたぐいは一切返さないので、" +
      "卦名と爻の並びを見て自分の知識で読むこと。\n" +
      "method: coins=擲銭法（コイン3枚を6回投げる。6/7/8/9 が 1:3:3:1 で変爻が出やすい）、" +
      "yarrow=本筮法（筮竹50本の三変を6回。老陰1/16・少陽5/16・少陰7/16・老陽3/16 という伝統的な偏り）、" +
      "abridged=略筮法（筮竹で下卦・上卦・変爻を1回ずつ得る。変爻はちょうど1本）。既定は coins。\n" +
      "返るのは本卦（序卦の番号・卦名・記号・上下の八卦）、六爻（初爻から上爻へ。老陽・老陰が変爻）、" +
      "変爻の位、之卦（変爻が無ければ null）、互卦、それにコインの出目や筮竹の本数といった過程。\n" +
      "nakko=true を渡すと納甲（断易・五行易）の表も添える——立卦日時の四柱（年月日時の干支）と、" +
      "本卦・之卦の各爻の納甲干支、八宮と世応、六親、六獣。" +
      "これらはすべて卦と日時からの導出で、乱数は 1 ビットも増えない。" +
      "六親の吉凶や用神の取り方は書かないので、そこも自分の知識で読むこと。\n" +
      "立卦日時（year / month / day / hour / minute / utc_offset）は nakko=true のときだけ使える。" +
      "すべて省略すると現在時刻。\n" +
      "自分で「立てたふり」をせず、易を立てる場面では必ずこのツールを呼ぶこと。",
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: CAST_METHOD_IDS,
          default: "coins",
          description: "立て方。coins=擲銭法（既定） / yarrow=本筮法 / abridged=略筮法",
        },
        nakko: {
          type: "boolean",
          default: false,
          description:
            "納甲（断易）を添えるか（既定 false）。true にすると立卦日時の四柱と、" +
            "各爻の納甲干支・八宮と世応・六親・六獣が付く。",
        },
        year: {
          type: "integer",
          minimum: -5000,
          maximum: 5000,
          description:
            "立卦日時の年（nakko=true のときだけ使える）。year / month / day は 3 つそろえて指定する。" +
            "日時をすべて省略すると現在時刻で立てる。",
        },
        month: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "立卦日時の月（1〜12）。",
        },
        day: {
          type: "integer",
          minimum: 1,
          maximum: 31,
          description: "立卦日時の日。暦に存在しない日付（2026-02-31 など）は断る。",
        },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "立卦日時の時（0〜23）。省略すると 0 時（12 時ではない）。",
        },
        minute: {
          type: "integer",
          minimum: 0,
          maximum: 59,
          description: "立卦日時の分（0〜59）。省略すると 0 分。",
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          default: DEFAULT_UTC_OFFSET,
          description:
            "日時をどの土地の時計で読むか（既定 9）。省略時は日本時間。" +
            "ほかの土地の時計で立てたときはその時差を。",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "roll_astro_dice",
    title: "アストロダイスを振る",
    description:
      "アストロダイス（天体・星座・ハウスの 12 面ダイス 3 個）を振る。" +
      "返るのは「天体 × 星座 × ハウス」の名前と記号の組だけで、意味は載せない——" +
      "よく知られた体系なので、読み解きはあなた自身の占星術の知識で行うこと。" +
      "シャッフルと同じくサーバー側の乱数で決まる。" +
      "自分で「振ったふり」をせず、必ずこのツールを呼ぶこと。",
    inputSchema: {
      type: "object",
      properties: {
        count: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DICE_COUNT,
          default: 1,
          description: `何組振るか（既定 1・最大 ${MAX_DICE_COUNT}）。1 組 = 天体・星座・ハウスのダイス 3 個。`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "cast_geomancy",
    title: "ジオマンシーのシールドチャートを立てる",
    description:
      "西洋ジオマンシーのシールドチャートを立てる。" +
      "サーバー側の乱数で母 4 つ（16 行ぶんの点の奇偶）を立て、" +
      "そこから娘・姪・証人・裁判官（と参考の和解者）を導出して、" +
      "16 図形の名前（ラテン名・日本語名）と点の並びだけを返す。" +
      "意味は載せない——よく知られた体系なので、読み解きはあなた自身の知識で行うこと。" +
      "自分で「立てたふり」をせず、必ずこのツールを呼ぶこと。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "moon_calendar",
    title: "月まわりの暦（朔望・星座入り・ボイド・食）",
    description:
      "月まわりの暦を期間でまとめて返す——新月・上弦・満月・下弦の瞬間、月の星座入り、" +
      "ボイドタイム（ボイド・オブ・コース）、期間内の日食・月食。乱数は使わない天体計算で、" +
      "誕生日も場所も受け取らない（誰が呼んでも同じ答えになる）。\n" +
      "計算するのはサーバー、" +
      READ_WITH_YOUR_OWN_KNOWLEDGE +
      "——返すのは時刻と星座と名前だけで、" +
      "「ボイド中は何をすべきか」のような吉凶・過ごし方は 1 文字も載せない。\n" +
      "採った規約（返り値の conventions にも名前で入る）: " +
      "ボイド＝月がその星座で相手天体と**最後に exact なメジャーアスペクト**" +
      "（0 / 60 / 90 / 120 / 180 度）を作った瞬間から、**次の星座に入る瞬間**まで。" +
      "オーブは取らない（exact ちょうどが境目）。相手天体は既定の modern が" +
      "太陽・水星・金星・火星・木星・土星・天王星・海王星・冥王星の 9 天体、" +
      "traditional が土星までの 7 天体で、どちらもノードは含めない。\n" +
      "⚠ **ボイドの定義は流派で割れる**（相手天体の範囲・オーブを取るかどうか・" +
      "「その星座を出るまで」と数えるか「次のアスペクトまで」と数えるか）。" +
      "このサーバーは上の 1 通りだけを採るので、別の流派の表とは時刻が食い違うことがある。\n" +
      "食は global＝地球上のどこかで起きるもの（場所を受けないので「どこで見えるか」は返さない）。" +
      "半影月食も入れる（type で見分けがつく）。黄道はトロピカル、天体計算は Moshier。\n" +
      "期間の頭より前に始まったボイドも、期間の尻をはみ出して終わるボイドも切らずに実時刻で返す" +
      "（開始時点でボイド中かどうかが分かるように）。\n" +
      "⚠ " +
      PRINCIPLE_NO_SUMMING +
      "。",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description:
            '期間の頭を "YYYY-MM-DD" で（例: 2026-08-25）。その日の 0 時から数える。' +
            "省略すると utc_offset の暦での今日。",
        },
        days: {
          type: "integer",
          minimum: MOON_CALENDAR_MIN_DAYS,
          maximum: MOON_CALENDAR_MAX_DAYS,
          default: MOON_CALENDAR_DEFAULT_DAYS,
          description:
            `何日ぶん見るか（既定 ${MOON_CALENDAR_DEFAULT_DAYS}・` +
            `最大 ${MOON_CALENDAR_MAX_DAYS} ＝ 2 朔望月ぶん）。`,
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          default: MOON_CALENDAR_DEFAULT_UTC_OFFSET,
          description:
            `どの土地の時計で読むか（既定 ${MOON_CALENDAR_DEFAULT_UTC_OFFSET}＝日本時間）。` +
            "返す時刻はすべてこの時差の現地時刻で、+09:00 のような札が付く。",
        },
        voc_bodies: {
          type: "string",
          enum: VOC_BODY_SETS,
          default: "modern",
          description:
            "ボイド判定の相手天体（既定 modern）。modern＝太陽・水星〜冥王星の 9 天体 / " +
            "traditional＝太陽・水星〜土星の 7 天体（近代以降に見つかった 3 つを外す流派）。",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "reverse_horoscope",
    title: "逆引きホロスコープ（その配置になる日を探す）",
    description:
      "**配置のほうを先に決めて、その配置になる日を年代範囲から逆に引く**。" +
      "「太陽が牡羊座で月が蟹座なのはいつか」「金星が獅子座で火星が牡羊座の年はいつか」のような探し方をする（逆行の有無は条件にできない＝返り値に印が付くだけ）。" +
      "乱数は使わない天体計算で、誕生日も場所も受け取らない（誰が呼んでも同じ答えになる）。\n" +
      "計算するのはサーバー、" +
      READ_WITH_YOUR_OWN_KNOWLEDGE +
      "——返すのは日付・時刻の範囲・星座の名前だけで、" +
      "「その配置の人は」「その日は何をするとよいか」のたぐいは 1 文字も載せない。\n" +
      "conditions は { body, sign, priority } の配列。priority=required（既定）**だけで候補日が決まり**、" +
      "priority=optional は各候補日に「その日そろっているか」を添えるだけ（成り立つ数の多い順→日付順に並ぶ）。" +
      "required は少なくとも 1 本要る。同じ天体を 2 回は指定できない。太陽は必須ではないので、" +
      "月だけ・外惑星だけの条件でも引ける。\n" +
      "sign は日本語（牡羊座〜魚座）でも英語の小文字（aries〜pisces）でもよい。\n" +
      "採った規約（返り値の conventions にも名前で入る）: 黄道はトロピカル・天体計算は Moshier・" +
      "星座の境は黄経 30° 刻み・**候補日＝その暦日のどこかの瞬間で required が全部そろう日**" +
      "（日の途中で始まる／終わる日には、その日の中の時刻の範囲が分単位で付く）。\n" +
      `候補は多いときで ${MAX_CANDIDATES} 日まで返す（超えたら truncated: true と総数が付く）。` +
      "各候補日には**その日の現地正午の 10 天体の星座**も添える（条件に無い天体も見えるように）" +
      "——ただし月のように 1 日で星座が変わる天体では、正午の星座と条件が食い違うことがある" +
      "（条件が成り立つ時刻は time_ranges のほう）。度数は返さない。\n" +
      "年代の範囲は year_from・year_to で（両端を含む）。" +
      `一度に見られるのは ${REVERSE_MAX_SPAN_YEARS} 年ぶんまでで、` +
      `${REVERSE_MIN_YEAR}〜${REVERSE_MAX_YEAR} 年の内側。\n` +
      "⚠ " +
      PRINCIPLE_NO_SUMMING +
      "。",
    inputSchema: {
      type: "object",
      properties: {
        conditions: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          description:
            "探したい配置。天体ごとに 1 本ずつ（同じ天体を 2 回は書けない）。" +
            "required が 1 本も無いと断る。",
          items: {
            type: "object",
            properties: {
              body: {
                type: "string",
                enum: REVERSE_BODY_KEYS,
                description: "天体。ノードやアングル（ASC / MC）は条件に使えない。",
              },
              sign: {
                type: "string",
                enum: REVERSE_SIGN_NAMES,
                description: "星座。日本語（牡羊座〜魚座）でも英語の小文字（aries〜pisces）でもよい。",
              },
              priority: {
                type: "string",
                enum: REVERSE_PRIORITIES,
                default: "required",
                description:
                  "required=候補日を決める条件（既定） / optional=候補日は決めず、" +
                  "そろっているかどうかだけを各候補日に添える。",
              },
            },
            required: ["body", "sign"],
            additionalProperties: false,
          },
        },
        year_from: {
          type: "integer",
          minimum: REVERSE_MIN_YEAR,
          maximum: REVERSE_MAX_YEAR,
          description: `探す年代の始まり（西暦・この年を含む）。${REVERSE_MIN_YEAR} 以上。`,
        },
        year_to: {
          type: "integer",
          minimum: REVERSE_MIN_YEAR,
          maximum: REVERSE_MAX_YEAR,
          description:
            `探す年代の終わり（西暦・この年を含む）。year_from との差は ${REVERSE_MAX_SPAN_YEARS} 年ぶんまで。`,
        },
        utc_offset: {
          type: "number",
          minimum: -14,
          maximum: 14,
          default: REVERSE_DEFAULT_UTC_OFFSET,
          description:
            `どの土地の時計・暦で読むか（既定 ${REVERSE_DEFAULT_UTC_OFFSET}＝日本時間）。` +
            "候補日はこの時差の暦日で、時刻の範囲もこの現地時刻（+09:00 のような札が付く）。",
        },
      },
      required: ["conditions", "year_from", "year_to"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// ---------------------------------------------------------------------------
// ツール実装
// ---------------------------------------------------------------------------

function reversedLabel(hasReversed: boolean | "mixed"): string {
  if (hasReversed === "mixed") return "正逆はカードによる";
  return hasReversed ? "正逆あり" : "正逆なし";
}

/**
 * 意味テキスト欄の表示。解説（explanation）の有無は台帳の旗ではなく実データから見る
 * （meanings/ の差し替えで解説が付いたり消えたりしても、案内文が嘘にならないように）。
 */
function meaningsLabel(deck: (typeof DECKS)[number]): string {
  if (!deck.meanings_included) return "意味テキストなし（カード名のみ）";
  const explained = deck.cards.some(
    (card) => card.explanation !== undefined || card.explanation_upright !== undefined,
  );
  return explained ? "意味テキスト＋解説あり" : "意味テキストあり";
}

function runListDecks(): ToolResult {
  const decks = DECKS.map((deck) => ({
    id: deck.id,
    name: deck.name,
    card_count: deck.cards.length,
    has_reversed: deck.has_reversed,
    meanings_included: deck.meanings_included,
  }));
  const spreads = SPREADS.map((spread) => ({
    id: spread.id,
    name: spread.name,
    count: spread.count,
    positions: spread.positions,
  }));

  const lines: string[] = [`デッキ（${DECKS.length}種）`];
  for (const deck of DECKS) {
    const reversed = reversedLabel(deck.has_reversed);
    lines.push(
      `- ${deck.id}: ${deck.name} / ${deck.cards.length}枚 / ${reversed} / ${meaningsLabel(deck)}`,
    );
  }
  lines.push("");
  lines.push(`スプレッド（${spreads.length}種）`);
  for (const spread of spreads) {
    lines.push(
      `- ${spread.id}: ${spread.name}（${spread.count}枚） ${spread.positions.join(" / ")}`,
    );
  }
  lines.push("");
  lines.push(
    "※ 空・エニグマは作者の自作デッキ（学習データに無い）のため一言＋解説を同梱。" +
      "タロット・ルーンは既知の体系なのでカード名のみ。" +
      "ルノルマンも既知の体系なのでカード名のみ（札番号と対応トランプは添える）。",
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { decks, spreads },
  };
}

/** draw_cards の引数を検算する（型だけ見る。値の妥当性は drawCards 側が見る） */
function parseDrawArguments(raw: unknown): DrawOptions {
  const args = (raw ?? {}) as Record<string, unknown>;

  const deck = args["deck"];
  if (typeof deck !== "string") {
    throw new DrawError(`deck は必須です（${DECK_IDS.join(" / ")}）`);
  }
  const options: DrawOptions = { deck };

  const spread = args["spread"];
  if (spread !== undefined && spread !== null) {
    if (typeof spread !== "string") {
      throw new DrawError("spread は文字列で指定してください");
    }
    options.spread = spread;
  }

  const count = args["count"];
  if (count !== undefined && count !== null) {
    if (typeof count !== "number") {
      throw new DrawError(`count は 1 以上の整数にしてください: ${JSON.stringify(count)}`);
    }
    options.count = count;
  }

  const allowReversed = args["allow_reversed"];
  if (allowReversed !== undefined && allowReversed !== null) {
    if (typeof allowReversed !== "boolean") {
      throw new DrawError("allow_reversed は true / false で指定してください");
    }
    options.allow_reversed = allowReversed;
  }

  const jumpOut = args["jump_out"];
  if (jumpOut !== undefined && jumpOut !== null) {
    if (typeof jumpOut !== "boolean") {
      throw new DrawError("jump_out は true / false で指定してください");
    }
    options.jump_out = jumpOut;
  }

  return options;
}

function runDrawCards(rawArguments: unknown): ToolResult {
  const options = parseDrawArguments(rawArguments);
  const result = drawCards(options);
  return {
    content: [{ type: "text", text: formatDrawResult(result) }],
    structuredContent: result,
  };
}

/** 数値の引数（範囲つき）。未指定は undefined */
function castNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CastError(`${key} は数値で指定してください`);
  }
  if (value < min || value > max) {
    throw new CastError(`${key} は ${min} 以上 ${max} 以下で指定してください: ${value}`);
  }
  return value;
}

/** 整数の引数（範囲つき）。未指定は undefined */
function castInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = castNumber(args, key, min, max);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new CastError(`${key} は整数で指定してください: ${value}`);
  return value;
}

/** cast_hexagram の読み取り結果（立て方と、納甲を付けるなら立卦の日時） */
interface CastRequest {
  options: CastOptions;
  /** null なら納甲を付けない（＝エンジンにも触らない） */
  nakko: NakkoMoment | null;
}

/**
 * cast_hexagram の引数を検算する（method の値の妥当性は castHexagram 側が見る）。
 *
 * 日時は nakko: true のときだけ受ける ―― nakko を付けないのに日時を渡してくるのは、
 * たいてい「納甲のつもりで旗を立て忘れた」ときなので、黙って無視せず断る。
 */
function parseCastArguments(raw: unknown, now: Date): CastRequest {
  const args = (raw ?? {}) as Record<string, unknown>;
  const options: CastOptions = {};

  const method = args["method"];
  if (method !== undefined && method !== null) {
    if (typeof method !== "string") {
      throw new CastError(`method は文字列で指定してください（${CAST_METHOD_IDS.join(" / ")}）`);
    }
    options.method = method;
  }

  const nakko = args["nakko"];
  if (nakko !== undefined && nakko !== null && typeof nakko !== "boolean") {
    throw new CastError("nakko は true / false で指定してください");
  }

  const year = castInteger(args, "year", -5000, 5000);
  const month = castInteger(args, "month", 1, 12);
  const day = castInteger(args, "day", 1, 31);
  const hour = castInteger(args, "hour", 0, 23);
  const minute = castInteger(args, "minute", 0, 59);
  const utcOffset = castNumber(args, "utc_offset", -14, 14);

  const hasMoment =
    year !== undefined ||
    month !== undefined ||
    day !== undefined ||
    hour !== undefined ||
    minute !== undefined ||
    utcOffset !== undefined;

  if (nakko !== true) {
    if (hasMoment) {
      throw new CastError(
        "日時は nakko: true のときだけ使います" +
          "（納甲を付けるなら nakko: true を、卦だけでよければ日時を外してください）",
      );
    }
    return { options, nakko: null };
  }

  const offset = utcOffset ?? DEFAULT_UTC_OFFSET;
  const hasDate = year !== undefined || month !== undefined || day !== undefined;
  const hasClock = hour !== undefined || minute !== undefined;

  if (!hasDate) {
    if (hasClock) {
      throw new CastError(
        "日時を指定するときは year / month / day をそろえてください" +
          "（hour・minute を省くと 0 時 0 分。日時をすべて省くと現在時刻）",
      );
    }
    return { options, nakko: momentFromDate(now, offset) };
  }

  if (year === undefined || month === undefined || day === undefined) {
    throw new CastError(
      "日時を指定するときは year / month / day をそろえてください" +
        "（hour・minute を省くと 0 時 0 分。日時をすべて省くと現在時刻）",
    );
  }
  // 実在しない日付は、黙って翌月へ繰り上がる前に断る
  assertCalendarDay(year, month, day);

  return {
    options,
    nakko: { year, month, day, hour: hour ?? 0, minute: minute ?? 0, utcOffset: offset },
  };
}

/**
 * 天体計算のエンジン。カード層でこれが要るのは納甲（cast_hexagram の nakko: true）と
 * 月まわりの暦（moon_calendar）だけなので、断り文の主語（何が出せないか）は
 * 呼び出し側から渡してもらう。
 *
 * 「そもそもエンジンが配線されていない」は呼び出し方の話なのでそのまま言う（CastError）。
 * 「立ち上げに失敗した」は内部障害なので詳細を持たせず、固定文にするのは callTool の catch の仕事。
 */
async function engineOf(context: CardContext, cannot: string): Promise<SwissEph> {
  if (!context.getEngine) {
    throw new CastError(`この呼び出しでは天体計算エンジンが使えないため${cannot}`);
  }
  try {
    return await context.getEngine();
  } catch {
    throw new EngineInitError();
  }
}

async function runCastHexagram(
  rawArguments: unknown,
  context: CardContext,
): Promise<ToolResult> {
  const now = context.now ? context.now() : new Date();
  const request = parseCastArguments(rawArguments, now);
  const result = castHexagram(request.options);

  if (!request.nakko) {
    // 納甲を付けないときの返り値は従来どおり（1 バイトも変えない）
    return {
      content: [{ type: "text", text: formatCastResult(result) }],
      structuredContent: result,
    };
  }

  const swe = await engineOf(context, "納甲を出せません");
  const nakko = buildNakko(result, request.nakko, sunLongitude(swe, request.nakko));
  return {
    content: [
      { type: "text", text: `${formatCastResult(result)}\n\n${formatNakkoText(result, nakko)}` },
    ],
    structuredContent: { ...result, nakko },
  };
}

/** roll_astro_dice の引数を検算する（型だけ見る。値の妥当性は rollAstroDice 側が見る） */
function parseDiceCount(raw: unknown): number {
  const args = (raw ?? {}) as Record<string, unknown>;

  const count = args["count"];
  if (count === undefined || count === null) return 1;
  if (typeof count !== "number") {
    throw new DiceError(
      `count は 1 〜 ${MAX_DICE_COUNT} の整数にしてください: ${JSON.stringify(count)}`,
    );
  }
  return count;
}

function runRollAstroDice(rawArguments: unknown): ToolResult {
  const rolls = rollAstroDice(parseDiceCount(rawArguments));
  return {
    content: [{ type: "text", text: formatAstroDiceText(rolls) }],
    structuredContent: { rolls },
  };
}

/** cast_geomancy は引数を取らない（乱数は母 4 つぶんの 16 ビットだけ、あとは導出） */
function runCastGeomancy(): ToolResult {
  const chart = castGeomancy();
  return {
    content: [{ type: "text", text: formatShieldChartText(chart) }],
    structuredContent: chart,
  };
}

/**
 * 月まわりの暦。この層で唯一「乱数を 1 ビットも使わない」ツールで、誕生日も場所も受けない
 * （誰が呼んでも同じ答え＝公開層に置いてよい、という線引きの側）。
 */
async function runMoonCalendar(rawArguments: unknown, context: CardContext): Promise<ToolResult> {
  const now = context.now ? context.now() : new Date();
  // 引数の検算はエンジンより先（断るだけなら wasm に触らずに済む）
  const request = parseMoonCalendarArguments(rawArguments, now);
  const swe = await engineOf(context, "月まわりの暦を出せません");
  const { result, text } = moonCalendar(swe, request);
  return { content: [{ type: "text", text }], structuredContent: result };
}

/**
 * 逆引きホロスコープ。moon_calendar と同じ側 ―― 乱数を 1 ビットも使わず、誕生日も場所も受けない
 * （誰が呼んでも同じ答え＝公開層に置いてよい、という線引きの側）。
 */
async function runReverseHoroscope(
  rawArguments: unknown,
  context: CardContext,
): Promise<ToolResult> {
  // 引数の検算はエンジンより先（断るだけなら wasm に触らずに済む）
  const request = parseReverseHoroscopeArguments(rawArguments);
  const swe = await engineOf(context, "逆引きホロスコープを出せません");
  const { result, text } = reverseHoroscope(swe, request);
  return { content: [{ type: "text", text }], structuredContent: result };
}

/** カード層のツールごとの許可キー（ツール定義から自動で導く） */
const CARD_ARGUMENT_KEYS = allowedArgumentKeys(TOOLS);

/** 綴り違い・余分なキーは黙って無視せず断る（知らないツール名は素通し＝下で名前を弾く） */
function assertKnownArguments(name: unknown, rawArguments: unknown): void {
  if (typeof name !== "string") return;
  const allowed = CARD_ARGUMENT_KEYS.get(name);
  if (allowed === undefined) return;
  const message = unknownArgumentMessage(allowed, rawArguments);
  if (message !== null) throw new ArgumentError(message);
}

/**
 * カード層のツールを 1 本呼ぶ。公開層 `/mcp` のほか、鍵つき層（astro-mcp.ts）からも
 * カード系の委譲先として呼ばれる ―― そのとき渡ってくるのも CardContext（getEngine / now）
 * だけで、KV も身元も受け取らない＝どちらの入口から引いても結果はどこにも保存されない。
 */
export async function callTool(
  name: unknown,
  rawArguments: unknown,
  context: CardContext,
): Promise<ToolResult> {
  try {
    assertKnownArguments(name, rawArguments);
    if (name === "list_decks") return runListDecks();
    if (name === "draw_cards") return runDrawCards(rawArguments);
    if (name === "cast_hexagram") return await runCastHexagram(rawArguments, context);
    if (name === "roll_astro_dice") return runRollAstroDice(rawArguments);
    if (name === "cast_geomancy") return runCastGeomancy();
    if (name === "moon_calendar") return await runMoonCalendar(rawArguments, context);
    if (name === "reverse_horoscope") return await runReverseHoroscope(rawArguments, context);
    return toolError(`知らないツールです: ${String(name)}`);
  } catch (error) {
    if (
      error instanceof DrawError ||
      error instanceof CastError ||
      error instanceof DiceError ||
      error instanceof ArgumentError ||
      // 天体計算まわりの言い分（moon_calendar・reverse_horoscope の引数の検算）も
      // 「渡された引数が変だった」なのでそのまま返す ―― 占星術層の catch と同じ扱い
      error instanceof AstroError
    ) {
      // 既知の入力エラーは「渡された引数が変だった」という言い分なのでそのまま返す
      return toolError(error.message);
    }
    if (error instanceof EngineInitError) {
      return toolError(internalFailureMessage(error, "engine"));
    }
    // それ以外は何が混ざっているか分からないので、固定文＋参照 ID だけを返す
    return toolError(internalFailureMessage(error, "unexpected"));
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC ディスパッチ
// ---------------------------------------------------------------------------

export function negotiateProtocolVersion(params: unknown): string {
  const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return DEFAULT_PROTOCOL_VERSION;
}

/** 読めた 1 件のリクエスト */
export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

/** リクエスト本文の上限（64 KiB）。JSON-RPC の 1 発は数 KB で足りる */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 本文の UTF-8 バイト数。
 * UTF-16 の文字数がバイト数を上回ることは無いので、文字数の時点で超えていれば数えるまでもない
 * （巨大な本文をもう一度バイト列に写さないための近道）。
 */
function bodyByteLength(text: string): number {
  if (text.length > MAX_BODY_BYTES) return text.length;
  return new TextEncoder().encode(text).byteLength;
}

function bodyTooLarge(): Response {
  return jsonRpcError(null, -32600, "リクエスト本文が大きすぎます（上限 64KB）", 413);
}

/**
 * POST の本文を JSON-RPC 2.0 の単発リクエストとして読む。
 * 読めなかった場合（大きすぎ・壊れた JSON・バッチ・id 無し・通知）は、そのまま返すべき Response を返す。
 * カード層と占星術層で同じ読み方をするための共通部分。
 */
export async function readJsonRpcRequest(
  request: Request,
): Promise<{ ok: true; value: JsonRpcRequest } | { ok: false; response: Response }> {
  // Content-Length で分かるぶんは**本文に触れる前に**断る
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { ok: false, response: bodyTooLarge() };
  }

  // chunked（Content-Length 無し）は読んでから測るしかない
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: jsonRpcError(null, -32700, "JSON を解析できませんでした", 400) };
  }
  if (bodyByteLength(text) > MAX_BODY_BYTES) {
    return { ok: false, response: bodyTooLarge() };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, response: jsonRpcError(null, -32700, "JSON を解析できませんでした", 400) };
  }

  if (Array.isArray(payload)) {
    return {
      ok: false,
      response: jsonRpcError(null, -32600, "バッチリクエストには対応していません", 400),
    };
  }
  if (payload === null || typeof payload !== "object") {
    return {
      ok: false,
      response: jsonRpcError(null, -32600, "JSON-RPC 2.0 のオブジェクトを送ってください", 400),
    };
  }

  const message = payload as JsonRpcMessage;
  // 版の名乗りは必須（省略も 1.0 も受けない）
  if (message.jsonrpc !== "2.0") {
    return {
      ok: false,
      response: jsonRpcError(null, -32600, 'jsonrpc は "2.0" を指定してください', 400),
    };
  }

  const method = message.method;
  if (typeof method !== "string") {
    return { ok: false, response: jsonRpcError(null, -32600, "method がありません", 400) };
  }

  const rawId = message.id;
  if (rawId === undefined || rawId === null) {
    // 通知（notifications/initialized など）は受け取るだけ。本文は返さない
    if (method.startsWith("notifications/")) {
      return { ok: false, response: new Response(null, { status: 202, headers: { ...CORS_HEADERS } }) };
    }
    return {
      ok: false,
      response: jsonRpcError(null, -32600, `id の無いリクエストです: ${method}`, 400),
    };
  }
  if (typeof rawId !== "string" && typeof rawId !== "number") {
    return {
      ok: false,
      response: jsonRpcError(null, -32600, "id は文字列か数値にしてください", 400),
    };
  }

  return { ok: true, value: { id: rawId, method, params: message.params } };
}

/**
 * カード層に外から差し込むもの。
 *
 * カード占い・易・ダイス・ジオマンシーは乱数だけで完結するので、ここが要るのは
 * **納甲（cast_hexagram の nakko: true）と月まわりの暦（moon_calendar）** ―― 納甲は月支と年の境に
 * 太陽黄経が、月まわりの暦は月と太陽の位置・星座入り・食が要る。
 * 占星術層の AstroContext と同じものを index.ts から渡している。
 */
export interface CardContext {
  /** 天体計算エンジン（納甲だけが使う。nakko を付けない限り触らない） */
  getEngine?: () => Promise<SwissEph>;
  /** テストから時刻を固定するための差し込み口（既定は現在時刻） */
  now?: () => Date;
}

/** POST /mcp の本体 */
export async function handleMcpRequest(
  request: Request,
  context: CardContext = {},
): Promise<Response> {
  const parsed = await readJsonRpcRequest(request);
  if (!parsed.ok) return parsed.response;
  const { id, method } = parsed.value;

  switch (method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocolVersion(parsed.value.params),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      });

    case "ping":
      return jsonRpcResult(id, {});

    case "tools/list":
      return jsonRpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const params = (parsed.value.params ?? {}) as { name?: unknown; arguments?: unknown };
      return jsonRpcResult(id, await callTool(params.name, params.arguments, context));
    }

    default:
      return jsonRpcError(id, -32601, `知らないメソッドです: ${method}`);
  }
}
