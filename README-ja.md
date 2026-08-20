# fortune-gatekeeper（占いMCP）

Claude が会話の流れから直接「占いを引ける」ようにする MCP サーバー。Cloudflare Workers の上で動く、一本の直通電話。カード占い（5デッキ）・易占（周易）と、鍵つきの占星術層（ホロスコープ計算）が入っています。

**引く（立てる・計算する）のはサーバー、読むのは Claude。** ここには解釈層がありません。シャッフルも正逆も飛び出しも、易の六爻もサーバー側の乱数（`crypto.getRandomValues`）で決めて、その結果だけを返します。LLM に引かせると「引いたふり」ができてしまうので、乱数だけは渡さない、という設計です。

カード層と易占には守るべき API キーもコストも無いので、認証・アクセス制御を持ちません（誰が呼んでも同じ答えが返ります）。占星術層だけは「誰のチャートか」を分ける必要があるため、URL に鍵を載せます（後述）。

## デッキ

| id | 名前 | 枚数 | 正逆 | 意味テキスト | 解説 |
|---|---|---|---|---|---|
| `sky` | 空オラクル | 16 | なし | あり | あり |
| `enigma` | エニグマオラクル | 32 | あり | あり | あり（正逆それぞれ） |
| `tarot` | タロット大アルカナ | 22 | あり | **なし**（カード名のみ） | なし |
| `tarot_full` | タロット（78枚） | 78 | あり | **なし**（カード名のみ） | なし |
| `rune` | ルーン（エルダーフサルク） | 25 | カードによる | **なし**（カード名のみ） | なし |

易占（周易）はデッキではなく別ツール（[`cast_hexagram`](#cast_hexagram)）です。六十四卦から1卦を立てて**卦名・番号・記号・爻の並びだけ**を返し、卦辞・爻辞は同梱しません。

### なぜデッキで厚さが違うか

空オラクルとエニグマオラクルは、このサーバーの作者（和条門尚樹）の自作オラクルデッキです。世に出回っていない＝**LLM の学習データに無い**ので、サーバー側が一言と解説を持って渡さないと Claude は読みようがありません。だから2デッキだけ中身が厚い。

逆にタロット・ルーン・易の六十四卦は広く知られた体系で、Claude が自分の知識で読めます。こちらはカード名（卦名）だけを返し、意味は同梱しません。権利の線引き（`PUBLIC_MEANINGS`）とも向きが揃っていて、**知られているものは名前だけ、知られていないものは意味ごと**、という一本の理屈になっています。この線引きは `initialize` の `instructions`・`list_decks` の案内文・`draw_cards` の説明文の3箇所に書いてあるので、Claude 側もそのつもりで読みます。

「意味テキスト」は一言（`meaning` / `meaning_upright` / `meaning_reversed`）、「解説」はそれより長い一段落（`explanation` / `explanation_upright` / `explanation_reversed`）。解説の素材は `meanings/` にあります（後述）。

`tarot_full` は大アルカナ22枚＋小アルカナ56枚のフルデッキ。素材は `tarot-major.json` と `tarot-minor.json` の2枚で、`decks.ts` が読み込み時に合成します（枚数が 78 にならなければその場で落ちる）。小アルカナ単体は引けるデッキとして出していません。

タロットとルーンは意味テキストの出自確認が済むまで公開版に載せません。カード名と正逆だけが返るので、そこは Claude 自身の知識で読みます。可否の管理は `scripts/sync-decks.mjs` 冒頭の `PUBLIC_MEANINGS` 一箇所。

空オラクルは小説こぼれ話のお題出し係も兼ねていて、題の形式が「カード名『メッセージ』」です。テキスト出力はこの形を崩さないようにしてあります。

## スプレッド

`single`（1枚引き）/ `two`（2枚引き・Yes-No）/ `three`（3枚引き・過去現在未来）/ `hexagram`（6枚）/ `celtic`（ケルト十字・10枚）/ `horoscope`（ホロスコープ・12枚）

## ツール

### `list_decks`

引数なし。デッキ一覧（id / name / card_count / has_reversed / meanings_included）とスプレッド一覧（id / name / count / positions）を返す。

### `draw_cards`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `deck` | enum（必須） | — | `sky` / `enigma` / `tarot` / `tarot_full` / `rune` |
| `count` | integer | 1 | 引く枚数。デッキ枚数を超えるとエラー |
| `spread` | enum | — | 指定すると枚数が固定され、各札に位置が付く（`count` より優先） |
| `allow_reversed` | boolean | true | false で全部正位置。もともと正逆の無いカードは常に正位置 |
| `jump_out` | boolean | true | 飛び出しカード。false で必ず 0 枚 |

飛び出し（ジャンプアウト）はシャッフル中に落ちた札の再現で、0枚92 / 1枚6.5 / 2枚3 / 3枚1 の重みで 0〜3 枚。本引きとは別枠で、札は重複しません（山が足りないときは飛び出しを削って本引きを優先）。

テキスト出力の形:

```
空オラクル / 3枚引き
1. 過去: 星空『自分を甘やかして、ゆっくり寝る時間です』
   解説: 星空のオラクルが示すのは空に瞬く星々、つまり気持ちのいい夜の象徴です。……
2. 現在: 霧『心の奥底の望みに耳を傾けましょう』
   解説: 五里霧中、周りの雑音が煩わしくても、だからこそ深く深く潜りましょう。……
3. 未来: 虹『今までの頑張りが報われるでしょう』
   解説: 虹のオラクルが示すのは、雨が上がった爽やかな空、夢への架け橋。……
飛び出し: 雷『サプライズがあるかもしれません』
   解説: 晴天の霹靂、とはよく言ったもの。何か、サプライズがあるかもしれません。……
```

解説を持つデッキでは、札の行の直下に `   解説: …`（半角スペース3つ）が1行ぶら下がります。**お題形式「カード名『メッセージ』」の行はそのまま**で、解説は別行に逃がしてあります。飛び出しも解説があるときだけ1枚ずつ行を分け、解説を持たないデッキ（タロット・ルーン）では従来どおり `飛び出し: 月（逆位置）、星（正位置）` の1行にまとまります。

同じ内容が `structuredContent` にも構造化されて載ります（各札の `explanation`。解説を持たないデッキではキーごと省かれます）。

### `cast_hexagram`

易占（周易）の卦を立てます。**立てるのはサーバー、読むのは Claude。** 卦辞・爻辞・彖伝のたぐいは一切返しません——返るのは卦名・番号・記号・爻の並びだけで、そこから先は Claude 自身の知識で読みます（六十四卦の名前は古典なので、ここに置いても権利の心配はありません）。

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `method` | enum | `coins` | 立て方。`coins` / `yarrow` / `abridged` |

3つの立て方は「どのくらい変爻が出るか」が違います。手順ごとシミュレートしているので、確率表から答えを直接引くのではなく、コインの表裏や筮竹の本数も過程として返ります。

| id | 名前 | 手順 | 6/7/8/9 の出方 |
|---|---|---|---|
| `coins` | 擲銭法 | コイン3枚を6回投げる（表=3・裏=2 の合計） | 1:3:3:1。手軽で変爻が出やすい |
| `yarrow` | 本筮法 | 筮竹50本の三変を6回（49本を二分→掛一→左右を4本ずつ数える） | 老陰1/16・少陽5/16・少陰7/16・老陽3/16 の伝統的な偏り |
| `abridged` | 略筮法 | 筮竹で下卦（mod 8）・上卦（mod 8）・変爻（mod 6）を1回ずつ | 変爻はちょうど1本 |

返り値（`structuredContent`）は `method` / `cast_at` / `lines`（初爻から上爻へ6本。`position` `value`(6〜9) `yin_yang` `changing` `label`＝初九・六二…、それに立て方ごとの過程）/ `primary`（本卦：序卦の番号・卦名・Unicode 記号・上下の八卦）/ `changing_lines` / `resulting`（之卦。変爻が無ければ `null`）/ `nuclear`（互卦）。略筮法だけは過程が卦単位なので、爻ではなく `abridged` に載ります。

テキスト出力の形:

```
易（擲銭法）
本卦: 第3卦 水雷屯 ䷂（上: 坎☵ 水 / 下: 震☳ 雷）
爻: 初九（老陽・変） 六二 六三 六四 九五 上六
変爻: 初爻
之卦: 第8卦 水地比 ䷇
互卦: 第23卦 山地剝 ䷖
出目: 3+3+3, 3+3+2, 3+3+2, 3+3+2, 3+2+2, 3+3+2
```

`（老陽・変）` が付くのは変爻だけ。変爻が無いときは `変爻: なし` で止まり、**之卦の行そのものが出ません**。最後の1行は過程のまとめで、本筮法なら `筮竹: 5-4-4→36, …`（三変で除いた本数→残り）、略筮法なら `筮竹: 下卦 4→4, 上卦 6→6, 変爻 1→1` になります。

六十四卦の表は `src/hexagrams.ts` の静的データ（番号・卦名・上下の八卦・記号）。爻のビット列（初爻が bit0・陽=1）で 0〜63 と 1 対 1 に対応させてあり、表の正しさ（64個・番号一意・記号が `U+4DC0+(番号-1)`・序卦が2つずつ対）はテストで固定しています。

## 占星術層（`POST /mcp/<鍵>`・招かれた人だけ）

カード層とは別の入口で、ホロスコープ（西洋占星術）の天体計算をします。**計算するのはサーバー、読むのは Claude。** 返るのは天体の黄経・ハウス・アスペクトといった座標と角度だけで、「射手座の人は〜」のたぐいの解釈は一切持ちません。エンジンは Swiss Ephemeris の wasm（Moshier モード＝天文暦ファイル不要）で、`src/astro/engine.ts` が唯一の窓口です。

**原本レス**が背骨です。`save_chart` に渡した出生日時・出生地は計算に使ったあと捨て、KV に残るのは計算済みの座標（天体の黄経と速度・ハウスカスプ・ASC/MC・ラベル・ハウス方式・登録日時）だけ。そのぶんハウス方式を変えたいときは登録し直しになります。例外は「いつもの場所」（`default_lat` / `default_lng`）で、これはリターン図を立てる土地として本人が明示的に預けたものです。

例外がもう1つ。**二次進行（`progressions`）だけは出生の原本が要る**ので、原本を Workers Secret（`OWNER_NATAL`）に預けた本人の URL でしか動きません。それでも返却テキストに出生日時・出生地の数値は出しません。

### 鍵（URL キー方式）

カード層と違って、こちらは誰の chart_id かを分ける必要があるので、URL の末尾に鍵を載せます。`POST /mcp/<鍵>` の鍵を KV の台帳（`key:<鍵>` → `{user, name, role}`）と突き合わせ、載っていなければ 401。**鍵そのものはレスポンスにもログにも出しません**（照合に失敗しても「確認できませんでした」としか言いません）。役どころは `owner` と `friend` の2つで、違いは `progressions` を使えるかどうかだけです。

### ツール（8本）

| ツール | 中身 |
|---|---|
| `save_chart` | 出生データからネイタルチャートを計算し `chart_id` を発行。**出生日時・出生地は保存しない** |
| `list_charts` | 登録済みチャートの一覧（chart_id / ラベル / ハウス方式 / いつもの場所 / 登録日時） |
| `delete_chart` | 登録の取り消し（原本が無いので戻せない） |
| `update_default_location` | 「いつもの場所」だけの差し替え（引っ越したとき）。出生データの再入力は不要で、保存済みの座標には触らない。`clear: true` で削除 |
| `transit` | 指定時刻（省略時は現在）の天体・ネイタルのカスプで見た在ハウス・ネイタルへのアスペクト |
| `lunar_return` | ネイタルの月に空の月が戻る瞬間（約27.3日に1回）とその図。`year`/`month` を指定するとその月のぶんを**すべて**（2回入る月もある）、省略すると次の1回 |
| `solar_return` | ネイタルの太陽に空の太陽が戻る瞬間（年に1回）とその図。`year` 省略で次の1回 |
| `progressions` | 二次進行（一日一年法）。進行天体・進行 ASC/MC・ネイタルへのアスペクト。**原本を預けた本人専用** |

アスペクトはメジャー5種（合・セクスタイル・スクエア・トライン・オポジション）・オーブ 1°。ハウス方式は P（プラシーダス）/ K（コッホ）/ W（ホールサイン）/ E（イコール）。天体は太陽から冥王星までの10個＋ノース ノード（真）の11個です。

リターンの瞬間は総当たりで探さず、Swiss Ephemeris の `swe_mooncross_ut` / `swe_solcross_ut` で一発で出します。⚠ ただし wrapper（`src/astro/sweph/sweph-wasm.js`・無改造コピー）のこの2メソッドはエラーチェックが壊れていて（返り値ではなく flags 引数を見ている）失敗しても throw しません。そこで `src/astro/returns.ts` の `crossUt` が「返ってきた jd が探索開始より後か」を必ず検算しています。

進行 ASC / MC はソーラーアークで動かした MC から ARMC を出し、`swe_houses_armc` で立てます（`astro-viewer` の `viewer/calc.js` の作法をそのまま移植）。

### 立ち上げ（KV・Secret・鍵の発行）

```bash
# 1) 台帳になる KV namespace を作る（出力された id を wrangler.jsonc に差し替え）
npx wrangler kv namespace create ASTRO_KV

# 2) 出生の原本を預ける（progressions を使う場合だけ。JSON 1 行を貼り付ける）
#    {"user":"owner","year":1990,"month":6,"day":15,"hour":12,"minute":0,
#     "utc_offset":9,"lat":35.6895,"lng":139.6917,"house_system":"P"}
npx wrangler secret put OWNER_NATAL

# 3) 鍵を発行して台帳に載せる（鍵は推測されない長さで。URL に載るので [A-Za-z0-9_-] 6〜128 文字）
KEY=$(openssl rand -hex 16)
npx wrangler kv key put --binding ASTRO_KV "key:$KEY" \
  '{"user":"owner","name":"オーナー","role":"owner"}' --remote
echo "https://fortune-mcp.my-sky.blue/mcp/$KEY"

# 友人用（progressions は使えない）
npx wrangler kv key put --binding ASTRO_KV "key:<別の鍵>" \
  '{"user":"tomodachi","name":"ともだち","role":"friend"}' --remote
```

ローカル開発では `--remote` を `--local` に替えると `.wrangler/state` 配下のローカル KV に入ります（`wrangler dev` が読むのはこちら）。原本のローカル版は `.dev.vars` の `OWNER_NATAL`（git 管理外・中身はダミー）。

疎通確認とツールの呼び出し:

```bash
curl -s http://localhost:8789/mcp/$KEY \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s http://localhost:8789/mcp/$KEY \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lunar_return","arguments":{"chart_id":"<ID>","utc_offset":9}}}'
```

Claude への登録も鍵つき URL で:

```bash
claude mcp add --transport http fortune-astro https://fortune-mcp.my-sky.blue/mcp/<鍵>
```

## 構成

```
fortune-gatekeeper/
  src/index.ts          … 入り口（ルーティング・CORS・最外殻の例外処理）
  src/mcp.ts            … JSON-RPC / MCP ハンドラ・ツール定義
  src/draw.ts           … ドローロジック（純関数）とテキスト整形
  src/iching.ts         … 易の立筮（純関数。擲銭法・本筮法・略筮法）とテキスト整形
  src/hexagrams.ts      … 六十四卦・八卦の台帳（卦名と記号だけ。卦辞・爻辞は持たない）
  src/decks.ts          … デッキ台帳（JSON を静的 import）
  src/spreads.ts        … スプレッド台帳
  src/random.ts         … 偏りのない乱数・シャッフル・重み付き抽選
  src/data/*.json       … デッキ（生成物・手で編集しない）
  meanings/*.json       … 解説（explanation）の素材。空・エニグマの2枚
  scripts/extract_fortune.py … dic_fortune.txt → meanings/*.json の変換（Python）
  scripts/sync-decks.mjs … デッキ同期＋解説の合成＋意味テキストの剥がし
  src/astro/astro-mcp.ts … 占星術層の MCP ハンドラ（鍵つき入口・ツール7本）
  src/astro/chart.ts    … 天体計算とテキスト整形（純関数寄り。エンジンは引数で受け取る）
  src/astro/returns.ts  … リターン（月・太陽）の一発計算と二次進行
  src/astro/store.ts    … KV の台帳（鍵とチャート）
  src/astro/engine.ts   … Swiss Ephemeris の wasm を読む唯一の窓口
  src/astro/sweph/*     … sweph-wasm 一式（astro-viewer からの無改造コピー。手を入れない）
  test/*.test.ts        … vitest
```

ランタイム依存はゼロ（MCP SDK も使っていません）。カード層はバインディングも無し。占星術層だけが KV（`ASTRO_KV`）と Secret（`OWNER_NATAL`）を使います。

## 動かし方

```bash
npm install
npm run sync:decks     # fortune-site からデッキを取り直す（素材の正本は向こう側）
npm test               # vitest
npm run type-check     # tsc --noEmit
npm run dev            # wrangler dev（http://localhost:8789）
npm run deploy         # wrangler deploy（Cloudflare Workers）
```

`wrangler dev` の疎通確認:

```bash
curl -s http://localhost:8789/                # 案内文
curl -s http://localhost:8789/health          # ok

curl -s http://localhost:8789/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s http://localhost:8789/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"draw_cards","arguments":{"deck":"sky","spread":"three"}}}'

curl -s http://localhost:8789/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cast_hexagram","arguments":{"method":"yarrow"}}}'
```

## エンドポイント

| メソッド・パス | 中身 |
|---|---|
| `POST /mcp` | MCP（JSON-RPC 2.0・Streamable HTTP・ステートレス） |
| `POST /mcp/<鍵>` | 占星術層の MCP（鍵が台帳に無ければ 401） |
| `GET /` | 案内文（プレーンテキスト） |
| `GET /health` | `ok` |
| `GET` / `DELETE` `/mcp` | 405（SSE ストリームもセッションも持たないため） |
| `OPTIONS` | CORS プリフライト |

ステートレスなので `Mcp-Session-Id` は発行しません。

## Claude への登録

```bash
# ローカル開発用
claude mcp add --transport http fortune-gatekeeper http://localhost:8789/mcp

# デプロイ後
claude mcp add --transport http fortune-gatekeeper https://fortune-mcp.my-sky.blue/mcp
```

### ChatGPT 側の注意（ツール定義のキャッシュ）

ChatGPT はコネクタ接続時に `tools/list` の結果（ツール名・説明・`deck` の enum）を取り込んで保持し、その後はサーバー側を更新しても取り直しません（`tools/call` しか飛んでこない）。スマホ版の再接続・アプリの入れ直しでも更新されず、取り直せるのは **Web 版の 設定 → プラグイン → 占いMCP → 情報 → 「更新する」** だけです（2026-08-19 tarot_full 追加時に判明）。デッキやツールを増やしたら、デプロイ後にこのボタンを押すこと。

**`cast_hexagram` の追加（2026-08-19）でツール定義が変わりました。**`draw_cards` の説明文にもデッキの厚さの理由を1文足しているので、デプロイ後に「更新する」を押さないと ChatGPT 側からは易占ツールが見えません。テスト側では `test/mcp.test.ts` 末尾の `FROZEN_TOOLS` が `tools/list` の返り値を丸ごと凍結しているので、うっかり文言を変えるとそこが赤くなります（意図して変えたときだけ literal を更新 → デプロイ → 「更新する」）。

## 解説（`meanings/`）の更新

`src/data/*.json` は**2つの素材の合成物**です。

| 中身 | 正本 | 直す場所 |
|---|---|---|
| カード名・一言（`meaning` 系） | `fortune-site/src/data/*.json` | fortune-site 側 |
| 解説（`explanation` 系） | 占いゴーストの里々辞書 `dic_fortune.txt` | このリポの `meanings/*.json` |

`meanings/` の中身は、`dic_fortune.txt` からカードごとの解説を抽出した JSON です（`sky_meanings.json` は16枚 `{name, message, explanation}`、`enigma_meanings.json` は32枚 `{name, upright:{…}, reversed:{…}}`）。**使うのは `explanation` だけ**で、同梱の `message` は読み捨てます —— 一言の正本は fortune-site 側（体言止め）で、`meanings` 側の `message` はですます調の別物だからです。

更新手順は、`dic_fortune.txt` を直したあと変換スクリプト（`scripts/extract_fortune.py`）で `meanings/` を作り直して同期:

```bash
python scripts/extract_fortune.py <dic_fortune.txt のパス>   # meanings/*.json を上書き
npm run sync:decks
npm test
```

合成はカード名の突合で行い、**名前が見つからない・余る・解説が空**のときはその場で落ちます（生成物が黙ってズレないように）。解説を足しても `tools/list` のツール定義は変わらないので、ChatGPT 側の「更新する」操作は要りません。

## 注意

- `src/data/*.json` は生成物。カード名・一言を直したいときは `fortune-site` 側、解説を直したいときは `meanings/` 側を直して `npm run sync:decks`
- デッキ JSON のスキーマは統一されていません（`sky` は `meaning`、`enigma` / `tarot` は `meaning_upright` / `meaning_reversed`、`rune` はカード個別の `has_reversed` を持ち、正逆の無い札は `meaning`）。`decks.ts` の `cardHasReversed` と `draw.ts` の `pickMeaning` / `pickExplanation` がその差を吸収します
- `name_en`（カードの英名）を持つのはタロット系（`tarot` / `tarot_full`）だけです。意味テキストではないので意味を剥がしたデッキにも残り、引いた札の `name_en` とテキスト出力の括弧併記（例: `ワンドのエース（Ace of Wands）（正位置）`）になります。持たないデッキではキーごと省かれます
- 設計判断の背骨は3本: **乱数と天体計算はサーバー側で**（LLM に「引いたふり」「計算したふり」をさせない）、**解釈層を持たない**（読むのは会話中の LLM）、**権利の門番**（知られている体系は名前だけ、自作デッキは意味ごと。占星術層は原本レス）

## ライセンス

- **コード**: [GNU AGPL-3.0](LICENSE)。同梱している [Swiss Ephemeris](https://www.astro.com/swisseph/)（Astrodienst AG）が AGPL-3.0 とプロフェッショナルライセンスのデュアルライセンスであり、本プロジェクトは AGPL-3.0 側を選択しています。`src/astro/sweph/` の wasm ビルドと JS ラッパーは [sweph-wasm](https://github.com/ptprashanttripathi/sweph-wasm) 由来（無改造）、その元は [Swiss Ephemeris](https://github.com/aloistr/swisseph) です
- **カードの文言・解説**（空オラクル・エニグマオラクルの `meaning` / `explanation`、`meanings/*.json`）: 作者（和条門尚樹）の著作物で、コードとは別に権利を保持します（単純併存＝mere aggregation であり AGPL の対象外）。デッキテキストの転載・再利用は別途ご相談ください
- タロット・ルーンのカード名、六十四卦の卦名は古典・共有文化の範疇です
