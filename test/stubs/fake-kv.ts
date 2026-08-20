/**
 * テスト用の偽 KV（Map 1 枚）。src/astro/store.ts の AstroKv と同じ形。
 * 本物の KVNamespace として渡したいときは `asKvNamespace()` を使う。
 */
import type { AstroKv } from "../../src/astro/store";

export class FakeKv implements AstroKv {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options: { prefix: string }): Promise<{ keys: { name: string }[] }> {
    const keys = [...this.store.keys()]
      .filter((name) => name.startsWith(options.prefix))
      .sort()
      .map((name) => ({ name }));
    return { keys };
  }

  /** Env.ASTRO_KV（KVNamespace）に差し込むための橋渡し */
  asKvNamespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
