#!/usr/bin/env python3
"""
dic_fortune.txt（占いゴーストの里々辞書）から空オラクル・エニグマオラクルの
一言＋解説を抜き出して meanings/*.json に書く。

出自: 2026-08-19 に Claude（claude.ai）が書いた変換スクリプトを、
      辞書の場所と出力先だけこのリポの配置に合わせたもの。パーサー本体は同じ。

使い方:
    python scripts/extract_fortune.py [dic_fortune.txt のパス]
    （省略時は OneDrive 上のゴースト本体 fortune_ghost/ghost/master/ を見に行く）
    → meanings/sky_meanings.json / meanings/enigma_meanings.json を上書き
    → そのあと npm run sync:decks で src/data/ に解説を合成する

注意:
    - ここで出る message（ですます調）は MCP では使わない。一言の正本は
      fortune-site 側（物理カード用に字数を削った体言止め版）。使うのは explanation だけ
    - 出力は BOM なし UTF-8・LF
"""
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "meanings"
DEFAULT_DIC = (
    Path.home()
    / "OneDrive"
    / "ドキュメント"
    / "pict"
    / "作業中"
    / "10_初代miniPC"
    / "ゴーストマスカレード8用"
    / "fortune_ghost"
    / "ghost"
    / "master"
    / "dic_fortune.txt"
)
# ※ 同フォルダ直下にも dic_fortune.txt があるが、それは 3/1 の骨格版（見出し24本）。
#    完成版（256トーク・解説122本）はゴースト本体 fortune_ghost/ghost/master/ の方

dic_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DIC
src = dic_path.read_text(encoding="utf-8")
lines = [l.rstrip("\r") for l in src.split("\n")]


def clean(text: str) -> str:
    """サクラスクリプトのタグを除去して一続きの文にする"""
    text = re.sub(r"\\w\d", "", text)          # ウェイト \w3 \w9
    text = re.sub(r"：（０）", "", text)        # サーフェス指定
    text = text.replace("\u3000", "")           # 全角スペース
    return "".join(text.split("\n")).strip()    # 辞書内改行は表示都合なので連結


# --- ブロック分割: ＊で始まる見出しごとに本文を集める ---
blocks = []  # (header, [body lines])
cur = None
for l in lines:
    if l.startswith("＊"):
        cur = (l[1:].strip(), [])
        blocks.append(cur)
    elif l.startswith("＃"):
        cur = None  # コメント行はセクション区切りなのでブロックを閉じる
    elif cur is not None:
        cur[1].append(l)


def parse_draw_block(body):
    """＊エニグマ占い/＊空占い ブロック → (card_key, message)"""
    key = None
    msg_lines = []
    in_msg = False
    for l in body:
        if l.startswith("＄今のカード"):
            key = l.split("\t", 1)[1].strip()
        elif l.startswith("＿"):
            break
        elif l.startswith("："):
            in_msg = True
            msg_lines.append(l)
        elif in_msg:
            msg_lines.append(l)
    full = clean("\n".join(msg_lines))
    # 「あなたが引いた…でした。」の定型導入を落とし、本体メッセージだけ残す
    m = re.search(r"でした。(.*)$", full)
    message = m.group(1).strip() if m else full
    return key, message


enigma = {}   # name -> {upright:{}, reversed:{}}
sky = {}      # name -> {message, explanation}
explanations = {}  # header(例: サラマンダー正解説/星空解説) -> text

for header, body in blocks:
    if header == "エニグマ占い":
        key, msg = parse_draw_block(body)
        if not key:
            continue
        name, pos = key[:-1], key[-1]   # 末尾1文字が 正/逆
        card = enigma.setdefault(name, {})
        card["upright" if pos == "正" else "reversed"] = {"message": msg}
    elif header == "空占い":
        key, msg = parse_draw_block(body)
        if not key:
            continue
        sky[key] = {"message": msg}
    elif header.endswith("解説"):
        text = clean("\n".join(l for l in body if not l.startswith("＿")))
        explanations[header] = text

# 解説を合流
for name, card in enigma.items():
    for pos, jp in (("upright", "正"), ("reversed", "逆")):
        exp = explanations.get(f"{name}{jp}解説")
        if exp and pos in card:
            card[pos]["explanation"] = exp
for name, card in sky.items():
    exp = explanations.get(f"{name}解説")
    if exp:
        card["explanation"] = exp

# 検証
problems = []
if len(enigma) != 32:
    problems.append(f"エニグマ枚数 {len(enigma)} != 32")
if len(sky) != 16:
    problems.append(f"空 枚数 {len(sky)} != 16")
for name, card in enigma.items():
    for pos in ("upright", "reversed"):
        if pos not in card:
            problems.append(f"エニグマ{name}: {pos}トーク欠落")
        elif "explanation" not in card[pos]:
            problems.append(f"エニグマ{name}{pos}: 解説欠落")
for name, card in sky.items():
    if "explanation" not in card:
        problems.append(f"空{name}: 解説欠落")

out_enigma = {
    "deck": "enigma",
    "name": "エニグマオラクル",
    "cards": [
        {"name": n, "upright": c.get("upright"), "reversed": c.get("reversed")}
        for n, c in enigma.items()   # 辞書出現順を保持
    ],
}
out_sky = {
    "deck": "sky",
    "name": "空オラクル",
    "cards": [
        {"name": n, "message": c.get("message"), "explanation": c.get("explanation")}
        for n, c in sky.items()
    ],
}


def dump(obj, path: Path) -> None:
    # BOM なし UTF-8・LF・末尾改行（Windows でも CRLF にしない）
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


OUT_DIR.mkdir(exist_ok=True)
dump(out_enigma, OUT_DIR / "enigma_meanings.json")
dump(out_sky, OUT_DIR / "sky_meanings.json")

print(f"辞書: {dic_path}")
print(f"エニグマ: {len(enigma)}枚 / 空: {len(sky)}枚 → {OUT_DIR}")
print("問題:", problems if problems else "なし")
if problems:
    sys.exit(1)
