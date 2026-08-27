/**
 * テスト用の偽 KV（Map 1 枚）。src/astro/store.ts の AstroKv と同じ形。
 * 本物の KVNamespace として渡したいときは `asKvNamespace()` を使う。
 */
import type { AstroKv } from "../../src/astro/store";

export class FakeKv implements AstroKv {
  readonly store = new Map<string, string>();

  /**
   * 1 回の list で返す最大件数（既定 0＝無制限に全部返す）。
   * 正の数を入れると本物の KV と同じく `list_complete: false` ＋ `cursor` で打ち切るので、
   * 呼び出し側がページ送りを回しているかを検算できる（cursor は「何件目から」の数字）。
   */
  pageSize = 0;

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete?: boolean; cursor?: string }> {
    const names = [...this.store.keys()].filter((name) => name.startsWith(options.prefix)).sort();

    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (this.pageSize <= 0) {
      return { keys: names.slice(start).map((name) => ({ name })), list_complete: true };
    }

    const page = names.slice(start, start + this.pageSize);
    const next = start + page.length;
    const keys = page.map((name) => ({ name }));
    if (next >= names.length) return { keys, list_complete: true };
    return { keys, list_complete: false, cursor: String(next) };
  }

  /** Env.ASTRO_KV（KVNamespace）に差し込むための橋渡し */
  asKvNamespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
