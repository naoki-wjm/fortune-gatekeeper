/**
 * OAuth の門（`POST /astro/mcp`）が使うバインディングの型。
 *
 * カード層・URL 鍵の口が使う `Env`（`ASTRO_KV` だけ）に、OAuth 面のぶんを足したものです。
 * 中身の出どころは 2 つ:
 *   - `OAUTH_KV` … `@cloudflare/workers-oauth-provider` がトークンとグラントを置く KV（台帳とは別の棚）
 *   - Secrets 6 本 … Cloudflare Access for SaaS (OIDC) アプリの値。`wrangler secret put` で入れます
 *     （`.dev.vars.example` にダミーの雛形があります。実データはリポに置かないこと）
 *
 * 許可台帳（誰が使えるか）はここには持ちません ―― `ASTRO_KV` の `email:<ハッシュ>` を引きます
 * （鍵のときと同じ流儀。手本の `ALLOWED_EMAILS` 変数は使っていません）。
 */
import type { Env } from "../index";

export interface AuthEnv extends Env {
  /** workers-oauth-provider 用 KV（トークン・グラントの置き場） */
  OAUTH_KV: KVNamespace;

  /** アップストリームの身元確認 = Cloudflare Access for SaaS (OIDC) アプリの値（Secrets） */
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_TOKEN_URL: string;
  /** 任意。未設定なら ACCESS_TOKEN_URL から末尾の /token を外したものを issuer とみなします */
  ACCESS_ISSUER?: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_JWKS_URL: string;
  /** 承認画面のクッキーを署名する鍵（`openssl rand -hex 32` などで作った 1 本） */
  COOKIE_ENCRYPTION_KEY: string;
}
