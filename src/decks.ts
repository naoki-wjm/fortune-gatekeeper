/**
 * デッキ台帳。
 *
 * JSON は scripts/sync-decks.mjs が fortune-site（カード名・一言）と meanings/（解説）から
 * 合成したもの（手で編集しない）。
 * 意味テキストを載せてよいデッキと、カード名だけのデッキがある ―― 権利の都合で、
 * タロットとルーンは意味テキストを剥がしてある。読むのは Claude 自身の知識。
 */
import skyOracle from "./data/sky-oracle.json";
import enigmaOracle from "./data/enigma-oracle.json";
import tarotMajor from "./data/tarot-major.json";
import tarotMinor from "./data/tarot-minor.json";
import runeFuthark from "./data/rune-futhark.json";

export type DeckId = "sky" | "enigma" | "tarot" | "tarot_full" | "rune";

/** JSON 側のカード1枚。デッキごとに持つキーが違う（統一スキーマではない） */
export interface RawCard {
  name: string;
  /** タロットだけ持つ英名（意味テキストではないので公開版にも残る） */
  name_en?: string;
  /** ルーンだけ、カード個別に正逆の有無を持つ（デッキ既定より優先） */
  has_reversed?: boolean;
  keyword?: string;
  /** 正逆の無いカード用の意味 */
  meaning?: string;
  meaning_upright?: string;
  meaning_reversed?: string;
  /**
   * 一言（meaning）より長い解説。素材は meanings/*.json（占いゴーストの里々辞書由来）で、
   * 持っているのは意味テキスト同梱のデッキ（空・エニグマ）だけ。
   * 正逆の無いカードは explanation、正逆のあるカードは向きごとの2本を持つ。
   */
  explanation?: string;
  explanation_upright?: string;
  explanation_reversed?: string;
}

/** JSON 側のデッキ1つ */
export interface RawDeck {
  id: DeckId;
  name: string;
  /** true=全札に正逆あり / false=正逆なし / "mixed"=カード個別 */
  has_reversed: boolean | "mixed";
  cards: RawCard[];
}

export interface Deck extends RawDeck {
  /** 意味テキストを同梱しているか（false ならカード名だけ返る） */
  meanings_included: boolean;
}

/** 意味テキストを同梱しているデッキ（sync-decks.mjs の PUBLIC_MEANINGS と対応） */
const MEANINGS_INCLUDED: Record<DeckId, boolean> = {
  sky: true,
  enigma: true,
  tarot: false,
  tarot_full: false,
  rune: false,
};

function toDeck(raw: unknown): Deck {
  const deck = raw as RawDeck;
  return { ...deck, meanings_included: MEANINGS_INCLUDED[deck.id] === true };
}

/**
 * 78枚のフルデッキ（大アルカナ22＋小アルカナ56）を合成する。
 *
 * 小アルカナ単体（tarot_minor）は引けるデッキとして出さず、合成の材料としてだけ使う。
 * 枚数が 78 にならないときは、生成物（src/data）がズレている合図なので早めに落とす。
 */
function buildTarotFull(): Deck {
  const major = tarotMajor as unknown as RawDeck;
  const minor = tarotMinor as unknown as RawDeck;
  const cards = [...major.cards, ...minor.cards];
  if (cards.length !== 78) {
    throw new Error(
      `タロット78枚デッキの枚数が合いません: ${cards.length}枚` +
        `（大アルカナ${major.cards.length}＋小アルカナ${minor.cards.length}）。` +
        "npm run sync:decks で取り直してください",
    );
  }
  return toDeck({ id: "tarot_full", name: "タロット（78枚）", has_reversed: true, cards });
}

export const DECKS: readonly Deck[] = [
  toDeck(skyOracle),
  toDeck(enigmaOracle),
  toDeck(tarotMajor),
  buildTarotFull(),
  toDeck(runeFuthark),
];

export const DECK_IDS: DeckId[] = DECKS.map((deck) => deck.id);

/** id からデッキを引く（未知の id なら undefined） */
export function getDeck(id: string): Deck | undefined {
  return DECKS.find((deck) => deck.id === id);
}

/**
 * そのカードに正逆の概念があるか。
 * カード個別の has_reversed があればそれを優先し、無ければデッキ既定に従う
 * （fortune-site の engine.js の assignReversed と同じ判定）。
 */
export function cardHasReversed(card: RawCard, deck: RawDeck): boolean {
  if (card.has_reversed !== undefined) return card.has_reversed;
  return deck.has_reversed === true;
}
