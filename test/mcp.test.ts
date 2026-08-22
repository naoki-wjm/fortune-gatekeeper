import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { getDeck } from "../src/decks";

const ENDPOINT = "http://localhost/mcp";

/** JSON-RPC を 1 発投げて、レスポンスと本文（JSON）を受け取る */
async function post(body: unknown): Promise<{ response: Response; json: any }> {
  const response = await worker.fetch(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

describe("initialize", () => {
  it("要求されたバージョンが対応表にあればそれを返す", async () => {
    const { response, json } = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // ステートレスなのでセッション ID は発行しない
    expect(response.headers.get("Mcp-Session-Id")).toBeNull();
    expect(json.result.protocolVersion).toBe("2025-03-26");
    expect(json.result.capabilities).toEqual({ tools: {} });
    expect(json.result.serverInfo.name).toBe("fortune-gatekeeper");
    expect(typeof json.result.serverInfo.version).toBe("string");
  });

  it("instructions にデッキの厚さの線引きと易占の一文が載る", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 12,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const instructions: string = json.result.instructions;
    // なぜ空・エニグマだけ意味テキストと解説を持つのか（作者の自作＝学習データに無い）
    expect(instructions).toContain("作者");
    expect(instructions).toContain("学習データには無い");
    expect(instructions).toContain("タロットとルーンは広く知られた体系");
    // 易占も立てられる
    expect(instructions).toContain("cast_hexagram");
    expect(instructions).toContain("卦辞・爻辞は載せていない");
  });

  it("知らないバージョンなら既定の 2025-06-18 を返す", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(json.result.protocolVersion).toBe("2025-06-18");
  });
});

describe("tools/list", () => {
  it("3 本のツールを返す", async () => {
    const { json } = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(["list_decks", "draw_cards", "cast_hexagram"]);

    const cast = json.result.tools[2];
    expect(cast.title).toBe("易占で卦を立てる");
    expect(cast.inputSchema.properties.method.enum).toEqual(["coins", "yarrow", "abridged"]);
    expect(cast.inputSchema.properties.method.default).toBe("coins");
    expect(cast.inputSchema.required).toBeUndefined();
    expect(cast.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });

    const draw = json.result.tools[1];
    expect(draw.inputSchema.required).toEqual(["deck"]);
    expect(draw.inputSchema.properties.deck.enum).toEqual([
      "sky",
      "enigma",
      "tarot",
      "tarot_full",
      "rune",
    ]);
    expect(draw.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(draw.title).toBe("カードを引く");
  });

  it("ツール定義は凍結（ChatGPT が接続時にキャッシュするので勝手に変えない）", async () => {
    const { json } = await post({ jsonrpc: "2.0", id: 10, method: "tools/list" });
    expect(json.result.tools).toEqual(FROZEN_TOOLS);
  });
});

describe("tools/call", () => {
  it("list_decks はデッキとスプレッドを返す", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_decks", arguments: {} },
    });
    expect(json.result.isError).toBeUndefined();
    expect(json.result.structuredContent.decks).toHaveLength(5);
    expect(json.result.structuredContent.spreads).toHaveLength(6);
    expect(json.result.content[0].text).toContain("空オラクル");
    // 案内文だけ「解説あり」を名乗る（structuredContent の形は変えていない）
    expect(json.result.content[0].text).toContain("意味テキスト＋解説あり");
    expect(json.result.content[0].text).toContain("意味テキストなし（カード名のみ）");
    // なぜデッキで厚さが違うか（structuredContent の形は変えず、案内文の末尾に1行）
    expect(json.result.content[0].text).toContain(
      "※ 空・エニグマは作者の自作デッキ（学習データに無い）のため一言＋解説を同梱。" +
        "タロット・ルーンは既知の体系なのでカード名のみ。",
    );
    expect(Object.keys(json.result.structuredContent.decks[0])).toEqual([
      "id",
      "name",
      "card_count",
      "has_reversed",
      "meanings_included",
    ]);
  });

  it("draw_cards（sky / three）は 3 枚に position を付けて返す", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "draw_cards", arguments: { deck: "sky", spread: "three" } },
    });
    const result = json.result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.cards).toHaveLength(3);
    expect(result.structuredContent.cards.map((card: { position: string }) => card.position)).toEqual(
      ["過去", "現在", "未来"],
    );

    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toBe("空オラクル / 3枚引き");
    expect(lines[1]).toMatch(/^1\. 過去: .+『.+』$/);
    // 解説は札の行の直下（お題形式の行は汚さない）
    expect(lines[2]).toMatch(/^   解説: .+$/);
    expect(
      result.structuredContent.cards.every(
        (card: { explanation?: string }) => typeof card.explanation === "string",
      ),
    ).toBe(true);
  });

  it("draw_cards（enigma）は向きに応じた解説を structuredContent に載せる", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "draw_cards", arguments: { deck: "enigma", count: 32, jump_out: false } },
    });
    const deck = getDeck("enigma")!;
    const byName = new Map(deck.cards.map((card) => [card.name, card]));
    const cards = json.result.structuredContent.cards as {
      name: string;
      orientation: string;
      meaning: string;
      explanation: string;
    }[];
    expect(cards).toHaveLength(32);
    for (const card of cards) {
      const raw = byName.get(card.name)!;
      expect(card.explanation).toBe(
        card.orientation === "reversed" ? raw.explanation_reversed : raw.explanation_upright,
      );
      expect(card.explanation).not.toBe(card.meaning);
    }
  });

  it("draw_cards は意味の無いデッキでは『』を付けない", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "draw_cards", arguments: { deck: "tarot", count: 1, jump_out: false } },
    });
    const lines = json.result.content[0].text.split("\n");
    expect(lines[0]).toBe("タロット大アルカナ / 1枚");
    expect(lines[1]).toMatch(/^1\. .+（(正|逆)位置）$/);
    expect(json.result.structuredContent.deck.meanings_included).toBe(false);
    // 解説も持たない（テキストにも JSON にも出ない）
    expect(json.result.content[0].text).not.toContain("解説:");
    expect(JSON.stringify(json.result.structuredContent)).not.toContain("explanation");
  });

  it("入力の誤りは JSON-RPC エラーではなく isError で返す", async () => {
    const { response, json } = await post({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "draw_cards", arguments: { deck: "sky", count: 999 } },
    });
    expect(response.status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("エラー:");
  });

  it("cast_hexagram は本卦・爻・互卦を structuredContent とテキストの両方で返す", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "cast_hexagram", arguments: {} },
    });
    const result = json.result;
    expect(result.isError).toBeUndefined();

    const cast = result.structuredContent;
    expect(cast.method).toEqual({ id: "coins", name: "擲銭法" });
    expect(cast.cast_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(cast.lines).toHaveLength(6);
    expect(cast.lines.map((line: { position: number }) => line.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cast.lines.every((line: { coins: number[] }) => line.coins.length === 3)).toBe(true);
    expect(cast.primary.number).toBeGreaterThanOrEqual(1);
    expect(cast.primary.number).toBeLessThanOrEqual(64);
    expect(typeof cast.primary.name).toBe("string");
    expect(cast.nuclear.number).toBeGreaterThanOrEqual(1);
    if (cast.changing_lines.length === 0) {
      expect(cast.resulting).toBeNull();
    } else {
      expect(cast.resulting.number).toBeGreaterThanOrEqual(1);
    }

    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toBe("易（擲銭法）");
    expect(lines[1]).toContain(`第${cast.primary.number}卦 ${cast.primary.name}`);
    expect(lines[lines.length - 1]).toMatch(/^出目: /);
    // 卦辞・爻辞は載せない
    expect(result.content[0].text).not.toContain("卦辞");
  });

  it("cast_hexagram の method で立て方が切り替わる", async () => {
    for (const [method, name] of [
      ["yarrow", "本筮法"],
      ["abridged", "略筮法"],
    ]) {
      const { json } = await post({
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "cast_hexagram", arguments: { method } },
      });
      expect(json.result.isError).toBeUndefined();
      expect(json.result.structuredContent.method).toEqual({ id: method, name });
      expect(json.result.content[0].text.split("\n")[0]).toBe(`易（${name}）`);
    }

    const abridged = await post({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "cast_hexagram", arguments: { method: "abridged" } },
    });
    expect(abridged.json.result.structuredContent.changing_lines).toHaveLength(1);
    expect(abridged.json.result.structuredContent.abridged).toBeDefined();
  });

  it("cast_hexagram の知らない method は isError", async () => {
    const { response, json } = await post({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: { name: "cast_hexagram", arguments: { method: "tortoise" } },
    });
    expect(response.status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("知らない立て方です: tortoise");

    const wrongType = await post({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: { name: "cast_hexagram", arguments: { method: 3 } },
    });
    expect(wrongType.json.result.isError).toBe(true);
  });

  it("知らないツールも isError で返す", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "read_tea_leaves", arguments: {} },
    });
    expect(json.result.isError).toBe(true);
  });
});

describe("プロトコルの端っこ", () => {
  it("notifications/initialized は 202・本文なし", async () => {
    const response = await worker.fetch(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("ping は空オブジェクト", async () => {
    const { json } = await post({ jsonrpc: "2.0", id: 8, method: "ping" });
    expect(json.result).toEqual({});
  });

  it("知らないメソッドは -32601", async () => {
    const { json } = await post({ jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect(json.error.code).toBe(-32601);
    expect(json.id).toBe(9);
  });

  it("壊れた JSON は -32700", async () => {
    const { response, json } = await post("{ こわれた");
    expect(response.status).toBe(400);
    expect(json.error.code).toBe(-32700);
  });

  it("バッチと id 無しの非通知は -32600", async () => {
    const batch = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(batch.json.error.code).toBe(-32600);

    const noId = await post({ jsonrpc: "2.0", method: "tools/list" });
    expect(noId.json.error.code).toBe(-32600);
  });

  it('jsonrpc の名乗りが "2.0" でなければ -32600・400', async () => {
    for (const payload of [
      { id: 1, method: "ping" }, // 省略
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: 2.0, id: 1, method: "ping" }, // 数値の 2.0 は文字列ではない
    ]) {
      const { response, json } = await post(payload);
      expect(response.status).toBe(400);
      expect(json.error.code).toBe(-32600);
      expect(json.error.message).toContain("jsonrpc");
    }
  });

  it("通知でも名乗りは要る（jsonrpc 無しは 202 にしない）", async () => {
    const { response, json } = await post({ method: "notifications/initialized" });
    expect(response.status).toBe(400);
    expect(json.error.code).toBe(-32600);
  });
});

describe("リクエスト本文の大きさ", () => {
  const LIMIT = 64 * 1024;

  /** 本文を 1 バイト単位で作る（全部 ASCII なので 1 文字 = 1 バイト） */
  function bodyOfSize(bytes: number): string {
    const base = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "" } });
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { pad: "x".repeat(bytes - base.length) },
    });
  }

  async function postRaw(
    body: string,
    headers: Record<string, string>,
  ): Promise<{ response: Response; json: any }> {
    const response = await worker.fetch(
      new Request(ENDPOINT, { method: "POST", headers, body }),
    );
    const text = await response.text();
    return { response, json: text ? JSON.parse(text) : null };
  }

  it("上限ちょうど（64KiB）は通る", async () => {
    const body = bodyOfSize(LIMIT);
    expect(body.length).toBe(LIMIT);

    const { response, json } = await postRaw(body, { "Content-Type": "application/json" });
    expect(response.status).toBe(200);
    expect(json.result).toEqual({});
  });

  it("Content-Length が上限超なら、本文を読まずに 413", async () => {
    // ヘッダだけ大きく名乗る（本文は小さい）＝読んでいたら通ってしまう形
    const { response, json } = await postRaw(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), {
      "Content-Type": "application/json",
      "Content-Length": String(LIMIT + 1),
    });
    expect(response.status).toBe(413);
    expect(json.error.code).toBe(-32600);
    expect(json.error.message).toContain("リクエスト本文が大きすぎます");
  });

  it("Content-Length が無くても（chunked）本体が超えていれば 413", async () => {
    const { response, json } = await postRaw(bodyOfSize(LIMIT + 1), {
      "Content-Type": "application/json",
    });
    expect(response.status).toBe(413);
    expect(json.error.code).toBe(-32600);
    expect(json.error.message).toContain("上限 64KB");
  });

  it("マルチバイトも文字数ではなくバイト数で見る", async () => {
    // 「あ」は UTF-8 で 3 バイト。文字数では上限内でもバイト数では超える
    const padded = "あ".repeat(30_000);
    const { response } = await postRaw(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: padded } }),
      { "Content-Type": "application/json" },
    );
    expect(response.status).toBe(413);
  });
});

describe("未知の引数キー", () => {
  it("綴り違いを黙って無視しない（draw_cards）", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "draw_cards", arguments: { deck: "sky", allow_reverse: false } },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("未知の引数です: allow_reverse");
    // 正しい綴りが一覧に出る（許可キーはツール定義から作っている）
    expect(json.result.content[0].text).toContain("allow_reversed");
  });

  it("引数を取らないツールでも断る（list_decks）", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "list_decks", arguments: { deck: "sky" } },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("このツールは引数を取りません");
  });

  it("易占も同じ（cast_hexagram）", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "cast_hexagram", arguments: { methods: "coins" } },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("未知の引数です: methods");
    expect(json.result.content[0].text).toContain("method");
  });

  it("正しい引数はこれまで通り通る", async () => {
    const draw = await post({
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "draw_cards",
        arguments: { deck: "sky", count: 2, allow_reversed: false, jump_out: false },
      },
    });
    expect(draw.json.result.isError).toBeUndefined();
    expect(draw.json.result.structuredContent.cards).toHaveLength(2);

    const spread = await post({
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: { name: "draw_cards", arguments: { deck: "tarot", spread: "three" } },
    });
    expect(spread.json.result.isError).toBeUndefined();

    const cast = await post({
      jsonrpc: "2.0",
      id: 25,
      method: "tools/call",
      params: { name: "cast_hexagram", arguments: { method: "yarrow" } },
    });
    expect(cast.json.result.isError).toBeUndefined();

    const listed = await post({
      jsonrpc: "2.0",
      id: 26,
      method: "tools/call",
      params: { name: "list_decks", arguments: {} },
    });
    expect(listed.json.result.isError).toBeUndefined();
  });
});

describe("ルーティング", () => {
  it("GET /mcp は 405", async () => {
    const response = await worker.fetch(new Request(ENDPOINT, { method: "GET" }));
    expect(response.status).toBe(405);
    const json: any = await response.json();
    expect(json.error.code).toBe(-32000);
  });

  it("DELETE /mcp も 405", async () => {
    const response = await worker.fetch(new Request(ENDPOINT, { method: "DELETE" }));
    expect(response.status).toBe(405);
  });

  it("GET / は案内文", async () => {
    const response = await worker.fetch(new Request("http://localhost/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(await response.text()).toContain("fortune-gatekeeper");
  });

  it("GET /health は ok", async () => {
    const response = await worker.fetch(new Request("http://localhost/health"));
    expect(await response.text()).toBe("ok");
  });

  it("OPTIONS は CORS プリフライト", async () => {
    const response = await worker.fetch(new Request(ENDPOINT, { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, GET, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Mcp-Session-Id");
  });
});

/**
 * tools/list の返り値まるごと（凍結）。
 *
 * ChatGPT はコネクタ接続時にツール定義を取り込んでキャッシュし、その後サーバー側を直しても
 * 取り直さない（更新には Web 版で「更新する」を押してもらう必要がある）。うっかり文言を
 * いじってしまわないよう、ここで丸ごと止めてある。意図して変えたときだけこの literal を
 * 更新し、デプロイ後に「更新する」を押してもらうこと。
 *
 * ※ draw_cards の返り値（explanation など）を増やすのは「定義」の変更ではないので、
 *   このテストは緑のまま。
 */
const FROZEN_TOOLS = [
  {
    "name": "list_decks",
    "title": "デッキとスプレッドの一覧",
    "description": "引けるカードデッキ（空オラクル／エニグマオラクル／タロット大アルカナ／タロット78枚／ルーン）と、使えるスプレッド（並べ方）の一覧を返す。draw_cards を呼ぶ前に、どのデッキが意味テキストを持っているか・どのスプレッドが何枚引くかを確かめたいときに使う。",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "draw_cards",
    "title": "カードを引く",
    "description": "カードを実際に引く（シャッフル・正逆・飛び出しはすべてサーバー側の乱数で決まる）。このツールは解釈をしない——引いた結果を返すだけなので、読み解きは呼び出した側で行うこと。\nデッキ: sky=空オラクル（16枚・正逆なし・意味テキストあり）、enigma=エニグマオラクル（32枚・正逆あり・意味テキストあり）、tarot=タロット大アルカナ（22枚・正逆あり・意味テキストなし）、tarot_full=タロット78枚（大アルカナ22＋小アルカナ56・正逆あり・意味テキストなし）、rune=ルーン エルダーフサルク（25枚・正逆はカードによる・意味テキストなし）。\nsky と enigma はこのサーバーの作者の自作オラクルデッキ（学習データに無い）なので一言＋解説を同梱、tarot と tarot_full と rune は広く知られた体系なのでカード名と正逆だけを返す——その3つは自分の知識で読むこと。\n空オラクルは小説のこぼれ話のお題出し係も兼ねていて、題の形式は「カード名『メッセージ』」。創作のお題として使うときはこの形を崩さないこと。\nspread を指定すると枚数はスプレッドに合わせて固定され、各札に位置（過去・現在・未来など）が付く。count と両方指定した場合は spread が優先される。「飛び出しカード」はシャッフル中に落ちた札の再現で、低い確率で 0〜3 枚付く（本引きとは別枠）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "deck": {
          "type": "string",
          "enum": [
            "sky",
            "enigma",
            "tarot",
            "tarot_full",
            "rune"
          ],
          "description": "引くデッキ。sky / enigma / tarot（大アルカナ22枚） / tarot_full（78枚） / rune"
        },
        "count": {
          "type": "integer",
          "minimum": 1,
          "description": "引く枚数（既定 1）。デッキの枚数を超えるとエラー。spread を指定した場合は無視される。"
        },
        "spread": {
          "type": "string",
          "enum": [
            "single",
            "two",
            "three",
            "hexagram",
            "celtic",
            "horoscope"
          ],
          "description": "並べ方。single=1枚引き / two=2枚引き（Yes-No） / three=3枚引き（過去・現在・未来） / hexagram=ヘキサグラム（6枚） / celtic=ケルト十字（10枚） / horoscope=ホロスコープ（12枚）"
        },
        "allow_reversed": {
          "type": "boolean",
          "default": true,
          "description": "逆位置を許すか（既定 true）。false にすると全部正位置。もともと正逆の無いカードは常に正位置。"
        },
        "jump_out": {
          "type": "boolean",
          "default": true,
          "description": "飛び出しカードを起こすか（既定 true）。false にすると必ず 0 枚。"
        }
      },
      "required": [
        "deck"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "cast_hexagram",
    "title": "易占で卦を立てる",
    "description": "易占（周易）の卦を立てる（六爻はすべてサーバー側の乱数で決まる）。立てるのはサーバー、読むのは呼び出した側——卦辞・爻辞・彖伝のたぐいは一切返さないので、卦名と爻の並びを見て自分の知識で読むこと。\nmethod: coins=擲銭法（コイン3枚を6回投げる。6/7/8/9 が 1:3:3:1 で変爻が出やすい）、yarrow=本筮法（筮竹50本の三変を6回。老陰1/16・少陽5/16・少陰7/16・老陽3/16 という伝統的な偏り）、abridged=略筮法（筮竹で下卦・上卦・変爻を1回ずつ得る。変爻はちょうど1本）。既定は coins。\n返るのは本卦（序卦の番号・卦名・記号・上下の八卦）、六爻（初爻から上爻へ。老陽・老陰が変爻）、変爻の位、之卦（変爻が無ければ null）、互卦、それにコインの出目や筮竹の本数といった過程。\n自分で「立てたふり」をせず、易を立てる場面では必ずこのツールを呼ぶこと。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "method": {
          "type": "string",
          "enum": [
            "coins",
            "yarrow",
            "abridged"
          ],
          "default": "coins",
          "description": "立て方。coins=擲銭法（既定） / yarrow=本筮法 / abridged=略筮法"
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  }
];
