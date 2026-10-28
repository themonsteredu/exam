"""점검 페이지에 넣을 글꼴을 필요한 글자만 남겨 작게 만든다 (woff2).

사용법: python3 scripts/subset-fonts.py <원본 글꼴 폴더> <출력 폴더>
원본 폴더: S-CoreDream-4Regular.woff, 5Medium.woff, 6Bold.woff, LiberationSerif-Regular.ttf, LiberationSerif-Italic.ttf
"""
import pathlib
import sys

from fontTools import subset

src, dst = map(pathlib.Path, sys.argv[1:3])
dst.mkdir(parents=True, exist_ok=True)

# 한글: KS X 1001 완성형 2350자 + 자모
hangul = []
for hi in range(0xB0, 0xC9):
    for lo in range(0xA1, 0xFF):
        try:
            hangul.append(bytes([hi, lo]).decode("euc-kr"))
        except UnicodeDecodeError:
            pass
common = [chr(c) for c in range(0x20, 0x7F)] + [chr(c) for c in range(0xA0, 0x100)]
extra = "‘’“”…·•×÷°′″−±≤≥≠∠△▶▷☞※①②③④⑤⑥⑦⑧⑨⑩←→↑↓▮"
jamo = [chr(c) for c in range(0x3131, 0x318F)]
greek = [chr(c) for c in range(0x0391, 0x03CA)]

def run(name: str, out: str, text: str):
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    font = subset.load_font(str(src / name), opts)
    sub = subset.Subsetter(opts)
    sub.populate(text=text)
    sub.subset(font)
    subset.save_font(font, str(dst / out), opts)
    print(out, (dst / out).stat().st_size)

ko_text = "".join(common + list(extra) + jamo + hangul)
for w in ("4Regular", "5Medium", "6Bold"):
    run(f"S-CoreDream-{w}.woff", f"S-CoreDream-{w}.woff2", ko_text)
serif_text = "".join(common + list(extra) + greek)
for s in ("Regular", "Italic"):
    run(f"LiberationSerif-{s}.ttf", f"LiberationSerif-{s}.woff2", serif_text)
