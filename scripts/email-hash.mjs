#!/usr/bin/env node
/**
 * メールアドレス → 台帳の鍵名に使うハッシュ（SHA-256 の hex 小文字）。
 *
 *   npm run email-hash -- someone@example.com
 *   npm run email-hash              （引数なしなら標準入力から 1 行読む＝履歴に残したくないとき）
 *
 * 出すのはハッシュだけです。OAuth の口（POST /astro/mcp）の許可台帳は
 * `email:<このハッシュ>` という鍵名で KV に置くので、**メールの生の文字列は
 * どこにも残りません**（会話にも、KV にも）。正規化は前後の空白を落として小文字に、
 * だけ ―― サーバー側（src/astro/store.ts の hashEmail）と同じ規則です。
 *
 *   npx wrangler kv key put --binding ASTRO_KV "email:<ハッシュ>" \
 *     '{"user":"owner","name":"オーナー","role":"owner"}' --remote
 */
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

/** 標準入力から 1 行だけ受け取る（引数を使いたくないとき用） */
async function readLine() {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return "";
}

const fromArgv = process.argv.slice(2).join(" ");
const raw = fromArgv.length > 0 ? fromArgv : await readLine();
const normalized = raw.trim().toLowerCase();

if (normalized.length === 0) {
  console.error("メールアドレスを渡してください（例: npm run email-hash -- someone@example.com）");
  process.exit(1);
}

console.log(createHash("sha256").update(normalized, "utf8").digest("hex"));
