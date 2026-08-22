/**
 * 宿曜占星術（二十七宿）の純関数。
 *
 * 背骨は numerology.ts・nakko.ts と同じ ―― 計算するのはサーバー、読むのは呼び出した側の Claude。
 * ここには乱数が 1 ビットも無く、**サーバーの仕事は「規約を固定すること」だけ**です。
 * 宿の意味・吉凶・相性の読みは一切持ちません（タロット・ルーンと同じ「既知の体系＝名前のみ」の線）。
 *
 * 採った規約（返り値にも description にも名前で書きます。読む側が「この鯖はこの流派」と
 * 分かってサーバーを疑わずに済むように）:
 *
 *   - **天文方式**。宿は出生時刻の**月のサイデリアル黄経 ÷ 13°20′**で決める。
 *     暦方式（旧暦の日付から宿を引く）は採らない ―― 旧暦は 2033 年問題のように
 *     裁定者のいない未解決の規約を含むため。
 *   - **基準点（アヤナムシャ）は Lahiri**（Swiss Ephemeris の SE_SIDM_LAHIRI = 1）。
 *     式で出るので天文暦ファイルも恒星ファイルも要らず、Moshier モード固定と両立する。
 *   - **27 宿**（牛宿＝Abhijit を含まない）。サイデリアル 0° から 13°20′ ずつで、
 *     **起点は婁宿（Ashvini）**。『宿曜経』の列挙が昴宿から始まるのは「表の並び」であって
 *     位置の起点ではない。
 *   - 三九の秘法は「本命宿を 1 として数えた距離」で決める。1＝命・10＝業・19＝胎、
 *     それ以外は 8 つ組「栄・衰・安・危・成・壊・友・親」の繰り返し。
 *
 * wasm には触らない ―― サイデリアル黄経（度）を受け取るだけなので、テストは数値を直接渡して回る。
 * トロピカル黄経とアヤナムシャから直すのは `toSidereal`。天体計算を持つモジュールへの依存も無い。
 */

/** 引数の形が受け付けられなかったときの言い分 */
export class ShukuyoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShukuyoError";
  }
}

// ---------------------------------------------------------------------------
// 27 宿の台帳
// ---------------------------------------------------------------------------

/** 宿 1 つ。名前と番号だけ ―― 意味も吉凶も持たない */
export interface Shuku {
  /** 1〜27（サイデリアル 0° の婁宿を 1 とする通し番号） */
  number: number;
  /** 漢字の宿名（「亢宿」） */
  name: string;
  /** 読み（「こうしゅく」） */
  reading: string;
  /** サンスクリット名（ローマ字。ヴェーダ占星術のナクシャトラ名） */
  sanskrit: string;
}

export const SHUKU_COUNT = 27;

/** 1 宿の幅（度）＝ 360 / 27 ＝ 13°20′ */
export const SHUKU_SPAN = 360 / SHUKU_COUNT;

/** Swiss Ephemeris の SE_SIDM_LAHIRI。基準点の名前を数字と一緒に返すために置いてある */
export const AYANAMSA_NAME = "Lahiri";

/**
 * 27 宿（サイデリアル 0° から 13°20′ ずつ）。
 *
 * 二十八宿から牛宿を抜いた 27 宿で、順番は中国の星宿の並び（角亢氐房心尾箕／斗女虚危室壁奎／
 * 婁胃昴畢觜参／井鬼柳星張翼軫）をそのまま巡り、**婁宿を 0° の起点に置いた**もの。
 * サンスクリット名は同じ位置のナクシャトラ（Ashvini から Revati まで）。
 */
export const SHUKU: readonly Shuku[] = [
  { number: 1, name: "婁宿", reading: "ろうしゅく", sanskrit: "Ashvini" },
  { number: 2, name: "胃宿", reading: "いしゅく", sanskrit: "Bharani" },
  { number: 3, name: "昴宿", reading: "ぼうしゅく", sanskrit: "Krittika" },
  { number: 4, name: "畢宿", reading: "ひつしゅく", sanskrit: "Rohini" },
  { number: 5, name: "觜宿", reading: "ししゅく", sanskrit: "Mrigashira" },
  { number: 6, name: "参宿", reading: "しんしゅく", sanskrit: "Ardra" },
  { number: 7, name: "井宿", reading: "せいしゅく", sanskrit: "Punarvasu" },
  { number: 8, name: "鬼宿", reading: "きしゅく", sanskrit: "Pushya" },
  { number: 9, name: "柳宿", reading: "りゅうしゅく", sanskrit: "Ashlesha" },
  { number: 10, name: "星宿", reading: "せいしゅく", sanskrit: "Magha" },
  { number: 11, name: "張宿", reading: "ちょうしゅく", sanskrit: "Purva Phalguni" },
  { number: 12, name: "翼宿", reading: "よくしゅく", sanskrit: "Uttara Phalguni" },
  { number: 13, name: "軫宿", reading: "しんしゅく", sanskrit: "Hasta" },
  { number: 14, name: "角宿", reading: "かくしゅく", sanskrit: "Chitra" },
  { number: 15, name: "亢宿", reading: "こうしゅく", sanskrit: "Swati" },
  { number: 16, name: "氐宿", reading: "ていしゅく", sanskrit: "Vishakha" },
  { number: 17, name: "房宿", reading: "ぼうしゅく", sanskrit: "Anuradha" },
  { number: 18, name: "心宿", reading: "しんしゅく", sanskrit: "Jyeshtha" },
  { number: 19, name: "尾宿", reading: "びしゅく", sanskrit: "Mula" },
  { number: 20, name: "箕宿", reading: "きしゅく", sanskrit: "Purva Ashadha" },
  { number: 21, name: "斗宿", reading: "としゅく", sanskrit: "Uttara Ashadha" },
  { number: 22, name: "女宿", reading: "じょしゅく", sanskrit: "Shravana" },
  { number: 23, name: "虚宿", reading: "きょしゅく", sanskrit: "Dhanishta" },
  { number: 24, name: "危宿", reading: "きしゅく", sanskrit: "Shatabhisha" },
  { number: 25, name: "室宿", reading: "しつしゅく", sanskrit: "Purva Bhadrapada" },
  { number: 26, name: "壁宿", reading: "へきしゅく", sanskrit: "Uttara Bhadrapada" },
  { number: 27, name: "奎宿", reading: "けいしゅく", sanskrit: "Revati" },
];

/**
 * ローマ字表記のゆれ（同じ宿を指す別綴り）。
 * 台帳の `sanskrit` そのものは入れない（下で自動的に足す）。
 */
const SANSKRIT_ALIASES: readonly (readonly string[])[] = [
  ["ashwini", "asvini", "aswini"], // 婁
  ["bharini"], // 胃
  ["kritika", "krttika"], // 昴
  [], // 畢 Rohini
  ["mrigasira", "mrgashira", "mrigashirsha"], // 觜
  ["arudra", "aardra"], // 参
  ["punarvasa"], // 井
  ["pusya", "pushyami"], // 鬼
  ["aslesha", "ashlesa"], // 柳
  ["makha"], // 星
  ["poorvaphalguni", "purvafalguni", "pubba", "pphalguni"], // 張
  ["uttaraphalguni", "uttarafalguni", "uphalguni"], // 翼
  ["hastha"], // 軫
  ["chithra", "citra"], // 角
  ["svati", "swathi"], // 亢
  ["visakha", "vishaka", "visakham"], // 氐
  ["anuradha"], // 房
  ["jyestha", "jyeshta", "jyeshthaa"], // 心
  ["moola", "mool", "moolam"], // 尾
  ["purvashadha", "poorvashadha", "pashadha"], // 箕
  ["uttarashadha", "uashadha"], // 斗
  ["sravana", "shravanam"], // 女
  ["dhanistha", "dhanishtha", "sravishtha"], // 虚
  ["satabhisha", "shatabhishak", "shatataraka"], // 危
  ["poorvabhadrapada", "purvabhadra", "pbhadrapada"], // 室
  ["uttarabhadra", "ubhadrapada"], // 壁
  ["revathi"], // 奎
];

/**
 * 名前 → 宿の索引。
 * 漢字（「亢宿」「亢」）・ローマ字（大文字小文字・区切りは問わない）・番号（"15"）を受ける。
 *
 * ⚠ 読み（かな）は索引に入れない ―― せいしゅく（井宿・星宿）、しんしゅく（参宿・心宿・軫宿）、
 *    きしゅく（鬼宿・箕宿・危宿）、ぼうしゅく（昴宿・房宿）のように重なる読みがあり、
 *    黙って別の宿を返してしまうため。読みは表示のためだけに持つ。
 */
const SHUKU_BY_KEY = new Map<string, Shuku>();
for (const [index, shuku] of SHUKU.entries()) {
  SHUKU_BY_KEY.set(shuku.name, shuku);
  SHUKU_BY_KEY.set(shuku.name.replace("宿", ""), shuku);
  SHUKU_BY_KEY.set(romanKey(shuku.sanskrit), shuku);
  for (const alias of SANSKRIT_ALIASES[index] as readonly string[]) {
    SHUKU_BY_KEY.set(romanKey(alias), shuku);
  }
}

/** ローマ字の突き合わせ用の形（小文字にして、英数字以外を落とす） */
function romanKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 0 始まりの索引（0〜26）から宿を引く */
export function shukuAt(index: number): Shuku {
  return SHUKU[((index % SHUKU_COUNT) + SHUKU_COUNT) % SHUKU_COUNT] as Shuku;
}

/**
 * 名前・番号の文字列から宿を探す（見つからなければ null）。
 *
 * 受ける形: 「亢宿」「亢」「Swati」「swati」「SWATI」「Purva Phalguni」「purva-phalguni」「15」。
 */
export function findShuku(raw: string): Shuku | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // 番号（1〜27）
  if (/^\d{1,2}$/.test(trimmed)) {
    const number = Number(trimmed);
    if (number < 1 || number > SHUKU_COUNT) return null;
    return SHUKU[number - 1] as Shuku;
  }

  // 漢字・読みはそのまま、ローマ字は区切りを落として突き合わせる
  const direct = SHUKU_BY_KEY.get(trimmed.replace(/\s+/g, ""));
  if (direct) return direct;
  return SHUKU_BY_KEY.get(romanKey(trimmed)) ?? null;
}

/** findShuku の、見つからなければ断る版 */
export function parseShuku(raw: string, label = "宿"): Shuku {
  const found = findShuku(raw);
  if (found) return found;
  throw new ShukuyoError(
    `${label}として読めませんでした: ${raw}` +
      "（漢字の宿名「亢宿」「亢」、サンスクリット名「Swati」、1〜27 の番号で指定してください）",
  );
}

// ---------------------------------------------------------------------------
// 宿の位置（サイデリアル黄経から）
// ---------------------------------------------------------------------------

/**
 * 0 以上 360 未満に畳む。
 *
 * chart.ts の normalizeDegree と同じ仕事だが、こちらは `(deg % 360) + 360` を通らない
 * ―― 13°20′ ちょうど（＝1 宿ぶん）のような値が「360 を足して引く」だけで最下位ビットずれ、
 * 境界が 1 つ手前の宿に落ちるのを避けるため。すでに 0〜360 に居る値は 1 ビットも動かない。
 */
function wrapLon(deg: number): number {
  const wrapped = deg % 360;
  return (wrapped < 0 ? wrapped + 360 : wrapped) + 0;
}

/** トロピカル黄経 → サイデリアル黄経（アヤナムシャを引くだけ） */
export function toSidereal(tropicalLon: number, ayanamsa: number): number {
  return wrapLon(tropicalLon - ayanamsa);
}

/**
 * 境界ちょうどと見なす幅（宿 1 つを 1 とした単位）。
 * 1e-9 宿 ＝ 1.3e-8 度 ＝ 0.00005 秒角で、月が動くのに 1e-4 秒しかかからない幅。
 */
const BOUNDARY_EPS = 1e-9;

/** 宿の索引・宿内の位置・畳んだ黄経をまとめて出す（境界の吸着はここ 1 箇所だけ） */
function locate(siderealLon: number): { index: number; degreesIn: number; lon: number } {
  const lon = wrapLon(siderealLon);
  const raw = lon / SHUKU_SPAN;
  const rounded = Math.round(raw);
  if (Math.abs(raw - rounded) < BOUNDARY_EPS) {
    // 境界ちょうど＝次の宿の 0°。360° の目と鼻の先なら 0°（婁宿の頭）に畳む
    return {
      index: rounded % SHUKU_COUNT,
      degreesIn: 0,
      lon: rounded === SHUKU_COUNT ? 0 : lon,
    };
  }
  const index = Math.floor(raw);
  return { index, degreesIn: lon - index * SHUKU_SPAN, lon };
}

/** サイデリアル黄経 → 0 始まりの宿の索引（0〜26） */
export function shukuIndexOf(siderealLon: number): number {
  return locate(siderealLon).index;
}

/** 宿とその中での位置、両隣、境界までの距離 */
export interface ShukuPosition {
  shuku: Shuku;
  /** サイデリアル黄経（度、0 以上 360 未満） */
  sidereal_lon: number;
  /** その宿の始まりから何度（＝前の境界までの距離。0 以上 13.333… 未満） */
  degrees_in: number;
  /** 「3°45′」 */
  position: string;
  /** 次の境界（＝次の宿の始まり）までの距離（度） */
  degrees_to_next: number;
  /** 1 つ前の宿 */
  prev: Shuku;
  /** 1 つ次の宿 */
  next: Shuku;
}

/**
 * サイデリアル黄経から宿を出す。
 *
 * 月は 1 日でほぼ 1 宿ぶん動くので、**出生時刻が少しずれると隣の宿**になり得る。
 * 読む側がそう言えるように、宿内の位置と両隣と境界までの距離を必ず添える。
 */
export function shukuOf(siderealLon: number): ShukuPosition {
  const { index, degreesIn, lon } = locate(siderealLon);
  return {
    shuku: SHUKU[index] as Shuku,
    sidereal_lon: lon,
    degrees_in: degreesIn,
    position: formatArcMinutes(degreesIn),
    degrees_to_next: SHUKU_SPAN - degreesIn,
    prev: shukuAt(index - 1),
    next: shukuAt(index + 1),
  };
}

// ---------------------------------------------------------------------------
// 三九の秘法（宿の距離による関係）
// ---------------------------------------------------------------------------

export type RelationName = "命" | "栄" | "衰" | "安" | "危" | "成" | "壊" | "友" | "親" | "業" | "胎";

/** 距離の遠近（9 宿ずつの 3 段） */
export type DistanceGroup = "近" | "中" | "遠";

/**
 * 三九の秘法の表。**本命宿を 1 として順に数えた距離**（1〜27）で引く。
 *
 * 1＝命、10＝業、19＝胎。その 3 つを頭に、あとは 8 つ組「栄・衰・安・危・成・壊・友・親」が
 * 3 回めぐる。9 宿ずつで 近距離（1〜9）・中距離（10〜18）・遠距離（19〜27）。
 *
 * ⚠ この並びは**対称性で検算してある**（test/shukuyo.test.ts の 27×27 総当たり）。
 *    A から B への距離が d なら、B から A への距離は 29 − d になるので、
 *    表が正しければ 栄↔親・衰↔友・安↔壊・危↔成・業↔胎 が必ず裏返しの位置で対になる。
 *    たとえば d=2（栄）の裏は d=27 で、そこが 親 になっていること。
 */
export const RELATION_BY_DISTANCE: readonly RelationName[] = [
  // 近距離（1〜9）
  "命", "栄", "衰", "安", "危", "成", "壊", "友", "親",
  // 中距離（10〜18）
  "業", "栄", "衰", "安", "危", "成", "壊", "友", "親",
  // 遠距離（19〜27）
  "胎", "栄", "衰", "安", "危", "成", "壊", "友", "親",
];

/** 関係の読み */
const RELATION_READING: Record<RelationName, string> = {
  命: "めい",
  栄: "えい",
  衰: "すい",
  安: "あん",
  危: "き",
  成: "せい",
  壊: "え",
  友: "ゆう",
  親: "しん",
  業: "ごう",
  胎: "たい",
};

/**
 * 対になる関係の組名。A→B と B→A で必ず同じ名前になる
 * （＝どちら側から見ても同じ「組」だと言える）。
 */
const RELATION_PAIR: Record<RelationName, string> = {
  命: "命",
  栄: "栄親",
  親: "栄親",
  衰: "友衰",
  友: "友衰",
  安: "安壊",
  壊: "安壊",
  危: "危成",
  成: "危成",
  業: "業胎",
  胎: "業胎",
};

const GROUP_NAMES: readonly DistanceGroup[] = ["近", "中", "遠"];
const GROUP_LABELS: readonly string[] = ["近距離", "中距離", "遠距離"];

/** 1 つの向きの関係（本命宿 → 相手の宿） */
export interface Relation {
  /** 本命宿を 1 として数えた距離（1〜27） */
  distance: number;
  name: RelationName;
  reading: string;
  group: DistanceGroup;
  /** 「近距離」 */
  group_label: string;
  /** 対になる関係の組名（逆向きでも同じ） */
  pair: string;
}

function assertIndex(index: number, label: string): number {
  if (!Number.isInteger(index) || index < 0 || index >= SHUKU_COUNT) {
    throw new ShukuyoError(`${label} は 0〜${SHUKU_COUNT - 1} の整数で指定してください: ${index}`);
  }
  return index;
}

/**
 * from の宿から見た to の宿の関係（三九の秘法）。索引はどちらも 0 始まり（0〜26）。
 *
 * 距離は「from を 1 として数える」＝同じ宿なら 1（命）。
 */
export function relationOf(fromIndex: number, toIndex: number): Relation {
  const from = assertIndex(fromIndex, "fromIndex");
  const to = assertIndex(toIndex, "toIndex");
  const distance = (((to - from) % SHUKU_COUNT) + SHUKU_COUNT) % SHUKU_COUNT + 1;
  const name = RELATION_BY_DISTANCE[distance - 1] as RelationName;
  const groupIndex = Math.floor((distance - 1) / 9);
  return {
    distance,
    name,
    reading: RELATION_READING[name],
    group: GROUP_NAMES[groupIndex] as DistanceGroup,
    group_label: GROUP_LABELS[groupIndex] as string,
    pair: RELATION_PAIR[name],
  };
}

/** 2 つの宿の相性（両方向の関係と、対称な組名） */
export interface ShukuCompat {
  a: Shuku;
  b: Shuku;
  /** a から見た b */
  a_to_b: Relation;
  /** b から見た a */
  b_to_a: Relation;
  /** 組名（どちらの向きから見ても同じ） */
  pair: string;
  /** 同じ宿（命）かどうか */
  same: boolean;
}

/**
 * 2 つの宿の相性。索引はどちらも 0 始まり（0〜26）。
 *
 * 三九の秘法は**向きで名前が変わる**（A から見て栄なら B から見ると親）ので両方向を返す。
 * 変わらないのは「組」のほうで、こちらは A→B と B→A で必ず同じ名前になる。
 */
export function compatOf(aIndex: number, bIndex: number): ShukuCompat {
  const aToB = relationOf(aIndex, bIndex);
  const bToA = relationOf(bIndex, aIndex);
  if (aToB.pair !== bToA.pair) {
    // 表を書き換えて対称性が壊れたときに、黙って違う答えを返さないための保険
    throw new ShukuyoError(
      `三九の秘法の表が対称ではありません（${aToB.name} と ${bToA.name}）。表を確かめてください。`,
    );
  }
  return {
    a: shukuAt(aIndex),
    b: shukuAt(bIndex),
    a_to_b: aToB,
    b_to_a: bToA,
    pair: aToB.pair,
    same: aIndex === bIndex,
  };
}

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

/**
 * 弧の長さ（度）→「3°45′」。
 *
 * 星座を持たない「宿の中での位置」なので chart.ts の formatDegree とは別物。
 * 分は素直に floor すると 3.9° が 3°53′ になる（浮動小数の埃）ので 1e-6 分だけ底上げする。
 */
export function formatArcMinutes(deg: number): string {
  const total = Math.floor(Math.max(0, deg) * 60 + 1e-6);
  return `${Math.floor(total / 60)}°${String(total % 60).padStart(2, "0")}′`;
}

/** 「亢宿（こうしゅく・Swati・15）」 */
export function formatShukuName(shuku: Shuku): string {
  return `${shuku.name}（${shuku.reading}・${shuku.sanskrit}・${shuku.number}）`;
}

/** 宿の位置を数行で。意味は書かない ―― 読みは呼び出した側に委ねる */
export function formatShukuLines(position: ShukuPosition): string[] {
  return [
    formatShukuName(position.shuku),
    `宿内の位置: ${position.position} / 境界まで: 前 ${position.position}・` +
      `次 ${formatArcMinutes(position.degrees_to_next)}`,
    `両隣: 前 ${formatShukuName(position.prev)} / 次 ${formatShukuName(position.next)}`,
    `サイデリアル黄経 ${position.sidereal_lon.toFixed(4)}°（1 宿 = 13°20′、起点は婁宿）`,
  ];
}

/** 「距離 3 → 衰（すい） / 近距離 / 組 友衰」 */
export function formatRelation(relation: Relation): string {
  return (
    `距離 ${relation.distance} → ${relation.name}（${relation.reading}） / ` +
    `${relation.group_label} / 組 ${relation.pair}`
  );
}

/** 相性（三九の秘法）を数行で。ここでも意味は書かない */
export function formatCompatLines(compat: ShukuCompat, aLabel: string, bLabel: string): string[] {
  return [
    `A: ${aLabel} ${formatShukuName(compat.a)}`,
    `B: ${bLabel} ${formatShukuName(compat.b)}`,
    `A → B: ${formatRelation(compat.a_to_b)}`,
    `B → A: ${formatRelation(compat.b_to_a)}`,
    compat.same
      ? "組: 命（同じ宿）"
      : `組: ${compat.pair}（A→B と B→A で名前は変わりますが、組は同じです）`,
  ];
}
