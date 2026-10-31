"""머리말·안내가 원본 사진이 아닌 수정 가능한 한글 글자로 출력되는지 검사한다."""
import io
import sys
import zipfile
from pathlib import Path
from lxml import etree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
from exam_hwpx.builder import build_exam

base = {"layout_mode": "source",
        "header": {"title": "2024학년도 수학과 지필평가", "date": "10월 8일 2교시"},
        "boxes": [{"kind": "notice", "lines": ["※ 유의 사항", "답안을 확인하세요"]}],
        "source_pages": [{"page": 1, "width": 1000, "height": 1400, "paper_mm": [210, 297],
          "decorations": [{"box": {"x": 30, "y": 20, "w": 940, "h": 80}, "png": "old-image"},
                          {"box": {"x": 30, "y": 110, "w": 440, "h": 180}, "png": "old-image"}]}],
        "sections": [{"items": [{"no": 1, "source": {"page": 1, "x": 30, "y": 350, "w": 440, "h": 100},
          "layout_blocks": [{"role": "stem", "box": {"x": 30, "y": 350, "w": 440, "h": 100}, "lines": [[{"t": "첫 문제"}]]}]}]}]}
data, warnings = build_exam(base)
ns = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}
with zipfile.ZipFile(io.BytesIO(data)) as z:
    root = ET.fromstring(z.read("Contents/section0.xml"))
    text = "".join(root.itertext())
    assert all(s in text for s in ["2024학년도 수학과 지필평가", "10월 8일 2교시", "유의 사항", "답안을 확인하세요"]), text
    assert not root.findall(".//hp:pic", ns), "머리말이 이미지로 들어감"
base["source_pages"][0]["decorations"] = [
  {"kind": "header", "box": {"x": 30, "y": 20, "w": 940, "h": 120}, "lines": ["새 제목", "저작권 안내 문구"]}]
data, warnings = build_exam(base)
with zipfile.ZipFile(io.BytesIO(data)) as z:
    root = ET.fromstring(z.read("Contents/section0.xml"))
    text = "".join(root.itertext())
    assert "새 제목" in text and "저작권 안내 문구" in text
    assert not root.findall(".//hp:pic", ns)
print("기존 읽기 결과와 새 결과의 머리말을 편집 가능한 글자로 출력함")
