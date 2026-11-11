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
        "body": 12,
        "choice": 12,
        "footer_page": 13,
        "footer_right": 11,
        "footer_notice": 6.5,
    },
    "line_spacing": {"body": 180, "box": 150, "choice": 160},
    "heights_mm": {"title_row": 13, "info_row": 10},
    # 바깥 굵은 선, 안쪽 가는 선
    "border": {"thick": "0.4 mm", "thin": "0.12 mm"},
    # 문항 사이 간격과 답안을 적는 빈 공간은 별도로 둔다.
    "item_gap_pt": 12,
    "work_space_mm": {"choice": 12, "written": 28},
    # 그림 크기는 원본에서 읽은 값을 기준으로 출력할 때 늘린다. PNG 해상도에도 같은 배율을 쓴다(render-exam.ts).
    "figure": {"gap_pt": 6, "right_max_ratio": 0.5, "scale": 1.4},
    # 수식 속 대문자(점 이름)를 정자체로. 점 이름이 아닌 대문자(집합 A, 확률 P 등)는 \mathit{A} 로 쓰면 기울임으로 남는다
    "upright_point_names": True,
}

TEMPLATES = {SCHOOL_A_2026["id"]: SCHOOL_A_2026}


def get_template(template_id: str | None) -> dict:
    return TEMPLATES.get(template_id or "", SCHOOL_A_2026)


def with_paper(template: dict, paper: dict | None) -> dict:
    """원본 용지가 양식 용지와 다르면(예: B4 원본) 용지·여백·단 사이를 용지 너비 비율로 늘린 양식.
    글자 크기·줄 간격은 그대로 둔다 (B4 시험지도 글자 크기는 A4 와 비슷하다).
    2026-11-01 호남삼육중: B4 4쪽 원본을 A4 4쪽에 맞추느라 글자 9.5pt·그림 0.8배까지 줄어 품질이 떨어졌다.
    lib/ai/assemble.ts 의 layoutFor 와 같은 비율을 쓴다 (그림 크기를 같은 본문 너비로 정하도록)."""
    if not isinstance(paper, dict):
        return template
    try:
        width, height = float(paper.get("width_mm") or 0), float(paper.get("height_mm") or 0)
    except (TypeError, ValueError):
        return template
    base = template["paper"]["width_mm"]
    if not (150 <= width <= 450 and 200 <= height <= 650) or abs(width - base) < 1:
        return template
    ratio = width / base
    tpl = dict(template)
    tpl["paper"] = {"width_mm": width, "height_mm": height}
    tpl["margins_mm"] = {key: round(value * ratio, 2) for key, value in template["margins_mm"].items()}
    tpl["columns"] = {**template["columns"], "gap_mm": round(template["columns"]["gap_mm"] * ratio, 2)}
    return tpl
