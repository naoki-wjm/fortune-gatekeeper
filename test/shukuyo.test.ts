import { describe, expect, it } from "vitest";
import {
  AYANAMSA_NAME,
  RELATION_BY_DISTANCE,
  SHUKU,
  SHUKU_COUNT,
  SHUKU_SPAN,
  ShukuyoError,
  compatOf,
  findShuku,
  formatArcMinutes,
  formatCompatLines,
  formatRelation,
  formatShukuLines,
  formatShukuName,
  parseShuku,
  relationOf,
  shukuAt,
  shukuIndexOf,
  shukuOf,
  toSidereal,
  type RelationName,
} from "../src/shukuyo";

/** 度分（13°20′ のような書き方）を度に直す。期待値を手計算のまま書けるように */
const dm = (degree: number, minute = 0): number => degree + minute / 60;

// ---------------------------------------------------------------------------
// 27 宿の台帳
// ---------------------------------------------------------------------------

describe("二十七宿の台帳", () => {
  it("27 宿ちょうどで、番号は 1 から順に振ってある", () => {
    expect(SHUKU).toHaveLength(SHUKU_COUNT);
    expect(SHUKU.map((shuku) => shuku.number)).toEqual(
      Array.from({ length: 27 }, (_unused, index) => index + 1),
    );
  });

  it("牛宿（Abhijit）は入っていない＝二十八宿から 1 つ抜いた 27 宿", () => {
    expect(SHUKU.map((shuku) => shuku.name)).not.toContain("牛宿");
    expect(SHUKU.map((shuku) => shuku.sanskrit)).not.toContain("Abhijit");
  });

  it("並びは中国の星宿の巡りそのままで、起点だけ婁宿に置いてある", () => {
    // 二十八宿の順（角亢氐房心尾箕／斗牛女虚危室壁／奎婁胃昴畢觜参／井鬼柳星張翼軫）から
    // 牛を抜き、婁から始まるように回したもの
    expect(SHUKU.map((shuku) => shuku.name).join("")).toBe(
      "婁宿胃宿昴宿畢宿觜宿参宿井宿鬼宿柳宿星宿張宿翼宿軫宿角宿亢宿氐宿房宿心宿尾宿箕宿斗宿女宿虚宿危宿室宿壁宿奎宿",
    );
  });

  it("サンスクリット名は Ashvini から Revati まで、同じ位置のナクシャトラ", () => {
    expect(SHUKU[0]).toMatchObject({ number: 1, name: "婁宿", sanskrit: "Ashvini" });
    expect(SHUKU[2]).toMatchObject({ number: 3, name: "昴宿", sanskrit: "Krittika" });
    expect(SHUKU[14]).toMatchObject({ number: 15, name: "亢宿", sanskrit: "Swati" });
    expect(SHUKU[26]).toMatchObject({ number: 27, name: "奎宿", sanskrit: "Revati" });
    // 名前もサンスクリット名も重複しない
    expect(new Set(SHUKU.map((shuku) => shuku.name)).size).toBe(27);
    expect(new Set(SHUKU.map((shuku) => shuku.sanskrit)).size).toBe(27);
  });

  it("1 宿の幅は 13°20′（360 / 27）", () => {
    expect(SHUKU_SPAN).toBeCloseTo(dm(13, 20), 12);
    expect(SHUKU_SPAN * 27).toBeCloseTo(360, 10);
  });

  it("shukuAt は 0 始まりで、はみ出しても輪になって戻る", () => {
    expect(shukuAt(0).name).toBe("婁宿");
    expect(shukuAt(26).name).toBe("奎宿");
    expect(shukuAt(27).name).toBe("婁宿");
    expect(shukuAt(-1).name).toBe("奎宿");
  });
});

// ---------------------------------------------------------------------------
// サイデリアル黄経 → 宿
// ---------------------------------------------------------------------------

describe("shukuOf（サイデリアル黄経から宿を出す）", () => {
  it("サイデリアル 0° は婁宿の始まり", () => {
    const position = shukuOf(0);
    expect(position.shuku.name).toBe("婁宿");
    expect(position.shuku.number).toBe(1);
    expect(position.degrees_in).toBe(0);
    expect(position.position).toBe("0°00′");
    expect(position.degrees_to_next).toBeCloseTo(dm(13, 20), 10);
    // 両隣は輪でつながる
    expect(position.prev.name).toBe("奎宿");
    expect(position.next.name).toBe("胃宿");
  });

  it("13°20′ ちょうどは胃宿の 0°（境界は次の宿のもの）", () => {
    // 13°20′ = 13.3333…° = 1 宿ぶん。floor(13.3333/13.3333) = 1 → 0 始まりの索引 1 ＝ 2 番目
    const position = shukuOf(SHUKU_SPAN);
    expect(position.shuku.name).toBe("胃宿");
    expect(position.shuku.number).toBe(2);
    expect(position.degrees_in).toBeCloseTo(0, 12);
    expect(position.prev.name).toBe("婁宿");
    expect(position.next.name).toBe("昴宿");
  });

  it("13°19′ は婁宿の末（1 分手前ならまだ手前の宿）", () => {
    const position = shukuOf(dm(13, 19));
    expect(position.shuku.name).toBe("婁宿");
    expect(position.position).toBe("13°19′");
    expect(position.degrees_to_next).toBeCloseTo(1 / 60, 10);
  });

  it("359°59′ は奎宿（27 番目）の末", () => {
    const position = shukuOf(dm(359, 59));
    expect(position.shuku.name).toBe("奎宿");
    expect(position.shuku.number).toBe(27);
    // 奎宿の始まりは 26 × 13°20′ = 346°40′。359°59′ − 346°40′ = 13°19′
    expect(position.position).toBe("13°19′");
    expect(position.next.name).toBe("婁宿");
  });

  it("360° は 0° に畳まれて婁宿へ戻る。負の黄経も同じ", () => {
    expect(shukuOf(360).shuku.name).toBe("婁宿");
    expect(shukuOf(-1).shuku.name).toBe("奎宿");
    expect(shukuOf(720 + 20).shuku.name).toBe("胃宿");
  });

  it("宿の境目 26 本を総当たり（境界は必ず次の宿の 0°）", () => {
    for (let index = 0; index < SHUKU_COUNT; index++) {
      const start = index * SHUKU_SPAN;
      const position = shukuOf(start);
      expect(position.shuku.number, `${index} 番目の始まり`).toBe(index + 1);
      expect(position.degrees_in).toBeCloseTo(0, 9);

      // 境界の 1″ 手前はまだ手前の宿
      const before = shukuOf(start - 1 / 3600);
      expect(before.shuku.number).toBe(((index + 26) % 27) + 1);
    }
  });

  it("宿内の位置と次の境界までの距離は、足すと必ず 1 宿ぶん", () => {
    for (let lon = 0; lon < 360; lon += 0.37) {
      const position = shukuOf(lon);
      expect(position.degrees_in + position.degrees_to_next).toBeCloseTo(SHUKU_SPAN, 10);
      expect(position.degrees_in).toBeGreaterThanOrEqual(0);
      expect(position.degrees_in).toBeLessThan(SHUKU_SPAN);
    }
  });

  it("実例: サイデリアル 190°25′ は亢宿（Swati）の 3°45′", () => {
    // 亢宿は 15 番目＝始まりは 14 × 13°20′ = 186°40′。190°25′ − 186°40′ = 3°45′
    const position = shukuOf(dm(190, 25));
    expect(position.shuku.name).toBe("亢宿");
    expect(position.shuku.sanskrit).toBe("Swati");
    expect(position.shuku.number).toBe(15);
    expect(position.position).toBe("3°45′");
    // 次の境界（200°00′）までは 9°35′
    expect(formatArcMinutes(position.degrees_to_next)).toBe("9°35′");
    expect(position.prev.name).toBe("角宿");
    expect(position.next.name).toBe("氐宿");
  });

  it("shukuIndexOf は 0 始まりで 0〜26 に収まる", () => {
    expect(shukuIndexOf(0)).toBe(0);
    expect(shukuIndexOf(359.9999999)).toBe(26);
    for (let lon = -720; lon < 1080; lon += 1.7) {
      const index = shukuIndexOf(lon);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(SHUKU_COUNT);
    }
  });
});

describe("toSidereal（トロピカル黄経 − アヤナムシャ）", () => {
  it("引くだけ。0〜360 に畳む", () => {
    // 2000 年ごろの Lahiri はおよそ 23.85°
    expect(toSidereal(100, 23.85)).toBeCloseTo(76.15, 10);
    expect(toSidereal(10, 23.85)).toBeCloseTo(346.15, 10);
    expect(toSidereal(23.85, 23.85)).toBeCloseTo(0, 10);
  });

  it("アヤナムシャ 0 なら素通し（偽エンジンの既定と同じ土俵）", () => {
    expect(toSidereal(200.5, 0)).toBeCloseTo(200.5, 12);
  });

  it("実例: トロピカル 259°37′ − Lahiri 24.2292° ＝ 心宿", () => {
    // 2026-08-22 00:00 UT の月（本物の wasm で確かめた値。test/shukuyo-real.test.ts と同じ）
    const sidereal = toSidereal(259.6207, 24.229216);
    expect(sidereal).toBeCloseTo(235.3915, 4);
    expect(shukuOf(sidereal).shuku.name).toBe("心宿");
    expect(shukuOf(sidereal).shuku.sanskrit).toBe("Jyeshtha");
  });
});

// ---------------------------------------------------------------------------
// 三九の秘法
// ---------------------------------------------------------------------------

describe("三九の秘法（relationOf）", () => {
  it("表は 27 個、1＝命・10＝業・19＝胎", () => {
    expect(RELATION_BY_DISTANCE).toHaveLength(27);
    expect(RELATION_BY_DISTANCE[0]).toBe("命");
    expect(RELATION_BY_DISTANCE[9]).toBe("業");
    expect(RELATION_BY_DISTANCE[18]).toBe("胎");
  });

  it("命・業・胎を除くと 8 つ組「栄・衰・安・危・成・壊・友・親」が 3 回まわる", () => {
    const eight: RelationName[] = ["栄", "衰", "安", "危", "成", "壊", "友", "親"];
    for (const head of [0, 9, 18]) {
      expect(RELATION_BY_DISTANCE.slice(head + 1, head + 9)).toEqual(eight);
    }
  });

  it("同じ宿は距離 1 の命", () => {
    for (let index = 0; index < SHUKU_COUNT; index++) {
      const relation = relationOf(index, index);
      expect(relation.distance).toBe(1);
      expect(relation.name).toBe("命");
      expect(relation.group).toBe("近");
      expect(relation.pair).toBe("命");
    }
  });

  it("距離は本命宿を 1 として数える（1 つ次が 2、1 つ前が 27）", () => {
    // 婁宿（0）から見た胃宿（1）は距離 2 ＝ 栄
    expect(relationOf(0, 1)).toMatchObject({ distance: 2, name: "栄", group: "近" });
    // 婁宿から見た奎宿（26）は距離 27 ＝ 親
    expect(relationOf(0, 26)).toMatchObject({ distance: 27, name: "親", group: "遠" });
    // 輪をまたいでも同じ（奎宿から見た婁宿は距離 2）
    expect(relationOf(26, 0)).toMatchObject({ distance: 2, name: "栄" });
  });

  it("距離 1〜27 の関係名と遠近が表のとおり", () => {
    const expected: [number, RelationName, string][] = [
      [1, "命", "近"],
      [2, "栄", "近"],
      [3, "衰", "近"],
      [4, "安", "近"],
      [5, "危", "近"],
      [6, "成", "近"],
      [7, "壊", "近"],
      [8, "友", "近"],
      [9, "親", "近"],
      [10, "業", "中"],
      [11, "栄", "中"],
      [18, "親", "中"],
      [19, "胎", "遠"],
      [20, "栄", "遠"],
      [27, "親", "遠"],
    ];
    for (const [distance, name, group] of expected) {
      // 婁宿（索引 0）から数えると、距離 d の相手は索引 d-1
      const relation = relationOf(0, distance - 1);
      expect(relation.distance, `距離 ${distance}`).toBe(distance);
      expect(relation.name, `距離 ${distance}`).toBe(name);
      expect(relation.group, `距離 ${distance}`).toBe(group);
    }
  });

  it("遠近は 9 宿ずつの 3 段（1〜9 近 / 10〜18 中 / 19〜27 遠）", () => {
    for (let distance = 1; distance <= 27; distance++) {
      const relation = relationOf(0, distance - 1);
      const expected = distance <= 9 ? "近" : distance <= 18 ? "中" : "遠";
      expect(relation.group, `距離 ${distance}`).toBe(expected);
      expect(relation.group_label).toBe(`${expected}距離`);
    }
  });

  it("索引が 0〜26 の整数でなければ断る", () => {
    expect(() => relationOf(-1, 0)).toThrow(ShukuyoError);
    expect(() => relationOf(0, 27)).toThrow(ShukuyoError);
    expect(() => relationOf(0, 1.5)).toThrow(ShukuyoError);
  });
});

describe("組の対称性（27 × 27 の総当たりで固定）", () => {
  /**
   * 三九の秘法の表がずれていないかを、**対称性ひとつ**で見張る。
   *
   * A から B への距離が d なら、B から A への距離は 29 − d（d ≧ 2）。
   * 表が正しければ、その 2 つは必ず対になる関係（栄↔親・衰↔友・安↔壊・危↔成・業↔胎）で、
   * 「組」の名前が一致する。並びを 1 つでも入れ替えるとここが落ちる。
   */
  it("A→B と B→A の組名が 729 通りすべてで一致する", () => {
    for (let a = 0; a < SHUKU_COUNT; a++) {
      for (let b = 0; b < SHUKU_COUNT; b++) {
        const compat = compatOf(a, b);
        expect(compat.a_to_b.pair, `${a}→${b}`).toBe(compat.b_to_a.pair);
        expect(compat.pair).toBe(compat.a_to_b.pair);
      }
    }
  });

  it("裏返しの距離は 29 − d（同じ宿だけ 1 と 1）", () => {
    for (let a = 0; a < SHUKU_COUNT; a++) {
      for (let b = 0; b < SHUKU_COUNT; b++) {
        const compat = compatOf(a, b);
        const sum = compat.a_to_b.distance + compat.b_to_a.distance;
        expect(sum, `${a}→${b}`).toBe(a === b ? 2 : 29);
      }
    }
  });

  it("対になる関係名は 栄↔親・衰↔友・安↔壊・危↔成・業↔胎・命↔命", () => {
    const partners: Record<string, string> = {
      命: "命",
      栄: "親",
      親: "栄",
      衰: "友",
      友: "衰",
      安: "壊",
      壊: "安",
      危: "成",
      成: "危",
      業: "胎",
      胎: "業",
    };
    for (let a = 0; a < SHUKU_COUNT; a++) {
      for (let b = 0; b < SHUKU_COUNT; b++) {
        const compat = compatOf(a, b);
        expect(compat.b_to_a.name, `${a}→${b}`).toBe(partners[compat.a_to_b.name]);
      }
    }
  });

  it("組の名前は 6 種類だけ（命・栄親・友衰・安壊・危成・業胎）", () => {
    const pairs = new Set<string>();
    for (let a = 0; a < SHUKU_COUNT; a++) {
      for (let b = 0; b < SHUKU_COUNT; b++) pairs.add(compatOf(a, b).pair);
    }
    expect([...pairs].sort()).toEqual(["命", "安壊", "危成", "業胎", "栄親", "友衰"].sort());
  });

  it("同じ宿どうしは命（same が立つ）", () => {
    const compat = compatOf(14, 14);
    expect(compat.same).toBe(true);
    expect(compat.pair).toBe("命");
    expect(compat.a.name).toBe("亢宿");
    expect(compat.b.name).toBe("亢宿");
  });

  it("実例: 亢宿（15）と氐宿（16）は栄親の組", () => {
    const compat = compatOf(14, 15);
    expect(compat.a_to_b).toMatchObject({ distance: 2, name: "栄", group: "近" });
    expect(compat.b_to_a).toMatchObject({ distance: 27, name: "親", group: "遠" });
    expect(compat.pair).toBe("栄親");
    expect(compat.same).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 宿名のパース
// ---------------------------------------------------------------------------

describe("宿名のパース", () => {
  it("漢字（宿つき・宿なし）を受ける", () => {
    expect(findShuku("亢宿")?.number).toBe(15);
    expect(findShuku("亢")?.number).toBe(15);
    expect(findShuku(" 婁宿 ")?.number).toBe(1);
    expect(findShuku("奎")?.number).toBe(27);
  });

  it("サンスクリット名は大文字小文字も区切りも問わない", () => {
    expect(findShuku("Swati")?.number).toBe(15);
    expect(findShuku("swati")?.number).toBe(15);
    expect(findShuku("SWATI")?.number).toBe(15);
    expect(findShuku("Purva Phalguni")?.number).toBe(11);
    expect(findShuku("purva-phalguni")?.number).toBe(11);
    expect(findShuku("purvaphalguni")?.number).toBe(11);
    expect(findShuku("Uttara Bhadrapada")?.number).toBe(26);
  });

  it("よくある別綴りも受ける", () => {
    expect(findShuku("Ashwini")?.number).toBe(1);
    expect(findShuku("Moola")?.number).toBe(19);
    expect(findShuku("Jyestha")?.number).toBe(18);
    expect(findShuku("Dhanistha")?.number).toBe(23);
    expect(findShuku("Satabhisha")?.number).toBe(24);
  });

  it("1〜27 の番号を受ける", () => {
    expect(findShuku("1")?.name).toBe("婁宿");
    expect(findShuku("15")?.name).toBe("亢宿");
    expect(findShuku("27")?.name).toBe("奎宿");
    expect(findShuku("0")).toBeNull();
    expect(findShuku("28")).toBeNull();
  });

  it("27 宿すべてが漢字・サンスクリット名・番号のどれでも引ける", () => {
    for (const shuku of SHUKU) {
      expect(findShuku(shuku.name)).toBe(shuku);
      expect(findShuku(shuku.name.replace("宿", ""))).toBe(shuku);
      expect(findShuku(shuku.sanskrit)).toBe(shuku);
      expect(findShuku(shuku.sanskrit.toLowerCase())).toBe(shuku);
      expect(findShuku(String(shuku.number))).toBe(shuku);
    }
  });

  it("読み（かな）では引かない＝重なる読みで別の宿を返さない", () => {
    // せいしゅく（井宿・星宿）、しんしゅく（参宿・心宿・軫宿）などがぶつかるため
    expect(findShuku("せいしゅく")).toBeNull();
    expect(findShuku("しんしゅく")).toBeNull();
  });

  it("読めなければ parseShuku は断る（何を渡せばよいかを書く）", () => {
    expect(findShuku("そんな宿はない")).toBeNull();
    expect(() => parseShuku("そんな宿はない")).toThrow(ShukuyoError);
    try {
      parseShuku("Nakshatra28", "a の宿");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("a の宿として読めませんでした");
      expect(message).toContain("Nakshatra28");
      expect(message).toContain("1〜27 の番号");
    }
  });
});

// ---------------------------------------------------------------------------
// テキスト整形
// ---------------------------------------------------------------------------

describe("テキスト整形", () => {
  it("formatArcMinutes は度と分（分は 2 桁）", () => {
    expect(formatArcMinutes(0)).toBe("0°00′");
    expect(formatArcMinutes(dm(3, 45))).toBe("3°45′");
    expect(formatArcMinutes(SHUKU_SPAN)).toBe("13°20′");
    // 3.9° が 3°53′ にならないこと（浮動小数の埃を 1e-6 分だけ底上げしてある）
    expect(formatArcMinutes(3.9)).toBe("3°54′");
  });

  it("formatShukuName は漢字・読み・サンスクリット名・番号を並べる", () => {
    expect(formatShukuName(SHUKU[14]!)).toBe("亢宿（こうしゅく・Swati・15）");
  });

  it("formatShukuLines は宿・宿内の位置・両隣・サイデリアル黄経の 4 行", () => {
    const lines = formatShukuLines(shukuOf(dm(190, 25)));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("亢宿（こうしゅく・Swati・15）");
    expect(lines[1]).toBe("宿内の位置: 3°45′ / 境界まで: 前 3°45′・次 9°35′");
    expect(lines[2]).toContain("両隣: 前 角宿");
    expect(lines[2]).toContain("次 氐宿");
    expect(lines[3]).toContain("サイデリアル黄経 190.4167°");
    // 意味・吉凶は 1 文字も書かない
    expect(lines.join("\n")).not.toContain("吉");
    expect(lines.join("\n")).not.toContain("凶");
  });

  it("formatRelation は距離・関係名・遠近・組を 1 行に", () => {
    expect(formatRelation(relationOf(0, 2))).toBe("距離 3 → 衰（すい） / 近距離 / 組 友衰");
  });

  it("formatCompatLines は両方向と組を書く", () => {
    const lines = formatCompatLines(compatOf(14, 15), "チャート A（abcd1234）", "宿名指定");
    expect(lines[0]).toBe("A: チャート A（abcd1234） 亢宿（こうしゅく・Swati・15）");
    expect(lines[1]).toBe("B: 宿名指定 氐宿（ていしゅく・Vishakha・16）");
    expect(lines[2]).toContain("A → B: 距離 2 → 栄（えい）");
    expect(lines[3]).toContain("B → A: 距離 27 → 親（しん）");
    expect(lines[4]).toContain("組: 栄親");
  });

  it("同じ宿どうしは「命（同じ宿）」と書く", () => {
    expect(formatCompatLines(compatOf(3, 3), "A", "B")[4]).toBe("組: 命（同じ宿）");
  });

  it("基準点の名前は Lahiri（規約は名前で言う）", () => {
    expect(AYANAMSA_NAME).toBe("Lahiri");
  });
});
