/**
 * fortune-gatekeeper（占いMCP）の入り口。
 *
 * ルーティング:
 *   POST   /mcp        … カード層・易占の MCP（JSON-RPC 2.0）。認証なし・誰が呼んでも同じ答え
 *   GET    /           … 案内文（プレーンテキスト）
 *   GET    /health     … "ok"
 *   GET|DELETE /mcp    … 405（ステートレスなので SSE ストリームも DELETE も持たない）
 *   OPTIONS            … CORS プリフライト
 *   それ以外           … 404
 *
 * 占星術層（鍵つき層）の入口はここにはありません ―― `POST /astro/mcp` だけで、OAuth の門の内側
 * （`src/worker.ts` → `src/auth/oauth.ts`）に置いてあります。URL に鍵を載せる旧口（`/mcp/<…>`）は
 * 2026-08-22 に引退しました。**URL に載ってきた文字列はレスポンスにもログにも出さないこと**
 * （鍵だったかもしれないものを echo しない）。
 *
 * このファイルは「カード層のルーター」で、Workers に渡す実際の入口は `src/worker.ts`
 * （OAuth の門＝`POST /astro/mcp` と `/authorize` などを被せたもの）です。OAuth を通らない口は
 * すべてここに落ちてきます ―― つまり下の `worker` が今までどおり全部を捌きます。
 * `worker` を named export にしてあるのは、OAuth 面（`cloudflare:workers` を読むため Node では
 * 動かない）に触らずにこのルーターだけをテストから叩けるようにするためです。
 */
import { CORS_HEADERS, handleMcpRequest, jsonResponse } from "./mcp";
import { internalFailureMessage } from "./internal-error";
import { getEngine } from "./astro/engine";

/** Workers のバインディング。ASTRO_KV は占星術層の台帳（許可台帳とチャート） */
export interface Env {
  ASTRO_KV: KVNamespace;
  /**
   * 公開層（POST /mcp）の呼び出し回数の見張り（wrangler.jsonc の `ratelimits`。2026-08-27 査読対応）。
   * 認証のない入口で wasm の天体計算（moon_calendar は 62 日で 50ms ほど）を誰でも回せるので、
   * 同じ送信元からの連打だけを断る。鍵つきの入口（/astro/mcp）と OAuth の口はこの枠に入れない。
   * テスト（env なし）では見張りが居ないので素通し。
   */
  MCP_RATE_LIMIT?: RateLimit;
}

/**
 * env を省略可にしてあるのは、カード層のテストが `worker.fetch(request)` の 1 引数で呼ぶため
 * （凍結テストは無修正のまま緑にしておきたい）。Workers 本番では必ず渡ってくる。
 * このルーター自身はもう KV を使わない（台帳を引くのは OAuth の門の内側だけ）が、
 * `defaultHandler` が今までどおり env ごと素通しできるように引数は受け取っておく。
 */
type MaybeEnv = Env | undefined;

const GUIDE_TEXT = [
  "fortune-gatekeeper — 占いMCPサーバー（カード占い・易占・アストロダイス・ジオマンシー・月まわりの暦）",
  "",
  "MCP エンドポイント: POST /mcp（JSON-RPC 2.0 / Streamable HTTP・ステートレス）",
  "ツール: list_decks, draw_cards, cast_hexagram, roll_astro_dice, cast_geomancy, moon_calendar",
  "デッキ: sky（空オラクル） / enigma（エニグマオラクル） / tarot（タロット大アルカナ22枚） / " +
    "tarot_full（タロット78枚） / rune（ルーン） / lenormand（ルノルマン36枚）",
  "易の立て方: coins（擲銭法） / yarrow（本筮法） / abridged（略筮法）",
  "納甲（断易）: cast_hexagram に nakko: true を渡すと、立卦日時の四柱と各爻の干支・世応・六親・六獣が付く",
  "アストロダイス: 天体・星座・ハウスの12面ダイス3個（1〜3組・名前と記号のみ）",
  "ジオマンシー: シールドチャート（母4・娘4・姪4・証人2・裁判官1＋参考の和解者。16図形の名前と点の並びのみ）",
  "月まわりの暦: 朔望・月の星座入り・ボイドタイム・食を期間でまとめて（乱数なしの天体計算。誕生日も場所も受け取らない）",
  "",
  "引くのはサーバー、読むのは呼び出した側。ここに解釈層はありません。",
  "",
  "この入口は何も預かりません——誕生日を使う占い（数秘術など）は置いていない、というのが線引きです。",
  "",
  "このほかに占星術（ホロスコープ計算）と誕生日を使う占いの層が別の入口で動いていますが、" +
    "そちらは招かれた人だけが使えます。",
  "",
].join("\n");

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

/** POST 以外で MCP エンドポイントを叩かれたときの返事 */
function methodNotAllowed(): Response {
  return jsonResponse(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "POST /mcp のみ対応しています（ステートレス構成のため SSE ストリームは開きません）",
      },
    },
    405,
  );
}

/**
 * 同じ送信元（cf-connecting-ip）からの連打かどうか。見張り（バインディング）が無ければ常に false。
 * 鍵になる IP は返事にもログにも書かない。見張り自体が失敗したときは通す（可用性を優先。
 * 例外の中身は internal-error.ts の流儀で表に出さないが、ここは握って素通しにする）。
 */
async function isRateLimited(request: Request, env: MaybeEnv): Promise<boolean> {
  const limiter = env?.MCP_RATE_LIMIT;
  if (!limiter) return false;
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    const outcome = await limiter.limit({ key });
    return !outcome.success;
  } catch {
    return false;
  }
}

/** 連打を断る返事（JSON-RPC の形で 429。送信元の情報は書かない） */
function tooManyRequests(): Response {
  return jsonResponse(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "呼び出しが多すぎます。少し待ってからもう一度お試しください（同じ送信元からの回数の上限）",
      },
    },
    429,
    { "Retry-After": "60" },
  );
}

export const worker = {
  async fetch(request: Request, _env?: MaybeEnv): Promise<Response> {
    try {
      const url = new URL(request.url);

      // CORS プリフライト
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
      }

      if (url.pathname === "/mcp") {
        if (request.method === "POST") {
          if (await isRateLimited(request, _env)) return tooManyRequests();
          // getEngine は納甲（cast_hexagram の nakko: true）だけが使う。占星術層と同じもの
          return await handleMcpRequest(request, { getEngine });
        }
        return methodNotAllowed();
      }

      if (url.pathname === "/health") {
        return textResponse("ok");
      }

      if (url.pathname === "/") {
        return textResponse(GUIDE_TEXT);
      }

      return textResponse("見つかりません（MCP は POST /mcp）", 404);
    } catch (error) {
      // 例外は握り潰さず、JSON-RPC の内部エラーとして表に出す ―― ただし**中身は出さない**。
      // ここまで転がってきた例外の message には何が混ざっているか分からないので、
      // 固定文と参照 ID だけを返し、突き合わせ用の札はログにだけ落とす（internal-error.ts）
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: internalFailureMessage(error, "unexpected") },
        },
        500,
      );
    }
  },
};

/**
 * 既定の書き出し。テスト（`import worker from "../src/index"`）と、
 * `src/worker.ts` の OAuth 面から見た「素通しの落とし先」が同じものを指します。
 */
export default worker;
