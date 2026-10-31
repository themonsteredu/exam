"""겹치는 원본 좌표는 문단 흐름으로 재배치하고 글·그림을 보존한다."""
import base64
import copy
import io
import sys
import zipfile
from pathlib import Path
from lxml import etree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
from exam_hwpx.builder import build_exam, ExamBuilder

png = base64.b64encode((Path(__file__).resolve().parent.parent / "samples" / "cubes_problem4.png").read_bytes()).decode()
boxes = [{"x": 30 + (i % 2) * 180, "y": 200 + (i // 2) * 150, "w": 20, "h": 30} for i in range(5)]
figures = [{"box": {"x": box["x"] + 30, "y": box["y"] + 8, "w": 100, "h": 95}, "png": png, "width_mm": 20} for box in boxes]
blocks = [{"role": "stem", "box": {"x": 30, "y": 100, "w": 450, "h": 80}, "lines": [[{"t": "문제 내용"}]]}]
blocks += [{"role": "choice", "choice_no": i + 1, "box": box, "lines": [[]]} for i, box in enumerate(boxes)]
blocks.append({"role": "text", "box": {"x": 30, "y": 105, "w": 300, "h": 30}, "lines": [[{"t": "겹치는 원본 좌표"}]]})
blocks.append({"role": "box", "title": "조건", "box": {"x": 30, "y": 145, "w": 300, "h": 50}, "lines": [[{"t": "조건 안의 글자"}]]})
exam = {"layout_mode": "source", "header": {"title": "읽기 쉬운 시험지", "date": "10월 8일"},
 "source_pages": [{"page": 1, "width": 1000, "height": 1400, "paper_mm": [210, 297]}],
 "sections": [{"items": [{"no": 14, "stem": [{"t": "문제 내용"}], "choices": [[], [], [], [], []],
   "source": {"page": 1, "x": 20, "y": 100, "w": 480, "h": 900}, "layout_blocks": blocks,
   "figure": figures[0], "extra_figures": figures[1:]}]}]}
shuffled = [figures[3], figures[0], figures[4], figures[1], figures[2]]
mapping = ExamBuilder.match_choice_figures(exam["sections"][0]["items"][0], shuffled)
assert mapping == {0: 1, 1: 3, 2: 4, 3: 0, 4: 2}, mapping
ambiguous = copy.deepcopy(shuffled)
ambiguous[0]["box"] = dict(ambiguous[1]["box"])
assert ExamBuilder.match_choice_figures(exam["sections"][0]["items"][0], ambiguous) == {}
data, warnings = build_exam(exam)
assert any("겹치지 않도록" in w for w in warnings), warnings
ns = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}
with zipfile.ZipFile(io.BytesIO(data)) as z:
    root = ET.fromstring(z.read("Contents/section0.xml"))
    assert len(root.findall(".//hp:pic", ns)) == 5
    text = "".join(root.itertext())
    assert all(s in text for s in ("읽기 쉬운 시험지", "문제 내용", "겹치는 원본 좌표", "조건", "조건 안의 글자")), text
    for mark in "①②③④⑤":
        assert mark in text, mark
    events = []
    for paragraph in root.findall("./hp:p", ns):
        value = "".join(paragraph.itertext())
        for mark in "①②③④⑤":
            if mark in value:
                events.append(mark)
        if paragraph.findall(".//hp:pic", ns):
            events.append("그림")
    assert events == ["①", "그림", "②", "그림", "③", "그림", "④", "그림", "⑤", "그림"], events
    assert any("조건 안의 글자" in "".join(table.itertext()) for table in root.findall(".//hp:tbl", ns))
invalid = copy.deepcopy(exam)
invalid["sections"][0]["items"][0]["source"] = {"page": 1}
_, invalid_warnings = build_exam(invalid)
assert any("원본 위치를 확인하지 못했습니다" in warning for warning in invalid_warnings), invalid_warnings
print("겹침과 잘못된 위치를 감지하고 글·번호·그림을 문단 흐름으로 모두 보존함")
