/**
 * ブラウザ用の貼り付けテキスト（src/browser/paste-*.ts）の形を固定する。
 *
 * 見ているのは 3 つです ――
 *   1. **様式**: 1 行目 `【種別】…`、2 行目 `規約: …`、3 行目は空行、まとまりは `■ 節`
 *   2. **既定は最小構成**: 対象日も相手も渡さなければ節が増えない（渡したときだけ増える）
 *   3. **中身は MCP と同じ**: 同じ偽エンジン・同じ入力で純関数経路が返す本文が、
 *      そのまま貼り付けテキストに入っている（＝計算の正本が 1 か所しかないことの検算）
 *
 * 規約行も「MCP 側の定数と同文」であることを、同じ定数を import して突き合わせます
 * ―― ここがずれると、貼られた側が「別の流派の鯖」だと読んでしまう。
 *
 * 本物の wasm は読みません（それは test/browser-bundle-real.test.ts の担当）。
 * 偽エンジンの太陽は `sunMotionAnchorJd` を立てて等速にしてあります
 * ―― 素のままだと太陽が止まったまま通過だけ格子で返り、節入り・至の検算に引っかかるためです。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  FAKE_TROPICAL_YEAR,
  makeFakeEngine,
  type FakeEngine,
} from "./stubs/fake-engine";
import { KYUSEI_SYSTEM_LINE, computeKyuseiBirth } from "../src/astro/kyusei-engine";
import { SHUKUYO_SYSTEM_LINE, shukuAtJd } from "../src/astro/shukuyo-engine";
import {
  computeDateFortune,
  computeFourPillarsNatal,
} from "../src/astro/four-pillars-engine";
import { formatDateFortuneText, formatFourPillarsText } from "../src/four-pillars";
import { formatShukuLines, compatOf, formatCompatLines } from "../src/shukuyo";
import { calculateNumerology, formatNumerologyText } from "../src/numerology";
import { julianDay, formatDegree } from "../src/astro/chart";
import { sabianDegreeOf } from "../src/sabian";
import type { NakkoMoment } from "../src/nakko";
import {
  prepareEngine,
  pasteAstroDice,
  pasteDraw,
  pasteFourPillars,
  pasteGeomancy,
  pasteHexagram,
  pasteKyusei,
  pasteNumerology,
  pasteSabian,
  pasteShukuyo,
  pasteShukuyoCompat,
  tzLabel,
  momentLabel,
  pasteHeader,
} from "../src/browser/index";

let engine: FakeEngine;

/** 偽エンジンの swe_julday と同じ式（現地時刻ではなく UTC の時で渡す） */
function fakeJd(year: number, month: number, day: number, utcHour: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 2440587.5 + utcHour / 24;
}

/**
 * 見本の出生（2022-11-30 10:00・UTC−8）。
 *
 * **ChatGPT の公開日**を借りています ―― 時刻の 10 時は架空、時差は米国太平洋時間（PST）。
 * 人の誕生日と紛れない公開された日付を見本にする、という取り決めです
 * （test/astro-kyusei.test.ts・test/astro-mcp.test.ts と同じ見本）。
 */
const BIRTH: NakkoMoment = {
  year: 2022,
  month: 11,
  day: 30,
  hour: 10,
  minute: 0,
  utcOffset: -8,
};

/** 見る日の見本（Claude 公開日 2023-03-14 の 12:00・JST。こちらも公開された日付） */
const TARGET: NakkoMoment = {
  year: 2023,
  month: 3,
  day: 14,
  hour: 12,
  minute: 0,
  utcOffset: 9,
};

/** 出生の瞬間（現地 10:00・UTC−8 → UTC では同じ日の 18:00） */
const NATAL_JD = fakeJd(2022, 11, 30, 10 + 8);

/** 出生の瞬間に置く太陽黄経（立冬 225° と大雪 255° のあいだ＝亥月） */
const NATAL_SUN = 247.98;

beforeEach(() => {
  engine = makeFakeEngine();
  // 等速太陽（回帰年 1 周）。出生の瞬間がちょうど 247.98° になるように位相を合わせる
  engine.sunMotionAnchorJd = NATAL_JD - (NATAL_SUN / 360) * FAKE_TROPICAL_YEAR;
});

/** 貼り付けテキストを行に割る（様式の検算はいつも行単位） */
function linesOf(text: string): string[] {
  return text.split("\n");
}

/** `■ …` で始まる行だけ（節の一覧） */
function sectionsOf(text: string): string[] {
  return linesOf(text).filter((line) => line.startsWith("■ "));
}

// ---------------------------------------------------------------------------
// 共通部品
// ---------------------------------------------------------------------------

describe("共通部品（paste-common）", () => {
  it("時差の札は JST だけ名前、あとは UTC±n", () => {
    expect(tzLabel(9)).toBe("JST");
    expect(tzLabel(0)).toBe("UTC+0");
    expect(tzLabel(-8)).toBe("UTC-8");
    expect(tzLabel(2)).toBe("UTC+2");
  });

  it("半端な時差は小数のまま（5.5 → UTC+5.5、Astro Tool と同じ字面）", () => {
    expect(tzLabel(5.5)).toBe("UTC+5.5");
    expect(tzLabel(5.75)).toBe("UTC+5.75");
    expect(tzLabel(-3.5)).toBe("UTC-3.5");
  });

  it("瞬間の札は「日付 時刻 時差」、時刻不明ならそう断る", () => {
    expect(momentLabel(BIRTH)).toBe("2022-11-30 10:00 UTC-8");
    expect(momentLabel(TARGET)).toBe("2023-03-14 12:00 JST");
    expect(momentLabel(TARGET, { time: false })).toBe("2023-03-14 JST（時刻不明）");
  });

  it("見出しは 2 行＋空行（様式の背骨）", () => {
    expect(pasteHeader("種別", "条件", "きまり")).toEqual([
      "【種別】条件",
      "規約: きまり",
      "",
    ]);
  });
});

// ---------------------------------------------------------------------------
// エンジンの準備
// ---------------------------------------------------------------------------

describe("prepareEngine", () => {
  it("サイデリアルの基準点を Lahiri に固定する（宿曜に要る）", () => {
    const swe = prepareEngine(engine);
    expect(swe).toBe(engine);
    expect(engine.sidModeCalls).toEqual([{ sidMode: 1, t0: 0, ayanT0: 0 }]);
  });

  it("何度呼んでも害がない", () => {
    prepareEngine(engine);
    prepareEngine(engine);
    expect(engine.sidModeCalls).toHaveLength(2);
    expect(engine.sidModeCalls.every((call) => call.sidMode === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 四柱推命
// ---------------------------------------------------------------------------

describe("pasteFourPillars", () => {
  it("既定は最小構成（命式だけ・対象日の節は無い）", () => {
    const { text } = pasteFourPillars(engine, BIRTH);
    const lines = linesOf(text);

    expect(lines[0]).toBe("【四柱推命】2022-11-30 10:00 UTC-8");
    expect(lines[1]).toMatch(/^規約: /);
    expect(lines[2]).toBe("");
    expect(text).not.toContain("■ 対象日");
  });

  it("規約行に流派の名前が並ぶ（子平・日界・節気・時刻補正・大運・月律分野表）", () => {
    const { text } = pasteFourPillars(engine, BIRTH);
    const conventions = linesOf(text)[1] as string;

    for (const name of [
      "子平",
      "日界 0 時",
      "節気は太陽黄経",
      "時刻の補正なし",
      "大運は順行・逆行の両方",
      "月律分野表は採らない",
    ]) {
      expect(conventions).toContain(name);
    }
  });

  it("本文は MCP と同じ純関数経路の返り値そのもの", () => {
    const { result, text } = pasteFourPillars(engine, BIRTH);
    const natal = computeFourPillarsNatal(engine, BIRTH);

    expect(text).toContain(formatFourPillarsText(natal));
    expect(result.natal.pillars.day.ganzhi).toBe(natal.pillars.day.ganzhi);
    expect(result.date_fortune).toBeUndefined();
  });

  it("target を渡すと対象日の節が増える（時運つき）", () => {
    const { result, text } = pasteFourPillars(engine, BIRTH, {
      target: { moment: TARGET, includeHour: true },
    });
    const natal = computeFourPillarsNatal(engine, BIRTH);
    const fortune = computeDateFortune(engine, natal, TARGET, true);

    expect(text).toContain("■ 対象日 2023-03-14（JST の暦）");
    expect(text).toContain(formatDateFortuneText(fortune));
    expect(result.date_fortune?.day.ganzhi).toBe(fortune.day.ganzhi);
    expect(result.date_fortune?.hour?.ganzhi).toBe(fortune.hour?.ganzhi);
    // 時刻を渡したので「時運は出しません」とは断らない
    expect(text).not.toContain("時運は出しません");
  });

  it("時刻なしの対象日は MCP と同じ断り方をする", () => {
    const { text } = pasteFourPillars(engine, BIRTH, {
      target: { moment: { ...TARGET, hour: 0, minute: 0 }, includeHour: false },
    });
    expect(text).toContain("（時刻の指定が無いので 0 時で見ています＝時運は出しません）");
  });
});

// ---------------------------------------------------------------------------
// 九星気学
// ---------------------------------------------------------------------------

describe("pasteKyusei", () => {
  it("既定は最小構成（三星だけ・盤は無い）", () => {
    const { text } = pasteKyusei(engine, BIRTH);
    expect(linesOf(text)[0]).toBe("【九星気学】2022-11-30 10:00 UTC-8");
    expect(sectionsOf(text)).toEqual(["■ 本命星・月命星・日命星"]);
  });

  it("規約行は MCP の KYUSEI_SYSTEM_LINE と同文", () => {
    const { text } = pasteKyusei(engine, BIRTH);
    expect(linesOf(text)[1]).toBe(KYUSEI_SYSTEM_LINE);
  });

  it("三星の 1 行は MCP と同じ中身（出生側の日命星は星と遁だけ）", () => {
    const { result, text } = pasteKyusei(engine, BIRTH);
    const birth = computeKyuseiBirth(engine, BIRTH, true);

    expect(text).toContain(
      `本命星: ${birth.honmei.name} / 月命星: ${birth.getsumei.name} / ` +
        `日命星: ${birth.nichimei.star.name}（${birth.nichimei.dun}）`,
    );
    // switch も days_since_switch も出生側には出さない（出生日が復元できてしまうため）
    expect(result.birth.nichimei).toEqual(birth.nichimei);
    expect(Object.keys(result.birth.nichimei)).toEqual(["star", "dun"]);
  });

  it("時刻不明で星が動かない日なら、注記は出ない", () => {
    const { text } = pasteKyusei(engine, BIRTH, { timeKnown: false });
    expect(linesOf(text)[0]).toBe("【九星気学】2022-11-30 UTC-8（時刻不明）");
    expect(text).not.toContain("※ 立春／節入りの当日");
  });

  it("target を渡すと盤 3 枚と遁の行が増える", () => {
    const { result, text } = pasteKyusei(engine, BIRTH, { target: { moment: TARGET } });

    // 盤の見出しも formatBoardText が「■ …」で出すので、節は 5 つに増える
    expect(sectionsOf(text).slice(0, 2)).toEqual([
      "■ 本命星・月命星・日命星",
      "■ 対象日 2023-03-14（JST の暦）",
    ]);
    expect(sectionsOf(text)[2]).toMatch(/^■ 年盤 .+年（中宮 /);
    expect(sectionsOf(text)[3]).toMatch(/^■ 月盤 .+月（中宮 /);
    expect(sectionsOf(text)[4]).toMatch(/^■ 日盤 .+日（中宮 /);
    expect(text).toMatch(/\n遁: (陽遁|陰遁)（(冬至|夏至)に最も近い甲子 /);
    expect(result.boards?.dayView.dun).toMatch(/^(陽遁|陰遁)$/);
  });
});

// ---------------------------------------------------------------------------
// 宿曜
// ---------------------------------------------------------------------------

describe("pasteShukuyo", () => {
  it("既定は最小構成（本命宿だけ・その日の宿は無い）", () => {
    const { text } = pasteShukuyo(prepareEngine(engine), BIRTH);
    expect(linesOf(text)[0]).toBe("【宿曜】2022-11-30 10:00 UTC-8");
    expect(sectionsOf(text)).toEqual(["■ 本命宿（出生時刻の月）"]);
    expect(text).not.toContain("アヤナムシャ");
  });

  it("規約行は MCP の SHUKUYO_SYSTEM_LINE と同文", () => {
    const { text } = pasteShukuyo(prepareEngine(engine), BIRTH);
    expect(linesOf(text)[1]).toBe(SHUKUYO_SYSTEM_LINE);
  });

  it("本命宿の行は MCP と同じ純関数経路の返り値そのもの", () => {
    const swe = prepareEngine(engine);
    const { result, text } = pasteShukuyo(swe, BIRTH);
    const natal = shukuAtJd(swe, julianDay(swe, BIRTH)).position;

    for (const line of formatShukuLines(natal)) expect(text).toContain(line);
    expect(result.natal.shuku.number).toBe(natal.shuku.number);
  });

  it("date を渡すと日運と切り替わりの節が増える", () => {
    const swe = prepareEngine(engine);
    const { result, text } = pasteShukuyo(swe, BIRTH, { date: { moment: TARGET } });

    expect(sectionsOf(text)).toEqual([
      "■ 本命宿（出生時刻の月）",
      "■ その日の宿 2023-03-14（JST の暦）",
    ]);
    expect(text).toContain("本命宿から: ");
    expect(text).toContain("アヤナムシャ ");
    expect(text).toContain("□ この日の宿の切り替わり（JST の暦の 0 時〜24 時）");
    expect(result.day?.date).toBe("2023-03-14");
  });

  it("その 24 時間に切り替わりが無ければ、MCP と同じ言い方で断る", () => {
    // 偽エンジンの月は 27.32 日周期の格子でしか通過を返さないので、まず窓には入らない
    const { text } = pasteShukuyo(prepareEngine(engine), BIRTH, { date: { moment: TARGET } });
    expect(text).toContain(
      "この 24 時間のうちに宿は変わりません（月は 1 宿に 21〜27 時間ほど留まります）",
    );
  });
});

describe("pasteShukuyoCompat", () => {
  it("1 行目は札と宿名、規約は宿曜＋三九の秘法", () => {
    const { result, text } = pasteShukuyoCompat(
      { label: "わたし", index: 0 },
      { label: "あなた", index: 12 },
    );
    const lines = linesOf(text);

    expect(lines[0]).toBe("【宿曜・相性】わたし（婁宿） × あなた（軫宿）");
    expect(lines[1]).toBe(`${SHUKUYO_SYSTEM_LINE} / 三九の秘法`);
    for (const line of formatCompatLines(compatOf(0, 12), "わたし", "あなた")) {
      expect(text).toContain(line);
    }
    expect(result.pair).toBe(compatOf(0, 12).pair);
  });

  it("エンジンを触らない（宿の番号だけで立つ＝相手の出生データが要らない）", () => {
    pasteShukuyoCompat({ label: "A", index: 3 }, { label: "B", index: 7 });
    expect(engine.juldays).toEqual([]);
    expect(engine.crossCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 数秘術
// ---------------------------------------------------------------------------

describe("pasteNumerology", () => {
  const BIRTH_DATE = { year: 2022, month: 11, day: 30 };
  const TARGET_DATE = { year: 2023, month: 3, day: 14 };

  it("1 行目は生年月日、規約行にマスターと暦年起点が並ぶ", () => {
    const { text } = pasteNumerology(BIRTH_DATE, { target: TARGET_DATE });
    const lines = linesOf(text);

    expect(lines[0]).toBe("【数秘術】2022-11-30");
    expect(lines[1]).toBe(
      "規約: ピタゴラス式 / 生年月日ベース / マスター 11・22・33（既定） / " +
        "パーソナルイヤーは暦年起点",
    );
  });

  it("masters を変えると規約行も変わる", () => {
    const { text } = pasteNumerology(BIRTH_DATE, { target: TARGET_DATE, masters: "11_22" });
    expect(linesOf(text)[1]).toContain("マスター 11・22 /");
    expect(linesOf(text)[1]).not.toContain("33");
  });

  it("本文は純関数の返り値そのもの", () => {
    const { result, text } = pasteNumerology(BIRTH_DATE, { target: TARGET_DATE });
    const expected = calculateNumerology({
      ...BIRTH_DATE,
      target: TARGET_DATE,
      masters: "11_22_33",
    });

    expect(text).toContain(formatNumerologyText(expected));
    expect(result.life_path.values).toEqual(expected.life_path.values);
    expect(result.life_path.presets.full_sum.value).toBe(
      expected.life_path.presets.full_sum.value,
    );
  });
});

// ---------------------------------------------------------------------------
// 易占
// ---------------------------------------------------------------------------

describe("pasteHexagram", () => {
  it("既定は最小構成（易の本文だけ・納甲の節は無い）", () => {
    const { result, text } = pasteHexagram();
    const lines = linesOf(text);

    expect(lines[0]).toBe("【易占】擲銭法");
    expect(lines[1]).toBe("規約: 本卦・変爻・之卦・互卦 / 卦辞・爻辞は載せない");
    expect(text).not.toContain("■ 納甲");
    expect(result.nakko).toBeUndefined();
  });

  it("method を渡すと 1 行目の立て方が変わる", () => {
    expect(linesOf(pasteHexagram({ method: "yarrow" }).text)[0]).toBe("【易占】本筮法");
    expect(linesOf(pasteHexagram({ method: "abridged" }).text)[0]).toBe("【易占】略筮法");
  });

  it("nakko を渡すと立卦の日時と納甲の節が増える", () => {
    const { result, text } = pasteHexagram({ nakko: { swe: engine, moment: TARGET } });
    const lines = linesOf(text);

    expect(lines[0]).toBe("【易占】擲銭法 2023-03-14 12:00 JST");
    expect(lines[1]).toContain("納甲: 四柱＝日界 0 時");
    expect(text).toContain("■ 納甲（断易）");
    expect(result.nakko?.pillars.day.ganzhi).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ジオマンシー・カード・ダイス
// ---------------------------------------------------------------------------

describe("pasteGeomancy", () => {
  it("様式どおり（1 行目・規約行・空行）で、母 4 つから導出まで並ぶ", () => {
    const { result, text } = pasteGeomancy();
    const lines = linesOf(text);

    expect(lines[0]).toBe("【ジオマンシー】シールドチャート");
    expect(lines[1]).toBe(
      "規約: 乱数は母卦 4 つ（16 ビット）だけ / 娘・姪・証人・裁判官・和解者は導出 / " +
        "図形はラテン名",
    );
    expect(lines[2]).toBe("");
    expect(text).toContain("母: ");
    expect(text).toContain("裁判官: ");
    expect(result.mothers).toHaveLength(4);
  });
});

describe("pasteDraw", () => {
  it("スプレッドありの 1 行目は「デッキ / スプレッド名（N 枚）」", () => {
    const { result, text } = pasteDraw({ deck: "sky", spread: "three" });
    const lines = linesOf(text);

    expect(lines[0]).toBe(`【カード】${result.deck.name} / ${result.spread?.name}（3 枚）`);
    expect(lines[1]).toBe(
      "規約: 正逆: あり / 飛び出し: あり / シャッフルはブラウザの乱数（crypto.getRandomValues）",
    );
    expect(result.cards).toHaveLength(3);
  });

  it("スプレッドなしの 1 行目は「デッキ / N 枚」", () => {
    const { text } = pasteDraw({ deck: "tarot", count: 2 });
    expect(linesOf(text)[0]).toBe("【カード】タロット大アルカナ / 2 枚");
  });

  it("正逆・飛び出しを切ると規約行もそう書く", () => {
    const { text } = pasteDraw({
      deck: "rune",
      count: 1,
      allow_reversed: false,
      jump_out: false,
    });
    expect(linesOf(text)[1]).toContain("正逆: なし / 飛び出し: なし");
  });
});

describe("pasteAstroDice", () => {
  it("1 行目は組数、規約行は面の数と「名前と記号だけ」", () => {
    const { result, text } = pasteAstroDice(3);
    const lines = linesOf(text);

    expect(lines[0]).toBe("【アストロダイス】3 組");
    expect(lines[1]).toBe(
      "規約: 天体 12（10 天体＋ノース／サウスノード）・星座 12・ハウス 12 / 名前と記号だけ",
    );
    expect(result).toHaveLength(3);
  });

  it("count を省くと 1 組", () => {
    expect(linesOf(pasteAstroDice().text)[0]).toBe("【アストロダイス】1 組");
  });
});

// ---------------------------------------------------------------------------
// サビアン度数
// ---------------------------------------------------------------------------

describe("pasteSabian", () => {
  const ENTRIES = [
    { label: "太陽", lon: 44.5 },
    { label: "月", lon: 0 },
    { label: "ASC", lon: 359.99 },
  ];

  it("1 行目は天体の数、規約行は切り上げとシンボル不掲載", () => {
    const { text } = pasteSabian(ENTRIES);
    const lines = linesOf(text);

    expect(lines[0]).toBe("【サビアン度数】3 天体");
    expect(lines[1]).toBe("規約: 切り上げ＝0°00′〜0°59′ が 1 度 / シンボルの文言は載せない");
  });

  it("1 行 1 天体で、元の度分とサビアン度数を並べる", () => {
    const { result, text } = pasteSabian(ENTRIES);
    const lines = linesOf(text);

    expect(lines[3]).toBe(`太陽 ${formatDegree(44.5)} → 牡牛座 15 度（通し 45）`);
    expect(lines[4]).toBe(`月 ${formatDegree(0)} → 牡羊座 1 度（通し 1）`);
    expect(lines[5]).toBe(`ASC ${formatDegree(359.99)} → 魚座 30 度（通し 360）`);
    expect(result.map((entry) => entry.sabian.serial)).toEqual([45, 1, 360]);
    expect(result[0]?.sabian).toEqual(sabianDegreeOf(44.5));
  });

  it("空で呼んでも様式は崩れない（0 天体）", () => {
    const { text } = pasteSabian([]);
    expect(linesOf(text)).toEqual([
      "【サビアン度数】0 天体",
      "規約: 切り上げ＝0°00′〜0°59′ が 1 度 / シンボルの文言は載せない",
      "",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 様式の横断
// ---------------------------------------------------------------------------

describe("様式は全部そろっている", () => {
  it("どの貼り付けテキストも 1 行目【…】・2 行目 規約:・3 行目 空行", () => {
    const swe = prepareEngine(engine);
    const texts = [
      pasteFourPillars(swe, BIRTH).text,
      pasteKyusei(swe, BIRTH).text,
      pasteShukuyo(swe, BIRTH).text,
      pasteShukuyoCompat({ label: "A", index: 0 }, { label: "B", index: 5 }).text,
      pasteNumerology({ year: 2022, month: 11, day: 30 }, { target: { year: 2023, month: 3, day: 14 } }).text,
      pasteHexagram().text,
      pasteGeomancy().text,
      pasteDraw({ deck: "sky", count: 1 }).text,
      pasteAstroDice(1).text,
      pasteSabian([{ label: "太陽", lon: 10 }]).text,
    ];

    for (const text of texts) {
      const lines = linesOf(text);
      expect(lines[0]).toMatch(/^【.+】/);
      expect(lines[1]).toMatch(/^規約: .+/);
      expect(lines[2]).toBe("");
    }
  });
});
