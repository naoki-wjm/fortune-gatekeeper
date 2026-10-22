#!/usr/bin/env node
// 本番 OAUTH_KV のグラント（grant:<user>:<id>）から期限を外す。
//
// workers-oauth-provider の refreshTokenTTL 既定 30 日で切られたレコードを、
// 中身そのまま・expiresAt だけ削って・KV の expiration なしで上書きする（2026-10-03 の
// クライアント登録と同じ手口）。再認証なしで既存の接続を延命させる用。
// 許可証の中身（ラップ済み鍵・暗号化 props）は標準出力にも一時ファイルにも残さない。
//
// 使い方（このフォルダで）:
//   node scripts/grant-remove-expiry.mjs                 … 期限つきグラントを一覧するだけ（書き込まない）
//   node scripts/grant-remove-expiry.mjs --write         … 期限つきグラント全部を期限なしで上書き
//   node scripts/grant-remove-expiry.mjs --write <id>…   … 指定したグラント id だけ
// 環境変数 OAUTH_KV_ID で namespace id を差し替え可（既定は wrangler.jsonc の OAUTH_KV）。

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAMESPACE = process.env.OAUTH_KV_ID ?? "82c148adb45247e4bd28165e934fc112";
const args = process.argv.slice(2);
const write = args.includes("--write");
const onlyIds = new Set(args.filter((a) => !a.startsWith("--")));

const wrangler = (...a) =>
  // npx.cmd は Node 22+ が shell なしでは起こさない（EINVAL）ので、wrangler の JS 入口を直接 node で呼ぶ
  execFileSync(process.execPath, [new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "kv", "key", ...a, `--namespace-id=${NAMESPACE}`, "--remote"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });

const keys = JSON.parse(wrangler("list"));
const targets = keys.filter((k) => k.name.startsWith("grant:") && k.expiration !== undefined);
const jst = (sec) => new Date(sec * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

if (targets.length === 0) {
  console.log("期限つきのグラントはありません。");
  process.exit(0);
}
for (const k of targets) {
  const id = k.name.split(":").at(-1);
  const picked = onlyIds.size === 0 || onlyIds.has(id);
  console.log(`${picked ? "*" : " "} ${id}  期限 ${jst(k.expiration)}`);
}
if (!write) {
  console.log("\n（一覧のみ。上書きするには --write）");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "grant-"));
try {
  for (const k of targets) {
    const id = k.name.split(":").at(-1);
    if (onlyIds.size > 0 && !onlyIds.has(id)) continue;
    const grant = JSON.parse(wrangler("get", k.name));
    if (grant.id !== id) throw new Error(`レコードの id が鍵名と一致しません: ${id}`);
    delete grant.expiresAt;
    const file = join(dir, `${id}.json`);
    writeFileSync(file, JSON.stringify(grant), { mode: 0o600 });
    wrangler("put", k.name, "--path", file);
    rmSync(file, { force: true });
    const back = JSON.parse(wrangler("get", k.name));
    const ok = back.expiresAt === undefined && back.clientId === grant.clientId && back.refreshTokenId === grant.refreshTokenId;
    console.log(`${ok ? "OK" : "NG"} ${id}（client ${grant.clientId}）`);
    if (!ok) process.exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const after = JSON.parse(wrangler("list")).filter((k) => k.name.startsWith("grant:") && k.expiration !== undefined);
console.log(`\n残っている期限つきグラント: ${after.length} 件`);
