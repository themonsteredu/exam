"""수식 상자 너비 확인: 사용자 한글 화면에서 잰 실제 너비와 우리가 파일에 적는 상자 너비를 견준다.

    python3 scripts/check_eq_width.py

한글(윈도)은 파일에 적힌 수식 상자 너비를 그대로 쓰고, 수식은 상자 왼쪽에 붙여 그린다.
상자가 실제보다 좁으면 수식 끝이 뒤 글자와 겹치고("MN의", "1.7의"), 넓으면 뒤에 빈칸이 생긴다("∠a ,", "∠c 의").

아래 '화면 너비'는 2026-11-01 대자중 시험지를 한글에서 연 화면 사진 세 장에서 잰 값이다
(상자 왼쪽 끝부터 마지막 글자의 잉크 오른쪽 끝까지, 글자 크기(em) 단위).
사진마다 글자 크기(px)는 두 가지로 따로 재서 맞는지 확인했다:
함초롬바탕 한글 간격(0.9676em)과, 상자 바로 뒤에 붙은 글자의 시작 = 상자 끝(파일에 적힌 너비).
  6.png  1em = 25.94px   7.png  1em = 23.77px   9.png  1em = 26.03px
측정 오차는 ±0.05em 쯤이다.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "py"))

from exam_hwpx import builder  # noqa: E402  (수식 너비 보정을 적용한다)
from hwpx.equation.measure import measure_equation  # noqa: E402

# (한글 수식 문법, 화면 너비 em, 어디서 잰 것인지)
MEASURED = [
    ("2 : 3 = x : 6", 4.46, "1번, 뒤 ' 을'"),
    ("0.7 x + 0.3 = 0.5 x - 1.7", 9.25, "4번, 뒤 '의' (예전 판에서 겹침)"),
    ("x = a", 2.11, "4번, 뒤 ','"),
    ("x = b", 2.05, "4번, 뒤 '라'"),
    ("2 ( 2 x - 3 ) = 5 x + a", 7.54, "1번"),
    ("{x} over {5} - {x - 3} over {2} = {9} over {10}", 6.67, "4번, 뒤 '의'"),
    ("angle c", 1.51, "서술형4, 줄 첫머리"),
    ("angle a", 1.50, "서술형4, 뒤 ','"),
    ("angle b", 1.43, "서술형4, 뒤 ','"),
    ("angle a - angle b + 2 angle c", 7.22, "서술형4, 뒤 '의'"),
    ("l ~parallel~ m", 3.10, "서술형4, 뒤 '일'"),
    ('overline {{rm "AB" it}}', 1.38, "11번, 뒤 ','"),
    ('overline {{rm "BC" it}}', 1.23, "11번, 뒤 '의'"),
    ('overline {{rm "MN" it}}', 1.65, "11번, 뒤 '의' (예전 판에서 겹침)"),
    ('8 {rm "cm" it}', 1.74, "11번, 8 부터 m 까지"),
]

# 뒤 글자와 이만큼은 떨어져야 하고(겹침 없음), 이보다 넓으면 빈칸이 눈에 띈다
MIN_GAP, MAX_GAP = 0.02, 0.25


def box_em(script: str, base_unit: int = 1050) -> float:
    width = measure_equation(script, base_unit=base_unit).width
    return (width * (1 + builder.EQ_PAD_RATIO) + base_unit * builder.EQ_PAD_EM) / base_unit


def main() -> int:
    bad = 0
    for script, real, where in MEASURED:
        gap = box_em(script) - real
        mark = "겹침" if gap < MIN_GAP else ("빈칸" if gap > MAX_GAP else "")
        bad += bool(mark)
        print(f"{mark:4s} 상자-화면 {gap:+.2f}em  {script}  ({where})")
    if bad:
        print(f"화면 너비와 맞지 않는 수식 {bad}개")
        return 1
    print(f"수식 {len(MEASURED)}개 모두 겹침 없음, 뒤 빈칸 {MAX_GAP}em 이하")
    return 0


if __name__ == "__main__":
    sys.exit(main())
