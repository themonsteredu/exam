"""Regression checks for overlapping text without AI calls."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
from exam_hwpx.layout_safety import reserve, wrap_lines, numbered_lines, LayoutOverflow

occupied = []
first = reserve({"x":10,"y":20,"w":40,"h":20}, occupied, 297)
next_line = reserve({"x":10,"y":25,"w":40,"h":12}, occupied, 297)
side_by_side = reserve({"x":60,"y":25,"w":40,"h":12}, occupied, 297)
assert next_line["y"] >= first["y"] + first["h"]
assert side_by_side["y"] == 25
try:
    reserve({"x":10,"y":290,"w":40,"h":20}, occupied,297)
except LayoutOverflow:
    pass
else:
    raise AssertionError("Content beyond the page must not be reported as successful")
measure = lambda pieces,font: sum(len(p.get("t", p.get("m",""))) for p in pieces)
lines = wrap_lines([[{"t":"조건을 읽고 답을 고르시오"}]],10,10,measure)
assert len(lines)==2
assert " ".join("".join(p.get("t","") for p in line).strip() for line in lines) == "조건을 읽고 답을 고르시오"
assert "".join(p.get("t","") for p in numbered_lines([[{"t":"14. 다음 그림"}]],"stem",14)[0]).count("14.") == 1
assert "".join(p.get("t","") for p in numbered_lines([[{"t":"① 첫째"}]],"choice",14,choice_no=1)[0]).count("①") == 1
print("Collision separation, horizontal choices, overflow, wrapping and single numbering checks passed.")
