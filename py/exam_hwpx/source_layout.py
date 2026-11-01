"""원본의 페이지·영역 좌표에 편집 가능한 글/수식 상자를 배치한다.

원본 좌표를 우선하되 내용이 쪽 밖으로 밀리면 이어지는 쪽을 만든다.
좌표 인식/글꼴의 오차가 있으므로 실제 한글 렌더링과 완전 동일하다고 보장하지 않는다.
"""
from __future__ import annotations

import math
import re

from hwpx.equation.measure import measure_equation
from hwpx.form_fit.measure import estimate_text_width

from .latex import script_for_measure, to_eqedit
from .template import mm
from .layout_safety import LayoutOverflow, PageOverflow, _split_math_at_operators, reserve, wrap_lines, numbered_lines

HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"


def valid_box(box):
    return isinstance(box, dict) and all(isinstance(box.get(k), (int, float)) and math.isfinite(box[k]) for k in ("x", "y", "w", "h")) and box["w"] > 0 and box["h"] > 0


class SourceLayout:
    def __init__(self, builder):
        self.b = builder
        self.doc = builder.doc
        self.occupied = []
        self.suppress_reserve = False
        self.page_shift = 0
        self.is_continuation = False
        self.seen_items = set()

    def start_section(self, section):
        """Create the anchor and collision space for one physical page."""
        self.doc.page.set_size(width=mm(self.paper_width), height=mm(self.paper_height), section=section)
        self.doc.page.set_margins(left=mm(5), right=mm(5), top=mm(5), bottom=mm(5), header=0, footer=0, section=section)
        anchor = section.paragraphs[0]
        self.b.para_format(anchor, line_spacing_percent=100, spacing_before_pt=0, spacing_after_pt=0)
        for run in anchor.element.findall(HP + "run"):
            run.set("charPrIDRef", self.b.run_style(size=1))
        self.anchor = anchor
        self.occupied = []
        self.continuation_labels = set()
        return anchor

    def continue_page(self, source_y):
        """Move the remaining source-page content onto a new physical page."""
        self.start_section(self.doc.add_section())
        self.page_shift = source_y - 10
        self.is_continuation = True
        self.b.warnings.append(f"{self.source_page}쪽: 내용이 길어 추가 쪽에 이어 배치했습니다. 원본과 쪽 구성이 달라질 수 있습니다.")

    def allocate(self, box, item_no=None):
        """Reserve a non-overlapping location, adding a page when needed."""
        if box["h"] > self.paper_height - 13:
            raise LayoutOverflow(f"{self.source_page}쪽: 한 글 또는 그림 영역이 한 쪽보다 큽니다. 읽은 결과는 보관되어 있습니다.")
        for attempt in range(2):
            candidate = {**box, "y": max(10 if self.is_continuation else 0, box["y"] - self.page_shift)}
            occupied = list(self.occupied)
            # If a question continues on a later page, identify its contents.
            show_label = (self.is_continuation and isinstance(item_no, int) and item_no in self.seen_items
                          and item_no not in self.continuation_labels and box["h"] <= self.paper_height - 20)
            label = None
            try:
                if show_label:
                    label_width = min(self.paper_width - 3 - candidate["x"], max(30, min(candidate["w"], 45)))
                    if label_width > 0:
                        label = reserve({"x": candidate["x"], "y": candidate["y"], "w": label_width, "h": 6}, occupied, self.paper_height)
                placed = reserve(candidate, occupied, self.paper_height)
            except PageOverflow:
                if attempt:
                    raise
                self.continue_page(box["y"])
                continue
            self.occupied = occupied
            if label:
                self.text_table(self.anchor, {"align": "LEFT"}, [[{"t": f"{item_no}번 이어서"}]], label, 9.5, 0, False, "", item_no, 0)
                self.continuation_labels.add(item_no)
            if isinstance(item_no, int):
                self.seen_items.add(item_no)
            return self.anchor, placed

    def place(self, element, x, y):
        element.set("textWrap", "IN_FRONT_OF_TEXT")
        pos = element.find(HP + "pos")
        for key, val in {
            "treatAsChar": "0", "affectLSpacing": "0", "flowWithText": "0", "allowOverlap": "1",
            "vertRelTo": "PAGE", "horzRelTo": "PAGE", "vertAlign": "TOP", "horzAlign": "LEFT",
            "vertOffset": str(mm(y)), "horzOffset": str(mm(x)),
        }.items():
            pos.set(key, val)
        for margin in element.findall(HP + "outMargin"):
            for k in ("left", "right", "top", "bottom"):
                margin.set(k, "0")

    def frame(self, anchor, box, sx, sy):
        if not valid_box(box):
            return
        shape = self.doc.shapes.add_rectangle(width=mm(box["w"] * sx), height=mm(box["h"] * sy),
            line_width="28", treat_as_char=False, paragraph=anchor)
        self.place(shape.element, box["x"] * sx, box["y"] * sy)

    def image(self, anchor, png, box, sx, sy, reserve_space=True):
        if not valid_box(box):
            return
        from .builder import hancom_picture_sizes, png_size
        iw, ih = png_size(png)
        # 원본 영역 안에서 종횡비 유지. 그림을 늘려 찌그러뜨리지 않는다.
        w, h = box["w"] * sx, box["h"] * sy
        placed = {"x": box["x"] * sx, "y": box["y"] * sy, "w": w, "h": h}
        if reserve_space and not self.suppress_reserve:
            anchor, placed = self.allocate(placed)
        ratio = min(w / iw, h / ih)
        fw, fh = iw * ratio, ih * ratio
        pic = anchor.add_picture(self.b.add_image(png), width=mm(fw), height=mm(fh), treat_as_char=False)
        hancom_picture_sizes(pic.element, png)
        self.place(pic.element, placed["x"] + (w - fw) / 2, placed["y"] + (h - fh) / 2)

    def line_width(self, pieces, font):
        width = 0
        for p in pieces:
            piece_font = p.get("_fit_font", font)
            if "m" in p:
                try:
                    script = to_eqedit(p["m"])
                    width += measure_equation(script_for_measure(script), base_unit=round(piece_font * 100)).width + piece_font * 22
                except Exception:
                    width += estimate_text_width(p["m"], piece_font)
            else:
                width += estimate_text_width(re.sub(r"\*\*|__", "", str(p.get("t", ""))), piece_font)
        return width

    def text(self, anchor, block, sx, sy, no):
        box = block.get("box")
        if not valid_box(box):
            self.b.warnings.append(f"{no}번: 글 영역의 위치를 읽지 못했습니다")
            return
        role, title = block.get("role", "text"), block.get("title", "")
        lines = numbered_lines(block.get("lines", []), role, no, block.get("label", ""), block.get("choice_no", 1))
        boxed = role == "box"
        if boxed and title:
            lines.insert(0, [{"t": title}])
        if block.get("direction") == "vertical":
            chars = "".join(str(p.get("t", "")) for line in lines for p in line)
            lines = [[{"t": c}] for c in chars if c != "\n"] or [[{"t": ""}]]
        pad = 1.2 if boxed else 0
        w, h = box["w"] * sx, box["h"] * sy
        available_w, available_h = max(1, w - pad * 2), max(1, h - pad * 2)
        # 원본의 줄 수·줄 폭에 맞추되 학생용 글씨를 무한정 줄이지 않는다.
        font = min(14, max(11, 11 * self.paper_width / 210), available_h * 72 / 25.4 / len(lines) * .80)
        font = max(9.5, font)
        minimum_font = 9.5
        if isinstance(block.get("font_pt"), (int, float)):
            minimum_font = max(3, min(8.5, block.get("minimum_font_pt", 8.5)))
            font = min(20, max(minimum_font, block["font_pt"]))
        required_w = max(self.line_width(line, font) for line in lines)
        if required_w > mm(available_w):
            font = max(minimum_font, font * mm(available_w) / required_w * .98)
        font = max(minimum_font, min(font, available_h * 72 / 25.4 / len(lines) / 1.12))
        adjusted = set()
        # An atomic equation cannot wrap without changing its meaning. If the
        # original item has free space to the right, use it before shrinking.
        right_limit = block.get("_right_limit")
        if not boxed and isinstance(right_limit, (int, float)) and math.isfinite(right_limit):
            max_w = max(w, (right_limit - box["x"]) * sx)
            atomic = [p for line in lines for p in line if "m" in p and len(_split_math_at_operators(str(p["m"]))) == 1]
            widest = max((self.line_width([p], font) for p in atomic), default=0)
            if widest > mm(available_w) * .97 and max_w > w:
                w = min(max_w, max(w, widest / mm(1) / .97 + pad * 2))
                available_w = max(1, w - pad * 2)
                adjusted.add("math_width")
        # Include the number and equation widths before wrapping, then reserve the
        # real height. A fixed source rectangle must not silently grow over its neighbour.
        location = f"{no}번" if isinstance(no, int) else str(no)
        original_lines = lines
        force_wide_page = False
        x = box["x"] * sx
        try:
            lines = wrap_lines(original_lines, font, mm(available_w) * .97, self.line_width, adjusted.add)
        except LayoutOverflow as exc:
            if self.suppress_reserve:
                raise LayoutOverflow(f"{location}: {exc}") from exc
            # A single equation or character can be wider than a detected box.
            # Give it a full-width continuation instead of dropping it or
            # making the user pay to read the same page again.
            w = max(1, self.paper_width - 20)
            available_w = max(1, w - pad * 2)
            try:
                lines = wrap_lines(original_lines, font, mm(available_w) * .97, self.line_width, adjusted.add)
            except LayoutOverflow as final_exc:
                raise LayoutOverflow(f"{location}: {final_exc}") from final_exc
            x = 10
            force_wide_page = True
            adjusted.add("wide_page")
        if adjusted:
            self.b.warnings.append(f"{location}: 긴 글 또는 수식의 줄바꿈·크기를 조정했습니다. 해당 부분을 확인해 주세요.")
        heights = []
        for line in lines:
            units = font * 100
            for piece in line:
                if "m" in piece:
                    try:
                        measured = measure_equation(script_for_measure(to_eqedit(piece["m"])), base_unit=round(piece.get("_fit_font", font) * 100))
                        units = max(units, measured.height)
                    except Exception:
                        pass
            heights.append(units / mm(1) * 1.2)
        source_y = box["y"] * sy
        if self.suppress_reserve:
            # A native chart/table must stay together inside its reserved box.
            chunks = [(lines, heights, 0)]
        else:
            max_inner = self.paper_height - 13 - pad * 2 - .8
            if max_inner <= 0 or any(height > max_inner for height in heights):
                raise LayoutOverflow(f"{location}: 한 줄의 높이가 용지보다 큽니다. 읽은 결과는 보관되어 있습니다.")
            chunks, chunk_lines, chunk_heights, start, chunk_total = [], [], [], 0, 0
            for line, height in zip(lines, heights):
                if chunk_lines and chunk_total + height > max_inner:
                    chunks.append((chunk_lines, chunk_heights, start))
                    start += len(chunk_lines)
                    chunk_lines, chunk_heights, chunk_total = [], [], 0
                chunk_lines.append(line)
                chunk_heights.append(height)
                chunk_total += height
            if chunk_lines:
                chunks.append((chunk_lines, chunk_heights, start))
            if force_wide_page:
                self.continue_page(source_y)

        table = None
        for chunk_index, (chunk_lines, chunk_heights, start) in enumerate(chunks):
            if chunk_index:
                self.continue_page(source_y)
            natural_h = sum(chunk_heights) + pad * 2 + .8
            desired_h = max(h, natural_h) if len(chunks) == 1 else natural_h
            if not self.suppress_reserve:
                desired_h = min(desired_h, self.paper_height - 13)
            placed = {"x": x, "y": source_y, "w": w, "h": desired_h}
            if not self.suppress_reserve:
                anchor, placed = self.allocate(placed, no)
            table = self.text_table(anchor, block, chunk_lines, placed, font, pad, boxed, title, no, start)
        return table

    def text_table(self, anchor, block, lines, placed, font, pad, boxed, title, no, start):
        """Write one editable part of a text block on the selected page."""
        w, h = placed["w"], placed["h"]
        bf = self.b.border(*(["0.12 mm"] * 4 if boxed else [None] * 4))
        table = anchor.add_table(1, 1, width=mm(w), height=mm(h), border_fill_id_ref=bf)
        table.element.set("pageBreak", "NONE")
        self.place(table.element, placed["x"], placed["y"])
        cell = table.cell(0, 0)
        cell.element.set("hasMargin", "1")
        cell.element.set("editable", "1")
        for tag in ("inMargin",):
            margin = table.element.find(HP + tag)
            if margin is not None:
                for k in ("left", "right", "top", "bottom"):
                    margin.set(k, "0")
        margin = cell.element.find(HP + "cellMargin")
        for k in ("left", "right", "top", "bottom"):
            margin.set(k, str(mm(pad)))
        cell.element.find(HP + "subList").set("vertAlign", "TOP")
        # 좌표는 상자 위치, 줄은 원본 인쇄 줄. 가로 선택지를 세로로 늘어놓지 않는다.
        spacing = 120
        for i, line in enumerate(lines):
            p = cell.paragraphs[0] if i == 0 else cell.add_paragraph("")
            if block.get("literal"):
                p.add_run("".join(str(part.get("t", "")) for part in line), char_pr_id_ref=self.b.run_style(size=font))
            else:
                self.b.add_pieces(p, line, size=font, where=f"{no}번 원본 배치")
            self.b.para_format(p, alignment="CENTER" if boxed and title and start + i == 0 else block.get("align", "LEFT"),
                line_spacing_percent=spacing, spacing_before_pt=0, spacing_after_pt=0,
                indent_left_mm=0, indent_right_mm=0, first_line_indent_mm=0)
        return table

    def fallback(self, item):
        """이전 자료: 문항 전체 영역만 있을 때 읽기 순서로 배치하고 한계를 알린다."""
        source = item["source"]
        self.b.warnings.append(f"{item['no']}번: 이전 인식 자료에 세부 위치가 없어 문항 안 배치를 추정했습니다. 원본을 다시 변환하면 세부 위치를 읽습니다")
        blocks = []
        lines = self.b.split_paragraphs(item.get("stem", []))
        fig = item.get("figure") or {}
        fb = fig.get("box")
        # 옛 자료도 조건 제목 다음의 글을 네모 안에 묶어 준다.
        condition = next((i for i, line in enumerate(lines) if "".join(p.get("t", "") for p in line).strip() in ("조건", "[조건]", "<조건>")), None)
        choices = item.get("choices", [])
        stem_end = fb["y"] if valid_box(fb) else source["y"] + source["h"] * .52
        height = max(10, stem_end - source["y"])
        blocks.append({"role": "stem", "box": {**source, "h": height}, "lines": lines[:condition] if condition is not None else lines})
        if condition is not None:
            blocks.append({"role": "box", "title": "조건", "box": {**source, "y": source["y"] + height, "h": source["h"] * .38}, "lines": lines[condition + 1:]})
        elif item.get("bogi"):
            blocks.append({"role": "box", "title": "보기", "box": {**source, "y": source["y"] + height, "h": source["h"] * .28}, "lines": item["bogi"]})
        if choices:
            start = max(source["y"] + source["h"] * .65, (fb["y"] + fb["h"]) if valid_box(fb) else 0)
            row_h = max(5, (source["y"] + source["h"] - start) / len(choices))
            for i, line in enumerate(choices):
                blocks.append({"role": "choice", "choice_no": i + 1, "box": {"x": source["x"], "y": start + row_h * i, "w": source["w"], "h": row_h}, "lines": [line]})
        return blocks

    def build(self):
        items = [it for s in self.b.exam.get("sections", []) for it in s.get("items", [])]
        for i, page in enumerate(self.b.exam["source_pages"]):
            section = self.doc.sections[0] if i == 0 else self.doc.add_section()
            self.paper_width, ph = page.get("paper_mm", [210, 297])
            self.paper_height = ph
            self.source_page = page["page"]
            self.page_shift = 0
            self.is_continuation = False
            self.seen_items = set()
            sx, sy = self.paper_width / page["width"], ph / page["height"]
            anchor = self.start_section(section)
            rules = [r for r in page.get("rules", []) if valid_box(r)]
            if rules:
                for r in rules:
                    if r["h"] > r["w"]:
                        shape = self.doc.shapes.add_line(end_x=0, end_y=mm(r["h"] * sy), line_width="28", treat_as_char=False, paragraph=anchor)
                        self.place(shape.element, (r["x"] + r["w"] / 2) * sx, r["y"] * sy)
                    else:
                        shape = self.doc.shapes.add_line(end_x=mm(r["w"] * sx), end_y=0, line_width="28", treat_as_char=False, paragraph=anchor)
                        self.place(shape.element, r["x"] * sx, (r["y"] + r["h"] / 2) * sy)
            else:
                self.frame(anchor, page.get("print_area"), sx, sy)
            # 두 단 문항의 실제 좌우 경계 사이에 원본처럼 구분선을 둔다.
            on_page = [it for it in items if (it.get("source") or {}).get("page") == page["page"] and valid_box(it.get("source"))]
            left = [it["source"] for it in on_page if it.get("column") == 1]
            right = [it["source"] for it in on_page if it.get("column") == 2]
            area = page.get("print_area")
            if not rules and left and right and valid_box(area):
                lx = sorted(b["x"] + b["w"] for b in left)[len(left) // 2]
                rx = sorted(b["x"] for b in right)[len(right) // 2]
                if lx <= rx:
                    x = (lx + rx) / 2 * sx
                    y = min(b["y"] for b in left + right) * sy
                    bottom = (area["y"] + area["h"]) * sy
                    rule = self.doc.shapes.add_line(end_x=0, end_y=mm(max(1, bottom - y)), line_width="28", treat_as_char=False, paragraph=anchor)
                    self.place(rule.element, x, y)
            entries = []
            for block in self.page_text(page, on_page, i):
                entries.append((block["box"]["y"], block["box"]["x"], "text", block, f"{page['page']}쪽"))
            for item in on_page:
                numbered = False
                seen = set()
                for original in item.get("layout_blocks") or self.fallback(item):
                    if not valid_box(original.get("box")):
                        continue
                    block = {**original, "label": item.get("label") or "", "_right_limit": min(page["width"], item["source"]["x"] + item["source"]["w"])}
                    signature = (repr(block.get("lines")), tuple(block["box"].get(k) for k in ("x", "y", "w", "h")))
                    if signature in seen:
                        continue
                    seen.add(signature)
                    if block.get("role") == "stem":
                        if numbered:
                            block["role"] = "text"
                        numbered = True
                    entries.append((block["box"]["y"], block["box"]["x"], "text", block, item["no"]))
                for fig in [item.get("figure"), *item.get("extra_figures", [])]:
                    if fig:
                        box = fig.get("layout_box") or fig.get("box")
                        if valid_box(box):
                            entries.append((box["y"], box["x"], "figure", fig, item["no"]))
                        else:
                            raise ValueError(f"{item['no']}번: 그림의 위치가 없습니다. 읽은 결과를 확인해 주세요.")
            for _, _, kind, value, no in sorted(entries, key=lambda e: (e[0], e[1])):
                if kind == "text":
                    # Do not expand across a neighbouring choice, picture, or
                    # text block that occupies the same original vertical band.
                    box = value["box"]
                    limit = value.get("_right_limit")
                    if isinstance(limit, (int, float)):
                        for _, _, other_kind, other, _ in entries:
                            if other is value:
                                continue
                            neighbour = other.get("box") if other_kind == "text" else (other.get("layout_box") or other.get("box"))
                            if valid_box(neighbour) and neighbour["x"] >= box["x"] + box["w"] - .5 and neighbour["y"] < box["y"] + box["h"] and neighbour["y"] + neighbour["h"] > box["y"]:
                                limit = min(limit, neighbour["x"] - 1)
                        value["_right_limit"] = max(box["x"] + box["w"], limit)
                    self.text(self.anchor, value, sx, sy, no)
                else:
                    self.figure(self.anchor, value, sx, sy, no)

    def figure(self, anchor, fig, sx, sy, no):
        placement = fig.get("layout_box") or fig.get("box")
        x, y = placement["x"] * sx, placement["y"] * sy
        w, h = placement["w"] * sx, placement["h"] * sy
        scale = min(1, (self.paper_width - 6) / w, (self.paper_height - 13) / h)
        w, h = w * scale, h * scale
        fitted_x = max(3, min(x, self.paper_width - 3 - w))
        if scale < 1 or abs(fitted_x - x) > .05:
            self.b.warnings.append(f"{no}번: 그림이 용지에 들어가도록 위치 또는 크기를 조정했습니다. 원본과 비교해 주세요.")
        anchor, positioned = self.allocate({"x": fitted_x, "y": y, "w": w, "h": h}, no)
        placement = {k: positioned[k] / (sx if k in ("x", "w") else sy) for k in ("x", "y", "w", "h")}
        native_failed = False
        if fig.get("graphic") and fig.get("render_mode") != "original" and fig["graphic"].get("kind") != "photo":
            before = list(anchor.element)
            try:
                from .graphic import draw_graphic
                self.suppress_reserve = True
                draw_graphic(self, anchor, fig["graphic"], placement, sx, sy, no)
                return
            except Exception as exc:
                native_failed = True
                for child in list(anchor.element):
                    if not any(child is old for old in before):
                        anchor.element.remove(child)
                self.b.warnings.append(f"{no}번: 편집 가능한 자료 대신 원본 이미지를 사용했습니다 ({str(exc)[:100]})")
            finally:
                self.suppress_reserve = False
        png = self.b.figure_png({"png": fig["original_png"]}) if native_failed and fig.get("original_png") else self.b.figure_png(fig)
        if png:
            self.image(anchor, png, placement, sx, sy, reserve_space=False)
        else:
            raise ValueError(f"{no}번: 출력할 그림이 없습니다. 그림을 생략하지 않도록 한글 파일 생성을 멈췄습니다. 읽은 결과는 보관되어 있습니다.")

    def page_text(self, page, items, index):
        blocks = page.get("text_blocks") or []
        if blocks:
            return [b for b in blocks if valid_box(b.get("box"))]
        # Old checkpoints already contain typed header strings; do not ask AI again.
        header = page.get("header") or (self.b.exam.get("header", {}) if index == 0 else {})
        boxes = page.get("boxes") if "boxes" in page else (self.b.exam.get("boxes", []) if index == 0 else [])
        footer = page.get("footer") or self.b.exam.get("footer", {})
        first_y = min((it["source"]["y"] for it in items), default=page["height"] * .4)
        area = page.get("print_area")
        if not valid_box(area):
            area = {"x": page["width"] * .04, "y": page["height"] * .03, "w": page["width"] * .92, "h": page["height"] * .94}
        top = sorted([d["box"] for d in page.get("decorations", []) if valid_box(d.get("box")) and d["box"]["y"] < first_y], key=lambda b: (b["y"], b["x"]))
        blocks = []
        used = 0
        y = area["y"]
        def block(lines, boxed, font=10):
            nonlocal used, y
            lines = [line for line in lines if line]
            if not lines:
                return
            if used < len(top):
                region = top[used]
            else:
                height = max(12, (first_y - y - 4) / max(1, len(boxes) + 1 - used))
                region = {"x": area["x"], "y": y, "w": area["w"], "h": height}
            used += 1
            y = region["y"] + region["h"] + 3
            blocks.append({"role": "box" if boxed else "text", "title": "", "box": region,
                           "font_pt": font, "minimum_font_pt": 9.5,
                           "lines": [[{"t": text}] for text in lines]})
        if header.get("title") or header.get("target") or header.get("date"):
            block([header.get("title", ""), " ".join(str(header.get(k) or "") for k in ("target_label", "target", "date")).strip()], True, 12)
        for box in boxes or []:
            block([str(line.get("text", "")) if isinstance(line, dict) else str(line) for line in box.get("lines", [])], True)
        bottom = sorted([d["box"] for d in page.get("decorations", []) if valid_box(d.get("box")) and d["box"]["y"] > first_y], key=lambda b: b["y"])
        footer_lines = [footer.get(k, "") for k in ("right_top", "right_bottom", "notice")]
        if any(footer_lines):
            region = bottom[-1] if bottom else {"x": area["x"], "y": page["height"] * .93, "w": area["w"], "h": page["height"] * .05}
            blocks.append({"role": "text", "title": "", "box": region, "font_pt": 9.5,
                           "lines": [[{"t": str(t)}] for t in footer_lines if t]})
        return blocks

