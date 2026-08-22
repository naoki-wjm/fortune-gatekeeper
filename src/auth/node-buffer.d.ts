/**
 * `node:buffer` の最小限の宣言。
 *
 * OAuth 面の access-handler（手本からの複製）が ID トークンの base64url を解くのに Buffer を使います。
 * 本番では `wrangler.jsonc` の `compatibility_flags: ["nodejs_compat"]` が workerd 側で本物を用意し、
 * vitest（Node）ではそのまま Node の Buffer が使われます。
 *
 * @types/node を入れないのはこのリポの既存方針（`test/vitest-env.d.ts` と同じ理由 ―― Workers の
 * コードを Node の型で汚さない）に合わせたためで、使う口だけをここで名乗ります。
 */
declare module "node:buffer" {
  /** Buffer のうち access-handler が使う 2 つの形だけ */
  export const Buffer: {
    from(
      input: string,
      encoding?: "base64url" | "base64" | "hex" | "utf8",
    ): Uint8Array & { toString(encoding?: string): string };
  };
}
