"""Regression checks for overlapping text without AI calls."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
from exam_hwpx.layout_safety import reserve, wrap_lines, numbered_lines, LayoutOverflow, _split_math_at_operators

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

def proportional(pieces, font):
    return sum(len(p.get("t", "").replace("**", "").replace("__", "")) * p.get("_fit_font", font) / 10
               if "t" in p else len(p["m"]) * p.get("_fit_font", font) / 10 for p in pieces)

adjusted = set()
word = "**조선대학교부속중학교**"
wrapped = wrap_lines([[{"t": word}]], 10, 5, proportional, adjusted.add)
fragments = [p["t"] for line in wrapped for p in line]
assert len(fragments) > 1 and all(p.startswith("**") and p.endswith("**") for p in fragments)
assert "".join(p[2:-2] for p in fragments) == word[2:-2]
assert "text" in adjusted and all(proportional(line, 10) <= 5.1 for line in wrapped)

equation = r"\frac{12+3}{45}=x+12"
math_parts = _split_math_at_operators(equation)
assert math_parts == [r"\frac{12+3}{45}", "=x", "+12"]
assert _split_math_at_operators(r"\(x+y\)=3") == [r"\(x+y\)", "=3"]
assert _split_math_at_operators("x<=-2") == ["x", "<=-2"]
assert _split_math_at_operators(r"\begin{cases}x+y=3\\2x-y=0\end{cases}") == [r"\begin{cases}x+y=3\\2x-y=0\end{cases}"]
assert _split_math_at_operators(r"\lvert x-1\rvert<2") == [r"\lvert x-1\rvert<2"]
assert "".join(math_parts) == equation
adjusted = set()
wrapped = wrap_lines([[{"m": "ABCDEFGHIJ"}]], 10, 9, proportional, adjusted.add)
piece = wrapped[0][0]
assert piece["m"] == "ABCDEFGHIJ" and 8 <= piece["_fit_font"] < 10
assert proportional([piece], 10) <= 9.2 and "math_size" in adjusted
try:
    wrap_lines([[{"m": "ABCDEFGHIJ"}]], 10, 3, proportional)
except LayoutOverflow:
    pass
else:
    raise AssertionError("An impossible atomic equation must not be silently clipped")
print("Collision separation, word and math wrapping, font fitting and overflow checks passed.")
