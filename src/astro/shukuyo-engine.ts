/**
 * 宿曜の「天体グルー」＝純関数（src/shukuyo.ts）に月の位置を流し込む配線。
 *
 * もとは `src/astro/tools/shukuyo.ts` の中に埋まっていたものを、
 * **鍵つき層の外からも同じ 1 か所を呼べるように**ここへ移しました（2026-09-20）。
 * ブラウザ用の束ね（src/browser/）も MCP の科（tools/shukuyo.ts）も、宿を出す道は
 * この 1 本だけ ―― 計算の正本を二重に持たない、というのがこのファイルの存在理由です。
 *
 * 天文方式一択（出生時刻の月のサイデリアル黄経 ÷ 13°20′、基準点は Lahiri 固定）。
 * ⚠ サイデリアル計算が効くには `swe_set_sid_mode(SIDEREAL_MODE_LAHIRI, 0, 0)` が
 *    一度呼ばれている必要があります（本番は engine.ts が初期化直後に、
 *    ブラウザは `src/browser/index.ts` の `prepareEngine` が呼びます）。
 *
 * ⚠ KV にも身元にも触れません（`SwissEph` を引数で受けるだけ）。
 */
import {
  AYANAMSA_NAME,
  SHUKU_COUNT,
  SHUKU_SPAN,
  shukuAt,
  shukuIndexOf,
  shukuOf,
  toSidereal,
  type Shuku,
  type ShukuPosition,
} from "../shukuyo";
import { CALC_FLAGS, SIDEREAL_MODE_LAHIRI, normalizeDegree, type SwissEph } from "./chart";
import { crossUt } from "./returns";

/** 月の天体 ID（PLANETS の並びと同じ） */
export const MOON_ID = 1;

/** 1 日のうちに宿が切り替わる回数の上限（月は 1 宿に 21〜27 時間いるので、多くて 2 回） */
export const MAX_SHUKU_CHANGES = 3;

/** その瞬間の月のトロピカル黄経 */
export function moonLongitude(swe: SwissEph, jd: number): number {
  return normalizeDegree(swe.swe_calc_ut(jd, MOON_ID, CALC_FLAGS)[0] as number);
}

/**
 * その瞬間の月の宿（サイデリアル）。
 *
 * ⚠ **アヤナムシャの値は呼び出し側へ返さないこと**（出生の瞬間で引いたぶんは）。
 *    Lahiri は 50″/年ほどで動くので、小数 4 桁まで出すと値そのものが「生まれた年月」の目盛りになる
 *    ――出生データを返事に出さない約束に触れる。日運のように**呼び出し側が日付を指定した瞬間**の
 *    アヤナムシャは、その日付がもともと会話に出ているので返してよい。
 */
export function shukuAtJd(
  swe: SwissEph,
  jd: number,
): { position: ShukuPosition; ayanamsa: number } {
  const ayanamsa = swe.swe_get_ayanamsa_ut(jd);
  return { position: shukuOf(toSidereal(moonLongitude(swe, jd), ayanamsa)), ayanamsa };
}

/**
 * 窓（startJd 以上 endJd 未満）の中で月が宿の境界を越える瞬間を拾う。
 *
 * 月は逆行しないので、境界は必ず前から順に 1 つずつ越える。探索は returns.ts の crossUt
 * （＝壊れた wrapper のエラーチェックを呼び出し側で検算するやつ）を借りる。
 * ⚠ `swe_mooncross_ut` が探すのは**トロピカル黄経**なので、サイデリアルの境界に
 *    アヤナムシャを足し戻してから渡す。アヤナムシャは 1 日で 4e-5° しか動かず、
 *    月足（13°/日）に直すと 0.3 秒未満なので、窓の頭の値を使い回して構わない。
 */
export function moonShukuChanges(
  swe: SwissEph,
  startJd: number,
  endJd: number,
  ayanamsa: number,
): { jd: number; from: Shuku; to: Shuku }[] {
  let index = shukuIndexOf(toSidereal(moonLongitude(swe, startJd), ayanamsa));
  const changes: { jd: number; from: Shuku; to: Shuku }[] = [];
  let cursor = startJd;

  for (let guard = 0; guard < MAX_SHUKU_CHANGES; guard++) {
    const nextIndex = (index + 1) % SHUKU_COUNT;
    const targetTropical = normalizeDegree(nextIndex * SHUKU_SPAN + ayanamsa);
    const jd = crossUt(swe, "moon", targetTropical, cursor);
    if (jd >= endJd) break;
    changes.push({ jd, from: shukuAt(index), to: shukuAt(nextIndex) });
    index = nextIndex;
    cursor = jd;
  }
  return changes;
}

/** 返り値に添える「このサーバーが採った規約」。名前で書くのは読む側が流派を確かめられるように */
export const SHUKUYO_SYSTEM = {
  method: "astronomical",
  method_label: "天文方式（出生時刻の月のサイデリアル黄経 ÷ 13°20′）",
  ayanamsa: AYANAMSA_NAME,
  ayanamsa_id: SIDEREAL_MODE_LAHIRI,
  mansions: SHUKU_COUNT,
  span_degrees: SHUKU_SPAN,
  origin: "婁宿（Ashvini）＝サイデリアル 0°",
  calendar_note:
    "暦方式（旧暦の日付から宿を引くやり方）は採らない" +
    "（旧暦は 2033 年問題のように裁定者のいない未解決の規約を含むため）",
  note: "『宿曜経』の列挙は昴宿から始まるが、それは表の並びであって位置の起点ではない",
} as const;

/** 規約の 1 行（テキストの末尾に置く） */
export const SHUKUYO_SYSTEM_LINE =
  `規約: ${SHUKUYO_SYSTEM.method_label} / 基準点 ${AYANAMSA_NAME}（SE_SIDM_LAHIRI）/ ` +
  `${SHUKU_COUNT} 宿・${SHUKUYO_SYSTEM.origin} / ${SHUKUYO_SYSTEM.calendar_note}`;
