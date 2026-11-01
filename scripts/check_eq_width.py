"""수식 상자 너비 확인: 한글이 실제로 그린 수식 너비와 우리가 파일에 적는 상자 너비를 견준다.

    python3 scripts/check_eq_width.py

한글(윈도)은 파일에 적힌 수식 상자 너비를 그대로 쓰고, 수식은 상자 왼쪽에 붙여 그린다.
상자 양옆에는 바깥 여백(56 HWPUNIT, 약 0.05em)이 따로 있다.
상자가 실제보다 좁으면 수식 끝이 뒤 글자와 겹치고("MN의", "1.7의"), 넓으면 뒤에 빈칸이 생긴다("∠a ,", "∠c 의").

아래 '그린 너비'는 사용자 한글 화면 사진(6·7·8·9.png)에서 잰 값이다 (상자 왼쪽 끝부터 마지막 글자 끝까지, 그 크기의 em).
사진마다 1em 을 함초롬바탕 한글 간격(0.970em)과 '상자 끝 + 바깥 여백 = 다음 글자 시작'으로 따로 재서 맞췄고,
글자 너비는 한글 수식 글꼴(HyhwpEQ)의 너비와 견주었다 (독립 점검, 2026-11-01).
  6.png 11pt 25.8px/em, 8.png 11pt, 7.png 10pt 23.5px/em, 9.png 10.5pt 24.7px/em
측정 오차는 ±0.03em 쯤이다.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "py"))

from exam_hwpx import builder  # noqa: E402  (수식 너비 보정을 적용한다)

# (한글 수식 문법, 글자 크기 pt, 그린 너비 em, 어디서 잰 것인지)
MEASURED = [
    ("x", 11, 0.571, "6.png 1번"),
    ("2 ( 2 x - 3 ) = 5 x + a", 11, 7.62, "6.png 1번"),
    ("2 : 3 = x : 6", 11, 4.55, "6.png 1번"),
    ("a", 11, 0.528, "6.png 1번"),
    ("0.7 x + 0.3 = 0.5 x - 1.7", 11, 9.27, "6.png 4번 (예전 판에서 '의'와 겹침)"),
    ("x = a", 11, 2.27, "6.png 4번"),
    ("{x} over {5} - {x - 3} over {2} = {9} over {10}", 11, 6.87, "6.png 4번"),
    ("x = b", 11, 2.14, "6.png 4번"),
    ("b", 11, 0.429, "8.png"),
    ("a + b", 11, 1.95, "8.png"),
    ("l ~parallel~ m", 10, 3.24, "7.png 서술형4"),
    ("angle a", 10, 1.57, "7.png 서술형4 (예전 판에서 뒤 ',' 가 떨어짐)"),
    ("angle b", 10, 1.46, "7.png 서술형4"),
    ("angle c", 10, 1.49, "7.png 서술형4"),
    ("angle a - angle b + 2 angle c", 10, 7.31, "7.png 서술형4"),
    ('overline {{rm "AB" it}}', 10.5, 1.455, "9.png 11번 (잉크 끝까지)"),
    ('overline {{rm "BC" it}}', 10.5, 1.28, "9.png 11번 (잉크 끝까지)"),
    ('overline {{rm "MN" it}}', 10.5, 1.73, "9.png 11번 (잉크 끝까지, 예전 판에서 '의'와 겹침)"),
]

# 상자 끝이 그린 끝보다 이만큼까지 안쪽이어도 바깥 여백(0.05em) 안이라 겹쳐 보이지 않는다.
# 이보다 넓으면 빈칸이 눈에 띈다
MIN_GAP, MAX_GAP = -0.03, 0.25


def box_em(script: str, size_pt: float) -> float:
    base_unit = int(round(size_pt * 100))
    width = builder.measure_equation_sized(script, base_unit).width
    return (width * (1 + builder.EQ_PAD_RATIO) + base_unit * builder.EQ_PAD_EM) / base_unit


def main() -> int:
    bad = 0
    for script, size, real, where in MEASURED:
        gap = box_em(script, size) - real
        mark = "겹침" if gap < MIN_GAP else ("빈칸" if gap > MAX_GAP else "")
        bad += bool(mark)
        print(f"{mark:4s} 상자-그린 {gap:+.2f}em  {size:>4}pt  {script}  ({where})")
    if bad:
        print(f"화면 너비와 맞지 않는 수식 {bad}개")
        return 1
    print(f"수식 {len(MEASURED)}개 모두 겹침 없음(바깥 여백 안), 뒤 빈칸 {MAX_GAP}em 이하")
    return 0


if __name__ == "__main__":
    sys.exit(main())
