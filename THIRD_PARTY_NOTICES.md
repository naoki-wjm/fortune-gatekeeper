# 第三者ソフトウェアの表示（THIRD PARTY NOTICES）

このリポジトリには、ほかの方が書いたコードがそのままの形で入っています。どれが誰のもので、どのライセンスで置いてあるのかをここにまとめました。

本体（fortune-gatekeeper が自分で書いた部分）のライセンスは [GNU AGPL-3.0](LICENSE) です。由来と SHA-256 の**正本は [README-ja.md](README-ja.md) の「ライセンス」節**で、この文書はそこに書いてあることを、ライセンス本文つきで並べ直したものです。

---

## 1. OAuth の門（MIT・Cloudflare, Inc.）

対象:

- `src/auth/access-handler.ts`
- `src/auth/workers-oauth-utils.ts`

出どころは Cloudflare の公式デモ `remote-mcp-cf-access`（リポジトリ [`cloudflare/ai`](https://github.com/cloudflare/ai) の `demos/` 配下）です。このリポジトリへは、同じ作者が先に作った保管庫MCPの門番 Worker（vault-gatekeeper）を経由して複製しました。**変えたのは承認画面のブランド文言と import の 1 行だけ**で、ロジックには手を入れていません（差分を追えるようにしてあります）。

ライセンス本文（原文のまま）:

```
MIT License

Copyright (c) 2025 Cloudflare, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## 2. `@cloudflare/workers-oauth-provider`（MIT・Cloudflare, Inc.）

npm から入る唯一のランタイム依存です（[GitHub](https://github.com/cloudflare/workers-oauth-provider)）。リポジトリにソースは同梱しておらず、`package.json` の依存として入ります。ライセンスは MIT で、著作権表示も上の 1. と同じ Cloudflare, Inc. です。

ライセンス本文（原文のまま）:

```
MIT License

Copyright (c) 2025 Cloudflare, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## 3. 天体計算のエンジン（AGPL-3.0）

対象（`src/astro/sweph/` の 3 点。**無改造の複製**です）:

| ファイル | 出どころ | SHA-256 |
|---|---|---|
| `swisseph.wasm` | `sweph-wasm@2.6.9` の `dist/wasm/swisseph.wasm` | `b8edc953c490d073f542fce22a9d50df85169fbb2e5e6573ec064df9d0bf622d` |
| `swisseph.js` | `sweph-wasm@2.6.9` の `dist/wasm/swisseph.js` | `622f30215961d447b028448caf105f78b34b490a0246eae522465bf99bff9a4a` |
| `sweph-wasm.js` | `sweph-wasm@2.6.9` の `dist/index.js` | `69edbea97573aa8171f40728e08d30d7ddd0c25cf3bf2c903e10e76267f33825` |

（同じフォルダの `sweph/wasm/swisseph.js` だけは複製ではなく、こちらで書いた再エクスポートの薄皮です）

- **sweph-wasm**（[GitHub](https://github.com/ptprashanttripathi/sweph-wasm) / [npm 2.6.9](https://www.npmjs.com/package/sweph-wasm/v/2.6.9)、2025-09-09 公開）: AGPL-3.0-or-later。上記 3 点は npm パッケージの `dist/` と SHA-256 が一致します（2026-08-22 照合）。同じバイナリを得たいときは、このバージョンの npm パッケージから取り出してください
- **Swiss Ephemeris**（[Astrodienst AG](https://www.astro.com/swisseph/) / [GitHub](https://github.com/aloistr/swisseph)）: 上の wasm に組み込まれている本体です。バージョンは `swe_version()` の返り値で **2.10.03**。AGPL-3.0 とプロフェッショナルライセンスのデュアルライセンスで、本プロジェクトは **AGPL-3.0 側を選択**しています（本体を AGPL-3.0 にしてあるのはこのためです）

AGPL-3.0 の本文はリポジトリ同梱の [LICENSE](LICENSE) を参照してください。

---

## 4. そのほか

- カードの文言・解説（空オラクル・エニグマオラクルの `meaning` / `explanation`、`meanings/*.json`）は作者（和条門尚樹）の著作物で、コードとは別に権利を保持しています（コードとの関係の整理は README-ja.md の「ライセンス」節に書いてあるとおり）。転載・再利用は別途ご相談ください
- タロット・ルーンのカード名、六十四卦の卦名は古典・共有文化の範疇です
