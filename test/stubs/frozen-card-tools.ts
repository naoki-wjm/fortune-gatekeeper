/**
 * カード層 5 本の tools/list 返り値まるごと（凍結）。
 *
 * クライアント（ChatGPT など）はコネクタ接続時にツール定義を取り込んでキャッシュし、その後
 * サーバー側を直しても取り直さない（更新には Web 版で「更新する」を押してもらう必要がある）。
 * うっかり文言をいじってしまわないよう、ここで丸ごと止めてある。意図して変えたときだけ
 * この literal を更新し、デプロイ後に「更新する」を押してもらうこと。
 *
 * 公開層 `/mcp` と鍵つき層 `/astro/mcp` の両方がカード層の定義をそのまま載せる
 * （スーパーセット構成、2026-08-24）ため、凍結もこの 1 か所で共有する
 * ―― mcp.test.ts と astro-mcp.test.ts の両方から import される。
 *
 * ※ draw_cards の返り値（explanation など）を増やすのは「定義」の変更ではないので、
 *   凍結テストは緑のまま。
 *
 * 更新履歴:
 *   2026-08-22 roll_astro_dice 追加で更新（既存 3 本の定義は 1 文字も変えていない）
 *   2026-08-22 lenormand 追加で更新（list_decks と draw_cards の description・deck の enum・
 *              spread の enum と description。cast_hexagram / roll_astro_dice は無変更）
 *   2026-08-22 cast_geomancy 追加で更新（既存 4 本の定義は 1 文字も変えていない）
 *   2026-08-22 nakko 追加で更新（cast_hexagram の description に 2 段落と、
 *              nakko / year / month / day / hour / minute / utc_offset の 7 引数が増えた。
 *              ほかの 4 本は 1 文字も変えていない）
 *   2026-08-22 calculate_numerology 追加で更新（既存 5 本の定義は 1 文字も変えていない）
 *   2026-08-22 calculate_numerology を削除して 5 本に戻した ―― 数秘は鍵つき層へ移した
 *              （公開層には個人データの口を生やさない、という線引き。
 *              残り 5 本の定義は 1 文字も変えていない）
 *   2026-08-24 mcp.test.ts から この stubs/ へ移動（スーパーセット化で共有するため。
 *              5 本の定義は 1 文字も変えていない）
 *   2026-08-25 moon_calendar（月まわりの暦）を 6 本目として追加。乱数も個人データも無いので
 *              公開層に置いた＝カード層の凍結もここで面倒を見る。
 *              既存 5 本の定義は 1 文字も変えていない
 *   2026-08-27 reverse_horoscope（逆引きホロスコープ）を 7 本目として追加。こちらも乱数なし・
 *              個人データなしなので公開層。既存 6 本の定義は 1 文字も変えていない
 *   2026-08-27 reverse_horoscope の description に「近似探索の限界」と「required 1 本なら 10 年まで」を
 *              追記（year_to の description も）。ほかの 6 本の定義は 1 文字も変えていない
 */
export const FROZEN_CARD_TOOLS = [
  {
    "name": "list_decks",
    "title": "デッキとスプレッドの一覧",
    "description": "引けるカードデッキ（空オラクル／エニグマオラクル／タロット大アルカナ／タロット78枚／ルーン／ルノルマン）と、使えるスプレッド（並べ方）の一覧を返す。draw_cards を呼ぶ前に、どのデッキが意味テキストを持っているか・どのスプレッドが何枚引くかを確かめたいときに使う。",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "draw_cards",
    "title": "カードを引く",
    "description": "カードを実際に引く（シャッフル・正逆・飛び出しはすべてサーバー側の乱数で決まる）。このツールは解釈をしない——引いた結果を返すだけなので、読み解きは呼び出した側で行うこと。\nデッキ: sky=空オラクル（16枚・正逆なし・意味テキストあり）、enigma=エニグマオラクル（32枚・正逆あり・意味テキストあり）、tarot=タロット大アルカナ（22枚・正逆あり・意味テキストなし）、tarot_full=タロット78枚（大アルカナ22＋小アルカナ56・正逆あり・意味テキストなし）、rune=ルーン エルダーフサルク（25枚・正逆はカードによる・意味テキストなし）、lenormand=ルノルマン（36枚・正逆なし・意味テキストなし）。\nsky と enigma はこのサーバーの作者の自作オラクルデッキ（学習データに無い）なので一言＋解説を同梱、tarot と tarot_full と rune は広く知られた体系なのでカード名と正逆だけを返す——その3つは自分の知識で読むこと。\nlenormand も同じ理由でカード名だけ（札番号と対応トランプは添える）——これも自分の知識で読むこと。\n空オラクルは小説のこぼれ話のお題出し係も兼ねていて、題の形式は「カード名『メッセージ』」。創作のお題として使うときはこの形を崩さないこと。\nspread を指定すると枚数はスプレッドに合わせて固定され、各札に位置（過去・現在・未来など）が付く。count と両方指定した場合は spread が優先される。「飛び出しカード」はシャッフル中に落ちた札の再現で、低い確率で 0〜3 枚付く（本引きとは別枠）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "deck": {
          "type": "string",
          "enum": [
            "sky",
            "enigma",
            "tarot",
            "tarot_full",
            "rune",
            "lenormand"
          ],
          "description": "引くデッキ。sky / enigma / tarot（大アルカナ22枚） / tarot_full（78枚） / rune / lenormand（36枚）"
        },
        "count": {
          "type": "integer",
          "minimum": 1,
          "description": "引く枚数（既定 1）。デッキの枚数を超えるとエラー。spread を指定した場合は無視される。"
        },
        "spread": {
          "type": "string",
          "enum": [
            "single",
            "two",
            "three",
            "hexagram",
            "celtic",
            "horoscope",
            "grand_tableau"
          ],
          "description": "並べ方。single=1枚引き / two=2枚引き（Yes-No） / three=3枚引き（過去・現在・未来） / hexagram=ヘキサグラム（6枚） / celtic=ケルト十字（10枚） / horoscope=ホロスコープ（12枚） / grand_tableau=グランタブロー（36枚・8列×4行＋5行目に4枚。ルノルマンの全展開）"
        },
        "allow_reversed": {
          "type": "boolean",
          "default": true,
          "description": "逆位置を許すか（既定 true）。false にすると全部正位置。もともと正逆の無いカードは常に正位置。"
        },
        "jump_out": {
          "type": "boolean",
          "default": true,
          "description": "飛び出しカードを起こすか（既定 true）。false にすると必ず 0 枚。"
        }
      },
      "required": [
        "deck"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "cast_hexagram",
    "title": "易占で卦を立てる",
    "description": "易占（周易）の卦を立てる（六爻はすべてサーバー側の乱数で決まる）。立てるのはサーバー、読むのは呼び出した側——卦辞・爻辞・彖伝のたぐいは一切返さないので、卦名と爻の並びを見て自分の知識で読むこと。\nmethod: coins=擲銭法（コイン3枚を6回投げる。6/7/8/9 が 1:3:3:1 で変爻が出やすい）、yarrow=本筮法（筮竹50本の三変を6回。老陰1/16・少陽5/16・少陰7/16・老陽3/16 という伝統的な偏り）、abridged=略筮法（筮竹で下卦・上卦・変爻を1回ずつ得る。変爻はちょうど1本）。既定は coins。\n返るのは本卦（序卦の番号・卦名・記号・上下の八卦）、六爻（初爻から上爻へ。老陽・老陰が変爻）、変爻の位、之卦（変爻が無ければ null）、互卦、それにコインの出目や筮竹の本数といった過程。\nnakko=true を渡すと納甲（断易・五行易）の表も添える——立卦日時の四柱（年月日時の干支）と、本卦・之卦の各爻の納甲干支、八宮と世応、六親、六獣。これらはすべて卦と日時からの導出で、乱数は 1 ビットも増えない。六親の吉凶や用神の取り方は書かないので、そこも自分の知識で読むこと。\n立卦日時（year / month / day / hour / minute / utc_offset）は nakko=true のときだけ使える。すべて省略すると現在時刻。\n自分で「立てたふり」をせず、易を立てる場面では必ずこのツールを呼ぶこと。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "method": {
          "type": "string",
          "enum": [
            "coins",
            "yarrow",
            "abridged"
          ],
          "default": "coins",
          "description": "立て方。coins=擲銭法（既定） / yarrow=本筮法 / abridged=略筮法"
        },
        "nakko": {
          "type": "boolean",
          "default": false,
          "description": "納甲（断易）を添えるか（既定 false）。true にすると立卦日時の四柱と、各爻の納甲干支・八宮と世応・六親・六獣が付く。"
        },
        "year": {
          "type": "integer",
          "minimum": -5000,
          "maximum": 5000,
          "description": "立卦日時の年（nakko=true のときだけ使える）。year / month / day は 3 つそろえて指定する。日時をすべて省略すると現在時刻で立てる。"
        },
        "month": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "立卦日時の月（1〜12）。"
        },
        "day": {
          "type": "integer",
          "minimum": 1,
          "maximum": 31,
          "description": "立卦日時の日。暦に存在しない日付（2026-02-31 など）は断る。"
        },
        "hour": {
          "type": "integer",
          "minimum": 0,
          "maximum": 23,
          "description": "立卦日時の時（0〜23）。省略すると 0 時（12 時ではない）。"
        },
        "minute": {
          "type": "integer",
          "minimum": 0,
          "maximum": 59,
          "description": "立卦日時の分（0〜59）。省略すると 0 分。"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "default": 9,
          "description": "日時をどの土地の時計で読むか（既定 9）。省略時は日本時間。ほかの土地の時計で立てたときはその時差を。"
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "roll_astro_dice",
    "title": "アストロダイスを振る",
    "description": "アストロダイス（天体・星座・ハウスの 12 面ダイス 3 個）を振る。返るのは「天体 × 星座 × ハウス」の名前と記号の組だけで、意味は載せない——よく知られた体系なので、読み解きはあなた自身の占星術の知識で行うこと。シャッフルと同じくサーバー側の乱数で決まる。自分で「振ったふり」をせず、必ずこのツールを呼ぶこと。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "count": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3,
          "default": 1,
          "description": "何組振るか（既定 1・最大 3）。1 組 = 天体・星座・ハウスのダイス 3 個。"
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "cast_geomancy",
    "title": "ジオマンシーのシールドチャートを立てる",
    "description": "西洋ジオマンシーのシールドチャートを立てる。サーバー側の乱数で母 4 つ（16 行ぶんの点の奇偶）を立て、そこから娘・姪・証人・裁判官（と参考の和解者）を導出して、16 図形の名前（ラテン名・日本語名）と点の並びだけを返す。意味は載せない——よく知られた体系なので、読み解きはあなた自身の知識で行うこと。自分で「立てたふり」をせず、必ずこのツールを呼ぶこと。",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "moon_calendar",
    "title": "月まわりの暦（朔望・星座入り・ボイド・食）",
    "description": "月まわりの暦を期間でまとめて返す——新月・上弦・満月・下弦の瞬間、月の星座入り、ボイドタイム（ボイド・オブ・コース）、期間内の日食・月食。乱数は使わない天体計算で、誕生日も場所も受け取らない（誰が呼んでも同じ答えになる）。\n計算するのはサーバー、読みはあなた自身の知識で——返すのは時刻と星座と名前だけで、「ボイド中は何をすべきか」のような吉凶・過ごし方は 1 文字も載せない。\n採った規約（返り値の conventions にも名前で入る）: ボイド＝月がその星座で相手天体と**最後に exact なメジャーアスペクト**（0 / 60 / 90 / 120 / 180 度）を作った瞬間から、**次の星座に入る瞬間**まで。オーブは取らない（exact ちょうどが境目）。相手天体は既定の modern が太陽・水星・金星・火星・木星・土星・天王星・海王星・冥王星の 9 天体、traditional が土星までの 7 天体で、どちらもノードは含めない。\n⚠ **ボイドの定義は流派で割れる**（相手天体の範囲・オーブを取るかどうか・「その星座を出るまで」と数えるか「次のアスペクトまで」と数えるか）。このサーバーは上の 1 通りだけを採るので、別の流派の表とは時刻が食い違うことがある。\n食は global＝地球上のどこかで起きるもの（場所を受けないので「どこで見えるか」は返さない）。半影月食も入れる（type で見分けがつく）。黄道はトロピカル、天体計算は Moshier。\n期間の頭より前に始まったボイドも、期間の尻をはみ出して終わるボイドも切らずに実時刻で返す（開始時点でボイド中かどうかが分かるように）。\n⚠ どれだけ体系を横断し、それらが全て同じ結果を示したとて、合算の根拠にはならない（面白がるのは自由）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "start": {
          "type": "string",
          "description": "期間の頭を \"YYYY-MM-DD\" で（例: 2026-08-25）。その日の 0 時から数える。省略すると utc_offset の暦での今日。"
        },
        "days": {
          "type": "integer",
          "minimum": 1,
          "maximum": 62,
          "default": 14,
          "description": "何日ぶん見るか（既定 14・最大 62 ＝ 2 朔望月ぶん）。"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "default": 9,
          "description": "どの土地の時計で読むか（既定 9＝日本時間）。返す時刻はすべてこの時差の現地時刻で、+09:00 のような札が付く。"
        },
        "voc_bodies": {
          "type": "string",
          "enum": [
            "modern",
            "traditional"
          ],
          "default": "modern",
          "description": "ボイド判定の相手天体（既定 modern）。modern＝太陽・水星〜冥王星の 9 天体 / traditional＝太陽・水星〜土星の 7 天体（近代以降に見つかった 3 つを外す流派）。"
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "reverse_horoscope",
    "title": "逆引きホロスコープ（その配置になる日を探す）",
    "description": "**配置のほうを先に決めて、その配置になる日を年代範囲から逆に引く**。「太陽が牡羊座で月が蟹座なのはいつか」「金星が獅子座で火星が牡羊座の年はいつか」のような探し方をする（逆行の有無は条件にできない＝返り値に印が付くだけ）。乱数は使わない天体計算で、誕生日も場所も受け取らない（誰が呼んでも同じ答えになる）。\n計算するのはサーバー、読みはあなた自身の知識で——返すのは日付・時刻の範囲・星座の名前だけで、「その配置の人は」「その日は何をするとよいか」のたぐいは 1 文字も載せない。\nconditions は { body, sign, priority } の配列。priority=required（既定）**だけで候補日が決まり**、priority=optional は各候補日に「その日そろっているか」を添えるだけ（成り立つ数の多い順→日付順に並ぶ）。required は少なくとも 1 本要る。同じ天体を 2 回は指定できない。太陽は必須ではないので、月だけ・外惑星だけの条件でも引ける。\nsign は日本語（牡羊座〜魚座）でも英語の小文字（aries〜pisces）でもよい。\n採った規約（返り値の conventions にも名前で入る）: 黄道はトロピカル・天体計算は Moshier・星座の境は黄経 30° 刻み・**候補日＝その暦日のどこかの瞬間で required が全部そろう日**（日の途中で始まる／終わる日には、その日の中の時刻の範囲が分単位で付く）。\n候補は多いときで 60 日まで返す（超えたら truncated: true と総数が付く）。各候補日には**その日の現地正午の 10 天体の星座**も添える（条件に無い天体も見えるように）——ただし月のように 1 日で星座が変わる天体では、正午の星座と条件が食い違うことがある（条件が成り立つ時刻は time_ranges のほう）。度数は返さない。\n年代の範囲は year_from・year_to で（両端を含む）。一度に見られるのは 30 年ぶんまでで、1800〜2200 年の内側。**required が 1 本だけのときは 10 年ぶんまで**（絞り込みが効かず、いちばん重い形になるため。条件を足せば長く見られる）。\n⚠ **近似探索**なので、留が星座の境のすぐ内側で起きる短い出入り（水星〜火星で 1 時間未満・木星〜冥王星で 4 時間未満）は拾えないことがある（太陽と月は通過の一発計算なのでこの穴は無い）。**候補なし＝必ず該当なし、ではない**——返り値の conventions.limitations にも同じ断りが入る。\n⚠ どれだけ体系を横断し、それらが全て同じ結果を示したとて、合算の根拠にはならない（面白がるのは自由）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "conditions": {
          "type": "array",
          "minItems": 1,
          "maxItems": 10,
          "description": "探したい配置。天体ごとに 1 本ずつ（同じ天体を 2 回は書けない）。required が 1 本も無いと断る。",
          "items": {
            "type": "object",
            "properties": {
              "body": {
                "type": "string",
                "enum": [
                  "sun",
                  "moon",
                  "mercury",
                  "venus",
                  "mars",
                  "jupiter",
                  "saturn",
                  "uranus",
                  "neptune",
                  "pluto"
                ],
                "description": "天体。ノードやアングル（ASC / MC）は条件に使えない。"
              },
              "sign": {
                "type": "string",
                "enum": [
                  "牡羊座",
                  "牡牛座",
                  "双子座",
                  "蟹座",
                  "獅子座",
                  "乙女座",
                  "天秤座",
                  "蠍座",
                  "射手座",
                  "山羊座",
                  "水瓶座",
                  "魚座",
                  "aries",
                  "taurus",
                  "gemini",
                  "cancer",
                  "leo",
                  "virgo",
                  "libra",
                  "scorpio",
                  "sagittarius",
                  "capricorn",
                  "aquarius",
                  "pisces"
                ],
                "description": "星座。日本語（牡羊座〜魚座）でも英語の小文字（aries〜pisces）でもよい。"
              },
              "priority": {
                "type": "string",
                "enum": [
                  "required",
                  "optional"
                ],
                "default": "required",
                "description": "required=候補日を決める条件（既定） / optional=候補日は決めず、そろっているかどうかだけを各候補日に添える。"
              }
            },
            "required": [
              "body",
              "sign"
            ],
            "additionalProperties": false
          }
        },
        "year_from": {
          "type": "integer",
          "minimum": 1800,
          "maximum": 2200,
          "description": "探す年代の始まり（西暦・この年を含む）。1800 以上。"
        },
        "year_to": {
          "type": "integer",
          "minimum": 1800,
          "maximum": 2200,
          "description": "探す年代の終わり（西暦・この年を含む）。year_from との差は 30 年ぶんまで（required が 1 本だけなら 10 年ぶんまで）。"
        },
        "utc_offset": {
          "type": "number",
          "minimum": -14,
          "maximum": 14,
          "default": 9,
          "description": "どの土地の時計・暦で読むか（既定 9＝日本時間）。候補日はこの時差の暦日で、時刻の範囲もこの現地時刻（+09:00 のような札が付く）。"
        }
      },
      "required": [
        "conditions",
        "year_from",
        "year_to"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  }
];
