"""Text wrapping and collision checks; no network or HWP dependencies."""
import math
import re


class LayoutOverflow(ValueError):
    pass


def reserve(box, occupied, page_height):
    """Keep horizontal positions; move a colliding block below earlier blocks."""
    x, y, w, h = (float(box[k]) for k in ("x", "y", "w", "h"))
    if not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 0 or h <= 0:
        raise LayoutOverflow("글 또는 그림의 배치 영역이 올바르지 않습니다.")
    for _ in range(len(occupied) + 1):
        collisions = [b for b in occupied if x < b["x"] + b["w"] - .05 and x + w > b["x"] + .05
                      and y < b["y"] + b["h"] - .05 and y + h > b["y"] + .05]
        if not collisions:
            break
        y = max(b["y"] + b["h"] + .7 for b in collisions)
    if y + h > page_height - 3:
        raise LayoutOverflow("읽은 내용이 쪽 아래로 넘쳐 한글 파일 생성을 멈췄습니다. AI 읽기 결과는 보관되어 있으므로 다시 읽지 말고 배치를 확인해 주세요.")
    placed = {"x": x, "y": y, "w": w, "h": h}
    occupied.append(placed)
    return placed


def wrap_lines(lines, font, width, measure):
    """Wrap at spaces, keeping math expressions and Korean words intact."""
    output = []
    for source in lines:
        line = []
        for piece in source:
            tokens = [piece] if "m" in piece else [{"t": t} for t in re.findall(r"\s+|\S+", str(piece.get("t", "")))]
            for token in tokens:
                if not line and token.get("t", "").isspace():
                    continue
                if measure([token], font) > width * 1.02:
                    raise LayoutOverflow("한 줄에 들어가지 않는 수식 또는 글이 있습니다. AI를 다시 부르지 말고 글 영역의 너비를 확인해 주세요.")
                if line and measure(line + [token], font) > width:
                    output.append(line)
                    line = []
                    if token.get("t", "").isspace():
                        continue
                line.append(token)
        output.append(line or [{"t": ""}])
    return output


def numbered_lines(lines, role, no, label="", choice_no=1):
    lines = [[dict(piece) for piece in line] for line in lines] or [[{"t": ""}]]
    prefix = ""
    if role == "stem":
        prefix = (label or str(no) + ".") + " "
        pattern = r"^\s*" + re.escape(prefix.strip()) + r"\s*"
    elif role == "choice":
        marks = "①②③④⑤⑥⑦⑧"
        prefix = (marks[choice_no - 1] if isinstance(choice_no, int) and 1 <= choice_no <= len(marks) else str(choice_no)) + "  "
        pattern = r"^\s*" + re.escape(prefix.strip()) + r"\s*"
    if prefix:
        if lines[0] and "t" in lines[0][0]:
            lines[0][0]["t"] = re.sub(pattern, "", lines[0][0]["t"], count=1)
        lines[0].insert(0, {"t": prefix})
    return lines
