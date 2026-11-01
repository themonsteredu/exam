"""Dense multi-page exams must continue without losing text or pictures."""
import base64
import io
import random
import struct
import sys
import zipfile
import zlib
from pathlib import Path
from lxml import etree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
from exam_hwpx.builder import build_exam
from exam_hwpx.template import mm
from exam_hwpx.latex import to_eqedit

def png_chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)

random_pixels = random.Random(20261101)
rows = b"".join(b"\0" + random_pixels.randbytes(128 * 3) for _ in range(128))
png_data = (b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 128, 128, 8, 2, 0, 0, 0))
            + png_chunk(b"IDAT", zlib.compress(rows)) + png_chunk(b"IEND", b""))
png = base64.b64encode(png_data).decode()
pages = []
items = []
for page_no in range(1, 7):
    pages.append({"page": page_no, "width": 1000, "height": 1414, "paper_mm": [210, 297],
                  "text_blocks": [{"role": "text", "artifact_kind": "footer", "box": {"x": 40, "y": 1360, "w": 920, "h": 40},
                                   "lines": [[{"t": f"FOOTER{page_no}"}]]}]})
    for index in range(4):
        no = (page_no - 1) * 4 + index + 1
        x, y = (40 if index < 2 else 520), (100 if index % 2 == 0 else 1100)
        stem_box = {"x": x, "y": y, "w": 420, "h": 100}
        choice_box = {"x": x, "y": y + 240, "w": 420, "h": 70}
        item = {"no": no, "column": 1 if index < 2 else 2,
                "source": {"page": page_no, "x": x, "y": y, "w": 420, "h": 310},
                "layout_blocks": [
                    {"role": "stem", "box": stem_box, "lines": [[{"t": f"QUESTION{no:02d}"}]]},
                    {"role": "text", "box": choice_box, "lines": [[{"t": f"CHOICE{no:02d}"}]]},
                ]}
        if no <= 20:
            item["figure"] = {"box": {"page": page_no, "x": x + 40, "y": y + 70, "w": 300, "h": 170}, "png": png}
        items.append(item)

exam = {"layout_mode": "source", "source_pages": pages, "sections": [{"items": items}]}
dense_data, warnings = build_exam(exam)
assert any("이어" in message for message in warnings), warnings
assert not any("검사 결과" in message for message in warnings), warnings
ns = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}
with zipfile.ZipFile(io.BytesIO(dense_data)) as archive:
    paths = sorted(name for name in archive.namelist() if name.startswith("Contents/section") and name.endswith(".xml"))
    assert len(paths) > 6, paths
    pages_xml = [ET.fromstring(archive.read(name)) for name in paths]
    output_text = "".join("".join(root.xpath("//hp:t/text()", namespaces=ns)) for root in pages_xml)
    for no in range(1, 25):
        assert output_text.count(f"QUESTION{no:02d}") == 1, no
        assert output_text.count(f"CHOICE{no:02d}") == 1, no
    for page in range(1, 7):
        assert output_text.count(f"FOOTER{page}") == 1, page
        source_page = next(root for root in pages_xml if f"QUESTION{(page - 1) * 4 + 1:02d}" in "".join(root.xpath("//hp:t/text()", namespaces=ns)))
        assert f"FOOTER{page}" in "".join(source_page.xpath("//hp:t/text()", namespaces=ns)), page
    assert "2번 이어서" in output_text and "4번 이어서" in output_text
    assert sum(len(root.xpath("//hp:pic", namespaces=ns)) for root in pages_xml) == 20
    for root in pages_xml:
        rects = []
        for element in root.xpath("//hp:tbl | //hp:pic", namespaces=ns):
            pos, size = element.find("hp:pos", ns), element.find("hp:sz", ns)
            assert pos is not None and size is not None
            x, y = int(pos.get("horzOffset")), int(pos.get("vertOffset"))
            w, h = int(size.get("width")), int(size.get("height"))
            assert y >= 0 and y + h <= mm(294) + 2, (x, y, w, h)
            rects.append((x, y, w, h))
        for i, (x, y, w, h) in enumerate(rects):
            for xx, yy, ww, hh in rects[i + 1:]:
                assert x + w <= xx + 2 or xx + ww <= x + 2 or y + h <= yy + 2 or yy + hh <= y + 2, (rects[i], (xx, yy, ww, hh))

# A single very tall condition box can span pages without losing any line.
long_lines = [[{"t": f"LINE{n:03d}"}] for n in range(200)]
long_exam = {"layout_mode": "source", "source_pages": [{"page": 1, "width": 1000, "height": 1414, "paper_mm": [210, 297]}],
             "sections": [{"items": [{"no": 1, "source": {"page": 1, "x": 40, "y": 80, "w": 500, "h": 1300},
                "layout_blocks": [{"role": "box", "title": "조건", "box": {"x": 40, "y": 80, "w": 500, "h": 1300}, "lines": long_lines}]}]}]}
data, warnings = build_exam(long_exam)
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    paths = sorted(name for name in archive.namelist() if name.startswith("Contents/section") and name.endswith(".xml"))
    assert len(paths) >= 3 and any("이어" in w for w in warnings)
    page_texts = ["".join(ET.fromstring(archive.read(name)).xpath("//hp:t/text()", namespaces=ns)) for name in paths]
    text = "".join(page_texts)
    assert text.count("조건") == 1
    assert all("1번 이어서" in t for t in page_texts[1:] if "LINE" in t), page_texts
    for n in range(200):
        assert text.count(f"LINE{n:03d}") == 1, n

# An atomic equation that cannot fit a narrow box uses a wider continuation.
wide_math = r"\overline{ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ}"
wide_exam = {"layout_mode": "source", "source_pages": [{"page": 1, "width": 1000, "height": 1414, "paper_mm": [210, 297]}],
             "sections": [{"items": [{"no": 1, "source": {"page": 1, "x": 40, "y": 100, "w": 420, "h": 100},
                "layout_blocks": [{"role": "text", "box": {"x": 40, "y": 100, "w": 40, "h": 60}, "lines": [[{"m": wide_math}]]},
                                  {"role": "text", "box": {"x": 81, "y": 100, "w": 140, "h": 60}, "lines": [[{"t": "이웃 글"}]]}]}]}]}
data, warnings = build_exam(wide_exam)
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    paths = sorted(name for name in archive.namelist() if name.startswith("Contents/section") and name.endswith(".xml"))
    assert len(paths) >= 2 and any("이어" in w for w in warnings)
    scripts = [s for name in paths for s in ET.fromstring(archive.read(name)).xpath("//hp:equation/hp:script/text()", namespaces=ns)]
    assert scripts.count(to_eqedit(wide_math)) == 1, scripts

print("Six pages, 24 questions, 20 figures, long boxes and wide equations continue without AI calls.")
