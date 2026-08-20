/**
 * スプレッド（並べ方）台帳。
 * fortune-site の src/cards/spreads.js を TypeScript へ移植したもの。内容は同一。
 */

export type SpreadId = "single" | "two" | "three" | "hexagram" | "celtic" | "horoscope";

export interface Spread {
  id: SpreadId;
  name: string;
  /** 引く枚数（positions の数と一致する） */
  count: number;
  /** 各札の置き場所の名前。cards[i].position になる */
  positions: string[];
}

export const SPREADS: readonly Spread[] = [
  { id: "single", name: "1枚引き", count: 1, positions: ["メッセージ"] },
  { id: "two", name: "2枚引き", count: 2, positions: ["Yes/No（原因）", "Yes/No（結果）"] },
  { id: "three", name: "3枚引き", count: 3, positions: ["過去", "現在", "未来"] },
  {
    id: "hexagram",
    name: "ヘキサグラム",
    count: 6,
    positions: ["過去", "現在", "未来", "対策", "周囲の環境", "最終結果"],
  },
  {
    id: "celtic",
    name: "ケルト十字",
    count: 10,
    positions: [
      "現在",
      "障害",
      "過去",
      "未来",
      "顕在意識",
      "潜在意識",
      "自分の立場",
      "周囲",
      "願望",
      "最終結果",
    ],
  },
  {
    id: "horoscope",
    name: "ホロスコープ",
    count: 12,
    positions: [
      "第1ハウス（自分自身）",
      "第2ハウス（お金・価値観）",
      "第3ハウス（知性・コミュニケーション）",
      "第4ハウス（家庭・基盤）",
      "第5ハウス（創造・恋愛）",
      "第6ハウス（健康・労働）",
      "第7ハウス（パートナー）",
      "第8ハウス（変容・共有）",
      "第9ハウス（哲学・旅行）",
      "第10ハウス（社会・キャリア）",
      "第11ハウス（友人・理想）",
      "第12ハウス（無意識・秘密）",
    ],
  },
];

export const SPREAD_IDS: SpreadId[] = SPREADS.map((spread) => spread.id);

/** id からスプレッドを引く（未知の id なら undefined） */
export function getSpread(id: string): Spread | undefined {
  return SPREADS.find((spread) => spread.id === id);
}
