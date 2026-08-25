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
import { getEngine } from "./astro/engine";

/** Workers のバインディング。ASTRO_KV は占星術層の台帳（許可台帳とチャート） */
export interface Env {
  ASTRO_KV: KVNamespace;
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
      // 例外は握り潰さず、JSON-RPC の内部エラーとして表に出す
      const detail = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: `内部エラー: ${detail}` },
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
