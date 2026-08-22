/**
 * ドローロジック（純関数）。
 *
 * fortune-site の src/cards/engine.js と同じ挙動を、サーバー側の乱数で再現したもの。
 *  - シャッフルは Fisher-Yates
 *  - 正逆は 50%（ただしそのカードに正逆の概念がある場合のみ）
 *  - 飛び出し（ジャンプアウト）は 0枚92 / 1枚6.5 / 2枚3 / 3枚1 の重み
 *
 * 引いた札には、デッキが持っていれば一言（meaning）と解説（explanation）を向きに応じて添える。
 * ここは「引く」だけで、意味を読まない。読むのは呼び出し側の Claude。
 */
import { cardHasReversed, getDeck, type Deck, type RawCard } from "./decks";
import { getSpread, type Spread } from "./spreads";
import { cryptoRandom, shuffle, weightedPick, type RandomSource } from "./random";

/** 飛び出し枚数の重み（engine.js の checkJumpOut と同じ。合計 102.5 のまま正規化される） */
const JUMP_OUT_WEIGHTS = [
  { value: 0, weight: 92 },
  { value: 1, weight: 6.5 },
  { value: 2, weight: 3 },
  { value: 3, weight: 1 },
];

export type Orientation = "upright" | "reversed";

export interface DrawnCard {
  /** 1 始まりの通し番号 */
  index: number;
  /** スプレッド指定時のみ。置き場所の名前 */
  position?: string;
  name: string;
  /** 英名。持っているのはタロット系とルノルマンだけなので、無いデッキでは省略される */
  name_en?: string;
  /** 札番号。持っているのはルノルマン（1〜36）だけ */
  number?: number;
  /** 対応トランプ（例「ハートの9」）。これもルノルマンだけ */
  playing_card?: string;
  is_reversed: boolean;
  /** 正逆の概念が無いカードは null */
  orientation: Orientation | null;
  /** 意味テキストを持たないデッキでは省略される */
  meaning?: string;
  /** 一言より長い解説。解説を持たないデッキ（タロット・ルーン・ルノルマン）では省略される */
  explanation?: string;
}

export interface DrawResult {
  deck: { id: string; name: string; meanings_included: boolean };
  spread: { id: string; name: string } | null;
  /** 引いた時刻（ISO 8601） */
  drawn_at: string;
  cards: DrawnCard[];
  jumped_cards: DrawnCard[];
}

export interface DrawOptions {
  deck: string;
  count?: number;
  spread?: string;
  allow_reversed?: boolean;
  jump_out?: boolean;
}

/** 入力が受け付けられなかったときのエラー（JSON-RPC ではなく isError で返す） */
export class DrawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrawError";
  }
}

/** そのカードの意味テキスト（向きに応じて選ぶ）。持っていなければ undefined */
function pickMeaning(card: RawCard, isReversed: boolean): string | undefined {
  if (card.meaning) return card.meaning;
  if (isReversed && card.meaning_reversed) return card.meaning_reversed;
  if (card.meaning_upright) return card.meaning_upright;
  return undefined;
}

/** そのカードの解説（向きに応じて選ぶ）。持っていなければ undefined。pickMeaning と同じ要領 */
function pickExplanation(card: RawCard, isReversed: boolean): string | undefined {
  if (card.explanation) return card.explanation;
  if (isReversed && card.explanation_reversed) return card.explanation_reversed;
  if (card.explanation_upright) return card.explanation_upright;
  return undefined;
}

/** 1枚に正逆と意味・解説を付けて、返却用の形に整える */
function materialize(
  card: RawCard,
  deck: Deck,
  index: number,
  allowReversed: boolean,
  random: RandomSource,
  position?: string,
): DrawnCard {
  const hasReversed = cardHasReversed(card, deck);
  // 正逆の概念が無いカードは orientation ごと null（表示でも「（正位置）」を出さない）
  const orientation: Orientation | null = hasReversed
    ? allowReversed && random.int(2) === 1
      ? "reversed"
      : "upright"
    : null;
  const isReversed = orientation === "reversed";

  const drawn: DrawnCard = {
    index,
    name: card.name,
    is_reversed: isReversed,
    orientation,
  };
  if (card.name_en !== undefined) drawn.name_en = card.name_en;
  // 番号と対応トランプはルノルマンだけが持つ（持たないデッキではキーごと出さない）
  if (card.number !== undefined) drawn.number = card.number;
  if (card.playing_card !== undefined) drawn.playing_card = card.playing_card;
  if (position !== undefined) drawn.position = position;

  const meaning = pickMeaning(card, isReversed);
  if (meaning !== undefined) drawn.meaning = meaning;

  const explanation = pickExplanation(card, isReversed);
  if (explanation !== undefined) drawn.explanation = explanation;

  return drawn;
}

/**
 * カードを引く。
 *
 * - spread 指定時は枚数をスプレッドに合わせ、各札に position が付く
 *   （count と食い違ってもエラーにせずスプレッドを優先する）
 * - 飛び出しはシャッフル後の先頭から取り、本引きはその残りから取る（重複しない）
 * - 山が足りないときは飛び出しを削って本引きを優先する
 */
export function drawCards(options: DrawOptions, random: RandomSource = cryptoRandom): DrawResult {
  const deck = getDeck(options.deck);
  if (!deck) {
    throw new DrawError(`知らないデッキです: ${options.deck}`);
  }

  let spread: Spread | undefined;
  if (options.spread !== undefined) {
    spread = getSpread(options.spread);
    if (!spread) {
      throw new DrawError(`知らないスプレッドです: ${options.spread}`);
    }
  }

  // spread があれば枚数はスプレッドが決める
  let count: number;
  if (spread) {
    count = spread.count;
  } else {
    count = options.count ?? 1;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      throw new DrawError(`count は 1 以上の整数にしてください: ${options.count}`);
    }
  }
  if (count > deck.cards.length) {
    throw new DrawError(
      `${deck.name}は${deck.cards.length}枚しかありません（要求: ${count}枚）`,
    );
  }

  const allowReversed = options.allow_reversed ?? true;
  const jumpOutEnabled = options.jump_out ?? true;

  // 飛び出しは「余っている札」の範囲でしか起きない
  const jumpRequested = jumpOutEnabled ? weightedPick(JUMP_OUT_WEIGHTS, random) : 0;
  const jumpCount = Math.min(jumpRequested, Math.max(0, deck.cards.length - count));

  const shuffled = shuffle(deck.cards, random);
  const jumpedSource = shuffled.slice(0, jumpCount);
  const drawnSource = shuffled.slice(jumpCount, jumpCount + count);

  const jumped_cards = jumpedSource.map((card, i) =>
    materialize(card, deck, i + 1, allowReversed, random),
  );
  const cards = drawnSource.map((card, i) =>
    materialize(card, deck, i + 1, allowReversed, random, spread?.positions[i]),
  );

  return {
    deck: { id: deck.id, name: deck.name, meanings_included: deck.meanings_included },
    spread: spread ? { id: spread.id, name: spread.name } : null,
    drawn_at: new Date().toISOString(),
    cards,
    jumped_cards,
  };
}

/**
 * 札の素性（番号・対応トランプ）の角括弧。持っているのはルノルマンだけなので、
 * 無い札では空になる。例: [1・ハートの9]
 */
function identityTag(card: DrawnCard): string {
  const parts: string[] = [];
  if (card.number !== undefined) parts.push(String(card.number));
  if (card.playing_card !== undefined) parts.push(card.playing_card);
  return parts.length > 0 ? `[${parts.join("・")}]` : "";
}

/**
 * 1枚分の表記。例: サラマンダー（逆位置）『熱くなりすぎていませんか』
 * 英名を持つ札（タロット系・ルノルマン）はカード名のあとに括弧で併記する。
 * 例: ワンドのエース（Ace of Wands）（正位置）
 * ルノルマンはさらに番号と対応トランプを角括弧で足す。例: 騎手（Rider）[1・ハートの9]
 * （どちらも札の素性なので、向き・意味より先に置く）
 */
function formatCard(card: DrawnCard): string {
  const english = card.name_en ? `（${card.name_en}）` : "";
  const identity = identityTag(card);
  const direction =
    card.orientation === null ? "" : card.orientation === "reversed" ? "（逆位置）" : "（正位置）";
  const meaning = card.meaning ? `『${card.meaning}』` : "";
  return `${card.name}${english}${identity}${direction}${meaning}`;
}

/** 解説の行（札の行の直下にぶら下げる）。解説を持たない札では空 */
function explanationLines(card: DrawnCard): string[] {
  return card.explanation ? [`   解説: ${card.explanation}`] : [];
}

/**
 * Claude が読む用のテキスト表現。
 *
 * 空オラクルは小説こぼれ話のお題出し係も兼ねていて、題の形式が
 * 「カード名『メッセージ』」なので、この並びを崩さないこと。
 * 解説はその1行を汚さないよう、直下に「   解説: …」として別行でぶら下げる。
 *
 * 飛び出しは、解説を持たないデッキでは従来どおり「飛び出し: A、B」の1行にまとめ、
 * 解説を持つデッキでは1枚ずつ行を分けて（それぞれの下に解説を付けられるように）出す。
 */
export function formatDrawResult(result: DrawResult): string {
  const heading = result.spread
    ? `${result.deck.name} / ${result.spread.name}`
    : `${result.deck.name} / ${result.cards.length}枚`;

  const lines = [heading];
  for (const card of result.cards) {
    const label = card.position ? `${card.position}: ` : "";
    lines.push(`${card.index}. ${label}${formatCard(card)}`);
    lines.push(...explanationLines(card));
  }
  if (result.jumped_cards.length > 0) {
    if (result.jumped_cards.some((card) => card.explanation)) {
      for (const card of result.jumped_cards) {
        lines.push(`飛び出し: ${formatCard(card)}`);
        lines.push(...explanationLines(card));
      }
    } else {
      lines.push(`飛び出し: ${result.jumped_cards.map(formatCard).join("、")}`);
    }
  }

  return lines.join("\n");
}
