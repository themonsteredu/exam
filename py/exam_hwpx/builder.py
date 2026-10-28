"""시험지 JSON + 양식 설정 → 한글 파일(.hwpx).

python-hwpx 6.9.0 사용. 사용법:
    from exam_hwpx.builder import build_exam
    data = build_exam(exam_json)          # .hwpx 파일 내용(bytes)
"""

from __future__ import annotations

import base64
import copy
import io
import re
import struct
import zipfile
import zlib

from hwpx import HwpxDocument
from hwpx.equation.measure import measure_equation

from .latex import latex_to_plain, script_for_measure, to_eqedit
from .template import MM, get_template, mm

CHOICE_MARKS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"]
_HH = "{http://www.hancom.co.kr/hwpml/2011/head}"
_HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_size(data: bytes) -> tuple[int, int]:
    if not data.startswith(_PNG_SIGNATURE) or len(data) < 24:
        raise ValueError("PNG 그림이 아닙니다")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def hancom_picture_sizes(pic_element, png: bytes) -> None:
    """그림 크기 정보를 한글이 직접 저장하는 방식으로 맞춘다.

    한글은 그림 파일의 원래 크기를 픽셀 x 75 (96dpi 기준 HWPUNIT)로 imgDim·imgClip 에 적고,
    크기를 바꾸지 않은 그림의 curSz 는 0 으로 둔다. 보이는 크기는 sz·orgSz·imgRect 가 정한다.
    python-hwpx 는 imgDim·imgClip 에 보이는 크기를, curSz 에도 같은 크기를 적는데,
    이 파일을 이전 버전 한글(Windows)에서 열면 그림 자리만 잡히고 그림은 비어 보였다.
    """
    px_w, px_h = png_size(png)
    natural_w, natural_h = str(px_w * 75), str(px_h * 75)
    cur = pic_element.find(f"{_HP}curSz")
    if cur is not None:
        cur.set("width", "0")
        cur.set("height", "0")
    clip = pic_element.find(f"{_HP}imgClip")
    if clip is not None:
        clip.set("left", "0")
        clip.set("top", "0")
        clip.set("right", natural_w)
        clip.set("bottom", natural_h)
    dim = pic_element.find(f"{_HP}imgDim")
    if dim is not None:
        dim.set("dimwidth", natural_w)
        dim.set("dimheight", natural_h)


def png_with_dpi(data: bytes, dpi: float) -> bytes:
    """PNG 에 해상도(pHYs) 정보를 넣는다. 다른 프로그램에 붙여 넣어도 크기가 맞게."""
    ppm = max(1, round(dpi / 0.0254))
    body = struct.pack(">IIB", ppm, ppm, 1)
    chunk = struct.pack(">I", len(body)) + b"pHYs" + body + struct.pack(">I", zlib.crc32(b"pHYs" + body) & 0xFFFFFFFF)
    out = bytearray(data[:8])
    pos = 8
    while pos + 8 <= len(data):
        length = int.from_bytes(data[pos : pos + 4], "big")
        ctype = data[pos + 4 : pos + 8]
        end = pos + 12 + length
        if ctype != b"pHYs":
            out += data[pos:end]
        if ctype == b"IHDR":
            out += chunk
        pos = end
    return bytes(out)


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
        if not isinstance(latex, str):  # 수식 자리에 글이 아닌 값(null, 숫자 등)이 온 경우
            self.warnings.append(f"{where}: 수식 자리가 비었거나 글이 아님 ({latex!r})")
            if latex is not None:
                p.add_run(str(latex), char_pr_id_ref=self.run_style(size=size))
            return
        base_unit = int(round(size * 100))
        before = list(p.element)
        try:
            script = to_eqedit(latex, upright_uppercase=self.tpl.get("upright_point_names", True))
            # 수식 상자 크기와 기준선: python-hwpx 측정기가 모르는 호(arch)·넓은 기호는 크기가 같은 것으로 바꿔 잰다
            box = measure_equation(script_for_measure(script), base_unit=base_unit)
            equation = self.doc.shapes.add_equation(
                script,
                paragraph=p,
                base_unit=base_unit,
                size=(box.width, box.height),
                char_pr_id_ref=self.run_style(size=size),
            )
            equation.element.set("baseLine", str(box.base_line))
        except Exception as exc:  # 바꾸지 못하거나 넣지 못한 수식은 읽을 수 있는 글자로 넣고 알려 준다
            for child in list(p.element):  # 넣다 만 수식 조각은 지운다
                if not any(child is old for old in before):
                    p.element.remove(child)
            self.warnings.append(f"{where}: 수식을 글자로 넣음 ({latex}) - {exc}")
            p.add_run(latex_to_plain(latex), char_pr_id_ref=self.run_style(size=size))

    def add_pieces(self, p, pieces: list[dict], *, size: float, where: str):
        for i, piece in enumerate(pieces):
            if not isinstance(piece, dict):  # 조각이 그냥 글로 들어온 경우
                piece = {"t": piece}
            if "m" in piece:
                self.add_equation(p, piece["m"], size=size, where=f"{where}[{i}]")
            else:
                text = piece.get("t")
                # 문단 나눔은 문제 글에서만 쓴다 (build_item 이 미리 나눔). 다른 곳에 섞여 오면 빈칸으로
                text = "" if text is None else str(text).replace("\n", " ")
                p.add_run(text, char_pr_id_ref=self.run_style(size=size))

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
                indent_left_mm=0,
                first_line_indent_mm=-3.5 if hanging else 0,
            )
        self.para_format(p_anchor, line_spacing_percent=100, spacing_after_pt=3)
        return table

    def build_section_title(self, title: str, break_before: str | None = None):
        t = self.tpl
        p_anchor = self.doc.add_paragraph("")
        self.set_break(p_anchor, break_before)
        table = p_anchor.add_table(1, 1, width=self.column_width(), border_fill_id_ref=self.border("0.4 mm", "0.4 mm", "0.4 mm", "0.4 mm"))
        p = table.cell(0, 0).paragraphs[0]
        p.add_run(title, char_pr_id_ref=self.run_style(size=t["sizes"]["section_title"], font=t["fonts"]["heading"]))
        self.para_format(p, alignment="CENTER", line_spacing_percent=130)
        self.para_format(p_anchor, line_spacing_percent=100, spacing_before_pt=10, spacing_after_pt=10)

    # ------------------------------------------------------------------ 그림
    @staticmethod
    def figure_png(fig: dict) -> bytes | None:
        """그림 엔진이 만든 PNG (base64 글자 또는 data: 주소)."""
        data = fig.get("png")
        if not data:
            return None
        if isinstance(data, str):
            if data.startswith("data:"):
                data = data.split(",", 1)[1]
            data = base64.b64decode(data)
        png_size(data)  # PNG 인지 확인
        return data

    def figure_width_mm(self, fig: dict) -> float:
        width = fig.get("width_mm") or (fig.get("size_mm") or [50])[0]
        column_mm = self.column_width() / MM
        limit = column_mm * self.tpl["figure"]["right_max_ratio"] if fig.get("place") == "right" else column_mm - 1
        return min(float(width), limit)

    def figure_align(self, fig: dict, no) -> str:
        """그림 가로 맞춤. LEFT·CENTER·RIGHT 가 아니면 가운데로 두고 알려 준다."""
        align = str(fig.get("align") or "CENTER").strip().upper()
        if align not in ("LEFT", "CENTER", "RIGHT"):
            self.warnings.append(f"{no}번 그림: 맞춤 값을 몰라 가운데로 둠 ({fig.get('align')!r})")
            align = "CENTER"
        return align

    def build_figure(self, item: dict, stem_paragraph):
        """그림을 문제 글 아래(place=below, 기본) 또는 오른쪽(place=right)에 넣는다.
        PNG 가 아직 없으면 그림 크기만큼 빈 자리를 둔다."""
        fig = item.get("figure")
        if not fig:
            return
        no = item.get("no")
        png = self.figure_png(fig)
        if png is None:
            if fig.get("render_error"):
                # 그림 그리기 단계(render-figures.mjs, 확인 화면)가 실패를 적어 둔 그림. 빈 자리만 넣고 알려 준다.
                # 그리기 단계를 아예 거치지 않은 경우(1단계처럼 일부러 비워 두는 경우)는 알리지 않는다
                self.warnings.append(f"{no}번 그림: 그림을 만들지 못해 빈 자리로 넣음 - {fig['render_error']}")
            self.build_figure_placeholder(fig, align=self.figure_align(fig, no))
            return
        w_mm = self.figure_width_mm(fig)
        px_w, px_h = png_size(png)
        h_mm = w_mm * px_h / px_w
        if fig.get("place") == "right":
            self.add_floating_figure(stem_paragraph, png, w_mm, h_mm)
            return
        align = self.figure_align(fig, no)
        gap = self.tpl["figure"]["gap_pt"]
        item_id = self.add_image(png)
        p = self.doc.add_paragraph("", include_run=False)
        pic = p.add_picture(item_id, width=mm(w_mm), height=mm(h_mm), treat_as_char=True, align=align)
        hancom_picture_sizes(pic.element, png)
        # 문제 글의 내어쓰기를 물려받지 않게 왼쪽 여백을 0 으로 둔다
        self.para_format(p, alignment=align, line_spacing_percent=100, indent_left_mm=0, first_line_indent_mm=0,
                         spacing_before_pt=gap, spacing_after_pt=gap)

    def add_image(self, png: bytes) -> str:
        """그림 파일을 문서에 넣고 그 이름(id)을 돌려준다. 한글이 저장하는 방식대로 image1, image2 … 로 붙인다."""
        self._image_count = getattr(self, "_image_count", 0) + 1
        return self.doc.media.add_image(png, "png", item_id=f"image{self._image_count}").item_id

    def add_floating_figure(self, p, png: bytes, w_mm: float, h_mm: float):
        """문제 글 오른쪽에 그림을 띄워 두고, 글은 그림 왼쪽으로 흐르게 한다."""
        pic = p.add_picture(
            self.add_image(png),
            width=mm(w_mm),
            height=mm(h_mm),
            treat_as_char=False,
            pos_overrides={
                "flowWithText": "1",
                "allowOverlap": "0",
                "vertRelTo": "PARA",
                "vertAlign": "TOP",
                "horzRelTo": "COLUMN",
                "horzAlign": "RIGHT",
                "vertOffset": 0,
                "horzOffset": 0,
            },
            text_wrap="SQUARE",
        )
        hancom_picture_sizes(pic.element, png)
        pic.element.set("textFlow", "LEFT_ONLY")
        margin = pic.element.find(f"{_HP}outMargin")
        if margin is not None:
            margin.set("left", str(mm(3)))
            margin.set("bottom", str(mm(1.5)))
        # 그림이 든 줄 조각을 문단 맨 앞으로 옮긴다 (한글은 문단 첫머리에 붙은 그림을 기준으로 둔다)
        for run in p.element.findall(f"{_HP}run"):
            if pic.element in list(run):
                p.element.remove(run)
                p.element.insert(0, run)
                break
        p.section.mark_dirty()

    def build_figure_placeholder(self, fig: dict, align: str = "CENTER"):
        """그림 자리: 그림이 아직 없을 때 크기만큼 비워 둔다 (연한 점선 상자)."""
        w_mm, h_mm = fig.get("size_mm", [fig.get("width_mm", 50), 40])
        p_anchor = self.doc.add_paragraph("")
        bf = self.doc.styles.ensure_border_fill(border_color="#C8C8C8", border_width="0.12 mm", border_type="DASH")
        table = p_anchor.add_table(1, 1, width=mm(w_mm), border_fill_id_ref=bf)
        self._set_row_height(table, 0, mm(h_mm))
        self.para_format(p_anchor, alignment=align, line_spacing_percent=100,
                         indent_left_mm=0, first_line_indent_mm=0, spacing_before_pt=6, spacing_after_pt=6)

    @staticmethod
    def set_break(p, kind: str | None):
        """문단 앞에서 단(column)이나 쪽(page)을 나눈다."""
        if kind == "column":
            p.column_break = True
        elif kind == "page":
            p.element.set("pageBreak", "1")
            p.section.mark_dirty()

    @staticmethod
    def split_paragraphs(pieces: list) -> list[list]:
        """문제 글 조각을 문단별로 나눈다. {"t": "\\n"} 조각이 문단 나눔이다."""
        paragraphs: list[list] = [[]]
        for piece in pieces or []:
            if isinstance(piece, dict) and piece.get("t") == "\n":
                paragraphs.append([])
            else:
                paragraphs[-1].append(piece)
        return [p for p in paragraphs if p] or [[]]

    def build_item(self, item: dict, is_first: bool):
        t = self.tpl
        size = t["sizes"]["body"]
        no = item["no"]
        label = item.get("label") or f"{no}."
        paragraphs = self.split_paragraphs(item.get("stem", []))
        first = None
        for k, pieces in enumerate(paragraphs):
            p = self.doc.add_paragraph("")
            if k == 0:
                first = p
                self.set_break(p, item.get("break_before"))
                p.add_run(f"{label} ", char_pr_id_ref=self.run_style(size=size))
            self.add_pieces(p, pieces, size=size, where=f"{no}번 문제 글")
            if k == len(paragraphs) - 1 and item.get("points") is not None:
                p.add_run(f" [{item['points']}점]", char_pr_id_ref=self.run_style(size=size))
            if k == 0:
                self.para_format(
                    p, alignment="JUSTIFY", line_spacing_percent=t["line_spacing"]["body"],
                    # 내어쓰기: 첫 줄(문제 번호)은 단 왼쪽 끝에서, 다음 줄부터 5.5mm 들여 시작한다.
                    # 한글은 왼쪽 여백에서 첫 줄을 시작하고 내어쓰기 값만큼 나머지 줄을 민다 (왼쪽 여백 0 이어야 번호가 선택지 번호와 같은 세로줄에 선다)
                    indent_left_mm=0, first_line_indent_mm=-5.5,
                    spacing_before_pt=0 if (is_first or item.get("break_before")) else t["item_gap_pt"],
                )
            else:
                # 둘째 문단부터는 번호 다음 글자와 같은 세로줄에서 시작한다
                self.para_format(p, alignment="JUSTIFY", line_spacing_percent=t["line_spacing"]["body"],
                                 indent_left_mm=5.5, first_line_indent_mm=0, spacing_before_pt=2)
        self.build_figure(item, first)
        if item.get("bogi"):
            self.build_bogi(item["bogi"], no)
        for i, choice in enumerate(item.get("choices", [])):
            cp = self.doc.add_paragraph("")
            cp.add_run(f"{CHOICE_MARKS[i]}  ", char_pr_id_ref=self.run_style(size=t["sizes"]["choice"]))
            self.add_pieces(cp, choice, size=t["sizes"]["choice"], where=f"{no}번 선택지 {i + 1}")
            self.para_format(cp, alignment="LEFT", line_spacing_percent=t["line_spacing"]["choice"],
                             indent_left_mm=0, spacing_before_pt=4 if i == 0 else 0)

    def build_bogi(self, lines: list, no):
        """<보기> 상자: 문제 글과 같은 들여쓰기로, 가는 테두리 안에 항목(ㄱ, ㄴ, ㄷ …)을 한 줄씩."""
        t = self.tpl
        size = t["sizes"]["body"]
        indent = 5.5
        p_anchor = self.doc.add_paragraph("")
        thin = t["border"]["thin"]
        table = p_anchor.add_table(1, 1, width=self.column_width() - mm(indent), border_fill_id_ref=self.border(thin, thin, thin, thin))
        cell = table.cell(0, 0)
        title = cell.paragraphs[0]
        title.add_run("<보기>", char_pr_id_ref=self.run_style(size=size, font=t["fonts"]["heading"]))
        self.para_format(title, alignment="CENTER", line_spacing_percent=t["line_spacing"]["box"])
        for i, line in enumerate(lines):
            lp = cell.add_paragraph("")
            self.add_pieces(lp, line, size=size, where=f"{no}번 보기 {i + 1}")
            first_text = next((piece.get("t", "") for piece in line if isinstance(piece, dict) and "t" in piece), "")
            # "ㄱ. " 처럼 기호로 시작하는 항목은 다음 줄을 기호 뒤 글자에 맞춘다
            hanging = bool(re.match(r"^\s*[ㄱ-ㅎ가-하①-⑳a-z0-9]\s*[.)]\s", first_text))
            self.para_format(lp, alignment="JUSTIFY", line_spacing_percent=t["line_spacing"]["body"],
                             indent_left_mm=0, first_line_indent_mm=-4.5 if hanging else 0)
        self.para_format(p_anchor, line_spacing_percent=100, indent_left_mm=indent, first_line_indent_mm=0,
                         spacing_before_pt=4, spacing_after_pt=4)

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
                self.build_section_title(section["title"], section.get("break_before"))
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

    - 한국어를 어절 단위로 줄바꿈: 모든 문단의 breakNonLatinWord 를 BREAK_WORD 로.
      한글에서는 이 값이 이름과 반대로 동작한다. BREAK_WORD 가 어절을 지키고 KEEP_WORD 는 글자 사이에서 끊는다
      (python-hwpx form_fit/measure.py 설명과 같고, KEEP_WORD 로 만든 파일은 한글에서 "구 / 하면"처럼 끊겼다)
    - 꼬리말의 쪽 번호 위치 컨트롤(pageNum) 제거: 꼬리말 글 안의 번호와 겹쳐 두 번 찍히지 않게
    - header.xml 의 binDataList 제거: 한글이 저장한 파일에는 없고, 그 안의 번호(0, 1, 2)가
      그림이 가리키는 이름(image1 …)과 달라 그림을 찾지 못하는 보기 프로그램이 있다
    - zip 을 다시 쓸 때 mimetype 을 맨 앞에, 압축 없이.
      한글이 저장하는 대로 그림 파일(BinData)과 version.xml 도 압축하지 않는다
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
                body = body.replace(b'breakNonLatinWord="KEEP_WORD"', b'breakNonLatinWord="BREAK_WORD"')
                body = re.sub(rb"<hh:binDataList\b[^>]*?(?:/>|>.*?</hh:binDataList>)", b"", body, flags=re.S)
            if name.startswith("Contents/section") and name.endswith(".xml"):
                text = body.decode("utf-8")
                text = re.sub(r'<hp:run charPrIDRef="\d+"><hp:ctrl><hp:pageNum [^>]*/></hp:ctrl></hp:run>', "", text)
                body = text.encode("utf-8")
            if name == "mimetype" or name == "version.xml" or name.startswith("BinData/"):
                dst.writestr(zipfile.ZipInfo(name), body, compress_type=zipfile.ZIP_STORED)
            else:
                dst.writestr(name, body)
    return out.getvalue()


def build_exam(exam: dict, template: dict | None = None) -> tuple[bytes, list[str]]:
    builder = ExamBuilder(exam, template)
    return builder.build(), builder.warnings
