"""Native header text and every figure must reach the final HWPX."""
import io
import sys
import base64
import zipfile
from pathlib import Path
from lxml import etree as ET
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
from exam_hwpx.builder import build_exam

png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQx8AAAAASUVORK5CYII="
figures = [{"box":{"page":1,"x":40+i*80,"y":300,"w":60,"h":50},"png":png} for i in range(5)]
exam = {"layout_mode":"source","source_pages":[{"page":1,"width":1000,"height":1414,"paper_mm":[210,297],
    "text_blocks":[{"role":"box","box":{"x":40,"y":30,"w":900,"h":80},"lines":[[{"t":"금호중 수학 시험"}]]}]}],
    "sections":[{"items":[{"no":14,"source":{"page":1,"x":40,"y":150,"w":430,"h":300},
      "layout_blocks":[{"role":"stem","box":{"x":40,"y":150,"w":430,"h":50},"lines":[[{"t":"14. 다음 그림 중 옳은 것은?"}]]}],
      "figure":figures[0],"extra_figures":figures[1:]}]}]}
data, warnings = build_exam(exam)
ns = {"hp":"http://www.hancom.co.kr/hwpml/2011/paragraph"}
with zipfile.ZipFile(io.BytesIO(data)) as z:
    root = ET.fromstring(z.read("Contents/section0.xml"))
    assert len(root.findall(".//hp:pic",ns)) == 5
    text = "".join(root.itertext())
    assert "금호중 수학 시험" in text
    assert text.count("14.") == 1
    assert len([n for n in z.namelist() if n.startswith("BinData/")]) == 5
# Old saved exams: header PNG must be replaced with the already-read native strings.
legacy = {"layout_mode":"source","header":{"title":"기존 시험 제목","target":"1학년","date":"2026년"},
 "source_pages":[{"page":1,"width":1000,"height":1414,"paper_mm":[210,297],
   "decorations":[{"box":{"x":40,"y":30,"w":900,"h":100},"png":png}]}],"sections":[]}
data, _ = build_exam(legacy)
with zipfile.ZipFile(io.BytesIO(data)) as z:
    root = ET.fromstring(z.read("Contents/section0.xml"))
    assert "기존 시험 제목" in "".join(root.itertext())
    assert not root.findall(".//hp:pic",ns)
print("Five figures, editable header, single question number and legacy header recovery passed.")
