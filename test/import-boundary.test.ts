/**
 * 公開層（認証なしの `POST /mcp`）の import 境界を、依存グラフで固定する。
 *
 * 約束はこうです ―― 公開層が占星術層から借りてよいのは**天体計算の純部品だけ**
 * （chart / calendar / events / returns / engine）。月まわりの暦も納甲の四柱も
 * 空の位置を要るので、「astro 配下を一切読まない」という言い方は事実と合いません。
 * 借りるのは計算だけ、という形に約束を言い直したうえで、ここで固定します。
 *
 * 落とすのは次の 5 つが**依存グラフに 1 つでも現れたとき**:
 *   - `src/astro/store.ts`      … KV の台帳（チャートと許可台帳）
 *   - `src/astro/tools/**`      … 誕生日を預かる鍵つきツールの中身
 *   - `src/auth/**`             … OAuth の門（身元）
 *   - `src/worker.ts`           … 門を被せた本番の入口
 *   - `src/astro/astro-mcp.ts`  … 鍵つき層の配線板
 *
 * つまり公開入口からは、KV にも・身元にも・預かった出生データにも、
 * **たどり着く道が無い**という言い方を機械に確かめてもらう仕掛けです。
 * 「この 1 本だけは許す」と足していく許可リスト方式にはしていません ――
 * 許可リストは足すたびに約束がゆるむ側に倒れるので、落ちたら配線のほうを直します。
 *
 * もう 1 本は AGENTS.md の「tools 同士は import しない」の固定。科どうしが横に
 * つながり始めると、入口の 1 行を読むだけでは何が載っているか分からなくなるためです。
 *
 * ⚠ 読むのはソースの文字列だけ（実行はしない）。動的 import（`import(...)`）は追えないので、
 *   境界をまたぐ配線を動的 import で書かれるとこの依存グラフはすり抜けられます。
 *   そこで **公開層から届く自作ファイルでは動的 import 自体を禁じる**という形で穴を塞いであります
 *   （3 本目のテスト。2026-08-27 再査読対応）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** リポジトリの根（`C:/…/fortune-gatekeeper`）。区切りは POSIX にそろえる */
const REPO_ROOT = toPosix(fileURLToPath(new URL("..", import.meta.url))).replace(/\/+$/, "");

/** 公開層の入口。テストが叩くのもここ（`src/worker.ts` は OAuth 面を被せた本番の入口） */
const PUBLIC_ENTRY = "src/index.ts";

/** 鍵つき層の配線板。tools/*.ts を集めているのはここ 1 枚だけ、という前提でも使う */
const ASTRO_ENTRANCE = "src/astro/astro-mcp.ts";

/** 公開層の依存グラフに現れてはいけないファイル（完全一致） */
const FORBIDDEN_FILES = ["src/astro/store.ts", "src/worker.ts", ASTRO_ENTRANCE];

/** 公開層の依存グラフに現れてはいけないフォルダ（この下は全部だめ） */
const FORBIDDEN_DIRS = ["src/astro/tools/", "src/auth/"];

/**
 * 逆に「必ず入っているはず」のもの。正規表現が壊れて何も拾えなくなったとき、
 * 禁止のほうだけ見ていると全部素通りして緑になってしまうので、空振りをここで止める。
 */
const EXPECTED_FILES = [
  "src/mcp.ts",
  "src/astro/chart.ts",
  "src/moon-calendar.ts",
  "src/reverse-horoscope.ts",
];

// ---------------------------------------------------------------------------
// ソースを読む
// ---------------------------------------------------------------------------

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/** リポジトリ相対のパスで読む。無ければ（フォルダでも）null */
function readSource(id: string): string | null {
  try {
    return new TextDecoder().decode(fs.readFileSync(`${REPO_ROOT}/${id}`));
  } catch {
    return null;
  }
}

/**
 * `import … from "…"` / `export … from "…"` / `import type … from "…"` を拾う。
 *
 * 中身に許す文字を `[\w$*{},\s]`（名前・`* as`・波かっこ・カンマ・改行）に絞ってあるので、
 * `;` や `/` をまたいで別の文へ食い込むことがない ―― コメントの中の "import" にも刺さらない。
 */
const FROM_IMPORT = /^[ \t]*(?:import|export)[ \t\r\n]+(?:type[ \t\r\n]+)?[\w$*{},\s]*?from[ \t]*["']([^"']+)["']/gm;

/** 副作用だけの `import "…";` */
const BARE_IMPORT = /^[ \t]*import[ \t]+["']([^"']+)["']/gm;

/** 1 枚のソースが名指ししている import 先を、書いてある順で返す */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const re of [FROM_IMPORT, BARE_IMPORT]) {
    re.lastIndex = 0;
    let match = re.exec(source);
    while (match !== null) {
      found.push(match[1]!);
      match = re.exec(source);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// パスを解く
// ---------------------------------------------------------------------------

/** `src/astro/tools/kyusei.ts` → `src/astro/tools` */
function dirnameOf(id: string): string {
  const cut = id.lastIndexOf("/");
  return cut < 0 ? "" : id.slice(0, cut);
}

/** `src/astro` と `../chart` から `src/chart` を作る（`.` と `..` をたたむ） */
function joinPath(base: string, relative: string): string {
  const parts = base === "" ? [] : base.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** 解けた先。`leaf` は「記録はするが、そこから先は読まない」もの（.json / .wasm / 素の .js） */
interface Resolved {
  id: string;
  leaf: boolean;
}

/**
 * 相対 import を 1 つ解く。`node:` や npm パッケージ（相対で始まらないもの）は null＝無視。
 *
 * - `.json` / `.wasm` はそこで打ち止め（葉として記録だけ）
 * - `.js` は同名の `.ts` があればそちらに読み替え、無ければ素の JS として葉に
 * - 拡張子なしは `.ts` → `/index.ts` → `.js` → `.json` の順で探す
 */
function resolveSpecifier(fromId: string, specifier: string): Resolved | null {
  if (!specifier.startsWith(".")) return null;

  const target = joinPath(dirnameOf(fromId), specifier);

  if (target.endsWith(".json") || target.endsWith(".wasm")) {
    return { id: target, leaf: true };
  }

  if (target.endsWith(".js")) {
    const asTypeScript = `${target.slice(0, -3)}.ts`;
    if (readSource(asTypeScript) !== null) return { id: asTypeScript, leaf: false };
    return { id: target, leaf: true };
  }

  for (const candidate of [`${target}.ts`, `${target}/index.ts`]) {
    if (readSource(candidate) !== null) return { id: candidate, leaf: false };
  }
  for (const candidate of [`${target}.js`, `${target}.json`]) {
    if (readSource(candidate) !== null) return { id: candidate, leaf: true };
  }
  return null;
}

/**
 * 起点から推移的にたどって、届くファイルを全部集める。
 * 併せて「誰から呼ばれたか」を覚えておき、落ちたときに起点からの道のりを見せる。
 */
function collectGraph(entry: string): { reached: Set<string>; importerOf: Map<string, string> } {
  const reached = new Set<string>([entry]);
  const importerOf = new Map<string, string>();
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const source = readSource(current);
    if (source === null) continue;

    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveSpecifier(current, specifier);
      if (resolved === null) continue;
      if (reached.has(resolved.id)) continue;

      reached.add(resolved.id);
      importerOf.set(resolved.id, current);
      if (!resolved.leaf) queue.push(resolved.id);
    }
  }

  return { reached, importerOf };
}

/** 起点からそのファイルまでの道のりを 1 行に（落ちたときのメッセージ用） */
function chainTo(id: string, importerOf: Map<string, string>): string {
  const chain = [id];
  let cursor = importerOf.get(id);
  while (cursor !== undefined) {
    chain.unshift(cursor);
    cursor = importerOf.get(cursor);
  }
  return chain.join(" → ");
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("公開層の import 境界", () => {
  const { reached, importerOf } = collectGraph(PUBLIC_ENTRY);

  it("正規表現が生きている（借りているはずの純部品が拾えている）", () => {
    for (const expected of EXPECTED_FILES) {
      expect(Array.from(reached), `${expected} が依存グラフに見当たらない`).toContain(expected);
    }
  });

  /**
   * 依存グラフは静的な import しか見ていないので、動的 import（`import(...)`）で書かれた配線は
   * 上のテストをすり抜ける。読む側が追えない書き方そのものを禁じて、穴を閉じておく
   * （2026-08-27 再査読対応 Minor-1）。
   *
   * 見るのは**自作の .ts だけ**。`src/astro/sweph/` は npm の無改造複製（minify 済みで、
   * 中に動的 import が入っている）なので、この約束の外に置く ―― あそこに手は入れない、が別の約束。
   * コメントの中の `import(` も区別せずに落とす（1 か所も無いのが正しい状態）。
   */
  it("公開層から届く自作ファイルは動的 import を使わない", () => {
    const dynamicImport = /\bimport\s*\(/;
    const offenders: string[] = [];

    for (const id of reached) {
      if (!id.endsWith(".ts")) continue;
      if (id.startsWith("src/astro/sweph/")) continue;
      const source = readSource(id);
      if (source === null) continue;
      if (dynamicImport.test(source)) offenders.push(chainTo(id, importerOf));
    }

    expect(
      offenders,
      [
        "公開層から届くファイルで動的 import が使われています。",
        "このテストの依存グラフは静的な import しか追えないので、動的 import で書かれると",
        "境界の約束（台帳・身元・鍵つきツールに道が無いこと）を機械が確かめられなくなります。",
        "見つかったファイル:",
        ...offenders.map((chain) => `  ${chain}`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("台帳・身元・鍵つきツールには、公開入口からたどり着けない", () => {
    const trespassers: string[] = [];

    for (const id of reached) {
      const forbidden =
        FORBIDDEN_FILES.includes(id) || FORBIDDEN_DIRS.some((dir) => id.startsWith(dir));
      if (forbidden) trespassers.push(chainTo(id, importerOf));
    }

    expect(
      trespassers,
      [
        "公開層（認証なしの POST /mcp）から鍵つきの部品に道が通っています。",
        "借りてよいのは天体計算の純部品だけ（chart / calendar / events / returns / engine）です。",
        "到達経路:",
        ...trespassers.map((chain) => `  ${chain}`),
      ].join("\n"),
    ).toEqual([]);
  });
});

describe("鍵つき層の科（tools/*.ts）", () => {
  /** 科の一覧は入口の列挙から取る＝「集めるのは入口だけ」という約束もここで一緒に確かめている */
  const entranceSource = readSource(ASTRO_ENTRANCE);
  const toolFiles = (entranceSource === null ? [] : importSpecifiers(entranceSource))
    .map((specifier) => resolveSpecifier(ASTRO_ENTRANCE, specifier))
    .filter((resolved): resolved is Resolved => resolved !== null)
    .map((resolved) => resolved.id)
    .filter((id) => id.startsWith("src/astro/tools/"));

  it("入口が科を列挙している", () => {
    expect(toolFiles.length).toBeGreaterThanOrEqual(5);
  });

  it("科どうしは import し合わない", () => {
    const crossLinks: string[] = [];

    for (const toolFile of new Set(toolFiles)) {
      const source = readSource(toolFile);
      if (source === null) continue;

      for (const specifier of importSpecifiers(source)) {
        const resolved = resolveSpecifier(toolFile, specifier);
        if (resolved === null) continue;
        if (resolved.id !== toolFile && resolved.id.startsWith("src/astro/tools/")) {
          crossLinks.push(`${toolFile} → ${resolved.id}`);
        }
      }
    }

    expect(
      crossLinks,
      [
        "科どうしが横につながっています。",
        "import は tools/* → 共通部品 → 純関数の一方向で、集めるのは入口（astro-mcp.ts）だけです。",
        "共通で要るものは共通部品（context.ts / calendar.ts / tool-args.ts …）へ移してください。",
        ...crossLinks.map((link) => `  ${link}`),
      ].join("\n"),
    ).toEqual([]);
  });
});
