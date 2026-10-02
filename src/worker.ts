/**
 * Workers の入口（`wrangler.jsonc` の `main`）。
 *
 * ここでやるのは OAuth の門を被せることだけです:
 *
 *   POST /astro/mcp                     … 占星術層（OAuth。`apiRoute`＝門の内側）
 *   /authorize /token /register /callback /.well-known/*
 *                                       … OAuth の面（`OAuthProvider` と access-handler が捌く）
 *   それ以外（POST /mcp・GET / ・GET /health …）
 *                                       … 今までどおり `src/index.ts` のルーターへ素通り
 *
 * 占星術層への入口はこの `POST /astro/mcp` の 1 つだけです ―― URL に鍵を載せる旧口
 * （`/mcp/<鍵>`）は 2026-08-22 に引退しました（README の「URL 鍵の引退」の段落）。
 *
 * `@cloudflare/workers-oauth-provider` は `cloudflare:workers` を読むので Node（vitest）では
 * 動きません。その import をこの 1 枚に閉じ込め、中身のハンドラは `src/auth/oauth.ts` に
 * 置いてあります（テストはそちらを直に叩きます）。
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { getEngine } from "./astro/engine";
import { createAstroOAuthHandler, defaultHandler } from "./auth/oauth";

/** 認証済みリクエストの受け口。天体計算のエンジンは本番の wasm を渡す */
const astroOAuthHandler = createAstroOAuthHandler({ getEngine });

// `OAuthProvider` の型は wrangler が生成する Cloudflare.Env を前提にしているため、
// ハンドラの受け渡しは手本（vault-gatekeeper）と同じく any を挟む。
export default new OAuthProvider({
  apiHandler: astroOAuthHandler as any,
  apiRoute: "/astro/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  // DCR で登録されたクライアント（claude.ai・ChatGPT・Grok・Claude Code・ローカルちゃん）は、既定だと 90 日で
  // KV から消え、以後は「Invalid client_id」で OAuth が始まらなくなる（保管庫MCPで 2026-10-03 に発生）。
  // undefined を明示すると無期限。登録の寿命は KV ではなく、コネクタの削除で管理する。
  clientRegistrationTTL: undefined,
  defaultHandler: defaultHandler as any,
  tokenEndpoint: "/token",
});
