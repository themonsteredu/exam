"""Text wrapping and collision checks; no network or HWP dependencies."""
import math
import re
import unicodedata


class LayoutOverflow(ValueError):
    pass


class PageOverflow(LayoutOverflow):
    """An otherwise valid block needs more vertical room on this page."""


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
        raise PageOverflow("읽은 내용이 쪽 아래로 넘쳐 한글 파일 생성을 멈췄습니다. AI 읽기 결과는 보관되어 있으므로 다시 읽지 말고 배치를 확인해 주세요.")
    placed = {"x": x, "y": y, "w": w, "h": h}
    occupied.append(placed)
    return placed


def text_tokens(text):
    """Keep each wrapped word's bold/underline delimiters balanced."""
    for part in re.split(r"(\*\*.+?\*\*|__.+?__)", text):
        marker = part[:2]
        if marker in ("**", "__") and part.endswith(marker) and len(part) > 4:
            for token in text_tokens(part[2:-2]):
                yield token if token.isspace() else marker + token + marker
        else:
            yield from re.findall(r"\s+|\S+", part)


def _split_long_text(token, font, width, measure):
    """Split only an individual word that cannot fit in an empty line.

    Ordinary Korean wrapping is still by word. Preserve emphasis delimiters on
    each fragment so formatting remains intact when a word spans paragraphs.
    """
    text = str(token.get("t", ""))
    markers = []
    while len(text) > 4 and text[:2] in ("**", "__") and text.endswith(text[:2]):
        markers.append(text[:2])
        text = text[2:-2]
    prefix, suffix = "".join(markers), "".join(reversed(markers))
    # Keep combining marks with their preceding character.
    chars = []
    for char in text:
        if chars and unicodedata.combining(char):
            chars[-1] += char
        else:
            chars.append(char)
    parts, chunk = [], ""
    for char in chars:
        candidate = chunk + char
        if measure([{"t": prefix + candidate + suffix}], font) > width * 1.02:
            if not chunk:
                raise LayoutOverflow("글 영역이 너무 좁아 한 글자도 넣을 수 없습니다. 읽은 결과는 보관되어 있습니다.")
            parts.append({"t": prefix + chunk + suffix})
            chunk = char
            if measure([{"t": prefix + chunk + suffix}], font) > width * 1.02:
                raise LayoutOverflow("글 영역이 너무 좁아 한 글자도 넣을 수 없습니다. 읽은 결과는 보관되어 있습니다.")
        else:
            chunk = candidate
    if chunk:
        parts.append({"t": prefix + chunk + suffix})
    return parts


def _split_math_at_operators(latex):
    """Split only at top-level operators, never inside a fraction or group."""
    # Environments and paired delimiters can span several top-level tokens.
    # Treat them as one equation so a line break cannot change their meaning.
    if re.search(r"\\(?:begin|end|left|right|lvert|rvert|lVert|rVert)\b|\|", latex):
        return [latex]
    positions, stack = [], []
    pairs = {")": "(", "]": "[", "}": "{"}
    operators = re.compile(r"\\(?:leq|geq|neq|times|div|cdot|pm|mp|le|ge|ne)(?![A-Za-z])")
    i = 0
    while i < len(latex):
        char = latex[i]
        if char == "\\":
            command = re.match(r"\\[A-Za-z]+|\\.", latex[i:])
            if command:
                if command.group() == r"\(":
                    stack.append("(")
                elif command.group() == r"\)" and stack and stack[-1] == "(":
                    stack.pop()
                if not stack and i and operators.fullmatch(command.group()):
                    positions.append(i)
                i += len(command.group())
                continue
        if char in "([{":
            stack.append(char)
        elif char in ")]}" and stack and stack[-1] == pairs[char]:
            stack.pop()
        elif not stack and i and char in "+-=<>±×÷≥≤≠":
            # Keep <=, >=, and an adjacent unary sign with the preceding operator.
            if latex[i - 1] not in "+-=<>±×÷≥≤≠":
                positions.append(i)
        i += 1
    if stack or not positions:
        return [latex]
    return [latex[a:b] for a, b in zip([0, *positions], [*positions, len(latex)]) if a < b]


def _fit_math(piece, font, width, measure):
    """Fit an indivisible equation without changing its mathematical content."""
    low, high = min(font, 8.0), font
    smallest = {**piece, "_fit_font": low}
    if measure([smallest], font) > width * 1.02:
        raise LayoutOverflow("수식이 글 영역보다 너무 넓습니다. 읽은 결과는 보관되어 있습니다.")
    for _ in range(18):
        mid = (low + high) / 2
        if measure([{**piece, "_fit_font": mid}], font) <= width * .99:
            low = mid
        else:
            high = mid
    return {**piece, "_fit_font": round(low, 3)}


def wrap_lines(lines, font, width, measure, on_adjustment=None):
    """Wrap at spaces; safely handle an overlong word or equation."""
    output = []
    for source in lines:
        line = []
        for piece in source:
            tokens = [piece] if "m" in piece else [{"t": t} for t in text_tokens(str(piece.get("t", "")))]
            pending = list(tokens)
            while pending:
                token = pending.pop(0)
                if not line and token.get("t", "").isspace():
                    continue
                if measure([token], font) > width * 1.02:
                    if "m" not in token:
                        if token.get("t", "").isspace():
                            if line:
                                output.append(line)
                                line = []
                            continue
                        parts = _split_long_text(token, font, width, measure)
                        if on_adjustment:
                            on_adjustment("text")
                        pending = parts + pending
                        continue
                    parts = _split_math_at_operators(str(token["m"]))
                    if len(parts) > 1:
                        if on_adjustment:
                            on_adjustment("math_wrap")
                        pending = [{**token, "m": part} for part in parts] + pending
                        continue
                    token = _fit_math(token, font, width, measure)
                    if on_adjustment:
                        on_adjustment("math_size")
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
