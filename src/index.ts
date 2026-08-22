/**
 * fortune-gatekeeper（占いMCP）の入り口。
 *
 * ルーティング:
 *   POST   /mcp        … カード層・易占の MCP（JSON-RPC 2.0）。認証なし・誰が呼んでも同じ答え
 *   POST   /mcp/<鍵>   … 占星術層の MCP。KV の台帳に載っている鍵だけ通る
 *   GET    /           … 案内文（プレーンテキスト）
 *   GET    /health     … "ok"
 *   GET|DELETE /mcp    … 405（ステートレスなので SSE ストリームも DELETE も持たない）
 *   OPTIONS            … CORS プリフライト
 *
 * ⚠ 鍵は URL に載る。**レスポンスにもログにも鍵そのものを出さないこと**
 *    （照合に失敗しても「確認できませんでした」としか言わない）。
 */
import { CORS_HEADERS, handleMcpRequest, jsonResponse } from "./mcp";
import { handleAstroMcpRequest, lookupKey, type AstroKv } from "./astro/astro-mcp";
import { getEngine } from "./astro/engine";

/** Workers のバインディング。ASTRO_KV は占星術層の台帳（鍵とチャート） */
export interface Env {
  ASTRO_KV: KVNamespace;
  /**
   * 出生の原本（JSON 文字列）。progressions（二次進行）だけがこれを見る。
   * 本番は `npx wrangler secret put OWNER_NATAL`、ローカルは `.dev.vars`（git 管理外）。
   * ⚠ **中身をレスポンスにもログにも出さないこと**。
   */
  OWNER_NATAL?: string;
}

/**
 * env を省略可にしてあるのは、カード層のテストが `worker.fetch(request)` の 1 引数で呼ぶため
 * （凍結テストは無修正のまま緑にしておきたい）。Workers 本番では必ず渡ってくる。
 * バインディングが無い状態で鍵つき URL を叩かれた場合は 500 で正直に言う。
 */
type MaybeEnv = Env | undefined;

const GUIDE_TEXT = [
  "fortune-gatekeeper — 占いMCPサーバー（カード占い・易占・アストロダイス・ジオマンシー）",
  "",
  "MCP エンドポイント: POST /mcp（JSON-RPC 2.0 / Streamable HTTP・ステートレス）",
  "ツール: list_decks, draw_cards, cast_hexagram, roll_astro_dice, cast_geomancy",
  "デッキ: sky（空オラクル） / enigma（エニグマオラクル） / tarot（タロット大アルカナ22枚） / " +
    "tarot_full（タロット78枚） / rune（ルーン） / lenormand（ルノルマン36枚）",
  "易の立て方: coins（擲銭法） / yarrow（本筮法） / abridged（略筮法）",
  "アストロダイス: 天体・星座・ハウスの12面ダイス3個（1〜3組・名前と記号のみ）",
  "ジオマンシー: シールドチャート（母4・娘4・姪4・証人2・裁判官1＋参考の和解者。16図形の名前と点の並びのみ）",
  "",
  "引くのはサーバー、読むのは呼び出した側。ここに解釈層はありません。",
  "",
  "このほかに占星術（ホロスコープ計算）の層が別の入口で動いていますが、そちらは招かれた人だけが使えます。",
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

/** 鍵つき URL の形。`/mcp/<鍵>` ちょうど 1 階層だけ */
const ASTRO_PATH = /^\/mcp\/([^/]+)\/?$/;

export default {
  async fetch(request: Request, env?: MaybeEnv): Promise<Response> {
    try {
      const url = new URL(request.url);

      // CORS プリフライト
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
      }

      if (url.pathname === "/mcp") {
        if (request.method === "POST") {
          return await handleMcpRequest(request);
        }
        return methodNotAllowed();
      }

      const astroMatch = ASTRO_PATH.exec(url.pathname);
      if (astroMatch) {
        if (request.method !== "POST") {
          return methodNotAllowed();
        }

        const kv = env?.ASTRO_KV as AstroKv | undefined;
        if (!kv) {
          return jsonResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: "占星術層の台帳（KV）が設定されていません" },
            },
            500,
          );
        }

        // 鍵は decode してから照合する。以降どこにも書き出さない
        let key: string;
        try {
          key = decodeURIComponent(astroMatch[1] as string);
        } catch {
          key = astroMatch[1] as string;
        }
        const auth = await lookupKey(kv, key);
        if (!auth) {
          return jsonResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32001,
                message:
                  "この URL では占星術層を使えません（鍵を確認できませんでした）。URL をもう一度お確かめください。",
              },
            },
            401,
          );
        }

        return await handleAstroMcpRequest(request, {
          auth,
          kv,
          getEngine,
          ownerNatal: env?.OWNER_NATAL,
        });
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
