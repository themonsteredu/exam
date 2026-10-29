"""비도형 자료의 선·글자·표를 한글 개체로 출력한다. 외부 코드/이미지를 실행하지 않는다."""
from __future__ import annotations
import math
import re
from .template import mm
from hwpx.form_fit.measure import estimate_text_width

HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"


def draw_graphic(layout, anchor, spec, box, sx, sy, no):
    from .source_layout import valid_box
    if not valid_box(box) or spec.get("kind") not in ("map", "table", "chart", "illustration"):
        raise ValueError("재작성 자료의 영역/종류 오류")
    def number(v):
        if not isinstance(v, (int, float)) or not math.isfinite(v):
            raise ValueError("자료 좌표 오류")
        return v
    width, height = number(spec.get("width")), number(spec.get("height"))
    if not (0 < width <= 4000 and 0 < height <= 4000):
        raise ValueError("자료 크기 오류")
    paths, ellipses, texts, tables = (spec.get(k, []) for k in ("paths", "ellipses", "texts", "tables"))
    if not all(isinstance(v, list) for v in (paths, ellipses, texts, tables)) or len(paths) > 500 or len(ellipses) > 300 or len(texts) > 400 or len(tables) > 15:
        raise ValueError("자료 개체 수 오류")
    if sum(len(p.get("points", [])) for p in paths) > 10000:
        raise ValueError("자료 꼭짓점 수 오류")
    b = layout.b
    ox, oy = box["x"] * sx, box["y"] * sy
    # 미리보기와 같은 종횡비: 원본 영역의 중심에 맞춘다.
    ratio = min(box["w"] * sx / width, box["h"] * sy / height)
    ox += (box["w"] * sx - width * ratio) / 2
    oy += (box["h"] * sy - height * ratio) / 2
    def color(v):
        if not isinstance(v, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}|none", v):
            raise ValueError("자료 색상 오류")
        return v
    def point(p):
        x, y = map(number, p)
        if not (0 <= x <= width and 0 <= y <= height):
            raise ValueError("자료 선이 영역 밖에 있습니다")
        return x, y
    def shape_style(shape, stroke, dashed=False):
        line = shape.element.find(HP + "lineShape")
        if line is not None and (stroke == "none" or dashed):
            line.set("style", "NONE" if stroke == "none" else "DASH")
    for p in paths:
        pts = [point(pt) for pt in p["points"]]
        if len(pts) < 2:
            raise ValueError("자료 선의 꼭짓점 부족")
        x, y = min(v[0] for v in pts), min(v[1] for v in pts)
        stroke, fill = color(p["stroke"]), color(p["fill"])
        weight = str(max(1, mm(min(80, max(.1, number(p["width"]))) * ratio)))
        if len(pts) == 2 and not p.get("closed"):
            a, c = pts
            shape = b.doc.shapes.add_line(start_x=mm((a[0] - x) * ratio), start_y=mm((a[1] - y) * ratio), end_x=mm((c[0] - x) * ratio), end_y=mm((c[1] - y) * ratio),
                line_color=stroke if stroke != "none" else "#FFFFFF", line_width=weight, treat_as_char=False, paragraph=anchor)
        else:
            shape = b.doc.shapes.add_polygon([( (px - x) * ratio, (py - y) * ratio) for px, py in pts], closed=bool(p.get("closed")),
                line_color=stroke if stroke != "none" else "#FFFFFF", line_width=weight, fill_color=None if fill == "none" else fill, treat_as_char=False, paragraph=anchor)
        layout.place(shape.element, ox + x * ratio, oy + y * ratio)
        shape_style(shape, stroke, p.get("dash", False))
    for e in ellipses:
        cx, cy, rx, ry = (number(e[k]) for k in ("cx", "cy", "rx", "ry"))
        if rx <= 0 or ry <= 0:
            raise ValueError("타원 반지름 오류")
        point([cx - rx, cy - ry]); point([cx + rx, cy + ry])
        stroke, fill = color(e["stroke"]), color(e["fill"])
        shape = b.doc.shapes.add_ellipse(width=mm(rx * 2 * ratio), height=mm(ry * 2 * ratio), line_color=stroke if stroke != "none" else "#FFFFFF",
            line_width=str(max(1, mm(min(80, max(.1, number(e["width"]))) * ratio))), fill_color=None if fill == "none" else fill, treat_as_char=False, paragraph=anchor)
        layout.place(shape.element, ox + (cx - rx) * ratio, oy + (cy - ry) * ratio); shape_style(shape, stroke)
    for t in tables:
        rows, cols = t["rows"], t["cols"]
        if not isinstance(rows, int) or not isinstance(cols, int) or not (1 <= rows <= 30 and 1 <= cols <= 30) or len(t["cells"]) > 900:
            raise ValueError("표 행·열 오류")
        weights, heights = t["col_widths"], t["row_heights"]
        if len(weights) != cols or len(heights) != rows or any(number(v) <= 0 for v in weights + heights):
            raise ValueError("표 행·열 크기 오류")
        x, y, w, h = (number(t[k]) for k in ("x", "y", "w", "h"))
        point([x,y]); point([x+w,y+h])
        if w <= 0 or h <= 0:
            raise ValueError("표 크기 오류")
        table = anchor.add_table(rows, cols, width=mm(w * ratio), height=mm(h * ratio), border_fill_id_ref=b.border(*(["0.12 mm"] * 4)))
        table.element.set("pageBreak", "NONE"); table.set_column_widths(weights)
        for r in range(rows): b._set_row_height(table, r, mm(h * ratio * heights[r] / sum(heights)))
        used = set()
        for c in t["cells"]:
            row, col, rs, cs = (c[k] for k in ("row", "col", "row_span", "col_span"))
            if not all(isinstance(v, int) for v in (row,col,rs,cs)) or not (0 <= row < rows and 0 <= col < cols and 1 <= rs <= rows-row and 1 <= cs <= cols-col):
                raise ValueError("표 병합 오류")
            occupied = {(r,c) for r in range(row,row+rs) for c in range(col,col+cs)}
            if used.intersection(occupied): raise ValueError("표 병합 겹침")
            used.update(occupied)
            if rs > 1 or cs > 1: table.merge_cells(row, col, row+rs-1, col+cs-1)
        font = max(8.5, min(20, number(t["size"]) * ratio * 72 / 25.4))
        for c in t["cells"]:
            cell = table.cell(c["row"], c["col"]); cell.element.set("editable", "1")
            cell_w = w * ratio * sum(weights[c["col"]:c["col"]+c["col_span"]]) / sum(weights)
            cell_h = h * ratio * sum(heights[c["row"]:c["row"]+c["row_span"]]) / sum(heights)
            lines = str(c["text"])[:2000].split("\n")
            widest = max(1, *(estimate_text_width(line, font) for line in lines))
            fitted = max(3, min(font, font * mm(max(1,cell_w-2)) / widest, max(1,cell_h-1) * 72/25.4 / len(lines) / 1.12))
            if fitted < 8.5: b.warnings.append(f"{no}번: 표 안 글자가 작습니다. 원본과 비교해 주세요")
            for i, text in enumerate(str(c["text"])[:2000].split("\n")):
                p = cell.paragraphs[0] if i == 0 else cell.add_paragraph("")
                p.add_run(text, char_pr_id_ref=b.run_style(size=fitted))
                b.para_format(p, alignment="CENTER", line_spacing_percent=110, spacing_before_pt=0, spacing_after_pt=0)
        layout.place(table.element, ox + x * ratio, oy + y * ratio)
    for t in texts:
        x, y, w, h = (number(t[k]) for k in ("x", "y", "w", "h"))
        point([x,y]); point([x+w,y+h])
        if w <= 0 or h <= 0: raise ValueError("자료 글자 영역 오류")
        block = {"role":"text", "box":{"x":ox+x*ratio,"y":oy+y*ratio,"w":w*ratio,"h":h*ratio},
            "lines":[[{"t":line}] for line in str(t["text"])[:2000].split("\n")], "font_pt":max(8.5,number(t["size"])*ratio*72/25.4), "minimum_font_pt":3,
            "align":str(t.get("align","left")).upper(), "direction": t.get("direction","horizontal"), "literal":True}
        if block["align"] not in ("LEFT","CENTER","RIGHT"): raise ValueError("글자 정렬 오류")
        layout.text(anchor, block, 1, 1, no)
