"""한 문항의 그림 5개가 실제 HWPX 에 각각 들어가는지 검사한다."""
import base64
import io
import sys
import zipfile
from pathlib import Path
from lxml import etree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
from exam_hwpx.builder import build_exam

png = base64.b64encode((Path(__file__).resolve().parent.parent / "samples" / "cubes_problem4.png").read_bytes()).decode()
figures = [{"box": {"x": 30 + (i % 2) * 180, "y": 200 + (i // 2) * 150, "w": 120, "h": 100}, "png": png} for i in range(5)]
exam = {"layout_mode": "source", "source_pages": [{"page": 1, "width": 1000, "height": 1400, "paper_mm": [210, 297]}],
  "sections": [{"items": [{"no": 14, "source": {"page": 1, "x": 20, "y": 100, "w": 450, "h": 800},
    "layout_blocks": [{"role": "stem", "box": {"x": 20, "y": 100, "w": 450, "h": 70},
                       "lines": [[{"t": "다음 중 나머지와 합동이 아닌 것은?"}]]}],
    "figure": figures[0], "extra_figures": figures[1:]}]}]}
data, warnings = build_exam(exam)
ns = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}
with zipfile.ZipFile(io.BytesIO(data)) as z:
    root = ET.fromstring(z.read("Contents/section0.xml"))
    pics = root.findall(".//hp:pic", ns)
    assert len(pics) == 5, f"그림 5개 중 {len(pics)}개만 출력됨: {warnings}"
print("한 문항의 그림 5개가 HWPX에 각각 들어감")
