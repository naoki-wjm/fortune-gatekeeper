import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { handleMcpRequest } from "../src/mcp";
import { getDeck } from "../src/decks";
import { makeFakeEngine } from "./stubs/fake-engine";
import { FROZEN_CARD_TOOLS } from "./stubs/frozen-card-tools";

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

/**
 * 納甲つきの cast_hexagram を 1 発。
 *
 * worker.fetch は本番の engine（テストでは wasm を読まないスタブ）を渡すので、
 * 中身まで見たいときはハンドラを直に叩いて偽エンジンを注入する
 * （占星術層のテストと同じ流儀。納甲が使うのは太陽黄経ひとつだけ）。
 */
async function castWithEngine(args: Record<string, unknown>): Promise<any> {
  const engine = makeFakeEngine();
  engine.offset = 149.6; // 太陽を 149.6°（申月）に置く
  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 47,
        method: "tools/call",
        params: { name: "cast_hexagram", arguments: args },
      }),
    }),
    { getEngine: async () => engine },
  );
  const text = await response.text();
  return JSON.parse(text).result;
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

  it("instructions に納甲の一文も載る", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 48,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const instructions: string = json.result.instructions;
    expect(instructions).toContain("nakko: true で納甲");
    expect(instructions).toContain("世応");
  });

  it("instructions にアストロダイスの一文も載る", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 18,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const instructions: string = json.result.instructions;
    expect(instructions).toContain("roll_astro_dice");
    expect(instructions).toContain("天体 × 星座 × ハウス");
    // ここでも意味は持たない（読むのは呼び出した側）
    expect(instructions).toContain("意味はあなたの知識で");
  });

  it("instructions にジオマンシーの一文も載る", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 40,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const instructions: string = json.result.instructions;
    expect(instructions).toContain("cast_geomancy");
    expect(instructions).toContain("16 図形の名前と点の並びだけを返す");
    expect(instructions).toContain("意味はあなたの知識で");
  });

  // 公開層には個人データの口を生やさない（誕生日を使う系は鍵つき層だけ、2026-08-22）
  it("instructions は数秘術に触れない（誕生日を使う占いは公開層に置かない）", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 50,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const instructions: string = json.result.instructions;
    expect(instructions).not.toContain("calculate_numerology");
    expect(instructions).not.toContain("数秘");
    expect(instructions).not.toContain("生年月日");
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
  it("6 本のツールを返す", async () => {
    const { json } = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual([
      "list_decks",
      "draw_cards",
      "cast_hexagram",
      "roll_astro_dice",
      "cast_geomancy",
      "moon_calendar",
    ]);

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
      "lenormand",
    ]);
    expect(draw.inputSchema.properties.spread.enum).toEqual([
      "single",
      "two",
      "three",
      "hexagram",
      "celtic",
      "horoscope",
      "grand_tableau",
    ]);
    expect(draw.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(draw.title).toBe("カードを引く");

    const dice = json.result.tools[3];
    expect(dice.title).toBe("アストロダイスを振る");
    expect(dice.inputSchema.properties.count).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 3,
      default: 1,
      description: "何組振るか（既定 1・最大 3）。1 組 = 天体・星座・ハウスのダイス 3 個。",
    });
    expect(dice.inputSchema.required).toBeUndefined();
    expect(dice.inputSchema.additionalProperties).toBe(false);
    expect(dice.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });

    const geomancy = json.result.tools[4];
    expect(geomancy.title).toBe("ジオマンシーのシールドチャートを立てる");
    // 引数なし（母 4 つの乱数だけがサーバー側にあり、呼び出し側に決める余地は無い）
    expect(geomancy.inputSchema.properties).toEqual({});
    expect(geomancy.inputSchema.required).toBeUndefined();
    expect(geomancy.inputSchema.additionalProperties).toBe(false);
    expect(geomancy.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });

  it("ツール定義は凍結（ChatGPT が接続時にキャッシュするので勝手に変えない）", async () => {
    const { json } = await post({ jsonrpc: "2.0", id: 10, method: "tools/list" });
    expect(json.result.tools).toEqual(FROZEN_CARD_TOOLS);
  });

  // スーパーセット化（2026-08-24）の回帰の本丸 ―― 逆方向（公開層への混入）が無いこと
  it("鍵つき層のツールは公開層には無い（tools/list にも tools/call にも）", async () => {
    const { json } = await post({ jsonrpc: "2.0", id: 11, method: "tools/list" });
    const names = json.result.tools.map((tool: { name: string }) => tool.name);
    for (const name of ["save_chart", "calculate_numerology", "shukuyo", "four_pillars", "kyusei"]) {
      expect(names).not.toContain(name);
      const { json: called } = await post({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name, arguments: {} },
      });
      expect(called.result.isError).toBe(true);
      expect(called.result.content[0].text).toContain("知らないツール");
    }
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
    expect(json.result.structuredContent.decks).toHaveLength(6);
    expect(json.result.structuredContent.spreads).toHaveLength(7);
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

  it("list_decks にルノルマンとグランタブローが載る", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 29,
      method: "tools/call",
      params: { name: "list_decks", arguments: {} },
    });
    const decks = json.result.structuredContent.decks as {
      id: string;
      name: string;
      card_count: number;
      has_reversed: boolean | string;
      meanings_included: boolean;
    }[];
    expect(decks.map((deck) => deck.id)).toEqual([
      "sky",
      "enigma",
      "tarot",
      "tarot_full",
      "rune",
      "lenormand",
    ]);
    expect(decks[5]).toEqual({
      id: "lenormand",
      name: "ルノルマン",
      card_count: 36,
      has_reversed: false,
      meanings_included: false,
    });

    const spreads = json.result.structuredContent.spreads as {
      id: string;
      count: number;
      positions: string[];
    }[];
    const grandTableau = spreads.find((spread) => spread.id === "grand_tableau")!;
    expect(grandTableau.count).toBe(36);
    expect(grandTableau.positions).toHaveLength(36);
    expect(grandTableau.positions[0]).toBe("1行1列");
    expect(grandTableau.positions[35]).toBe("5行4列");

    const text: string = json.result.content[0].text;
    expect(text).toContain("- lenormand: ルノルマン / 36枚 / 正逆なし / 意味テキストなし（カード名のみ）");
    // 名前のみの線引きはルノルマンにも及ぶ（案内文の末尾）
    expect(text).toContain("ルノルマンも既知の体系なのでカード名のみ（札番号と対応トランプは添える）。");
  });

  it("draw_cards（lenormand / grand_tableau）は 36 枚に位置と番号を付けて返す", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: {
        name: "draw_cards",
        arguments: { deck: "lenormand", spread: "grand_tableau", jump_out: false },
      },
    });
    expect(json.result.isError).toBeUndefined();
    const structured = json.result.structuredContent;
    expect(structured.deck).toEqual({
      id: "lenormand",
      name: "ルノルマン",
      meanings_included: false,
    });
    expect(structured.spread).toEqual({ id: "grand_tableau", name: "グランタブロー" });

    const cards = structured.cards as {
      position: string;
      name: string;
      name_en: string;
      number: number;
      playing_card: string;
      orientation: string | null;
    }[];
    expect(cards).toHaveLength(36);
    expect(new Set(cards.map((card) => card.number)).size).toBe(36);
    expect(cards.map((card) => card.position)).toContain("5行4列");
    expect(cards.every((card) => card.orientation === null)).toBe(true);
    expect(cards.every((card) => typeof card.playing_card === "string")).toBe(true);

    const lines: string[] = json.result.content[0].text.split("\n");
    expect(lines).toHaveLength(37);
    expect(lines[0]).toBe("ルノルマン / グランタブロー");
    expect(lines[1]).toMatch(/^1\. 1行1列: .+（[A-Za-z]+）\[\d+・.+\]$/);
  });

  it("draw_cards（sky / grand_tableau）は枚数不足で撥ねる", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "draw_cards", arguments: { deck: "sky", spread: "grand_tableau" } },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("空オラクルは16枚しかありません");
    expect(json.result.content[0].text).toContain("36枚");
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

  it("cast_hexagram は nakko を省くと従来どおり（nakko キーが生えない）", async () => {
    for (const args of [{}, { method: "yarrow" }, { nakko: false }]) {
      const { json } = await post({
        jsonrpc: "2.0",
        id: 44,
        method: "tools/call",
        params: { name: "cast_hexagram", arguments: args },
      });
      const result = json.result;
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.nakko).toBeUndefined();
      expect(Object.keys(result.structuredContent)).not.toContain("nakko");
      expect(result.content[0].text).not.toContain("納甲");
    }
  });

  it("cast_hexagram は nakko: true で納甲の構造を返す（偽エンジンを注入）", async () => {
    const result = await castWithEngine({
      nakko: true,
      year: 2026,
      month: 8,
      day: 22,
      hour: 21,
      minute: 30,
    });
    expect(result.isError).toBeUndefined();

    // 卦の側は今までどおり載ったまま
    expect(result.structuredContent.primary.number).toBeGreaterThanOrEqual(1);
    const nakko = result.structuredContent.nakko;
    expect(Object.keys(nakko).sort()).toEqual(
      [
        "moment",
        "pillars",
        "sun_longitude",
        "palace",
        "self_line",
        "other_line",
        "lines",
        ...(result.structuredContent.resulting ? ["changed_lines"] : []),
      ].sort(),
    );
    expect(nakko.moment).toEqual({ local: "2026-08-22T21:30+09:00", utc_offset: 9 });
    // 偽エンジンの太陽は 149.6°（＝申月）に置いてある
    expect(nakko.pillars).toEqual({
      year: { stem: "丙", branch: "午", ganzhi: "丙午" },
      month: { stem: "丙", branch: "申", ganzhi: "丙申" },
      day: { stem: "戊", branch: "辰", ganzhi: "戊辰" },
      hour: { stem: "癸", branch: "亥", ganzhi: "癸亥" },
    });
    expect(nakko.lines).toHaveLength(6);
    expect(Object.keys(nakko.lines[0]).sort()).toEqual(
      ["position", "label", "stem", "branch", "element", "relation", "beast", "is_self", "is_other"].sort(),
    );
    expect(nakko.lines.filter((line: { is_self: boolean }) => line.is_self)).toHaveLength(1);
    expect(nakko.lines.filter((line: { is_other: boolean }) => line.is_other)).toHaveLength(1);
    expect(nakko.palace.name).toMatch(/^[乾兌離震巽坎艮坤]宮$/);
    expect(result.content[0].text).toContain("■ 納甲（断易）");
    expect(result.content[0].text).toContain("丙午年 丙申月 戊辰日 癸亥時");
  });

  it("cast_hexagram は nakko を立てずに日時を渡されたら断る", async () => {
    for (const args of [
      { year: 2026, month: 8, day: 22 },
      { nakko: false, year: 2026, month: 8, day: 22 },
      { utc_offset: 0 },
      { hour: 21 },
    ]) {
      const { json } = await post({
        jsonrpc: "2.0",
        id: 45,
        method: "tools/call",
        params: { name: "cast_hexagram", arguments: args },
      });
      expect(json.result.isError, JSON.stringify(args)).toBe(true);
      expect(json.result.content[0].text).toContain("日時は nakko: true のときだけ使います");
    }
  });

  it("cast_hexagram の日時は一部だけの指定を断る", async () => {
    const result = await castWithEngine({ nakko: true, year: 2026, month: 8 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("year / month / day をそろえて");
  });

  it("worker 経由の nakko: true は本番の天体計算エンジンを呼ぶ（テストではスタブが断る）", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 46,
      method: "tools/call",
      params: { name: "cast_hexagram", arguments: { nakko: true } },
    });
    // index.ts が getEngine を渡しているので、スタブの拒否でエンジンが立ち上がらない。
    // 返るのは**固定文＋参照 ID** で、スタブの言い分（wasm の中身の話）は表に出さない
    // ―― 内部障害の message には何が混ざっているか分からないため（2026-08-27 査読対応）
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("天体計算エンジンを初期化できませんでした");
    expect(json.result.content[0].text).toMatch(/参照ID: [0-9a-f]{8}$/);
    expect(json.result.content[0].text).not.toContain("テスト環境では wasm を読み込みません");
  });

  it("roll_astro_dice は天体×星座×ハウスの組を返す（引数省略で 1 組）", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "roll_astro_dice", arguments: {} },
    });
    const result = json.result;
    expect(result.isError).toBeUndefined();

    // structuredContent は rolls だけ（時刻もメッセージも持たない）
    expect(Object.keys(result.structuredContent)).toEqual(["rolls"]);
    const rolls = result.structuredContent.rolls;
    expect(rolls).toHaveLength(1);
    expect(Object.keys(rolls[0])).toEqual(["planet", "sign", "house"]);
    expect(Object.keys(rolls[0].planet)).toEqual(["name", "symbol", "name_en"]);
    expect(Object.keys(rolls[0].sign)).toEqual(["name", "symbol", "name_en"]);
    expect(Object.keys(rolls[0].house)).toEqual(["number", "name"]);
    expect(rolls[0].house.number).toBeGreaterThanOrEqual(1);
    expect(rolls[0].house.number).toBeLessThanOrEqual(12);

    const lines = result.content[0].text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("アストロダイス / 1組");
    expect(lines[1]).toBe(
      `1. ${rolls[0].planet.symbol} ${rolls[0].planet.name}` +
        ` × ${rolls[0].sign.symbol} ${rolls[0].sign.name}` +
        ` × ${rolls[0].house.name}`,
    );
  });

  it("roll_astro_dice の count で組数が変わる", async () => {
    for (const count of [1, 2, 3]) {
      const { json } = await post({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "roll_astro_dice", arguments: { count } },
      });
      expect(json.result.isError).toBeUndefined();
      expect(json.result.structuredContent.rolls).toHaveLength(count);
      expect(json.result.content[0].text.split("\n")).toHaveLength(count + 1);
      expect(json.result.content[0].text.split("\n")[0]).toBe(`アストロダイス / ${count}組`);
    }
  });

  it("roll_astro_dice の count は 1〜3 の外なら isError", async () => {
    for (const count of [0, 4, -1, 1.5]) {
      const { response, json } = await post({
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: { name: "roll_astro_dice", arguments: { count } },
      });
      expect(response.status).toBe(200);
      expect(json.error).toBeUndefined();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toContain("count は 1 〜 3 の整数にしてください");
    }

    const wrongType = await post({
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: { name: "roll_astro_dice", arguments: { count: "3" } },
    });
    expect(wrongType.json.result.isError).toBe(true);
  });

  it("roll_astro_dice は意味テキストを載せない", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 34,
      method: "tools/call",
      params: { name: "roll_astro_dice", arguments: { count: 3 } },
    });
    expect(json.result.content[0].text).not.toContain("意味");
    expect(json.result.content[0].text).not.toContain("解説");
    expect(JSON.stringify(json.result.structuredContent)).not.toContain("meaning");
  });

  it("cast_geomancy はシールドチャート一式を返す（引数なし）", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "cast_geomancy", arguments: {} },
    });
    const result = json.result;
    expect(result.isError).toBeUndefined();

    const chart = result.structuredContent;
    expect(Object.keys(chart)).toEqual([
      "mothers",
      "daughters",
      "nieces",
      "witnesses",
      "judge",
      "reconciler",
    ]);
    expect(chart.mothers).toHaveLength(4);
    expect(chart.daughters).toHaveLength(4);
    expect(chart.nieces).toHaveLength(4);
    expect(Object.keys(chart.witnesses)).toEqual(["right", "left"]);

    const figures = [
      ...chart.mothers,
      ...chart.daughters,
      ...chart.nieces,
      chart.witnesses.right,
      chart.witnesses.left,
      chart.judge,
      chart.reconciler,
    ] as { latin: string; name: string; lines: number[]; glyph: string }[];
    expect(figures).toHaveLength(16); // 15 図形＋参考の和解者
    for (const figure of figures) {
      expect(Object.keys(figure)).toEqual(["latin", "name", "lines", "glyph"]);
      expect(figure.lines).toHaveLength(4);
      for (const dots of figure.lines) expect([1, 2]).toContain(dots);
      expect(figure.glyph).toBe(figure.lines.map((dots) => (dots === 1 ? "•" : "••")).join("|"));
    }
    // 裁判官の点の総和は必ず偶数
    expect(chart.judge.lines.reduce((sum: number, dots: number) => sum + dots, 0) % 2).toBe(0);

    const lines: string[] = result.content[0].text.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe("ジオマンシー / シールドチャート");
    expect(lines[1]).toContain(`1 ${chart.mothers[0].latin}（${chart.mothers[0].name}）`);
    expect(lines[5]).toBe(
      `裁判官: ${chart.judge.latin}（${chart.judge.name}）${chart.judge.glyph}`,
    );
    expect(lines[6]).toMatch(/^和解者（参考）: /);
    // 意味は載せない
    expect(result.content[0].text).not.toContain("意味");
    expect(JSON.stringify(chart)).not.toContain("meaning");
  });

  it("cast_geomancy は引数を省いても立つ", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "cast_geomancy" },
    });
    expect(json.result.isError).toBeUndefined();
    expect(json.result.structuredContent.mothers).toHaveLength(4);
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

  it("アストロダイスも同じ（roll_astro_dice）", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 27,
      method: "tools/call",
      params: { name: "roll_astro_dice", arguments: { cnt: 2 } },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("未知の引数です: cnt");
    // 正しい綴りが一覧に出る（許可キーはツール定義から作っている）
    expect(json.result.content[0].text).toContain("count");
  });

  it("ジオマンシーは引数を取らないので何を渡しても断る（cast_geomancy）", async () => {
    const { json } = await post({
      jsonrpc: "2.0",
      id: 43,
      method: "tools/call",
      params: { name: "cast_geomancy", arguments: { method: "shield" } },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("未知の引数です: method");
    expect(json.result.content[0].text).toContain("このツールは引数を取りません");
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

    const dice = await post({
      jsonrpc: "2.0",
      id: 28,
      method: "tools/call",
      params: { name: "roll_astro_dice", arguments: { count: 3 } },
    });
    expect(dice.json.result.isError).toBeUndefined();
    expect(dice.json.result.structuredContent.rolls).toHaveLength(3);
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
    const guide = await response.text();
    expect(guide).toContain("fortune-gatekeeper");
    // ツールの列挙は tools/list と食い違わせない
    expect(guide).toContain(
      "list_decks, draw_cards, cast_hexagram, roll_astro_dice, cast_geomancy, moon_calendar",
    );
    expect(guide).toContain("ジオマンシー");
    // 数秘術は鍵つき側なので、案内文でも「ここには無い」としか言わない
    expect(guide).toContain("誕生日を使う占い（数秘術など）は置いていない");
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


describe("公開層の連打の見張り（MCP_RATE_LIMIT）", () => {
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

  function fakeLimiter(success: boolean): { limiter: RateLimit; keys: string[] } {
    const keys: string[] = [];
    const limiter = {
      async limit(options: { key: string }) {
        keys.push(options.key);
        return { success };
      },
    } as unknown as RateLimit;
    return { limiter, keys };
  }

  async function post(env: Parameters<typeof worker.fetch>[1], ip?: string): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ip) headers["cf-connecting-ip"] = ip;
    return worker.fetch(
      new Request(ENDPOINT, { method: "POST", headers, body: JSON.stringify(ping) }),
      env,
    );
  }

  it("見張りが居なければ素通し（テスト環境と同じ）", async () => {
    const response = await post(undefined);
    expect(response.status).toBe(200);
  });

  it("送信元の IP を鍵にして見張りを引き、通れば 200", async () => {
    const { limiter, keys } = fakeLimiter(true);
    const response = await post({ MCP_RATE_LIMIT: limiter } as any, "203.0.113.7");
    expect(response.status).toBe(200);
    expect(keys).toEqual(["203.0.113.7"]);
  });

  it("超えていれば 429 と Retry-After。返事に IP は書かない", async () => {
    const { limiter } = fakeLimiter(false);
    const response = await post({ MCP_RATE_LIMIT: limiter } as any, "203.0.113.7");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe(-32000);
    expect(text).toContain("呼び出しが多すぎます");
    expect(text).not.toContain("203.0.113.7");
  });

  it("見張り自体が失敗したら通す（可用性を優先）", async () => {
    const limiter = {
      async limit() {
        throw new Error("limiter down");
      },
    } as unknown as RateLimit;
    const response = await post({ MCP_RATE_LIMIT: limiter } as any);
    expect(response.status).toBe(200);
  });

  it("POST /mcp 以外（/health）は見張りを引かない", async () => {
    const { limiter, keys } = fakeLimiter(false);
    const response = await worker.fetch(
      new Request("http://localhost/health"),
      { MCP_RATE_LIMIT: limiter } as any,
    );
    expect(response.status).toBe(200);
    expect(keys).toEqual([]);
  });
});
