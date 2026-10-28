"""시험지 JSON + 양식 JSON -> 한글 파일(.hwpx).

1단계: 양식 틀과 글만 넣는다. 수식은 읽기 쉬운 글자로, 그림 자리는 빈 칸으로 둔다.
3단계에서 equations=True, 그림 PNG를 넘기면 수식 개체와 그림이 들어간다.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path
from typing import Any

from hwpx import HwpxDocument

MM = 283.465  # 1mm = 283.465 HWPUNIT
CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩"

HERE = Path(__file__).resolve().parent


def mm(v: float) -> int:
    return int(round(v * MM))


def load_template(name: str) -> dict[str, Any]:
    return json.loads((HERE / "templates" / f"{name}.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- 수식 -> 글자

_PLAIN_REPLACE = [
    (r"\\overline\{([^{}]*)\}", r"\1"),
    (r"\^\{\\circ\}", "°"),
    (r"\^\\circ", "°"),
    (r"\\angle\s*", "∠"),
    (r"\\triangle\s*", "△"),
    (r"\\times", "×"),
    (r"\\div", "÷"),
    (r"\\pm", "±"),
    (r"\\leq?", "≤"),
    (r"\\geq?", "≥"),
    (r"\\neq", "≠"),
    (r"\\perp", "⊥"),
    (r"\\parallel", "∥"),
    (r"\\cdot", "·"),
    (r"\\sqrt\{([^{}]*)\}", r"√\1"),
    (r"\\frac\{([^{}]*)\}\{([^{}]*)\}", r"\1/\2"),
    (r"\^\{2\}|\^2", "²"),
    (r"\^\{3\}|\^3", "³"),
    (r"\\[,;! ]", " "),
    (r"[{}]", ""),
]


def latex_to_plain(latex: str) -> str:
    s = latex
    for pat, rep in _PLAIN_REPLACE:
        s = re.sub(pat, rep, s)
    return s


# ---------------------------------------------------------------- 빌더


class ExamBuilder:
    def __init__(self, template: dict[str, Any], *, equations: bool = False) -> None:
        self.tpl = template
        self.equations = equations
        self.doc = HwpxDocument.new()
        self.unconverted: list[str] = []  # 수식 개체로 못 바꾼 LaTeX
        self.placeholders: list[dict[str, Any]] = []
        self._setup_page()
        self._setup_styles()

    # -- 쪽 설정
    def _setup_page(self) -> None:
        page = self.tpl["page"]
        m = page["margin_mm"]
        self.doc.page.set_size(width=mm(page["width_mm"]), height=mm(page["height_mm"]))
        self.doc.page.set_margins(
            left=mm(m["left"]), right=mm(m["right"]), top=mm(m["top"]),
            bottom=mm(m["bottom"]), header=mm(m["header"]), footer=mm(m["footer"]),
        )
        self.text_width = mm(page["width_mm"] - m["left"] - m["right"])
        cols = self.tpl["columns"]
        self.col_width = (self.text_width - mm(cols["gap_mm"])) // cols["count"]

    def _setup_styles(self) -> None:
        st = self.doc.styles
        f, s = self.tpl["fonts"], self.tpl["sizes"]
        for face in set(f.values()):
            st.ensure_font(face)
        self.cs = {
            "title": st.ensure_run(font=f["title"], size=s["title"], bold=True),
            "head": st.ensure_run(font=f["head"], size=s["head"], bold=False),
            "head_b": st.ensure_run(font=f["head"], size=s["head"], bold=True),
            "box": st.ensure_run(font=f["body"], size=s["box"]),
            "box_b": st.ensure_run(font=f["body"], size=s["box"], bold=True),
            "box_u": st.ensure_run(font=f["body"], size=s["box"], underline=True),
            "sec": st.ensure_run(font=f["head"], size=s["section_title"], bold=False),
            "body": st.ensure_run(font=f["body"], size=s["body"]),
            "no": st.ensure_run(font=f["body"], size=s["body"], bold=False),
            "choice": st.ensure_run(font=f["body"], size=s["choice"]),
            "note": st.ensure_run(font=f["head"], size=s["body"]),
            "foot": st.ensure_run(font=f["head"], size=s["footer"]),
            "foot_b": st.ensure_run(font=f["head"], size=s["footer"] + 2, bold=True),
            "foot_s": st.ensure_run(font=f["head"], size=s["footer_note"]),
        }
        self.bf_none = st.ensure_border_fill(active_borders=[])
        self.bf_line = st.ensure_border_fill(border_color="#000000", border_width="0.12 mm")
        self.bf_thick = st.ensure_border_fill(border_color="#000000", border_width="0.4 mm")
        frame = self.tpl.get("frame") or {}
        if frame.get("enabled"):
            bf = st.ensure_border_fill(border_color="#000000", border_width=frame["width"])
            off = mm(frame["offset_mm"])
            for page_type in ("BOTH", "EVEN", "ODD"):
                self.doc.sections[0].properties.set_page_border_fill(
                    page_type=page_type, border_fill_id_ref=bf, text_border="CONTENT",
                    header_inside=False, footer_inside=False,
                    offset_left=off, offset_right=off, offset_top=off, offset_bottom=off,
                )

    # -- 문단 도우미
    def _fmt(self, p, **kw) -> None:
        self.doc.styles.apply_paragraph_format(paragraphs=[p], **kw)

    def _add_marked(self, p, line: str, normal: str, bold: str, under: str) -> None:
        """'**굵게**', '__밑줄__' 표시가 있는 한 줄을 글자 모양별로 나눠 넣는다."""
        for part in re.split(r"(\*\*.+?\*\*|__.+?__)", line):
            if not part:
                continue
            if part.startswith("**"):
                p.add_run(part[2:-2], char_pr_id_ref=bold)
            elif part.startswith("__"):
                p.add_run(part[2:-2], char_pr_id_ref=under)
            else:
                p.add_run(part, char_pr_id_ref=normal)

    def _add_pieces(self, p, pieces: list[dict[str, str]], cid: str) -> None:
        for piece in pieces:
            if "t" in piece:
                p.add_run(piece["t"], char_pr_id_ref=cid)
            elif "m" in piece:
                self._add_math(p, piece["m"], cid)

    def _add_math(self, p, latex: str, cid: str) -> None:
        if self.equations:
            try:
                from hwpx.equation.authoring import latex_to_eqedit

                self.doc.shapes.add_equation(
                    latex_to_eqedit(latex), paragraph=p, char_pr_id_ref=cid,
                    base_unit=int(self.tpl["sizes"]["body"] * 100),
                )
                return
            except Exception:
                self.unconverted.append(latex)
        p.add_run(latex_to_plain(latex), char_pr_id_ref=cid)

    def _first_para(self, cell):
        return cell.paragraphs[0]

    # -- 머리 표
    def add_header(self, header: dict[str, str]) -> None:
        t = self.doc.add_table(2, 3, width=self.text_width, border_fill_id_ref=self.bf_line)
        t.set_column_widths([15, 33, 52])
        t.merge_cells(0, 0, 0, 2)
        t.cell(0, 0).set_size(height=mm(13))
        for c in range(3):
            t.cell(1, c).set_size(height=mm(10))
        t.set_cell_border_fill(0, 0, self.bf_thick)

        p = self._first_para(t.cell(0, 0))
        p.text = ""
        p.add_run(header["title"], char_pr_id_ref=self.cs["title"])
        self._fmt(p, alignment="CENTER", line_spacing_percent=100)

        cells = [
            (t.cell(1, 0), self.tpl["header_labels"]["target"], "head_b"),
            (t.cell(1, 1), header["target"], "head_b"),
            (t.cell(1, 2), header["date"], "head_b"),
        ]
        for cell, text, key in cells:
            p = self._first_para(cell)
            p.text = ""
            p.add_run(text, char_pr_id_ref=self.cs[key])
            self._fmt(p, alignment="CENTER", line_spacing_percent=100)
        self.header_table = t

    # -- 2단 시작
    def start_columns(self) -> None:
        cols = self.tpl["columns"]
        p = self.doc.add_paragraph("", char_pr_id_ref=self.cs["body"], inherit_style=False)
        self._fmt(p, line_spacing_percent=100, spacing_before_pt=0)
        self.doc.page.set_columns(
            cols["count"], same_gap=mm(cols["gap_mm"]),
            separator_type="SOLID", separator_width=cols["separator_width"],
            separator_color=cols["separator_color"], paragraph=p,
        )

    # -- 안내 상자
    def add_box(self, box: dict[str, Any]) -> None:
        t = self.doc.add_table(1, 1, width=self.col_width, border_fill_id_ref=self.bf_line)
        cell = t.cell(0, 0)
        lines = box["lines"]
        first = True
        for i, line in enumerate(lines):
            p = self._first_para(cell) if first else cell.add_paragraph("", char_pr_id_ref=self.cs["box"])
            p.text = ""
            first = False
            center = box["kind"] == "score" and i == 0
            if center:
                p.add_run(line, char_pr_id_ref=self.cs["box_b"])
            else:
                self._add_marked(p, line, self.cs["box"], self.cs["box_b"], self.cs["box_u"])
            if box["kind"] == "notice" and line.startswith("※"):
                self._fmt(p, alignment="JUSTIFY", line_spacing_percent=self.tpl["line_spacing"]["box"],
                          indent_left_mm=3.5, first_line_indent_mm=-3.5)
            else:
                self._fmt(p, alignment="CENTER" if center else "LEFT",
                          line_spacing_percent=self.tpl["line_spacing"]["box"])
        gap = self.doc.add_paragraph("", char_pr_id_ref=self.cs["box"], inherit_style=False)
        self._fmt(gap, line_spacing_percent=60)

    # -- "선택형" 제목 상자
    def add_section_title(self, title: str) -> None:
        gap = self.doc.add_paragraph("", char_pr_id_ref=self.cs["box"], inherit_style=False)
        self._fmt(gap, line_spacing_percent=80)
        t = self.doc.add_table(1, 1, width=self.col_width, border_fill_id_ref=self.bf_thick)
        p = self._first_para(t.cell(0, 0))
        p.text = ""
        p.add_run(title, char_pr_id_ref=self.cs["sec"])
        self._fmt(p, alignment="CENTER", line_spacing_percent=110)

    # -- 문항
    def add_item(self, item: dict[str, Any]) -> None:
        gap = self.doc.add_paragraph("", char_pr_id_ref=self.cs["body"], inherit_style=False)
        self._fmt(gap, line_spacing_percent=100)

        p = self.doc.add_paragraph("", char_pr_id_ref=self.cs["body"], inherit_style=False)
        p.text = ""
        p.add_run(f"{item['no']}. ", char_pr_id_ref=self.cs["no"])
        self._add_pieces(p, item["stem"], self.cs["body"])
        if item.get("points") is not None:
            p.add_run(f" [{item['points']}점]", char_pr_id_ref=self.cs["body"])
        self._fmt(p, alignment="JUSTIFY", line_spacing_percent=self.tpl["line_spacing"]["body"],
                  indent_left_mm=5, first_line_indent_mm=-5)

        fig = item.get("figure")
        if fig:
            self._add_figure_slot(item["no"], fig)

        for i, choice in enumerate(item.get("choices") or []):
            cp = self.doc.add_paragraph("", char_pr_id_ref=self.cs["choice"], inherit_style=False)
            cp.text = ""
            cp.add_run(f"{CIRCLED[i]} ", char_pr_id_ref=self.cs["choice"])
            self._add_pieces(cp, choice, self.cs["choice"])
            self._fmt(cp, alignment="LEFT", line_spacing_percent=self.tpl["line_spacing"]["body"],
                      indent_left_mm=1.5)

    def _add_figure_slot(self, no: int, fig: dict[str, Any]) -> None:
        """그림 자리: 선 없는 1칸 표로 높이만 잡아 둔다. 3단계에서 그림으로 바꾼다."""
        size = fig.get("size_mm") or {"w": 50, "h": 40}
        t = self.doc.add_table(1, 1, width=self.col_width, border_fill_id_ref=self.bf_none)
        t.cell(0, 0).set_size(height=mm(size["h"]))
        p = self._first_para(t.cell(0, 0))
        p.text = ""
        self._fmt(p, alignment="CENTER", line_spacing_percent=100)
        self.placeholders.append({"no": no, "size_mm": size})

    def add_page_end_note(self) -> None:
        note = self.tpl.get("page_end_note")
        if not note:
            return
        gap = self.doc.add_paragraph("", char_pr_id_ref=self.cs["body"], inherit_style=False)
        self._fmt(gap, line_spacing_percent=100)
        p = self.doc.add_paragraph("", char_pr_id_ref=self.cs["note"], inherit_style=False)
        p.text = ""
        p.add_run(note, char_pr_id_ref=self.cs["note"])
        self._fmt(p, alignment="RIGHT", line_spacing_percent=130, spacing_before_pt=12)

    def column_break(self) -> None:
        p = self.doc.add_paragraph("", char_pr_id_ref=self.cs["body"], inherit_style=False)
        self._fmt(p, column_break=True, line_spacing_percent=100)

    # -- 꼬리말
    def add_footer(self) -> None:
        ft = self.tpl["footer"]
        fs = self.tpl["sizes"]
        font = self.tpl["fonts"]["head"]
        before, _, rest = ft["page_format"].partition("{page}")
        _, _, after = rest.partition("{total}")
        big = {"font": font, "size": fs["footer"] + 2, "bold": True}
        content = [
            {"align": "RIGHT", "children": [
                {"type": "run", "text": ft["right_lines"][0], "font": font, "size": fs["footer"], "bold": True},
            ]},
            {"align": "CENTER", "children": [
                {"type": "run", "text": before, **big},
                {"type": "page_number", "page_number": "page/total"},
                {"type": "run", "text": after, **big},
            ]},
            {"align": "RIGHT", "children": [
                {"type": "run", "text": ft["right_lines"][1], **big},
            ]},
            {"align": "LEFT", "children": [
                {"type": "run", "text": ft["note"], "font": font, "size": fs["footer_note"]},
            ]},
        ]
        self.doc.page.set_footer(content=content)

    # -- 전체
    def build(self, exam: dict[str, Any]) -> None:
        self.add_header(exam["header"])
        self.start_columns()
        for box in exam.get("boxes", []):
            self.add_box(box)
        for sec in exam["sections"]:
            if sec.get("column_break"):
                self.column_break()
            if sec.get("title"):
                self.add_section_title(sec["title"])
            for item in sec["items"]:
                self.add_item(item)
        self.add_page_end_note()
        self.add_footer()

    def save(self, path: str | Path) -> dict[str, Any]:
        raw = self.doc.to_bytes()
        report = self.doc.validate()
        fixed = postprocess(raw, self.cs["foot_b"])
        Path(path).write_bytes(fixed)
        return {"valid": getattr(report, "ok", None), "report": report,
                "unconverted": self.unconverted, "placeholders": self.placeholders}


# ---------------------------------------------------------------- 저장 뒤 손질


def _fix_section(xml: str, foot_cid: str | None) -> str:
    """꼬리말 쪽 번호 손질.

    - 쪽 번호 위치 컨트롤(pageNum)은 한글이 쪽 아래 가운데에 번호를 한 번 더 찍게 하므로 뺀다.
    - 쪽 번호, '/', 전체 쪽 수를 꼬리말 글자 모양으로 맞추고 '/' 앞뒤를 띄운다.
    """
    xml = re.sub(r'<hp:run charPrIDRef="\d+"><hp:ctrl><hp:pageNum [^>]*/></hp:ctrl></hp:run>', "", xml)
    if foot_cid is not None:
        xml = re.sub(
            r'<hp:run charPrIDRef="0">(<hp:ctrl><hp:autoNum num="1" numType="(?:PAGE|TOTAL_PAGE)">)',
            rf'<hp:run charPrIDRef="{foot_cid}">\1', xml)
        xml = re.sub(
            r'(numType="PAGE">.*?</hp:run>)<hp:run charPrIDRef="0"><hp:t>/</hp:t></hp:run>',
            rf'\1<hp:run charPrIDRef="{foot_cid}"><hp:t> / </hp:t></hp:run>', xml, flags=re.S)
    return xml


def postprocess(data: bytes, foot_cid: str | None = None) -> bytes:
    src = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    names = src.namelist()
    order = ["mimetype"] + [n for n in names if n != "mimetype"]
    with zipfile.ZipFile(out, "w") as dst:
        for name in order:
            if name not in names:
                continue
            body = src.read(name)
            if name.endswith("header.xml"):
                body = body.replace(b'breakNonLatinWord="BREAK_WORD"', b'breakNonLatinWord="KEEP_WORD"')
            if re.match(r"Contents/section\d+\.xml$", name):
                text = body.decode("utf-8")
                text = _fix_section(text, foot_cid)
                body = text.encode("utf-8")
            if name == "mimetype":
                dst.writestr(zipfile.ZipInfo(name), body, compress_type=zipfile.ZIP_STORED)
            else:
                dst.writestr(name, body, compress_type=zipfile.ZIP_DEFLATED)
    return out.getvalue()
