import { describe, expect, it } from "vitest";
import { DECK_IDS, getDeck } from "../src/decks";

/** ルノルマンの対応トランプに出そろうはずのスートとランク（4 × 9 = 36 でぴったり） */
const SUITS = ["ハート", "ダイヤ", "スペード", "クラブ"];
const RANKS = ["A", "6", "7", "8", "9", "10", "J", "Q", "K"];

describe("デッキ台帳", () => {
  it("引けるデッキは 6 種（ルノルマンが末尾に増えた）", () => {
    expect(DECK_IDS).toEqual(["sky", "enigma", "tarot", "tarot_full", "rune", "lenormand"]);
  });
});

describe("ルノルマン（手書きの JSON）", () => {
  const deck = getDeck("lenormand")!;

  it("36 枚・正逆なし・意味テキストなし", () => {
    expect(deck).toBeDefined();
    expect(deck.name).toBe("ルノルマン");
    expect(deck.cards).toHaveLength(36);
    expect(deck.has_reversed).toBe(false);
    expect(deck.meanings_included).toBe(false);
  });

  it("札番号は 1〜36 が一つずつ", () => {
    const numbers = deck.cards.map((card) => card.number);
    expect(numbers.every((number) => typeof number === "number")).toBe(true);
    // 並び順そのものが 1〜36（JSON を目で追えるように）
    expect(numbers).toEqual(Array.from({ length: 36 }, (_, i) => i + 1));
    expect(new Set(numbers).size).toBe(36);
  });

  it("対応トランプは 4スート × 9ランクに過不足なし", () => {
    const playingCards = deck.cards.map((card) => card.playing_card);
    expect(playingCards.every((value) => typeof value === "string")).toBe(true);
    expect(new Set(playingCards).size).toBe(36);

    const expected = new Set(
      SUITS.flatMap((suit) => RANKS.map((rank) => `${suit}の${rank}`)),
    );
    expect(new Set(playingCards)).toEqual(expected);
  });

  it("カード名・英名は重複しない", () => {
    expect(new Set(deck.cards.map((card) => card.name)).size).toBe(36);
    expect(new Set(deck.cards.map((card) => card.name_en)).size).toBe(36);
    for (const card of deck.cards) {
      expect(card.name.trim()).not.toBe("");
      expect(card.name_en!.trim()).not.toBe("");
    }
  });

  it("意味テキストも解説も持たない（既知の体系なので名前のみ）", () => {
    for (const card of deck.cards) {
      expect(card.meaning).toBeUndefined();
      expect(card.meaning_upright).toBeUndefined();
      expect(card.meaning_reversed).toBeUndefined();
      expect(card.explanation).toBeUndefined();
      expect(card.explanation_upright).toBeUndefined();
      expect(card.explanation_reversed).toBeUndefined();
      // 正逆はデッキ既定（false）に従う＝カード個別の旗は持たない
      expect(card.has_reversed).toBeUndefined();
    }
  });

  it("番号と対応トランプを持つのはルノルマンだけ", () => {
    for (const deckId of ["sky", "enigma", "tarot", "tarot_full", "rune"]) {
      const other = getDeck(deckId)!;
      expect(other.cards.every((card) => card.number === undefined)).toBe(true);
      expect(other.cards.every((card) => card.playing_card === undefined)).toBe(true);
    }
  });
});
