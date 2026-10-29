"""수식 변환 확인: LaTeX 마다 한글 수식 문법과, 못 바꿀 때 대신 넣을 글자를 보여 준다.

    python3 scripts/check_latex.py                     (아래 목록)
    python3 scripts/check_latex.py '\\frac{1}{2}' 'x^2'  (직접 넣은 수식)
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "py"))

from exam_hwpx.latex import EquationError, latex_to_plain, to_eqedit  # noqa: E402

EXAMPLES = [
    r"\overline{AB}=\overline{AC}",
    r"\angle A=38^{\circ}",
    r"\triangle ABC \equiv \triangle DEF",
    r"\overline{AB} \perp \overline{CD}",
    r"\overset{\frown}{AB}",
    r"\overset{\rightarrow}{AB}",
    r"\frac12",
    r"\begin{cases} x+y=3 \\[2pt] 2x-y=0 \end{cases}",
    r"\left\{\begin{array}{l} x+y=3 \\ 2x-y=0 \end{array}\right.",
    r"P(\mathit{A}\cap\mathit{B})",
    r"\pi \fallingdotseq 3.14",
    r"\lvert x-1 \rvert < 2",
    r"a \not\in A",
    r"\text{50\%}",
    r"\boxed{\quad}",
    r"\underline{\phantom{00}}",
    r"\square ABCD",
    r"\textcircled{1}",
    r"\mathrm{\Delta}",
]


def main(items: list[str]) -> None:
    for latex in items:
        try:
            result = "수식  " + to_eqedit(latex)
        except EquationError as exc:
            result = f"글자로 넣음 ({exc})"
        print(f"{latex}\n    {result}\n    대신 넣을 글자: {latex_to_plain(latex)}")


if __name__ == "__main__":
    main(sys.argv[1:] or EXAMPLES)
