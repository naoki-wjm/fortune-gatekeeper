/**
 * 乱数まわり。
 *
 * 背骨: 乱数は必ずサーバー側で引く。LLM に引かせると「引いたふり」ができてしまうため、
 * シャッフルも正逆も飛び出しも、全部この場で crypto を回して決める。
 */

/** 差し替え可能な乱数源（テストでは決め打ちの実装を渡す） */
export interface RandomSource {
  /** 0 以上 maxExclusive 未満の整数を返す */
  int(maxExclusive: number): number;
}

/**
 * 0 以上 maxExclusive 未満の偏りのない整数。
 *
 * crypto.getRandomValues の 32bit 値を剰余で潰すと、2^32 が maxExclusive で
 * 割り切れないぶんだけ小さい値が出やすくなる（modulo bias）。
 * そこで割り切れる範囲（ceiling）の外に出た目は捨てて引き直す（棄却サンプリング）。
 */
export function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError(`randomInt には 1 以上の整数が必要です: ${maxExclusive}`);
  }
  if (maxExclusive === 1) return 0;

  const range = 0x1_0000_0000; // 2^32
  const ceiling = Math.floor(range / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);

  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    if (value < ceiling) return value % maxExclusive;
  }
}

/** 既定の乱数源（Workers / Node どちらでも global crypto を使う） */
export const cryptoRandom: RandomSource = {
  int: randomInt,
};

/** Fisher-Yates シャッフル（元の配列は壊さない） */
export function shuffle<T>(items: readonly T[], random: RandomSource = cryptoRandom): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/** 重み付き抽選の 1 項目 */
export interface WeightedEntry<T> {
  value: T;
  weight: number;
}

/** 小数の重みを整数化するときの分解能（0.5 刻みまで扱えれば足りる） */
const WEIGHT_SCALE = 1000;

/**
 * 重み付き抽選。
 * 重みの合計が 100% でなくてもよい（合計で正規化される。飛び出し表は 102.5% ある）。
 */
export function weightedPick<T>(
  entries: readonly WeightedEntry<T>[],
  random: RandomSource = cryptoRandom,
): T {
  if (entries.length === 0) {
    throw new RangeError("weightedPick に空の候補が渡されました");
  }

  const weights = entries.map((entry) => Math.max(0, Math.round(entry.weight * WEIGHT_SCALE)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    throw new RangeError("weightedPick の重みの合計が 0 です");
  }

  let roll = random.int(total);
  for (let i = 0; i < entries.length; i++) {
    roll -= weights[i] as number;
    if (roll < 0) return (entries[i] as WeightedEntry<T>).value;
  }
  // 丸めの都合でここに来ることは無いはずだが、保険として最後の候補を返す
  return (entries[entries.length - 1] as WeightedEntry<T>).value;
}
