"""Original figure geometry and small footers remain on the source page."""
import base64
import io
import struct
import sys
import zipfile
import zlib
from pathlib import Path
from lxml import etree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
from exam_hwpx.builder import build_exam
from exam_hwpx.template import mm


def chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)


rows = b"".join(b"\0" + b"\xff\xff\xff" * 200 for _ in range(100))
png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 200, 100, 8, 2, 0, 0, 0))
                       + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")).decode()
page = {"page": 1, "width": 1000, "height": 1414, "paper_mm": [210, 297],
        "text_blocks": [{"role": "text", "artifact_kind": "footer", "box": {"x": 40, "y": 1360, "w": 400, "h": 25},
                         "lines": [[{"t": "학교 안내"}], [{"t": "작은 꼬리말"}]]}]}
item = {"no": 1, "column": 1, "source": {"page": 1, "x": 40, "y": 100, "w": 420, "h": 280},
        "layout_blocks": [{"role": "stem", "box": {"x": 40, "y": 100, "w": 420, "h": 100},
                           "lines": [[{"t": "문항의 한 줄"}]]}],
        "figure": {"box": {"x": 80, "y": 160, "w": 200, "h": 100},
                   "layout_box": {"x": 60, "y": 150, "w": 280, "h": 140}, "png": png}}
exam = {"layout_mode": "source", "source_pages": [page], "sections": [{"items": [item]}]}
data, warnings = build_exam(exam)
assert not warnings, warnings
ns = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    paths = [name for name in archive.namelist() if name.startswith("Contents/section") and name.endswith(".xml")]
    assert len(paths) == 1, paths
    root = ET.fromstring(archive.read(paths[0]))
    pic = root.find(".//hp:pic", ns)
    pos, size = pic.find("hp:pos", ns), pic.find("hp:sz", ns)
    expected = (mm(80 * .21), mm(160 * 297 / 1414), mm(200 * .21), mm(100 * 297 / 1414))
    actual = tuple(int(value) for value in (pos.get("horzOffset"), pos.get("vertOffset"), size.get("width"), size.get("height")))
    assert all(abs(a - b) <= 2 for a, b in zip(actual, expected)), (actual, expected)
    footer = next(table for table in root.xpath("//hp:tbl", namespaces=ns)
                  if "작은 꼬리말" in "".join(table.xpath(".//hp:t/text()", namespaces=ns)))
    assert abs(int(footer.find("hp:pos", ns).get("vertOffset")) - mm(1360 * 297 / 1414)) <= 2
    assert "학교 안내" in "".join(root.xpath("//hp:t/text()", namespaces=ns))

edge_page = {**page, "text_blocks": [
    {"role": "text", "artifact_kind": "footer", "box": {"x": 40, "y": 1385, "w": 400, "h": 10}, "lines": [[{"t": "꼬리말 하나"}]]},
    {"role": "text", "artifact_kind": "footer", "box": {"x": 40, "y": 1385, "w": 400, "h": 10}, "lines": [[{"t": "꼬리말 둘"}]]},
]}
edge_data, edge_warnings = build_exam({**exam, "source_pages": [edge_page]})
with zipfile.ZipFile(io.BytesIO(edge_data)) as archive:
    paths = [name for name in archive.namelist() if name.startswith("Contents/section") and name.endswith(".xml")]
    assert len(paths) == 1, paths
    root = ET.fromstring(archive.read(paths[0]))
    content = "".join(root.xpath("//hp:t/text()", namespaces=ns))
    assert all(phrase in content for phrase in ("문항의 한 줄", "꼬리말 하나", "꼬리말 둘"))
    assert any("꼬리말" in warning for warning in edge_warnings), edge_warnings
    rectangles = []
    for table in root.xpath("//hp:tbl", namespaces=ns):
        pos, size = table.find("hp:pos", ns), table.find("hp:sz", ns)
        rect = tuple(int(value) for value in (pos.get("horzOffset"), pos.get("vertOffset"), size.get("width"), size.get("height")))
        for x, y, w, h in rectangles:
            xx, yy, ww, hh = rect
            assert x + w <= xx or xx + ww <= x or y + h <= yy or yy + hh <= y
        rectangles.append(rect)

print("Original figure position, compact text and small editable footer stay on the source page.")
