import { describe, expect, it } from "vitest";
import { DrawError, drawCards, formatDrawResult, type DrawResult } from "../src/draw";
import { getDeck } from "../src/decks";
import type { RandomSource } from "../src/random";

/** 常に下限を返す乱数源（正位置固定・飛び出し 0 枚になる） */
const alwaysZero: RandomSource = { int: () => 0 };
/** 常に上限を返す乱数源（逆位置固定・飛び出し 3 枚になる） */
const alwaysMax: RandomSource = { int: (max) => max - 1 };

describe("drawCards", () => {
  it("引いた札は重複しない（飛び出しとも被らない）", () => {
    for (let i = 0; i < 200; i++) {
      const result = drawCards({ deck: "enigma", count: 10 });
      const names = [...result.cards, ...result.jumped_cards].map((card) => card.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("count の枚数だけ引く", () => {
    const result = drawCards({ deck: "tarot", count: 5 });
    expect(result.cards).toHaveLength(5);
    expect(result.cards.map((card) => card.index)).toEqual([1, 2, 3, 4, 5]);
    expect(result.spread).toBeNull();
  });

  it("count 未指定なら 1 枚", () => {
    const result = drawCards({ deck: "sky" });
    expect(result.cards).toHaveLength(1);
  });

  it("spread を指定すると枚数が固定され position が付く", () => {
    const result = drawCards({ deck: "sky", spread: "three" });
    expect(result.spread).toEqual({ id: "three", name: "3枚引き" });
    expect(result.cards).toHaveLength(3);
    expect(result.cards.map((card) => card.position)).toEqual(["過去", "現在", "未来"]);
  });

  it("spread と count が食い違ったら spread を優先する（エラーにしない）", () => {
    const result = drawCards({ deck: "enigma", spread: "hexagram", count: 99 });
    expect(result.cards).toHaveLength(6);
  });

  it("空オラクルは常に正位置（orientation は null）", () => {
    for (let i = 0; i < 50; i++) {
      const result = drawCards({ deck: "sky", count: 5 });
      for (const card of [...result.cards, ...result.jumped_cards]) {
        expect(card.is_reversed).toBe(false);
        expect(card.orientation).toBeNull();
      }
    }
  });

  it("エニグマは allow_reversed=false で全部正位置", () => {
    for (let i = 0; i < 50; i++) {
      const result = drawCards({ deck: "enigma", count: 8, allow_reversed: false });
      for (const card of [...result.cards, ...result.jumped_cards]) {
        expect(card.is_reversed).toBe(false);
        expect(card.orientation).toBe("upright");
      }
    }
  });

  it("エニグマは allow_reversed 既定なら逆位置も出る", () => {
    const result = drawCards({ deck: "enigma", count: 32 }, alwaysMax);
    expect(result.cards.every((card) => card.orientation === "reversed")).toBe(true);
  });

  it("ルーンの個別 has_reversed=false のカードは正位置固定", () => {
    const deck = getDeck("rune");
    expect(deck).toBeDefined();
    const fixedNames = new Set(
      deck!.cards.filter((card) => card.has_reversed === false).map((card) => card.name),
    );
    expect(fixedNames.size).toBeGreaterThan(0);

    // 山ぜんぶ引いて全カードを一度に確かめる（逆位置が出やすい乱数源で）
    const result = drawCards({ deck: "rune", count: deck!.cards.length, jump_out: false }, alwaysMax);
    for (const card of result.cards) {
      if (fixedNames.has(card.name)) {
        expect(card.orientation).toBeNull();
        expect(card.is_reversed).toBe(false);
      } else {
        expect(card.orientation).toBe("reversed");
      }
    }
  });

  it("jump_out=false なら飛び出しは 0 枚", () => {
    for (let i = 0; i < 100; i++) {
      const result = drawCards({ deck: "enigma", count: 3, jump_out: false });
      expect(result.jumped_cards).toHaveLength(0);
    }
  });

  it("飛び出しが出るときは本引きとは別枠で最大 3 枚", () => {
    const result = drawCards({ deck: "enigma", count: 3 }, alwaysMax);
    expect(result.jumped_cards).toHaveLength(3);
    expect(result.cards).toHaveLength(3);
    expect(result.jumped_cards.every((card) => card.position === undefined)).toBe(true);
  });

  it("山が足りないときは飛び出しを削って本引きを優先する", () => {
    // 空オラクルは 16 枚。16 枚引けば飛び出しの余地は無い
    const result = drawCards({ deck: "sky", count: 16 }, alwaysMax);
    expect(result.cards).toHaveLength(16);
    expect(result.jumped_cards).toHaveLength(0);
  });

  it("意味テキストを持たないデッキでは meaning を返さない", () => {
    const tarot = drawCards({ deck: "tarot", count: 3 });
    expect(tarot.deck.meanings_included).toBe(false);
    expect(tarot.cards.every((card) => card.meaning === undefined)).toBe(true);

    const sky = drawCards({ deck: "sky", count: 3 });
    expect(sky.deck.meanings_included).toBe(true);
    expect(sky.cards.every((card) => typeof card.meaning === "string")).toBe(true);
  });

  it("tarot_full は大アルカナ22＋小アルカナ56の78枚", () => {
    const deck = getDeck("tarot_full");
    expect(deck).toBeDefined();
    expect(deck!.name).toBe("タロット（78枚）");
    expect(deck!.cards).toHaveLength(78);

    const result = drawCards({ deck: "tarot_full", count: 78, jump_out: false });
    expect(result.cards).toHaveLength(78);
    // 78 枚すべて別の札（大小を混ぜても重複が無い）
    expect(new Set(result.cards.map((card) => card.name)).size).toBe(78);
    expect(result.cards.some((card) => card.name === "愚者")).toBe(true);
    expect(result.cards.some((card) => card.name === "ワンドのエース")).toBe(true);
    expect(result.cards.some((card) => card.name === "ペンタクルのキング")).toBe(true);
  });

  it("tarot_full は 79 枚だと撥ねる", () => {
    expect(() => drawCards({ deck: "tarot_full", count: 79 })).toThrow(DrawError);
  });

  it("tarot_full は英名（name_en）を返す", () => {
    const result = drawCards({ deck: "tarot_full", count: 78, jump_out: false });
    expect(result.cards.every((card) => typeof card.name_en === "string")).toBe(true);
    expect(result.cards.find((card) => card.name === "愚者")?.name_en).toBe("The Fool");
    expect(result.cards.find((card) => card.name === "ワンドのエース")?.name_en).toBe(
      "Ace of Wands",
    );
  });

  it("英名を持たないデッキでは name_en のキーごと出さない", () => {
    const sky = drawCards({ deck: "sky", count: 3 });
    expect(sky.cards.every((card) => card.name_en === undefined)).toBe(true);
    expect(JSON.stringify(sky)).not.toContain("name_en");
  });

  it("空オラクルは 16 枚すべて解説を持つ（生成物の整合）", () => {
    const deck = getDeck("sky");
    expect(deck!.cards).toHaveLength(16);
    for (const card of deck!.cards) {
      expect(typeof card.explanation).toBe("string");
      expect(card.explanation!.trim()).not.toBe("");
      // 正逆の無いデッキなので向きごとの解説は持たない
      expect(card.explanation_upright).toBeUndefined();
      expect(card.explanation_reversed).toBeUndefined();
    }
  });

  it("エニグマは 32 枚すべて正逆それぞれの解説を持つ（生成物の整合）", () => {
    const deck = getDeck("enigma");
    expect(deck!.cards).toHaveLength(32);
    for (const card of deck!.cards) {
      expect(card.explanation_upright!.trim()).not.toBe("");
      expect(card.explanation_reversed!.trim()).not.toBe("");
      expect(card.explanation).toBeUndefined();
    }
  });

  it("空オラクルは引いた札に解説が付く", () => {
    const result = drawCards({ deck: "sky", count: 5 });
    for (const card of [...result.cards, ...result.jumped_cards]) {
      expect(typeof card.explanation).toBe("string");
      expect(card.explanation).not.toBe("");
    }
  });

  it("エニグマは向きに応じた解説を選ぶ", () => {
    const deck = getDeck("enigma");
    const byName = new Map(deck!.cards.map((card) => [card.name, card]));

    const upright = drawCards({ deck: "enigma", count: 32, jump_out: false }, alwaysZero);
    for (const card of upright.cards) {
      expect(card.orientation).toBe("upright");
      expect(card.explanation).toBe(byName.get(card.name)!.explanation_upright);
    }

    const reversed = drawCards({ deck: "enigma", count: 32, jump_out: false }, alwaysMax);
    for (const card of reversed.cards) {
      expect(card.orientation).toBe("reversed");
      expect(card.explanation).toBe(byName.get(card.name)!.explanation_reversed);
    }

    // 正位置と逆位置で別の文が返っている（同じ札で見比べる）
    const sample = byName.get("サラマンダー")!;
    expect(sample.explanation_upright).not.toBe(sample.explanation_reversed);
  });

  it("解説を持たないデッキでは explanation を返さない", () => {
    for (const deckId of ["tarot", "tarot_full", "rune"]) {
      const result = drawCards({ deck: deckId, count: 10 });
      for (const card of [...result.cards, ...result.jumped_cards]) {
        expect(card.explanation).toBeUndefined();
      }
      expect(JSON.stringify(result)).not.toContain("explanation");
    }
  });

  it("tarot_full は意味テキストを持たない", () => {
    const result = drawCards({ deck: "tarot_full", count: 20 });
    expect(result.deck.meanings_included).toBe(false);
    for (const card of [...result.cards, ...result.jumped_cards]) {
      expect(card.meaning).toBeUndefined();
    }
  });

  it("drawn_at は ISO 8601", () => {
    const result = drawCards({ deck: "sky" });
    expect(result.drawn_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("知らないデッキ・スプレッドは撥ねる", () => {
    expect(() => drawCards({ deck: "oracle" })).toThrow(DrawError);
    expect(() => drawCards({ deck: "sky", spread: "pyramid" })).toThrow(DrawError);
  });

  it("枚数超過・0 以下・小数は撥ねる", () => {
    expect(() => drawCards({ deck: "sky", count: 17 })).toThrow(DrawError);
    expect(() => drawCards({ deck: "sky", count: 0 })).toThrow(DrawError);
    expect(() => drawCards({ deck: "sky", count: -1 })).toThrow(DrawError);
    expect(() => drawCards({ deck: "sky", count: 2.5 })).toThrow(DrawError);
  });

  it("乱数源を差し替えれば結果が決まる（サーバー側で引いている証拠）", () => {
    const a = drawCards({ deck: "sky", count: 3 }, alwaysZero);
    const b = drawCards({ deck: "sky", count: 3 }, alwaysZero);
    expect(a.cards.map((card) => card.name)).toEqual(b.cards.map((card) => card.name));
    expect(a.jumped_cards).toHaveLength(0);
  });
});

describe("formatDrawResult", () => {
  it("空オラクルの題形式「カード名『メッセージ』」を守る", () => {
    const result: DrawResult = {
      deck: { id: "sky", name: "空オラクル", meanings_included: true },
      spread: { id: "three", name: "3枚引き" },
      drawn_at: "2026-08-15T00:00:00.000Z",
      cards: [
        {
          index: 1,
          position: "過去",
          name: "星空",
          is_reversed: false,
          orientation: null,
          meaning: "自分を甘やかして、ゆっくり寝る時間です",
        },
        {
          index: 2,
          position: "現在",
          name: "霧",
          is_reversed: false,
          orientation: null,
          meaning: "心の奥底の望みに耳を傾けましょう",
        },
        {
          index: 3,
          position: "未来",
          name: "虹",
          is_reversed: false,
          orientation: null,
          meaning: "今までの頑張りが報われるでしょう",
        },
      ],
      jumped_cards: [
        {
          index: 1,
          name: "雷",
          is_reversed: false,
          orientation: null,
          meaning: "サプライズがあるかもしれません",
        },
      ],
    };

    expect(formatDrawResult(result)).toBe(
      [
        "空オラクル / 3枚引き",
        "1. 過去: 星空『自分を甘やかして、ゆっくり寝る時間です』",
        "2. 現在: 霧『心の奥底の望みに耳を傾けましょう』",
        "3. 未来: 虹『今までの頑張りが報われるでしょう』",
        "飛び出し: 雷『サプライズがあるかもしれません』",
      ].join("\n"),
    );
  });

  it("正逆のあるカードは（逆位置）を付け、意味の無いデッキは『』を付けない", () => {
    const enigma: DrawResult = {
      deck: { id: "enigma", name: "エニグマオラクル", meanings_included: true },
      spread: null,
      drawn_at: "2026-08-15T00:00:00.000Z",
      cards: [
        {
          index: 1,
          name: "サラマンダー",
          is_reversed: true,
          orientation: "reversed",
          meaning: "熱くなりすぎていませんか",
        },
      ],
      jumped_cards: [],
    };
    expect(formatDrawResult(enigma)).toBe(
      ["エニグマオラクル / 1枚", "1. サラマンダー（逆位置）『熱くなりすぎていませんか』"].join("\n"),
    );

    const tarot: DrawResult = {
      deck: { id: "tarot", name: "タロット大アルカナ", meanings_included: false },
      spread: null,
      drawn_at: "2026-08-15T00:00:00.000Z",
      cards: [{ index: 1, name: "愚者", is_reversed: false, orientation: "upright" }],
      jumped_cards: [],
    };
    expect(formatDrawResult(tarot)).toBe(
      ["タロット大アルカナ / 1枚", "1. 愚者（正位置）"].join("\n"),
    );
  });

  it("英名を持つ札はカード名のあとに括弧で併記する", () => {
    const tarotFull: DrawResult = {
      deck: { id: "tarot_full", name: "タロット（78枚）", meanings_included: false },
      spread: null,
      drawn_at: "2026-08-19T00:00:00.000Z",
      cards: [
        {
          index: 1,
          name: "ワンドのエース",
          name_en: "Ace of Wands",
          is_reversed: false,
          orientation: "upright",
        },
        {
          index: 2,
          name: "愚者",
          name_en: "The Fool",
          is_reversed: true,
          orientation: "reversed",
        },
      ],
      jumped_cards: [],
    };
    expect(formatDrawResult(tarotFull)).toBe(
      [
        "タロット（78枚） / 2枚",
        "1. ワンドのエース（Ace of Wands）（正位置）",
        "2. 愚者（The Fool）（逆位置）",
      ].join("\n"),
    );
  });

  it("実際に引いた tarot_full のテキストにも英名が載る", () => {
    const result = drawCards({ deck: "tarot_full", count: 1, jump_out: false });
    const lines = formatDrawResult(result).split("\n");
    expect(lines[0]).toBe("タロット（78枚） / 1枚");
    expect(lines[1]).toMatch(/^1\. .+（[A-Za-z ]+）（(正|逆)位置）$/);
  });

  it("解説は札の行を汚さず、直下に「   解説: 」でぶら下がる", () => {
    const result: DrawResult = {
      deck: { id: "sky", name: "空オラクル", meanings_included: true },
      spread: null,
      drawn_at: "2026-08-19T00:00:00.000Z",
      cards: [
        {
          index: 1,
          name: "虹",
          is_reversed: false,
          orientation: null,
          meaning: "今までの頑張りが報われるでしょう",
          explanation: "虹のオラクルが示すのは、雨が上がった爽やかな空、夢への架け橋。",
        },
      ],
      jumped_cards: [],
    };

    const lines = formatDrawResult(result).split("\n");
    // お題形式「カード名『メッセージ』」の行はそのまま
    expect(lines[1]).toBe("1. 虹『今までの頑張りが報われるでしょう』");
    expect(lines[2]).toBe(
      "   解説: 虹のオラクルが示すのは、雨が上がった爽やかな空、夢への架け橋。",
    );
  });

  it("飛び出しは、解説があれば1枚ずつ別行・無ければ従来どおり1行", () => {
    const withExplanation: DrawResult = {
      deck: { id: "sky", name: "空オラクル", meanings_included: true },
      spread: null,
      drawn_at: "2026-08-19T00:00:00.000Z",
      cards: [
        { index: 1, name: "太陽", is_reversed: false, orientation: null, meaning: "イケイケです" },
      ],
      jumped_cards: [
        {
          index: 1,
          name: "雷",
          is_reversed: false,
          orientation: null,
          meaning: "サプライズがあるかもしれません",
          explanation: "雷のオラクルは、突然の出来事を告げています。",
        },
        {
          index: 2,
          name: "風",
          is_reversed: false,
          orientation: null,
          meaning: "流れるままに流されましょう",
          explanation: "風のオラクルは、逆らわないことを勧めています。",
        },
      ],
    };
    expect(formatDrawResult(withExplanation)).toBe(
      [
        "空オラクル / 1枚",
        "1. 太陽『イケイケです』",
        "飛び出し: 雷『サプライズがあるかもしれません』",
        "   解説: 雷のオラクルは、突然の出来事を告げています。",
        "飛び出し: 風『流れるままに流されましょう』",
        "   解説: 風のオラクルは、逆らわないことを勧めています。",
      ].join("\n"),
    );

    const withoutExplanation: DrawResult = {
      deck: { id: "tarot", name: "タロット大アルカナ", meanings_included: false },
      spread: null,
      drawn_at: "2026-08-19T00:00:00.000Z",
      cards: [{ index: 1, name: "愚者", is_reversed: false, orientation: "upright" }],
      jumped_cards: [
        { index: 1, name: "月", is_reversed: true, orientation: "reversed" },
        { index: 2, name: "星", is_reversed: false, orientation: "upright" },
      ],
    };
    expect(formatDrawResult(withoutExplanation)).toBe(
      [
        "タロット大アルカナ / 1枚",
        "1. 愚者（正位置）",
        "飛び出し: 月（逆位置）、星（正位置）",
      ].join("\n"),
    );
  });

  it("解説を持たないデッキのテキストには「解説:」が出ない", () => {
    for (const deckId of ["tarot", "tarot_full", "rune"]) {
      const result = drawCards({ deck: deckId, count: 5 });
      expect(formatDrawResult(result)).not.toContain("解説:");
    }
  });

  it("実際に引いた空オラクルのテキストにも解説行が載る", () => {
    const result = drawCards({ deck: "sky", count: 1, jump_out: false });
    const lines = formatDrawResult(result).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("空オラクル / 1枚");
    expect(lines[1]).toMatch(/^1\. [^『]+『[^』]+』$/);
    expect(lines[2]).toMatch(/^   解説: .+$/);
  });

  it("飛び出しが 0 枚なら行ごと出さない", () => {
    const result = drawCards({ deck: "sky", count: 2, jump_out: false });
    expect(formatDrawResult(result)).not.toContain("飛び出し");
    // 見出し1行＋（札の行＋解説の行）×2
    expect(formatDrawResult(result).split("\n")).toHaveLength(5);
  });
});
