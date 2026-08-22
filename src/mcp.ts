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
  "アストロダイス（roll_astro_dice）も振れます——天体 × 星座 × ハウスの名前の組だけを返すので、" +
  "意味はあなたの知識で。" +
  "ジオマンシー（cast_geomancy）も立てられます——16 図形の名前と点の並びだけを返すので、" +
  "意味はあなたの知識で。";

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
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
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

const TOOLS = [
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

/** cast_hexagram の引数を検算する（型だけ見る。値の妥当性は castHexagram 側が見る） */
function parseCastArguments(raw: unknown): CastOptions {
  const args = (raw ?? {}) as Record<string, unknown>;
  const options: CastOptions = {};

  const method = args["method"];
  if (method !== undefined && method !== null) {
    if (typeof method !== "string") {
      throw new CastError(`method は文字列で指定してください（${CAST_METHOD_IDS.join(" / ")}）`);
    }
    options.method = method;
  }

  return options;
}

function runCastHexagram(rawArguments: unknown): ToolResult {
  const options = parseCastArguments(rawArguments);
  const result = castHexagram(options);
  return {
    content: [{ type: "text", text: formatCastResult(result) }],
    structuredContent: result,
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

function callTool(name: unknown, rawArguments: unknown): ToolResult {
  try {
    assertKnownArguments(name, rawArguments);
    if (name === "list_decks") return runListDecks();
    if (name === "draw_cards") return runDrawCards(rawArguments);
    if (name === "cast_hexagram") return runCastHexagram(rawArguments);
    if (name === "roll_astro_dice") return runRollAstroDice(rawArguments);
    if (name === "cast_geomancy") return runCastGeomancy();
    return toolError(`知らないツールです: ${String(name)}`);
  } catch (error) {
    if (
      error instanceof DrawError ||
      error instanceof CastError ||
      error instanceof DiceError ||
      error instanceof ArgumentError
    ) {
      return toolError(error.message);
    }
    return toolError(error instanceof Error ? error.message : String(error));
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

/** POST /mcp の本体 */
export async function handleMcpRequest(request: Request): Promise<Response> {
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
      return jsonRpcResult(id, callTool(params.name, params.arguments));
    }

    default:
      return jsonRpcError(id, -32601, `知らないメソッドです: ${method}`);
  }
}
