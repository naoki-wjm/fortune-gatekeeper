/**
 * OAuth の門の接合部（`POST /astro/mcp`）。
 *
 * 占星術層の入口はここ 1 つです（URL に鍵を載せる口 `POST /mcp/<鍵>` は 2026-08-22 に引退。
 * 当時はこの門がその並走版でした）。門を通ったあとは `handleAstroMcpRequest` に `AuthContext` を渡すだけ。
 * 「誰か」の確かめ方:
 *
 *   OAuth    … Cloudflare Access（OIDC）で身元を確かめ、そのメールを `email:<SHA-256>` で台帳に照合
 *
 * 台帳レコードの `user` がチャートの仕切り（`chart:<user>:<chart_id>`）です。
 *
 * 二重の門にしてあるのは手本（保管庫MCPの門番 Worker）と同じ考えで、Access のポリシーを通っても
 * こちらの台帳に載っていなければ 403 です。**メールの生の文字列はレスポンスにもログにも出しません**
 * （台帳に置くのもハッシュだけ ―― `npm run email-hash` で作ります）。
 *
 * OAuth 面の実装（`access-handler.ts` / `workers-oauth-utils.ts`）は保管庫MCPの門番 Worker
 * （`vault_search/gatekeeper-worker/src/`）からの複製で、変えたのは承認画面のブランド文言と
 * import だけです。`OAuthProvider` そのものを組み立てるのは `src/worker.ts`（＝ Workers の入口）で、
 * このファイルはそこに渡す 2 つのハンドラを作るところまでを受け持ちます
 * （`@cloudflare/workers-oauth-provider` は `cloudflare:workers` を読むため Node のテストで動きません。
 *   その import を入口 1 枚に閉じ込めてあるので、ここから下はテストから直に叩けます）。
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { handleAstroMcpRequest, type AstroContext } from "../astro/astro-mcp";
import type { SwissEph } from "../astro/chart";
import { lookupEmail, type AstroKv } from "../astro/store";
import { worker } from "../index";
import { jsonResponse } from "../mcp";
import { handleAccessRequest } from "./access-handler";
import type { AuthEnv } from "./env";
import type { Props } from "./workers-oauth-utils";

/** `OAuthProvider` は defaultHandler を呼ぶとき env に自分（OAUTH_PROVIDER）を差し込む */
export type AuthEnvWithOauth = AuthEnv & { OAUTH_PROVIDER: OAuthHelpers };

/** 認証済みリクエストを占星術層に渡すときの差し込み口（テストでは偽エンジンを渡す） */
export interface AstroOAuthDeps {
  getEngine: () => Promise<SwissEph>;
  /**
   * 占星術層の本体。既定は `handleAstroMcpRequest`。
   * テストから「何が渡ったか」を覗くためだけの差し込み口で、本番では差し替えません。
   */
  handle?: (request: Request, context: AstroContext) => Promise<Response>;
}

/**
 * `ctx.props` は `access-handler` が `completeAuthorization` に渡した値
 * （`OAuthProvider` がトークンと一緒に預かって、認証済みリクエストのたびに戻してくれる）。
 */
export type ExecutionContextWithProps = ExecutionContext & { props?: Partial<Props> };

/** 身元は確かめられたが、この入口を使ってよい人ではなかったときの返事（理由の中身は明かさない） */
function forbidden(message: string): Response {
  return jsonResponse(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message } },
    403,
  );
}

/**
 * OAuth を通ったリクエストの受け口（`OAuthProvider` の `apiHandler`）。
 *
 * ここに来た時点で `Authorization` ヘッダ（門のトークン）は `OAuthProvider` が検算済みです。
 * 占星術層に渡す前にそのヘッダは落とします ―― 中の層に門の鍵を持ち込ませないため（手本と同じ）。
 */
export function createAstroOAuthHandler(deps: AstroOAuthDeps) {
  return {
    async fetch(
      request: Request,
      env: AuthEnv,
      ctx: ExecutionContextWithProps,
    ): Promise<Response> {
      if (request.method !== "POST") {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32000,
              message:
                "POST /astro/mcp のみ対応しています（ステートレス構成のため SSE ストリームは開きません）",
            },
          },
          405,
        );
      }

      const email = typeof ctx?.props?.email === "string" ? ctx.props.email : "";
      if (email.length === 0) {
        return forbidden(
          "この入口は身元の確認が済んだ人だけが使えます（もう一度サインインしてお試しください）。",
        );
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

      // 台帳に載っている人だけ通す（Access のポリシーと二重の門）。
      // ⚠ 照合に失敗しても、メールアドレスは返事にも自前のログにも出さないこと
      const auth = await lookupEmail(kv, email);
      if (!auth) {
        return forbidden(
          "このアカウントでは占星術層を使えません（招かれた方の台帳に載っていませんでした）。",
        );
      }

      const headers = new Headers(request.headers);
      headers.delete("authorization"); // 門のトークンは中の層に渡さない
      headers.delete("cookie");
      const forwarded = new Request(request, { headers });

      const handle = deps.handle ?? handleAstroMcpRequest;
      return await handle(forwarded, { auth, kv, getEngine: deps.getEngine });
    },
  };
}

/**
 * OAuth の面（`/authorize`・`/callback`）以外は、今までどおりのルーター（`src/index.ts`）に落とす。
 * カード層（`POST /mcp`）も `/` も `/health` も（引退した `/mcp/<何か>` の 404 も）ここを素通りします。
 */
export const defaultHandler = {
  async fetch(
    request: Request,
    env: AuthEnvWithOauth,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize" || pathname === "/callback") {
      return await handleAccessRequest(request, env, ctx);
    }
    return await worker.fetch(request, env);
  },
};
