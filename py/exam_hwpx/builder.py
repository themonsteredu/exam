"""시험지 JSON + 양식 설정 → 한글 파일(.hwpx).

python-hwpx 6.9.0 사용. 사용법:
    from exam_hwpx.builder import build_exam
    data = build_exam(exam_json)          # .hwpx 파일 내용(bytes)
"""

from __future__ import annotations

import copy
import io
import re
import zipfile
from typing import Any

from hwpx import HwpxDocument
from hwpx.equation.authoring import latex_to_eqedit

from .template import get_template, mm

CHOICE_MARKS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"]
_HH = "{http://www.hancom.co.kr/hwpml/2011/head}"
_HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"


class ExamBuilder:
    def __init__(self, exam: dict, template: dict | None = None):
        self.exam = exam
        self.tpl = template or get_template(exam.get("template"))
        self.doc = HwpxDocument.new()
        self.warnings: list[str] = []  # 글자로 대신 넣은 수식 등
        self._run_cache: dict[tuple, str] = {}
        self._bf_cache: dict[tuple, str] = {}

    # ------------------------------------------------------------------ 서식
    def run_style(self, *, size: float, font: str | None = None, bold=False, underline=False, italic=False) -> str:
        font = font or self.tpl["fonts"]["body"]
        key = (size, font, bold, underline, italic)
        if key not in self._run_cache:
            self._run_cache[key] = self.doc.styles.ensure_run(
                font=font, size=size, bold=bold, underline=underline, italic=italic, color="#000000"
            )
        return self._run_cache[key]

    def border(self, left: str | None, right: str | None, top: str | None, bottom: str | None) -> str:
        """면마다 굵기를 따로 정하는 테두리. None 이면 선 없음."""
        key = (left, right, top, bottom)
        if key in self._bf_cache:
            return self._bf_cache[key]
        base_id = self.doc.styles.ensure_border_fill(border_color="#000000", border_width="0.12 mm")
        header = self.doc.oxml.headers[0]
        parent = header._border_fills_element()
        base = next(e for e in parent.findall(f"{_HH}borderFill") if e.get("id") == str(base_id))
        new = copy.deepcopy(base)
        new_id = header._allocate_border_fill_id(parent)
        new.set("id", new_id)
        for side, width in (("left", left), ("right", right), ("top", top), ("bottom", bottom)):
            el = new.find(f"{_HH}{side}Border")
            if width:
                el.set("type", "SOLID")
                el.set("width", width)
            else:
                el.set("type", "NONE")
                el.set("width", "0.1 mm")
        parent.append(new)
        parent.set("itemCnt", str(len(parent.findall(f"{_HH}borderFill"))))
        header.mark_dirty()
        self._bf_cache[key] = new_id
        return new_id

    def para_format(self, p, **kw):
        self.doc.styles.apply_paragraph_format(paragraphs=[p], **kw)

    # ------------------------------------------------------------------ 글 넣기
    def add_rich_text(self, p, text: str, *, size: float, font: str | None = None, bold=False):
        """**굵게**, __밑줄__ 표시가 들어간 글을 넣는다."""
        for token in re.split(r"(\*\*.+?\*\*|__.+?__)", text):
            if not token:
                continue
            b, u, t = bold, False, token
            if token.startswith("**") and token.endswith("**"):
                b, t = True, token[2:-2]
                # 굵은 글 안의 밑줄
                if "__" in t:
                    self.add_rich_text(p, t, size=size, font=font, bold=True)
                    continue
            elif token.startswith("__") and token.endswith("__"):
                u, t = True, token[2:-2]
            p.add_run(t, char_pr_id_ref=self.run_style(size=size, font=font, bold=b, underline=u))

    def add_equation(self, p, latex: str, *, size: float, where: str):
        try:
            script = latex_to_eqedit(latex)
            self.doc.shapes.add_equation(
                script,
                paragraph=p,
                base_unit=int(round(size * 100)),
                char_pr_id_ref=self.run_style(size=size),
            )
        except Exception as exc:  # 바꾸지 못한 수식은 글자로
            self.warnings.append(f"{where}: 수식을 글자로 넣음 ({latex}) - {exc}")
            p.add_run(latex, char_pr_id_ref=self.run_style(size=size))

    def add_pieces(self, p, pieces: list[dict], *, size: float, where: str):
        for i, piece in enumerate(pieces):
            if "m" in piece:
                self.add_equation(p, piece["m"], size=size, where=f"{where}[{i}]")
            else:
                p.add_run(piece.get("t", ""), char_pr_id_ref=self.run_style(size=size))

    # ------------------------------------------------------------------ 부분별
    def text_width(self) -> int:
        t = self.tpl
        return mm(t["paper"]["width_mm"] - t["margins_mm"]["left"] - t["margins_mm"]["right"])

    def column_width(self) -> int:
        c = self.tpl["columns"]
        return int((self.text_width() - mm(c["gap_mm"]) * (c["count"] - 1)) / c["count"])

    def setup_page(self):
        t = self.tpl
        self.doc.page.set_size(width=mm(t["paper"]["width_mm"]), height=mm(t["paper"]["height_mm"]))
        m = t["margins_mm"]
        self.doc.page.set_margins(
            left=mm(m["left"]), right=mm(m["right"]), top=mm(m["top"]),
            bottom=mm(m["bottom"]), header=mm(m["header"]), footer=mm(m["footer"]),
        )

    def build_header_table(self):
        """맨 위 제목 상자 + 응시대상·실시 일자 줄 (1단)."""
        t, h = self.tpl, self.exam["header"]
        thick, thin = t["border"]["thick"], t["border"]["thin"]
        first = self.doc.paragraphs[0]
        table = first.add_table(2, 3, width=self.text_width(), border_fill_id_ref=self.border(thick, thick, thick, thick))
        table.set_column_widths([14, 34, 52])
        table.merge_cells("A1:C1")
        # 칸마다 테두리: 바깥은 굵게, 안쪽은 가늘게
        table.set_cell_border_fill(0, 0, self.border(thick, thick, thick, thick))
        table.set_cell_border_fill(1, 0, self.border(thick, thin, thick, thick))
        table.set_cell_border_fill(1, 1, self.border(thin, thick, thick, thick))
        table.set_cell_border_fill(1, 2, self.border(thick, thick, thick, thick))
        heading = t["fonts"]["heading"]
        cells = [
            ((0, 0), h["title"], t["sizes"]["title"], True, heading),
            ((1, 0), h.get("target_label", "응시대상"), t["sizes"]["header_row"], False, heading),
            ((1, 1), h.get("target", ""), t["sizes"]["header_row"], False, heading),
            ((1, 2), h.get("date", ""), t["sizes"]["header_row"], False, heading),
        ]
        for (r, c), text, size, bold, font in cells:
            p = table.cell(r, c).paragraphs[0]
            self.add_rich_text(p, text, size=size, font=font, bold=bold)
            self.para_format(p, alignment="CENTER", line_spacing_percent=130)
        self._set_row_height(table, 0, mm(t["heights_mm"]["title_row"]))
        self._set_row_height(table, 1, mm(t["heights_mm"]["info_row"]))
        return table

    @staticmethod
    def _set_row_height(table, row: int, height: int):
        for tc in table.element.iter(f"{_HP}tc"):
            addr = tc.find(f"{_HP}cellAddr")
            if addr is not None and addr.get("rowAddr") == str(row):
                sz = tc.find(f"{_HP}cellSz")
                if sz is not None:
                    sz.set("height", str(height))
        table.mark_dirty()

    def start_columns(self):
        """여기서부터 2단. 가운데 세로 구분선."""
        c = self.tpl["columns"]
        p = self.doc.add_paragraph("")
        self.doc.page.set_columns(
            c["count"], same_gap=mm(c["gap_mm"]), separator_type=c["separator"],
            separator_width=c["separator_width"], separator_color="#000000", paragraph=p,
        )
        self.para_format(p, line_spacing_percent=100)
        return p

    def build_box(self, box: dict, anchor=None):
        """안내 상자 (유의 사항 / 문항 배점 안내)."""
        t = self.tpl
        size = t["sizes"]["box"]
        p_anchor = anchor or self.doc.add_paragraph("")
        table = p_anchor.add_table(1, 1, width=self.column_width(), border_fill_id_ref=self.border("0.12 mm", "0.12 mm", "0.12 mm", "0.12 mm"))
        cell = table.cell(0, 0)
        lines = box.get("lines", [])
        paragraphs = [cell.paragraphs[0]]
        for _ in lines[1:]:
            paragraphs.append(cell.add_paragraph(""))
        for p, line in zip(paragraphs, lines):
            if isinstance(line, str):
                line = {"text": line}
            text = line.get("text", "")
            self.add_rich_text(p, text, size=size)
            hanging = box.get("kind") == "notice" and text.startswith("※")
            self.para_format(
                p,
                alignment=line.get("align", "JUSTIFY"),
                line_spacing_percent=t["line_spacing"]["box"],
                indent_left_mm=3.5 if hanging else 0,
                first_line_indent_mm=-3.5 if hanging else 0,
            )
        self.para_format(p_anchor, line_spacing_percent=100, spacing_after_pt=3)
        return table

    def build_section_title(self, title: str):
        t = self.tpl
        p_anchor = self.doc.add_paragraph("")
        table = p_anchor.add_table(1, 1, width=self.column_width(), border_fill_id_ref=self.border("0.4 mm", "0.4 mm", "0.4 mm", "0.4 mm"))
        p = table.cell(0, 0).paragraphs[0]
        p.add_run(title, char_pr_id_ref=self.run_style(size=t["sizes"]["section_title"], font=t["fonts"]["heading"]))
        self.para_format(p, alignment="CENTER", line_spacing_percent=130)
        self.para_format(p_anchor, line_spacing_percent=100, spacing_before_pt=10, spacing_after_pt=10)

    def build_figure_slot(self, item: dict):
        """그림 자리 (1단계에서는 비워 둠, 3단계에서 그림이 들어감)."""
        fig = item.get("figure")
        if not fig:
            return
        w_mm, h_mm = fig.get("size_mm", [50, 40])
        p_anchor = self.doc.add_paragraph("")
        bf = self.doc.styles.ensure_border_fill(border_color="#C8C8C8", border_width="0.12 mm", border_type="DASH")
        table = p_anchor.add_table(1, 1, width=mm(w_mm), border_fill_id_ref=bf)
        self._set_row_height(table, 0, mm(h_mm))
        self.para_format(p_anchor, alignment=fig.get("align", "CENTER"), line_spacing_percent=100,
                         spacing_before_pt=6, spacing_after_pt=6)

    def build_item(self, item: dict, is_first: bool):
        t = self.tpl
        size = t["sizes"]["body"]
        no = item["no"]
        p = self.doc.add_paragraph("")
        if item.get("break_before") == "column":
            p.column_break = True
        p.add_run(f"{no}. ", char_pr_id_ref=self.run_style(size=size))
        self.add_pieces(p, item.get("stem", []), size=size, where=f"{no}번 문제 글")
        if item.get("points") is not None:
            p.add_run(f" [{item['points']}점]", char_pr_id_ref=self.run_style(size=size))
        self.para_format(
            p, alignment="JUSTIFY", line_spacing_percent=t["line_spacing"]["body"],
            indent_left_mm=5.5, first_line_indent_mm=-5.5,
            spacing_before_pt=0 if (is_first or item.get("break_before")) else t["item_gap_pt"],
        )
        self.build_figure_slot(item)
        for i, choice in enumerate(item.get("choices", [])):
            cp = self.doc.add_paragraph("")
            cp.add_run(f"{CHOICE_MARKS[i]}  ", char_pr_id_ref=self.run_style(size=t["sizes"]["choice"]))
            self.add_pieces(cp, choice, size=t["sizes"]["choice"], where=f"{no}번 선택지 {i + 1}")
            self.para_format(cp, alignment="LEFT", line_spacing_percent=t["line_spacing"]["choice"],
                             indent_left_mm=0, spacing_before_pt=4 if i == 0 else 0)

    def build_footer(self):
        """꼬리말: 위쪽 선, ( 쪽 / 전체 쪽 ), 오른쪽 학년·학교, 맨 아래 안내 문구."""
        t, f = self.tpl, self.exam.get("footer", {})
        footer = self.doc.page.set_footer(text="")
        anchor = footer.paragraphs[0]
        table = anchor.add_table(2, 3, width=self.text_width(), border_fill_id_ref=self.border(None, None, None, None))
        table.set_column_widths([30, 40, 30])
        table.merge_cells("A2:C2")
        top_line = self.border(None, None, "0.4 mm", None)
        for c in range(3):
            table.set_cell_border_fill(0, c, top_line)
        table.set_cell_border_fill(1, 0, self.border(None, None, None, None))

        # 가운데: ( 1 / 7 )
        page_size = t["sizes"]["footer_page"]
        cid = self.run_style(size=page_size, font=t["fonts"]["heading"])
        pp = table.cell(0, 1).paragraphs[0]
        pp.add_run("( ", char_pr_id_ref=cid)
        footer.add_page_number_field(paragraph=pp.element, format="page")
        pp.add_run(" / ", char_pr_id_ref=cid)
        footer._add_total_page_counter(pp.element, "DIGIT")
        pp.add_run(" )", char_pr_id_ref=cid)
        for run in pp.element.findall(f"{_HP}run"):
            run.set("charPrIDRef", str(cid))
        self.para_format(pp, alignment="CENTER", line_spacing_percent=130)

        # 오른쪽: [ 2 ]학년 [수학과] / 학교 이름
        right_size = t["sizes"]["footer_right"]
        rp1 = table.cell(0, 2).paragraphs[0]
        self.add_rich_text(rp1, f.get("right_top", ""), size=right_size, font=t["fonts"]["heading"])
        rp2 = table.cell(0, 2).add_paragraph("")
        self.add_rich_text(rp2, f.get("right_bottom", ""), size=right_size, font=t["fonts"]["heading"], bold=True)
        for rp in (rp1, rp2):
            self.para_format(rp, alignment="RIGHT", line_spacing_percent=120)

        # 맨 아래 안내 문구
        np_ = table.cell(1, 0).paragraphs[0]
        self.add_rich_text(np_, f.get("notice", ""), size=t["sizes"]["footer_notice"])
        self.para_format(np_, alignment="LEFT", line_spacing_percent=110)
        self.para_format(anchor, line_spacing_percent=100)
        self._footer_table = table

    # ------------------------------------------------------------------ 전체
    def build(self) -> bytes:
        self.setup_page()
        self.build_header_table()
        first_col_para = self.start_columns()
        boxes = self.exam.get("boxes", [])
        for i, box in enumerate(boxes):
            self.build_box(box, anchor=first_col_para if i == 0 else None)
        for section in self.exam.get("sections", []):
            if section.get("title"):
                self.build_section_title(section["title"])
            for j, item in enumerate(section.get("items", [])):
                self.build_item(item, is_first=(j == 0))
        note = self.exam.get("page_end_note")
        if note:
            p = self.doc.add_paragraph("")
            p.add_run(note, char_pr_id_ref=self.run_style(size=self.tpl["sizes"]["body"], font=self.tpl["fonts"]["heading"]))
            self.para_format(p, alignment="RIGHT", spacing_before_pt=60)
        self.build_footer()
        report = self.doc.validate()
        if not getattr(report, "ok", True):
            self.warnings.append(f"검사 결과: {report}")
        return postprocess(self.doc.to_bytes())


def postprocess(data: bytes) -> bytes:
    """저장 뒤 손보기.

    - 한국어를 어절 단위로 줄바꿈 (BREAK_WORD → KEEP_WORD)
    - 꼬리말의 쪽 번호 위치 컨트롤(pageNum) 제거: 꼬리말 글 안의 번호와 겹쳐 두 번 찍히지 않게
    - zip 을 다시 쓸 때 mimetype 을 맨 앞에, 압축 없이
    """
    src = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        names = src.namelist()
        order = ["mimetype"] + [n for n in names if n != "mimetype"]
        for name in order:
            if name not in names:
                continue
            body = src.read(name)
            if name == "Contents/header.xml":
                body = body.replace(b'breakNonLatinWord="BREAK_WORD"', b'breakNonLatinWord="KEEP_WORD"')
            if name.startswith("Contents/section") and name.endswith(".xml"):
                text = body.decode("utf-8")
                text = re.sub(r'<hp:run charPrIDRef="\d+"><hp:ctrl><hp:pageNum [^>]*/></hp:ctrl></hp:run>', "", text)
                body = text.encode("utf-8")
            if name == "mimetype":
                dst.writestr(zipfile.ZipInfo("mimetype"), body, compress_type=zipfile.ZIP_STORED)
            else:
                dst.writestr(name, body)
    return out.getvalue()


def build_exam(exam: dict, template: dict | None = None) -> tuple[bytes, list[str]]:
    builder = ExamBuilder(exam, template)
    return builder.build(), builder.warnings
