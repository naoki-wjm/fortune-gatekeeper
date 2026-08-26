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
  TOOLS as CARD_TOOLS,
  allowedArgumentKeys,
  callTool as callCardTool,
  jsonRpcError,
  jsonRpcResult,
  negotiateProtocolVersion,
  readJsonRpcRequest,
  toolError,
  unknownArgumentMessage,
  type ToolResult,
} from "../mcp";
import { ShukuyoError } from "../shukuyo";
import { AstroError } from "./chart";
import { type AstroContext, type AstroTool } from "./context";
import { PRINCIPLE_NO_SUMMING, PRINCIPLE_SERVER_COMPUTES } from "../phrases";
import { type AstroKv, type AuthContext } from "./store";
import {
  deleteChartTool,
  getChartTool,
  listChartsTool,
  saveChartTool,
  updateDefaultLocationTool,
} from "./tools/charts";
import { fourPillarsTool, pillarsRelationsTool } from "./tools/four-pillars";
import { kyuseiTool } from "./tools/kyusei";
import { lunarReturnTool, solarReturnTool } from "./tools/lunar-solar-return";
import { natalMoonCalendarTool } from "./tools/natal-moon-calendar";
import { calculateNumerologyTool } from "./tools/numerology";
import { progressionsTool } from "./tools/progressions";
import { shukuyoCompatTool, shukuyoTool } from "./tools/shukuyo";
import { compositeTool, synastryTool } from "./tools/synastry";
import { transitEventsTool, transitTool } from "./tools/transit";
import { yearlyOverviewTool } from "./tools/yearly-overview";

export { type AstroKv, type AuthContext };
/** ツールの実装は占術ごとの src/astro/tools/*.ts にある（この入口は集めて配るだけ） */
export { type AstroContext };

/** 占星術層の initialize に載せる注意書き（カード層とは別文） */
const ASTRO_INSTRUCTIONS =
  "ホロスコープ（西洋占星術）の天体位置を計算するサーバーです。" +
  PRINCIPLE_SERVER_COMPUTES +
  "\n" +
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
  "composite=登録済みの出生図 2 枚の**中点図**（コンポジット。中点法＝ダヴィソンではありません）。" +
  "2 人の関係そのものを 1 枚の図として見るときはこれで、" +
  "「2 枚の間に線を引く」synastry とは見ているものが違います" +
  "（c に第三者の chart_id を足すと三者読みになります） / " +
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
  "natal_moon_calendar=空の月の暦（moon_calendar と同じ朔望・星座入り・ボイド・食）に、" +
  "登録済みチャートのハウス入り・ネイタル天体への exact・ネイタル太陽／月に対する個人朔望を" +
  "重ねた 1 枚（「この 2 週間、月が自分の図のどこを通るか」はこれ） / " +
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
  "pillars_relations=四柱の**多者盤面**（登録済み 2〜4 枚の命式を横に並べ、日主・地支・空亡の" +
  "つながりを表引きで拾う）。ひとりの命式そのものは four_pillars、" +
  "**人と人のあいだに立つ関係**（六合・六沖・半合・同一支・空亡・三合局・方合）はこちらです" +
  "——点数化も多数決もしません。 / " +
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
  "⚠ " +
  PRINCIPLE_NO_SUMMING +
  "。並べて眺めるのはよいのですが、点数を足したり多数決を取ったりはしないでください。\n" +
  "この入口にはカード占い・易占・アストロダイス・ジオマンシー" +
  "（list_decks / draw_cards / cast_hexagram / roll_astro_dice / cast_geomancy）と" +
  "月まわりの暦（moon_calendar＝朔望・月の星座入り・ボイドタイム・食の時刻。こちらは乱数を使わない" +
  "天体計算です）も同居しています" +
  "——公開の入口と同じもので、シャッフルも出目もサーバー側の乱数、読みはあなた自身の知識で行います。" +
  "こちらは誰の誕生日も預からず、この鍵つきの入口から引いても**結果は一切保存されません**" +
  "（台帳に入るのはチャートだけ）。カード・易・ダイス・ジオマンシーもまた別の体系です" +
  "（上と同じく、合算の根拠にはなりません）。";

// ---------------------------------------------------------------------------
// ツール定義
// ---------------------------------------------------------------------------

/**
 * 占術ごとのファイルが持つツール（定義＋実装）を**科ごとの並び**にしたもの
 * （出生図の台帳 → 天体系 → 2 枚以上の図 → 誕生日系。2026-08-25 に歴史順から組み替えた）。
 * この並びがそのまま tools/list に出るので、足すときは同じ科の並びの末尾に足す。
 */
const ASTRO_TOOL_LIST: readonly AstroTool[] = [
  // 出生図の台帳
  saveChartTool,
  listChartsTool,
  getChartTool,
  deleteChartTool,
  updateDefaultLocationTool,
  // 天体系
  transitTool,
  transitEventsTool,
  lunarReturnTool,
  solarReturnTool,
  progressionsTool,
  yearlyOverviewTool,
  natalMoonCalendarTool,
  // 2 枚以上の図
  synastryTool,
  compositeTool,
  // 誕生日系
  calculateNumerologyTool,
  shukuyoTool,
  shukuyoCompatTool,
  fourPillarsTool,
  pillarsRelationsTool,
  kyuseiTool,
];

export const ASTRO_TOOLS = ASTRO_TOOL_LIST.map((tool) => tool.definition);

/** ツール名 → 実装の表引き（名前は定義そのものから採る＝手書きの写しを持たない） */
const ASTRO_TOOL_RUNNERS: ReadonlyMap<string, AstroTool["run"]> = new Map(
  ASTRO_TOOL_LIST.map((tool) => [tool.definition.name, tool.run]),
);

/** 占星術層のツールごとの許可キー（ツール定義から自動で導く） */
const ASTRO_ARGUMENT_KEYS = allowedArgumentKeys(ASTRO_TOOLS);

/**
 * この入口（/astro/mcp）が公開するツールの明示リスト（allowlist）＝占星術層の全部＋カード層の全部の
 * スーパーセット（2026-08-24。無料プランのコネクタ 1 枠でも全部に届くように）。
 * 除外リストではなく「載せるものを列挙して合成する」方式 ―― カード層に共通ツールが増えれば
 * CARD_TOOLS 経由で自動的にここにも載る。逆方向（公開層に個人データの口が混ざる事故）は、
 * 公開層のルーター（index.ts / mcp.ts）が astro モジュールを import しない構造なので起こしようがない。
 */
const ASTRO_ENTRANCE_TOOLS = [...ASTRO_TOOLS, ...CARD_TOOLS];

/** カード層へ委譲するツール名（定義そのものから導く＝手書きの写しを持たない） */
const CARD_TOOL_NAMES: ReadonlySet<string> = new Set(CARD_TOOLS.map((tool) => tool.name));

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
    if (typeof name === "string" && CARD_TOOL_NAMES.has(name)) {
      // カード系はカード層の実装へそのまま委譲する。渡すのは乱数と暦に要る 2 つだけで、
      // kv も auth も渡さない ―― 鍵つきの入口から引いても結果はどこにも保存されない（構造で担保）
      return await callCardTool(name, rawArguments, {
        getEngine: context.getEngine,
        now: context.now,
      });
    }
    assertKnownAstroArguments(name, rawArguments);
    const run = typeof name === "string" ? ASTRO_TOOL_RUNNERS.get(name) : undefined;
    if (run) return await run(rawArguments, context);
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
      return jsonRpcResult(id, { tools: ASTRO_ENTRANCE_TOOLS });

    case "tools/call": {
      const callParams = (params ?? {}) as { name?: unknown; arguments?: unknown };
      return jsonRpcResult(id, await callAstroTool(callParams.name, callParams.arguments, context));
    }

    default:
      return jsonRpcError(id, -32601, `知らないメソッドです: ${method}`);
  }
}
