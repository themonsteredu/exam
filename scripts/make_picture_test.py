"""그림이 보이는지 확인하는 작은 파일: 그림 정보를 네 가지 방식으로 넣고 번호를 붙인다.

    python3 scripts/make_picture_test.py   → output/picture_test.hwpx

1번: python-hwpx 기본 방식 (그림 원래 크기 = 보이는 크기, 현재 크기 = 보이는 크기, PNG 해상도 정보 있음)
2번: 그림 원래 크기만 한글 방식 (픽셀 x 75)
3번: 현재 크기(curSz)만 0
4번: 둘 다 한글 방식 (지금 시험지 파일과 같음)
"""
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))

from hwpx import HwpxDocument  # noqa: E402

from exam_hwpx.builder import _HP, png_size, png_with_dpi, postprocess  # noqa: E402
from exam_hwpx.template import mm  # noqa: E402

png = zipfile.ZipFile(ROOT / "output" / "step3_exam_p1.hwpx").read("BinData/image1.png")
px_w, px_h = png_size(png)
w_mm = 30.0
h_mm = w_mm * px_h / px_w

doc = HwpxDocument.new()
cid = doc.styles.ensure_run(font="함초롬바탕", size=12, color="#000000")
intro = doc.paragraphs[0]
intro.add_run("그림 확인용 파일입니다. 아래 1~4번 가운데 그림이 보이는 번호를 알려 주세요.", char_pr_id_ref=cid)

variants = [
    ("1번 (지금까지 방식)", False, False),
    ("2번 (원래 크기만 바꿈)", True, False),
    ("3번 (현재 크기만 0)", False, True),
    ("4번 (둘 다 바꿈)", True, True),
]
for n, (label, natural, cur_zero) in enumerate(variants, 1):
    lp = doc.add_paragraph("")
    lp.add_run(label, char_pr_id_ref=cid)
    data = png if natural else png_with_dpi(png, px_w / (w_mm / 25.4))
    item = doc.media.add_image(data, "png", item_id=f"image{n}")
    p = doc.add_paragraph("", include_run=False)
    pic = p.add_picture(item.item_id, width=mm(w_mm), height=mm(h_mm), treat_as_char=True, align="CENTER")
    el = pic.element
    if natural:
        el.find(f"{_HP}imgClip").attrib.update({"left": "0", "top": "0", "right": str(px_w * 75), "bottom": str(px_h * 75)})
        el.find(f"{_HP}imgDim").attrib.update({"dimwidth": str(px_w * 75), "dimheight": str(px_h * 75)})
    if cur_zero:
        el.find(f"{_HP}curSz").attrib.update({"width": "0", "height": "0"})
    doc.styles.apply_paragraph_format(paragraphs=[p], alignment="CENTER")

out = ROOT / "output" / "picture_test.hwpx"
out.write_bytes(postprocess(doc.to_bytes()))
print("저장:", out)
