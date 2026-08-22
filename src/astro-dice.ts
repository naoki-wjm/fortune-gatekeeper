/**
 * アストロダイス（純関数）。
 *
 * 背骨は draw.ts・iching.ts と同じ ―― 振るのはサーバー、読むのは呼び出した側の Claude。
 * ここは天体・星座・ハウスの 12 面ダイスを 3 個振って、出た面の名前と記号を並べるだけで、
 * 意味テキストも占断も持たない（占星術は広く知られた体系なので、読みは Claude 自身の知識に任せる）。
 *
 * 3 個のダイスはそれぞれ独立に振る（天体が決まっても星座・ハウスの出方は変わらない）。
 * 面の数はどれも 12 なので、同じ組が二度出ることも当然ある ―― 引いた札と違って重複を避けない。
 */
import { cryptoRandom, type RandomSource } from "./random";

/** 天体ダイスの 1 面 */
export interface DicePlanet {
  name: string;
  symbol: string;
  name_en: string;
}

/** 星座ダイスの 1 面 */
export interface DiceSign {
  name: string;
  symbol: string;
  name_en: string;
}

/** ハウスダイスの 1 面 */
export interface DiceHouse {
  /** 1〜12 */
  number: number;
  name: string;
}

/** 天体ダイス 12 面（10 天体＋ノード 2 つ） */
export const DICE_PLANETS: readonly DicePlanet[] = [
  { name: "太陽", symbol: "☉", name_en: "Sun" },
  { name: "月", symbol: "☽", name_en: "Moon" },
  { name: "水星", symbol: "☿", name_en: "Mercury" },
  { name: "金星", symbol: "♀", name_en: "Venus" },
  { name: "火星", symbol: "♂", name_en: "Mars" },
  { name: "木星", symbol: "♃", name_en: "Jupiter" },
  { name: "土星", symbol: "♄", name_en: "Saturn" },
  { name: "天王星", symbol: "♅", name_en: "Uranus" },
  { name: "海王星", symbol: "♆", name_en: "Neptune" },
  { name: "冥王星", symbol: "♇", name_en: "Pluto" },
  { name: "ノースノード", symbol: "☊", name_en: "North Node" },
  { name: "サウスノード", symbol: "☋", name_en: "South Node" },
];

/** 星座ダイス 12 面（牡羊座から。名前は src/astro/chart.ts の SIGNS と同じ表記） */
export const DICE_SIGNS: readonly DiceSign[] = [
  { name: "牡羊座", symbol: "♈", name_en: "Aries" },
  { name: "牡牛座", symbol: "♉", name_en: "Taurus" },
  { name: "双子座", symbol: "♊", name_en: "Gemini" },
  { name: "蟹座", symbol: "♋", name_en: "Cancer" },
  { name: "獅子座", symbol: "♌", name_en: "Leo" },
  { name: "乙女座", symbol: "♍", name_en: "Virgo" },
  { name: "天秤座", symbol: "♎", name_en: "Libra" },
  { name: "蠍座", symbol: "♏", name_en: "Scorpio" },
  { name: "射手座", symbol: "♐", name_en: "Sagittarius" },
  { name: "山羊座", symbol: "♑", name_en: "Capricorn" },
  { name: "水瓶座", symbol: "♒", name_en: "Aquarius" },
  { name: "魚座", symbol: "♓", name_en: "Pisces" },
];

/** ハウスダイス 12 面（第1ハウス〜第12ハウス） */
export const DICE_HOUSES: readonly DiceHouse[] = Array.from({ length: 12 }, (_, index) => ({
  number: index + 1,
  name: `第${index + 1}ハウス`,
}));

/** 1 組ぶんの出目（天体 × 星座 × ハウス） */
export interface AstroDiceRoll {
  planet: DicePlanet;
  sign: DiceSign;
  house: DiceHouse;
}

/** 一度に振れる組数の上限（3 組も出れば読み切れなくなる） */
export const MAX_DICE_COUNT = 3;

/** 入力が受け付けられなかったときのエラー（DrawError・CastError と同じ扱い＝isError で返す） */
export class DiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiceError";
  }
}

/**
 * アストロダイスを振る。
 *
 * 乱数はここでしか回さない（LLM に振らせない）。count を省くと 1 組。
 */
export function rollAstroDice(
  count: number = 1,
  random: RandomSource = cryptoRandom,
): AstroDiceRoll[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_DICE_COUNT) {
    throw new DiceError(`count は 1 〜 ${MAX_DICE_COUNT} の整数にしてください: ${count}`);
  }

  const rolls: AstroDiceRoll[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push({
      planet: DICE_PLANETS[random.int(DICE_PLANETS.length)] as DicePlanet,
      sign: DICE_SIGNS[random.int(DICE_SIGNS.length)] as DiceSign,
      house: DICE_HOUSES[random.int(DICE_HOUSES.length)] as DiceHouse,
    });
  }
  return rolls;
}

/**
 * Claude が読む用のテキスト表現。
 *
 * 意味は載せない ―― 記号つきの名前を「×」でつないだ 1 行だけ渡して、読みは呼び出した側に委ねる。
 */
export function formatAstroDiceText(rolls: readonly AstroDiceRoll[]): string {
  const lines = [`アストロダイス / ${rolls.length}組`];
  rolls.forEach((roll, index) => {
    lines.push(
      `${index + 1}. ${roll.planet.symbol} ${roll.planet.name}` +
        ` × ${roll.sign.symbol} ${roll.sign.name}` +
        ` × ${roll.house.name}`,
    );
  });
  return lines.join("\n");
}
