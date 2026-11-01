"""A long scanned-exam word and equations must survive HWPX generation."""
import io
import sys
import zipfile
from pathlib import Path
from lxml import etree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
from exam_hwpx.builder import build_exam
from exam_hwpx.latex import to_eqedit

def block(role, x, y, w, h, lines):
    return {"role": role, "box": {"x": x, "y": y, "w": w, "h": h}, "lines": lines}

word = "조선대학교부속중학교수학시험"
equation = r"\frac{12}{35}+\frac{42}{55}=\frac{321}{77}"
atomic = r"\overline{ABCDEFGHIJKLMN}"
items = [
    {"no": 1, "source": {"page": 1, "x": 40, "y": 80, "w": 430, "h": 130}, "layout_blocks": [
        block("stem", 40, 80, 110, 70, [[{"t": "**" + word + "**"}]])]},
    {"no": 2, "source": {"page": 1, "x": 40, "y": 250, "w": 430, "h": 100}, "layout_blocks": [
        block("text", 40, 250, 92, 60, [[{"m": equation}]])]},
    {"no": 3, "source": {"page": 1, "x": 40, "y": 420, "w": 430, "h": 100}, "layout_blocks": [
        block("text", 40, 420, 140, 50, [[{"m": atomic}]]),
        block("text", 220, 420, 140, 50, [[{"t": "옆 글자"}]])]},
    {"no": 4, "source": {"page": 1, "x": 40, "y": 600, "w": 430, "h": 100}, "layout_blocks": [
        block("text", 40, 600, 80, 50, [[{"m": r"\overline{ABCDEFGH}"}]]),
        block("text", 122, 600, 140, 50, [[{"t": "옆 글자"}]])]},
]
exam = {"layout_mode": "source", "source_pages": [{"page": 1, "width": 1000, "height": 1414, "paper_mm": [210, 297]}],
        "sections": [{"items": items}]}
data, warnings = build_exam(exam)
assert any("1번" in warning for warning in warnings), warnings
assert any("2번" in warning for warning in warnings), warnings
assert any("3번" in warning for warning in warnings), warnings
assert any("4번" in warning for warning in warnings), warnings
ns = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}
with zipfile.ZipFile(io.BytesIO(data)) as z:
    root = ET.fromstring(z.read("Contents/section0.xml"))
    text = "".join(root.xpath("//hp:t/text()", namespaces=ns))
    assert word in text and "**" not in text
    scripts = root.xpath("//hp:equation/hp:script/text()", namespaces=ns)
    assert [to_eqedit(part) for part in [r"\frac{12}{35}", r"+\frac{42}{55}", r"=\frac{321}{77}"]] == scripts[:3], scripts
    assert to_eqedit(atomic) in scripts
    equations = root.xpath("//hp:equation", namespaces=ns)
    assert any(int(eq.get("baseUnit")) < 950 for eq in equations), "An indivisible equation may shrink to fit"
    # Text boxes on each original row must not overlap after any expansion.
    rects = []
    for table in root.xpath("//hp:tbl", namespaces=ns):
        pos, size = table.find("hp:pos", ns), table.find("hp:sz", ns)
        rects.append(tuple(int(v) for v in (pos.get("horzOffset"), pos.get("vertOffset"), size.get("width"), size.get("height"))))
    for i, (x, y, w, h) in enumerate(rects):
        for xx, yy, ww, hh in rects[i+1:]:
            assert x + w <= xx or xx + ww <= x or y + h <= yy or yy + hh <= y, (rects[i], (xx, yy, ww, hh))
print("Long words, equations, editable HWPX content and non-overlapping boxes passed.")
