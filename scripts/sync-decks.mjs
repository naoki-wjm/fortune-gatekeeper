/**
 * デッキ JSON 同期スクリプト（fortune-site ＋ meanings/ → src/data/）
 *
 * 素材の正本は2箇所にある。
 *  - カード名と一言（meaning / meaning_upright / meaning_reversed）… fortune-site 側の JSON
 *  - 解説（explanation）… このリポの meanings/*.json
 * ここはその2つを合成して src/data/ へ出力するだけ。src/data/ は生成物なので手で編集しない
 * （編集すると次の同期で消える）。
 *
 * meanings/*.json の出自は占いゴーストの里々辞書 dic_fortune.txt で、そこからカードごとの
 * 解説を抽出したもの。**使うのは explanation だけ**で、同梱の message は使わない
 * ——一言の正本はあくまで fortune-site 側の meaning_*（体言止め）で、meanings 側の message は
 * ですます調の別物。上書きすると空オラクルのお題形式「カード名『メッセージ』」が変わってしまう。
 *
 * 権利の門番: 意味テキストの公開可否を PUBLIC_MEANINGS で管理する。
 * false のデッキはカード名（とルーンの個別 has_reversed）だけを残し、
 * meaning / meaning_upright / meaning_reversed / keyword と解説（explanation 系）を
 * 剥がして出力する。意味を持たないデッキは「カード名だけ引く」ツールになり、
 * 読むのは Claude 自身の知識。
 *
 * 使い方: npm run sync:decks
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 意味テキストを公開版に載せてよいか（false なら剥がす） */
const PUBLIC_MEANINGS = { sky: true, enigma: true, tarot: false, tarot_minor: false, rune: false };

/** 剥がす対象のキー（name_en は意味テキストではないので残す） */
const MEANING_KEYS = [
  "meaning",
  "meaning_upright",
  "meaning_reversed",
  "keyword",
  "explanation",
  "explanation_upright",
  "explanation_reversed",
];

/** デッキ id → 元ファイル名 */
const DECK_FILES = {
  sky: "sky-oracle.json",
  enigma: "enigma-oracle.json",
  tarot: "tarot-major.json",
  tarot_minor: "tarot-minor.json",
  rune: "rune-futhark.json",
};

/** デッキ id → 解説ファイル名（meanings/ 配下）。載っていないデッキは解説を持たない */
const MEANING_FILES = {
  sky: "sky_meanings.json",
  enigma: "enigma_meanings.json",
};

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const SOURCE_DIR = resolve(PROJECT_ROOT, "..", "fortune-site", "src", "data");
const MEANINGS_DIR = join(PROJECT_ROOT, "meanings");
const OUTPUT_DIR = join(PROJECT_ROOT, "src", "data");

/** カード1枚から意味テキストを剥がす（name と個別 has_reversed は残す） */
function stripMeanings(card) {
  const kept = {};
  for (const [key, value] of Object.entries(card)) {
    if (MEANING_KEYS.includes(key)) continue;
    kept[key] = value;
  }
  return kept;
}

/** JSON を読む（BOM が混ざっていても落ちないように削っておく） */
async function readJson(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw.replace(/^﻿/, ""));
}

/** JSON を読む。ファイルが無ければ undefined（その他のエラーはそのまま投げる） */
async function readJsonIfExists(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** 空文字・欠落を弾いて解説テキストを取り出す */
function requireExplanation(value, fileName, cardName, where) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fileName}: 「${cardName}」の解説（${where}）が空です`);
  }
  return value;
}

/**
 * 解説（explanation）をカードへ合成する。
 *
 * 突合はカード名。片方にしか無い名前が1つでもあればその場で落とす
 * （生成物が黙ってズレると、引いた札と解説が入れ違ったまま公開されてしまうため）。
 * 正逆のあるデッキには explanation_upright / explanation_reversed を、
 * 正逆の無いデッキには explanation を付ける。meanings 側の message には触らない。
 */
function attachExplanations(deck, meanings, fileName) {
  const table = new Map();
  for (const entry of meanings.cards ?? []) {
    if (table.has(entry.name)) {
      throw new Error(`${fileName}: 解説のカード名が重複しています: ${entry.name}`);
    }
    table.set(entry.name, entry);
  }

  const deckNames = deck.cards.map((card) => card.name);
  const missing = deckNames.filter((name) => !table.has(name));
  if (missing.length > 0) {
    throw new Error(`${fileName}: 解説の見つからないカードがあります: ${missing.join("、")}`);
  }
  const extra = [...table.keys()].filter((name) => !deckNames.includes(name));
  if (extra.length > 0) {
    throw new Error(`${fileName}: デッキに無いカードの解説が余っています: ${extra.join("、")}`);
  }

  const perOrientation = deck.has_reversed === true;
  for (const card of deck.cards) {
    const entry = table.get(card.name);
    if (perOrientation) {
      card.explanation_upright = requireExplanation(
        entry.upright && entry.upright.explanation,
        fileName,
        card.name,
        "正位置",
      );
      card.explanation_reversed = requireExplanation(
        entry.reversed && entry.reversed.explanation,
        fileName,
        card.name,
        "逆位置",
      );
    } else {
      card.explanation = requireExplanation(entry.explanation, fileName, card.name, "正逆なし");
    }
  }
}

/**
 * 5デッキを組み立てて検証まで済ませる（ここではまだ 1 バイトも書かない）。
 * 解説の突合で落ちるのは 3 デッキ目かもしれないので、**書くのは全部通ってから**。
 * 途中で投げれば src/data/ は前回のまま＝新旧の混ざった生成物を残さない。
 */
async function buildDecks() {
  const built = [];

  for (const [deckId, fileName] of Object.entries(DECK_FILES)) {
    const deck = await readJson(join(SOURCE_DIR, fileName));

    if (deck.id !== deckId) {
      throw new Error(`デッキ id が想定と違います: ${fileName} → ${deck.id}（期待: ${deckId}）`);
    }

    const includeMeanings = PUBLIC_MEANINGS[deckId] === true;

    // 解説は公開デッキにだけ合成する（非公開デッキはどのみち剥がされる）
    let explained = false;
    const meaningFile = MEANING_FILES[deckId];
    if (includeMeanings && meaningFile !== undefined) {
      const meanings = await readJsonIfExists(join(MEANINGS_DIR, meaningFile));
      if (meanings === undefined) {
        console.warn(`  ⚠ meanings/${meaningFile} が無いので ${deckId} は解説なしで出力します`);
      } else {
        attachExplanations(deck, meanings, meaningFile);
        explained = true;
      }
    }

    const cards = deck.cards.map((card) => (includeMeanings ? card : stripMeanings(card)));
    const label = includeMeanings ? (explained ? "意味＋解説あり" : "意味あり") : "意味を剥がした";

    built.push({ fileName, label, cards, output: { ...deck, cards } });
  }

  return built;
}

async function main() {
  const built = await buildDecks();

  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const { fileName, label, cards, output } of built) {
    const outputPath = join(OUTPUT_DIR, fileName);
    // 整形（2スペース）・末尾改行・BOMなし UTF-8・LF
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(`  ${fileName}: ${cards.length}枚（${label}）`);
  }

  console.log(`同期完了 → ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
