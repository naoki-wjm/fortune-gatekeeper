import { describe, expect, it } from "vitest";
import {
  DEFAULT_MASTERS,
  MASTERS_OPTIONS,
  NumerologyError,
  PRESET_KEYS,
  calculateNumerology,
  digitSum,
  formatNumerologyText,
  reduceNumber,
  type MastersOption,
  type MultiPath,
  type NumerologyResult,
  type PresetKey,
} from "../src/numerology";

// ---------------------------------------------------------------------------
// 突き合わせ用の別実装
//
// 仕様書の期待値の表は検算済みだが、写し取るだけでは「表と実装が同じ勘違いをしている」
// 場合に気づけないので、ここで**もう一度別の書き方で**計算して突き合わせる。
// ---------------------------------------------------------------------------

/** 桁の並び（12 → [1, 2]） */
const digitsOf = (value: number): number[] => String(value).split("").map(Number);

/** 1 桁になるまで（またはマスターに当たるまで）桁を足す。再帰で書いてある */
function down(value: number, masters: readonly number[]): number {
  if (value <= 9 || masters.includes(value)) return value;
  return down(
    digitsOf(value).reduce((sum, digit) => sum + digit, 0),
    masters,
  );
}

const mastersOf = (option: MastersOption): number[] =>
  option === "11_22" ? [11, 22] : [11, 22, 33];

/** 「いくつかの数を足して還元する」形の 4 経路を別実装で出す */
function expectedPaths(
  parts: readonly number[],
  masters: readonly number[],
): Record<PresetKey, number> {
  // full_sum / no_master は YYYYMMDD を 1 桁ずつ足したもの（0 埋めの有無に左右されない）
  const allDigits = parts.flatMap(digitsOf).reduce((sum, digit) => sum + digit, 0);
  const sumOf = (partMasters: readonly number[]): number =>
    parts.map((part) => down(part, partMasters)).reduce((sum, part) => sum + part, 0);
  return {
    full_sum: down(allDigits, masters),
    component_reduce: down(sumOf([]), masters),
    component_keep: down(sumOf(masters), masters),
    no_master: down(allDigits, []),
  };
}

/** 「前の段に 1 つ足して還元する」形（パーソナルマンス・デイ） */
function expectedFromBase(
  base: Record<PresetKey, number>,
  addend: number,
  masters: readonly number[],
): Record<PresetKey, number> {
  const step = (key: PresetKey): number =>
    down(base[key] + addend, key === "no_master" ? [] : masters);
  return {
    full_sum: step("full_sum"),
    component_reduce: step("component_reduce"),
    component_keep: step("component_keep"),
    no_master: step("no_master"),
  };
}

/** MultiPath から value だけ取り出す */
function valuesOf(multi: MultiPath): Record<PresetKey, number> {
  return {
    full_sum: multi.presets.full_sum.value,
    component_reduce: multi.presets.component_reduce.value,
    component_keep: multi.presets.component_keep.value,
    no_master: multi.presets.no_master.value,
  };
}

/** その日の結果を 1 発で（基準日は既定で 2026-08-22） */
function run(
  year: number,
  month: number,
  day: number,
  options: { masters?: MastersOption; target?: [number, number, number] } = {},
): NumerologyResult {
  const [ty, tm, td] = options.target ?? [2026, 8, 22];
  return calculateNumerology({
    year,
    month,
    day,
    target: { year: ty, month: tm, day: td },
    ...(options.masters ? { masters: options.masters } : {}),
  });
}

/** 結果の中の steps を全部集める */
function allSteps(result: NumerologyResult): string[] {
  const multis: MultiPath[] = [
    result.life_path,
    result.attitude,
    result.personal_year,
    result.personal_month,
    result.personal_day,
  ];
  const steps = multis.flatMap((multi) => PRESET_KEYS.map((key) => multi.presets[key].steps));
  steps.push(result.birthday.steps);
  return steps;
}

// ---------------------------------------------------------------------------

describe("桁の和と還元", () => {
  it("digitSum は十進の各桁を足す", () => {
    expect(digitSum(38)).toBe(11);
    expect(digitSum(1986)).toBe(24);
    expect(digitSum(7)).toBe(7);
    expect(digitSum(0)).toBe(0);
  });

  it("reduceNumber はマスターに当たるまで、無ければ 1 桁まで落とす", () => {
    expect(reduceNumber(38, [11, 22, 33])).toBe(11);
    expect(reduceNumber(38, [])).toBe(2);
    expect(reduceNumber(33, [11, 22, 33])).toBe(33);
    expect(reduceNumber(33, [11, 22])).toBe(6);
    expect(reduceNumber(29, [11, 22, 33])).toBe(11);
    expect(reduceNumber(9, [11, 22, 33])).toBe(9);
    // 99 → 18 → 9（途中の 18 はマスターではない）
    expect(reduceNumber(99, [11, 22, 33])).toBe(9);
  });
});

describe("ライフパスの 4 経路（検算表）", () => {
  // 仕様書の表。ここは「手で検算した答え」として置き、下の別実装でも同じ数になるか見る
  const table: {
    date: [number, number, number];
    full: Record<MastersOption, number>;
    rest: [number, number, number];
  }[] = [
    { date: [1986, 12, 29], full: { "11_22_33": 11, "11_22": 11 }, rest: [11, 2, 2] },
    { date: [1960, 12, 12], full: { "11_22_33": 22, "11_22": 22 }, rest: [4, 4, 4] },
    { date: [1959, 3, 6], full: { "11_22_33": 33, "11_22": 6 }, rest: [6, 6, 6] },
    { date: [2000, 1, 1], full: { "11_22_33": 4, "11_22": 4 }, rest: [4, 4, 4] },
  ];

  for (const entry of table) {
    const [year, month, day] = entry.date;
    for (const option of MASTERS_OPTIONS) {
      it(`${year}-${month}-${day}（masters: ${option}）`, () => {
        const values = valuesOf(run(year, month, day, { masters: option }).life_path);
        expect(values).toEqual({
          full_sum: entry.full[option],
          component_reduce: entry.rest[0],
          component_keep: entry.rest[1],
          no_master: entry.rest[2],
        });
        // 別実装でも同じ答えになるか
        expect(values).toEqual(expectedPaths([year, month, day], mastersOf(option)));
      });
    }
  }

  it("1986-12-29 の中身（全桁 38・個別 6/3/2・保持だと 6+3+11）", () => {
    const life = run(1986, 12, 29).life_path;
    expect(life.presets.full_sum.steps).toBe("全桁の合計 38 → 3+8 = 11（マスター、保持）");
    expect(life.presets.component_reduce.steps).toBe("年 6 ＋ 月 3 ＋ 日 2 = 11（マスター、保持）");
    expect(life.presets.component_keep.steps).toBe("年 6 ＋ 月 3 ＋ 日 11 = 20 → 2+0 = 2");
    expect(life.presets.no_master.steps).toBe(
      "全桁の合計 38 → 3+8 = 11 → 1+1 = 2（マスター無し）",
    );
  });

  it("マスターのときは還元先も添える", () => {
    const life = run(1986, 12, 29).life_path;
    expect(life.presets.full_sum).toMatchObject({ value: 11, reduced: 2, is_master: true });
    expect(life.presets.component_keep).toMatchObject({ value: 2, reduced: 2, is_master: false });

    const twentyTwo = run(1960, 12, 12).life_path.presets.full_sum;
    expect(twentyTwo).toMatchObject({ value: 22, reduced: 4, is_master: true });

    const thirtyThree = run(1959, 3, 6).life_path.presets.full_sum;
    expect(thirtyThree).toMatchObject({ value: 33, reduced: 6, is_master: true });
    // 33 を認めない流派なら 6（マスターではない）
    expect(run(1959, 3, 6, { masters: "11_22" }).life_path.presets.full_sum).toMatchObject({
      value: 6,
      reduced: 6,
      is_master: false,
    });
  });
});

describe("経路が割れているかどうか", () => {
  it("1986-12-29 は割れる（11 と 2）", () => {
    const life = run(1986, 12, 29).life_path;
    expect(life.agree).toBe(false);
    expect(life.values).toEqual([11, 2]);
  });

  it("2000-01-01 は 4 経路とも同じ", () => {
    const life = run(2000, 1, 1).life_path;
    expect(life.agree).toBe(true);
    expect(life.values).toEqual([4]);
  });

  it("presets のキーは 4 つ・順番も固定", () => {
    const life = run(1986, 12, 29).life_path;
    expect(Object.keys(life.presets)).toEqual([
      "full_sum",
      "component_reduce",
      "component_keep",
      "no_master",
    ]);
    expect(PRESET_KEYS).toEqual(Object.keys(life.presets));
  });
});

describe("バースデーナンバー", () => {
  it("29 は 11（還元先 2・マスター）", () => {
    const birthday = run(1986, 12, 29).birthday;
    expect(birthday).toEqual({
      day: 29,
      value: 11,
      reduced: 2,
      is_master: true,
      steps: "日 29 → 2+9 = 11（マスター、保持）",
    });
  });

  it("7 はそのまま 7（マスターではない）", () => {
    const birthday = run(1986, 12, 7).birthday;
    expect(birthday).toEqual({
      day: 7,
      value: 7,
      reduced: 7,
      is_master: false,
      steps: "日 7",
    });
  });

  it("22 日はマスター 22（還元先 4）、11_22 でも同じ", () => {
    expect(run(2000, 1, 22).birthday).toMatchObject({ value: 22, reduced: 4, is_master: true });
    expect(run(2000, 1, 22, { masters: "11_22" }).birthday).toMatchObject({
      value: 22,
      is_master: true,
    });
  });

  it("経路で割れない（1 本だけ）", () => {
    const birthday = run(1986, 12, 29).birthday;
    expect(Object.keys(birthday).sort()).toEqual(
      ["day", "value", "reduced", "is_master", "steps"].sort(),
    );
  });
});

describe("アティチュード（サンナンバー）", () => {
  it("1986-12-29 は 4 経路とも 5", () => {
    const attitude = run(1986, 12, 29).attitude;
    expect(attitude.agree).toBe(true);
    expect(attitude.values).toEqual([5]);
    expect(valuesOf(attitude)).toEqual(expectedPaths([12, 29], [11, 22, 33]));
  });

  it("月と日だけを見る（年に左右されない）", () => {
    const a = valuesOf(run(1986, 12, 29).attitude);
    const b = valuesOf(run(2001, 12, 29).attitude);
    expect(a).toEqual(b);
  });
});

describe("パーソナルイヤー／マンス／デイ", () => {
  it("1986-12-29 を 2026-08-22 で見ると 6 / 5 / 9", () => {
    const result = run(1986, 12, 29);
    expect(result.personal_year.values).toEqual([6]);
    expect(result.personal_month.values).toEqual([5]);
    expect(result.personal_day.values).toEqual([9]);
    expect(result.personal_year.agree).toBe(true);
    expect(result.personal_month.agree).toBe(true);
    expect(result.personal_day.agree).toBe(true);

    // 別実装での再計算（月・日・基準年 → ＋基準月 → ＋基準日）
    const masters = [11, 22, 33];
    const year = expectedPaths([12, 29, 2026], masters);
    const month = expectedFromBase(year, 8, masters);
    const day = expectedFromBase(month, 22, masters);
    expect(valuesOf(result.personal_year)).toEqual(year);
    expect(valuesOf(result.personal_month)).toEqual(month);
    expect(valuesOf(result.personal_day)).toEqual(day);
  });

  it("基準日を持ち歩く（年・月・日が返り値に載る）", () => {
    const result = run(1986, 12, 29, { target: [2027, 1, 3] });
    expect(result.personal_year.year).toBe(2027);
    expect(result.personal_month).toMatchObject({ year: 2027, month: 1 });
    expect(result.personal_day).toMatchObject({ year: 2027, month: 1, day: 3 });
  });

  it("暦年起点（1/1 で切り替わる）", () => {
    const before = run(1986, 12, 29, { target: [2026, 12, 31] }).personal_year.values;
    const after = run(1986, 12, 29, { target: [2027, 1, 1] }).personal_year.values;
    // 誕生日（12/29）を過ぎていても年末までは同じ数、年が明けると変わる
    expect(before).toEqual([6]);
    expect(after).not.toEqual(before);
    // 誕生日の前後では変わらない
    expect(run(1986, 12, 29, { target: [2026, 1, 1] }).personal_year.values).toEqual(before);
  });

  it("マンスはイヤーに基準月、デイはマンスに基準日を足す", () => {
    const result = run(1986, 12, 29);
    expect(result.personal_month.presets.full_sum.steps).toBe(
      "パーソナルイヤー 6 ＋ 基準月 8 = 14 → 1+4 = 5",
    );
    expect(result.personal_day.presets.full_sum.steps).toBe(
      "パーソナルマンス 5 ＋ 基準日 22 = 27 → 2+7 = 9",
    );
  });
});

describe("途中式に出生データを書かない", () => {
  it("生まれ年（1986）と生まれ月（12）の生の数字が steps に出ない", () => {
    const result = run(1986, 12, 29);
    for (const steps of allSteps(result)) {
      expect(steps, steps).not.toContain("1986");
      expect(steps, steps).not.toContain("12");
    }
    // 日はバースデーナンバーとして表に出る数なので、そのまま書いてよい
    expect(result.birthday.steps).toContain("29");
    // 基準日は出生データではないので全部書く
    expect(result.personal_year.presets.full_sum.steps).toContain("2026");
    expect(result.personal_day.presets.full_sum.steps).toContain("22");
  });

  it("テキスト整形にも生まれ年・生まれ月は出ない", () => {
    const text = formatNumerologyText(run(1986, 12, 29));
    expect(text).not.toContain("1986");
    // 「12」は基準日にも出うるので、生まれ月が 12 でも出てこない基準日（8/22）で見る
    expect(text).not.toContain("12");
  });
});

describe("採った規約を返す", () => {
  it("マスターの並び・起点・プリセットの説明・守備範囲", () => {
    const conventions = run(1986, 12, 29).conventions;
    expect(conventions.masters).toEqual([11, 22, 33]);
    expect(conventions.personal_year_start).toBe("calendar");
    expect(Object.keys(conventions.presets)).toEqual([...PRESET_KEYS]);
    for (const key of PRESET_KEYS) {
      expect(conventions.presets[key].length).toBeGreaterThan(5);
    }
    expect(conventions.note).toContain("ピタゴラス式");
    expect(conventions.note).toContain("名前数秘");
  });

  it("11_22 なら 33 は載らない", () => {
    expect(run(1986, 12, 29, { masters: "11_22" }).conventions.masters).toEqual([11, 22]);
  });

  it("masters を省くと既定は 11_22_33", () => {
    expect(DEFAULT_MASTERS).toBe("11_22_33");
    expect(run(1959, 3, 6).life_path.presets.full_sum.value).toBe(33);
  });
});

describe("テキスト整形", () => {
  it("割れているときは経路ごとの行を出す", () => {
    const text = formatNumerologyText(run(1986, 12, 29));
    const lines = text.split("\n");
    expect(lines[0]).toBe("■ 数秘術（生年月日ベース・ピタゴラス式）");
    expect(lines[1]).toBe("ライフパス: 11 / 2 ← 経路で割れています");
    expect(lines[2]).toContain("full_sum");
    expect(lines[2]).toContain("11 (→2)");
    expect(lines[5]).toContain("no_master");
    expect(text).toContain("バースデー: 29 → 11 (→2)");
    expect(text).toContain("（4 経路一致）");
    expect(text).toContain("パーソナルデイ 2026-08-22: 9（4 経路一致）");
    expect(text).toContain("規約: マスター 11/22/33");
    expect(text).toContain("名前数秘・ピナクル・チャレンジは範囲外");
  });

  it("一致しているときは 1 行に畳む", () => {
    const text = formatNumerologyText(run(2000, 1, 1));
    const lines = text.split("\n");
    expect(lines[1]).toBe("ライフパス: 4（4 経路一致）");
    // 畳んだ行の下に経路ごとの行は出ない
    expect(lines[2]).toBe("バースデー: 1"); // 1 日生まれは矢印も出さない
    expect(lines[3]).toBe("アティチュード（サンナンバー）: 2（4 経路一致）");
  });

  it("サイクル側だけが割れることもある（マンスで 11 が立つ）", () => {
    // 2000-01-01 はライフパスは 4 で一致するが、パーソナルマンスは 3+8 = 11 で割れる
    const result = run(2000, 1, 1);
    expect(result.life_path.agree).toBe(true);
    expect(result.personal_month.values).toEqual([11, 2]);
    expect(result.personal_month.presets.no_master.value).toBe(2);
    const text = formatNumerologyText(result);
    expect(text).toContain("パーソナルマンス 2026-08: 11 / 2 ← 経路で割れています");
  });

  it("11_22 の規約もそのまま書く", () => {
    const text = formatNumerologyText(run(1959, 3, 6, { masters: "11_22" }));
    expect(text).toContain("規約: マスター 11/22、");
  });
});

describe("受け付けない引数", () => {
  const cases: { label: string; input: Parameters<typeof calculateNumerology>[0]; hit: string }[] = [
    {
      label: "存在しない日付（2 月 31 日）",
      input: { year: 1986, month: 2, day: 31, target: { year: 2026, month: 8, day: 22 } },
      hit: "暦に存在しない日付です",
    },
    {
      label: "月が 13",
      input: { year: 1986, month: 13, day: 1, target: { year: 2026, month: 8, day: 22 } },
      hit: "月は 1〜12",
    },
    {
      label: "小数の日",
      input: { year: 1986, month: 12, day: 29.5, target: { year: 2026, month: 8, day: 22 } },
      hit: "整数で指定してください",
    },
    {
      label: "基準日が存在しない",
      input: { year: 1986, month: 12, day: 29, target: { year: 2026, month: 4, day: 31 } },
      hit: "基準日の 2026-04-31",
    },
    {
      label: "知らない masters",
      input: {
        year: 1986,
        month: 12,
        day: 29,
        target: { year: 2026, month: 8, day: 22 },
        masters: "11_22_33_44" as MastersOption,
      },
      hit: "masters は",
    },
  ];

  for (const entry of cases) {
    it(entry.label, () => {
      expect(() => calculateNumerology(entry.input)).toThrow(NumerologyError);
      expect(() => calculateNumerology(entry.input)).toThrow(entry.hit);
    });
  }

  it("うるう年の 2 月 29 日は通る", () => {
    expect(() => run(2028, 2, 29)).not.toThrow();
    expect(() => run(2027, 2, 29)).toThrow(NumerologyError);
  });
});

describe("別実装との総当たり", () => {
  it("いろいろな生年月日で 4 経路とも一致する", () => {
    const years = [1899, 1900, 1959, 1960, 1986, 1999, 2000, 2011, 2026];
    const days = [1, 6, 9, 11, 19, 22, 28, 29];
    let checked = 0;

    for (const option of MASTERS_OPTIONS) {
      const masters = mastersOf(option);
      for (const year of years) {
        for (let month = 1; month <= 12; month++) {
          for (const day of days) {
            if (month === 2 && day === 29) continue; // うるう年は別の試験で見る
            const result = run(year, month, day, { masters: option, target: [2026, 8, 22] });

            expect(valuesOf(result.life_path), `${year}-${month}-${day}`).toEqual(
              expectedPaths([year, month, day], masters),
            );
            expect(valuesOf(result.attitude), `${year}-${month}-${day}`).toEqual(
              expectedPaths([month, day], masters),
            );

            const personalYear = expectedPaths([month, day, 2026], masters);
            const personalMonth = expectedFromBase(personalYear, 8, masters);
            expect(valuesOf(result.personal_year)).toEqual(personalYear);
            expect(valuesOf(result.personal_month)).toEqual(personalMonth);
            expect(valuesOf(result.personal_day)).toEqual(
              expectedFromBase(personalMonth, 22, masters),
            );

            expect(result.birthday.value).toBe(down(day, masters));
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("マスターの還元先は 11→2・22→4・33→6", () => {
    for (const multi of [run(1986, 12, 29).life_path, run(1960, 12, 12).life_path]) {
      for (const key of PRESET_KEYS) {
        const path = multi.presets[key];
        expect(path.is_master).toBe([11, 22, 33].includes(path.value));
        expect(path.reduced).toBe(down(path.value, []));
      }
    }
  });
});
