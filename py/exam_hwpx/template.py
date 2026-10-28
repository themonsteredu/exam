"""학교 시험지 양식(틀) 설정.

양식마다 용지, 여백, 글꼴, 글자 크기, 선 굵기 같은 값만 다르다.
6단계에서 이 값들을 Supabase에 저장하고 골라 쓰게 된다.
"""

MM = 283.465  # 1mm = 283.465 HWPUNIT


def mm(value: float) -> int:
    return int(round(value * MM))


# samples/exam_p1.jpg (광주화정중학교 2026 2학년 2학기 1차) 양식
SCHOOL_A_2026 = {
    "id": "school-A-2026",
    "name": "광주화정중 정기시험 (A4 2단)",
    "paper": {"width_mm": 210, "height_mm": 297},
    "margins_mm": {"left": 12, "right": 12, "top": 10, "bottom": 6, "header": 0, "footer": 17},
    "columns": {"count": 2, "gap_mm": 8, "separator": "SOLID", "separator_width": "0.4 mm"},
    "fonts": {
        "body": "함초롬바탕",
        "heading": "함초롬돋움",
    },
    "sizes": {
        "title": 17,
        "header_row": 11,
        "box": 9.5,
        "section_title": 12,
        "body": 11,
        "choice": 11,
        "footer_page": 13,
        "footer_right": 11,
        "footer_notice": 6.5,
    },
    "line_spacing": {"body": 180, "box": 150, "choice": 160},
    "heights_mm": {"title_row": 13, "info_row": 10},
    # 바깥 굵은 선, 안쪽 가는 선
    "border": {"thick": "0.4 mm", "thin": "0.12 mm"},
    # 문제와 문제 사이 빈 공간 (풀이 공간)
    "item_gap_pt": 40,
    # 그림: 위아래 여백, 오른쪽에 둘 때 단 너비에 대한 최대 비율
    "figure": {"gap_pt": 6, "right_max_ratio": 0.5},
    # 수식 속 대문자(점 이름)를 정자체로
    "upright_point_names": True,
}

TEMPLATES = {SCHOOL_A_2026["id"]: SCHOOL_A_2026}


def get_template(template_id: str | None) -> dict:
    return TEMPLATES.get(template_id or "", SCHOOL_A_2026)
