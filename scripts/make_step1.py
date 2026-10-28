"""1단계 확인용: data/exam_p1_manual.json → output/step1_exam_p1.hwpx"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))

from exam_hwpx.builder import build_exam  # noqa: E402

exam = json.loads((ROOT / "data" / "exam_p1_manual.json").read_text(encoding="utf-8"))
data, warnings = build_exam(exam)
out = ROOT / "output" / "step1_exam_p1.hwpx"
out.parent.mkdir(exist_ok=True)
out.write_bytes(data)
print("저장:", out)
for w in warnings:
    print("알림:", w)
