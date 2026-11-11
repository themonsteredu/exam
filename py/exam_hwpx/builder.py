"""시험지 JSON + 양식 설정 → 한글 파일(.hwpx).

python-hwpx 6.9.0 사용. 사용법:
    from exam_hwpx.builder import build_exam
    data = build_exam(exam_json)          # .hwpx 파일 내용(bytes)
"""

from __future__ import annotations

import base64
import copy
import io
import math
import re
import struct
import zipfile
import zlib

from hwpx import HwpxDocument
import hwpx.equation.measure as _eq_measure
from hwpx.equation.measure import measure_equation
from hwpx.form_fit.measure import estimate_text_width

# ── 수식 상자 너비 ──
# 한글(윈도)은 파일에 적힌 수식 상자 너비를 그대로 쓰고, 수식은 상자 왼쪽에 붙여 그린다 (상자 양옆에 바깥 여백 56 HWPUNIT).
# 상자가 좁으면 수식 끝이 뒤 글자와 겹치고("MN의", "1.7의"), 넓으면 뒤에 빈칸이 생긴다("∠a ,", "∠c 의").
# python-hwpx 측정기를 바탕으로, 사용자 한글 화면 사진(6·7·8·9.png)과 한글로 만든 PDF(글자 위치가 정확함)에서 잰 너비에 맞춘다.
# 글자 크기·옆 기호에 따라 다른 것: + − = : 양옆 빈칸과 여는 괄호가 10pt(그리고 ∠ 옆)에서 11pt 보다 넓다
# (+ 1.14em 대 1.01em, = 1.28 대 1.16). 잰 값과 맞춰 보는 검사: scripts/check_eq_width.py
import threading as _threading

_eq_measure._DIGIT = 0.5  # 숫자 (한글 수식 글꼴 HyhwpEQ 너비 0.500)
_eq_measure._PUNCT = 0.25  # 소수점 0.24~0.25 (측정기 0.15)
_eq_measure._FRACTION_PAD = 0.24  # 분수: 가로줄이 분자·분모보다 양쪽으로 길고, 그 바깥에도 빈칸이 있다 (양쪽 0.24)
# 기울인 영문: HyhwpEQ 글꼴 너비 (x 0.571, a 0.528, b 0.429, c 0.432), m 은 화면에서 0.87~0.88 (측정기 1.03)
_eq_measure._LETTER_WIDTHS = {**_eq_measure._LETTER_WIDTHS, "x": 0.571, "a": 0.528, "b": 0.43, "c": 0.432, "m": 0.88}
# 비례식 2:3 의 ':' 는 한글이 양옆을 띄운 관계 기호로 그린다 (측정기는 0.15)
_eq_measure._RELATIONS = _eq_measure._RELATIONS | frozenset({":"})
# 각도의 ° (^{circ}): 측정기는 circ 를 연산 기호로 보고 양옆 빈칸까지 넣는다 → 기호 하나만
_eq_measure._KEYWORD_GLYPHS = {**_eq_measure._KEYWORD_GLYPHS, "circ": 0.5}
# ∠ △ ∞ ∂ … : 측정기 안의 연산 기호 목록(OPERATORS)에도 들어 있어서, 기호 하나(1.05)가 아니라 양옆 빈칸이 붙은 연산 기호로 쟀다
# (∠ 하나가 화면에서는 1.04 인데 1.26 으로 재져 "∠a ," 처럼 빈칸이 생김)
_ORDINARY_SYMBOLS = frozenset(_eq_measure._SYMBOL_ORDINARY) | frozenset({"dots", "infty", "star", "ast"})
_eq_is_operator = _eq_measure._is_operator


def _calibrated_is_operator(token: str) -> bool:
    return token.lower() not in _ORDINARY_SYMBOLS and _eq_is_operator(token)


_eq_measure._is_operator = _calibrated_is_operator
# 바로 세운 영문(점 이름 AB·MN, 단위 cm)은 측정기가 대문자를 모두 0.67 로 재서 M·N·W 처럼 넓은 글자에서 뒤 글자와 겹쳤다.
# 화면에서 잰 너비(AB 1.46, MN 1.73, 8cm)가 Times 글꼴 너비보다 조금 넓다 → Times 너비(1/1000 em) x 1.06 으로 글자마다
_TIMES_UPRIGHT = {
    **dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889,
                                             722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611))),
    **dict(zip("abcdefghijklmnopqrstuvwxyz", (444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778,
                                             500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444))),
}
_UPRIGHT_SCALE = 1.06
_eq_char_width = _eq_measure._char_width


def _calibrated_char_width(ch: str, upright: bool = False) -> float:
    if upright and ch in _TIMES_UPRIGHT:
        return _TIMES_UPRIGHT[ch] / 1000 * _UPRIGHT_SCALE
    # 따옴표 안의 기호는 측정기가 영문 소문자 너비(0.4)로 잰다 → 기호 너비로.
    # □ △ ○ ① ㉠ ★ 같은 도형·동그라미 글자는 거의 한 글자(0.95), ⊥ ∽ ≡ → 같은 수학 기호는 0.75
    code = ord(ch)
    if 0x2460 <= code <= 0x24FF or 0x25A0 <= code <= 0x27BF or 0x3000 <= code <= 0x33FF:
        return 0.95
    if code >= 0x2000 and not ("가" <= ch <= "힣"):
        return 0.75
    return _eq_char_width(ch, upright)


_eq_measure._char_width = _calibrated_char_width
# 측정기가 '그 밖의 글자'(0.36)로 재는 문장 부호 중 넓은 것: 30% 의 % 는 Times 로 0.83
_WIDE_MARKS = {"%": 0.83, "?": 0.44, "*": 0.5, "@": 0.92}

# 넓은 값('small')과 보통 값('large') (em). 넓은 값은 10pt 이하이거나 ∠·△ 가 든 수식에 쓴다
#  - 연산 기호 글자 너비와 양옆 빈칸: 11pt 화면(6·8.png) + 1.01 − 0.98 = 1.15 : 0.66,
#    10pt 화면(7.png, "∠a−∠b+2∠c")과 다른 판 한글로 만든 PDF(10pt) + 1.14 − 1.08~1.13 = 1.28.
#    10.5pt 화면(9.png)의 '=' 뒤 빈칸은 11pt 와 같았다 → 10.5pt 는 보통 값.
#    ∠ 옆이라서 넓은지 10pt 라서 넓은지는 아직 가리지 못해, 둘 다 넓은 값으로 (겹침보다 작은 빈칸이 낫다)
#  - 괄호: 숫자·글자 뒤의 ')' 앞에 0.1em 쯤 빈칸 (0.48), 10pt 에서는 숫자 뒤 '(' 도 0.47
#  - ∥ (~parallel~ 전체 11pt 1.95, 10pt 2.07)
_EQ_SIZE_TABLE = {
    "large": {"space": 0.12, "+": 0.77, "-": 0.74, "=": 0.92, ":": 0.42, "open": 0.39, "close": 0.48},
    "small": {"space": 0.18, "+": 0.78, "-": 0.76, "=": 0.92, ":": 0.42, "open": 0.47, "close": 0.48},
}
_eq_size = {"key": "large"}
_eq_lock = _threading.Lock()
_eq_token_width = _eq_measure._token_width


def _calibrated_token_width(token: str, upright: bool = False, sign: bool = False) -> float:
    if token in _WIDE_MARKS:
        return _WIDE_MARKS[token]
    table = _EQ_SIZE_TABLE[_eq_size["key"]]
    if token in ("(", "["):
        return table["open"]
    if token in (")", "]"):
        return table["close"]
    # 앞에 아무것도 없는 부호(-3)도 한글은 양옆을 띄운다 (화면 0.97, 측정기는 한쪽만)
    return _eq_token_width(token, upright, False)


_eq_measure._token_width = _calibrated_token_width
# 빈칸 '~' : 한글 설명서에 '보통 빈칸', ` 는 그 1/4. "~parallel~" 전체가 화면에서 1.95~2.07 이 되도록 0.45, ∥ 글자 0.81
# 따옴표 안의 빈칸(" cm")은 측정기 그대로 0.25
TILDE_EM = 0.45
_eq_symbol = _eq_measure._Measurer._symbol


def _calibrated_symbol(self, token: str, sign: bool = False):
    if token == "~":
        return _eq_measure._Box(TILDE_EM, 0.0, 0.0)
    return _eq_symbol(self, token, sign)


_eq_measure._Measurer._symbol = _calibrated_symbol
# 분수 바로 뒤의 + − = 는 왼쪽 빈칸 없이 붙는다 (분수 상자 자체의 양옆 0.24 가 그 자리를 대신한다)
_eq_infix = _eq_measure._Measurer._infix
_eq_dispatch = _eq_measure._Measurer._dispatch


def _calibrated_infix(self, token, items, depth):
    done = _eq_infix(self, token, items, depth)
    if done:
        self._after_fraction = token == "over" or token.lower() == "atop"
    return done


def _calibrated_dispatch(self, token, depth, sign=False):
    after_fraction = getattr(self, "_after_fraction", False)
    self._after_fraction = False
    box = _eq_dispatch(self, token, depth, sign)
    if after_fraction and _eq_measure._is_operator(token):
        box = _eq_measure._Box(max(0.0, box.width - _eq_measure._OPERATOR_SPACE), box.ascent, box.descent)
    return box


_eq_measure._Measurer._infix = _calibrated_infix
_eq_measure._Measurer._dispatch = _calibrated_dispatch
_EQ_GLYPHS_BASE = dict(_eq_measure._OPERATOR_GLYPHS)


_ANGLE_LIKE = re.compile(r"\b(?:angle|triangle|TRIANGLE)\b")


def measure_equation_sized(script: str, base_unit: int):
    """글자 크기(base_unit, 1/100pt)에 맞춘 값으로 수식 상자를 잰다 (python-hwpx measure_equation 과 같은 결과 모양)."""
    key = "small" if base_unit < 1025 or _ANGLE_LIKE.search(script) else "large"
    table = _EQ_SIZE_TABLE[key]
    with _eq_lock:
        _eq_size["key"] = key
        _eq_measure._OPERATOR_SPACE = table["space"]
        # 목록에 없는 관계 기호(≤ ≥ ≠ ≡ ∽ …)의 글자, ∥ 글자
        _eq_measure._OPERATOR_GLYPH = 0.72
        _eq_measure._OPERATOR_GLYPHS = {**_EQ_GLYPHS_BASE, "+": table["+"], "-": table["-"], "=": table["="],
                                        ":": table[":"], "<": 0.85, ">": 0.85, "times": 0.7, "parallel": 0.81}
        return measure_equation(script, base_unit=base_unit)


# 상자 오른쪽 여유: 잰 너비와 화면 너비의 차이를 덮을 만큼만 (상자 바깥 여백 0.05em 과 뒤 글자의 왼쪽 여백이 따로 있다).
# 넉넉히(0.35em+3%) 잡았을 때는 "∠c 의", "∠a ," 처럼 뒤 조사·쉼표가 떨어져 보였다
EQ_PAD_EM = 0.05
EQ_PAD_RATIO = 0.01
# 수식 바로 뒤의 조사·서술어 앞 띄어쓰기는 지운다 (AI 가 "x:6 을", "m 일 때" 처럼 띄워 읽는 일이 있다)
_PARTICLES = (
    "을|를|의|이|가|은|는|와|과|에|에서|에게|에는|로|으로|일|인|이다|이고|이며|이면|라|라고|이라|이라고|만|도|까지|부터|보다|과의|와의"
    "|이므로|임|임을|만큼|씩|마다|처럼|인지|인가|일까|이나|이라는|라는|이라면|라면|이란|이지만|이면서|이어야"
    "|에서의|에서는|에서도|에도|로부터|으로부터|로의|으로의|로는|으로는|와는|과는|까지의|부터의|보다는|만을|만의"
)
# 조사 뒤에 오는 것: 빈칸·문장 부호·괄호("은(는)")·따옴표·줄임표, 또는 글 끝
_PARTICLE_END = r"(?:[\s,.?!)\]·:;(’”'\"…~]|$)"
# "이 때", "이 식" 처럼 띄어 쓴 지시어 '이' 는 붙이지 않는다
_NOT_DEMONSTRATIVE = r"(?!이\s+(?:때|식|점|값|두|세|중|것|그래프|도형|직선|선분|수|각))"
_PARTICLE_AFTER_EQ = re.compile(
    r"^\s+(?:(?=[,.?!)\]])|" + _NOT_DEMONSTRATIVE + r"(?=(?:" + _PARTICLES + r")" + _PARTICLE_END + r"))"
)
# 숫자를 글로 읽은 경우("30% 일 때", "3 과 4")도 같은 규칙으로 붙인다
_PARTICLE_AFTER_NUMBER = re.compile(
    r"(?<=[0-9%°])\s+" + _NOT_DEMONSTRATIVE + r"(?=(?:" + _PARTICLES + r")" + _PARTICLE_END + r")"
)

from .latex import latex_to_plain, script_for_measure, to_eqedit
from .template import MM, get_template, mm, with_paper

# 쉼표로 나열한 조건을 수식 하나씩으로 나눌 때, 조각마다 있어야 하는 관계 기호
_RELATION = re.compile(r"=|<|>|≤|≥|≠|∥|⊥|≡|\\(?:le|leq|ge|geq|ne|neq|equiv|parallel|perp|sim|cong|approx)(?![A-Za-z])")
_SPACING = re.compile(r"^(?:\s|~|\\[,;:! ]|\\q?quad(?![A-Za-z]))+|(?:\s|~|\\[,;:! ]|\\q?quad(?![A-Za-z]))+$")


def split_condition_list(latex: str) -> list[str]:
    """'\\angle A=70^{\\circ}, \\angle C=30^{\\circ}' 처럼 쉼표로 나열한 조건을 수식 하나씩으로 나눈다.
    한글 수식은 줄을 바꾸지 못해, 긴 수식 하나는 통째로 다음 줄로 넘어가 앞 줄 끝이 빈다
    (2026-11-01 호남삼육중 21번: 조건 다섯 개가 수식 하나라 "21. 다음 그림에서" 뒤가 비었다).
    괄호·중괄호 안의 쉼표(순서쌍, 집합, 구간)와 \\, (좁은 빈칸)는 나누지 않고, 조각이 모두 관계식(=, <, ∥ …)일 때만 나눈다."""
    if not isinstance(latex, str) or "," not in latex:
        return [latex]
    parts, depth, start, i = [], 0, 0, 0
    while i < len(latex):
        ch = latex[i]
        if ch == "\\":
            nxt = latex[i + 1 : i + 2]
            if nxt in ("{", "["):
                depth += 1
            elif nxt in ("}", "]"):
                depth -= 1
            if nxt.isalpha():
                i += 1
                while i < len(latex) and latex[i].isalpha():
                    i += 1
                continue
            i += 2
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(latex[start:i])
            start = i + 1
        i += 1
    parts.append(latex[start:])
    parts = [_SPACING.sub("", part) for part in parts]
    if len(parts) < 2 or not all(part and _RELATION.search(part) for part in parts):
        return [latex]
    return parts


def split_condition_pieces(value):
    """시험지 데이터 속 글 조각 목록마다 쉼표로 나열한 조건 수식을 나눈다 (그림 데이터는 건드리지 않는다)."""
    if isinstance(value, list):
        if any(isinstance(piece, dict) and "m" in piece for piece in value):
            out = []
            for piece in value:
                parts = split_condition_list(piece["m"]) if isinstance(piece, dict) and "m" in piece else [None]
                if len(parts) < 2:
                    out.append(piece)
                    continue
                for k, part in enumerate(parts):
                    if k:
                        out.append({"t": ", "})
                    out.append({**piece, "m": part})
            return out
        return [split_condition_pieces(v) for v in value]
    if isinstance(value, dict):
        return {k: (v if k in ("figure", "extra_figures", "png", "commands", "graphic") else split_condition_pieces(v)) for k, v in value.items()}
    return value

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
        self.exam = split_condition_pieces(exam)
        # 문항마다 (부분 번호, 문항 번호, 첫 문단, 끝 문단) — 만든 뒤 단마다 빈 곳을 재는 데 쓴다
        self.item_spans: list[tuple[int, int, int, int]] = []
        self.tpl = template or with_paper(get_template(exam.get("template")), exam.get("paper"))
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
    def add_rich_text(self, p, text: str, *, size: float, font: str | None = None, bold=False, underline=False):
        """**굵게**, __밑줄__ 표시가 들어간 글을 넣는다. 둘이 겹친 것(__**옳지 않은**__)도 푼다."""
        for token in re.split(r"(\*\*.+?\*\*|__.+?__)", text):
            if not token:
                continue
            if len(token) > 4 and token.startswith("**") and token.endswith("**"):
                self.add_rich_text(p, token[2:-2], size=size, font=font, bold=True, underline=underline)
            elif len(token) > 4 and token.startswith("__") and token.endswith("__"):
                self.add_rich_text(p, token[2:-2], size=size, font=font, bold=bold, underline=True)
            else:
                p.add_run(token, char_pr_id_ref=self.run_style(size=size, font=font, bold=bold, underline=underline))

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
            box = measure_equation_sized(script_for_measure(script), base_unit)
            equation = self.doc.shapes.add_equation(
                script,
                paragraph=p,
                base_unit=base_unit,
                # 기울임 글자의 끝 획과 뒤의 한글이 붙지 않게 여유 폭을 둔다.
                size=(int(box.width * (1 + EQ_PAD_RATIO) + base_unit * EQ_PAD_EM), box.height),
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
                fitted = piece.get("_fit_font", size)
                if not isinstance(fitted, (int, float)) or not 0 < fitted <= size:
                    fitted = size
                self.add_equation(p, piece["m"], size=fitted, where=f"{where}[{i}]")
            else:
                text = piece.get("t")
                # 문단 나눔은 문제 글에서만 쓴다 (build_item 이 미리 나눔). 다른 곳에 섞여 오면 빈칸으로
                text = "" if text is None else str(text).replace("\n", " ")
                prev = pieces[i - 1] if i > 0 else None
                if isinstance(prev, dict) and "m" in prev:
                    text = _PARTICLE_AFTER_EQ.sub("", text)
                text = _PARTICLE_AFTER_NUMBER.sub("", text)
                self.add_rich_text(p, text, size=size)

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
        t, h = self.tpl, self.exam.get("header") or {}
        thick, thin = t["border"]["thick"], t["border"]["thin"]
        first = self.doc.paragraphs[0]
        if not str(h.get("target") or "").strip():
            return self.build_simple_header(first, h)
        table = first.add_table(2, 3, width=self.text_width(), border_fill_id_ref=self.border(thick, thick, thick, thick))
        table.set_column_widths([14, 34, 52])
        table.merge_cells("A1:C1")
        # 칸마다 테두리: 바깥은 굵게, 안쪽은 가늘게
        table.set_cell_border_fill(0, 0, self.border(thick, thick, thick, thick))
        table.set_cell_border_fill(1, 0, self.border(thick, thin, thick, thick))
        table.set_cell_border_fill(1, 1, self.border(thin, thick, thick, thick))
        table.set_cell_border_fill(1, 2, self.border(thick, thick, thick, thick))
        heading = t["fonts"]["heading"]
        # 원본에 제목 상자가 없던 학습지·문제 사진이면 header 가 비어 있다 → 화면에서 적은 시험지 제목을 쓴다
        title = h.get("title") or self.exam.get("title") or ""
        cells = [
            ((0, 0), title, t["sizes"]["title"], True, heading),
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

    def build_simple_header(self, first, h: dict):
        """응시대상 칸이 없는 시험지의 머리: 굵은 테두리 상자 하나에 제목 줄과 날짜 줄."""
        t = self.tpl
        thick = t["border"]["thick"]
        heading = t["fonts"]["heading"]
        table = first.add_table(1, 1, width=self.text_width(), border_fill_id_ref=self.border(thick, thick, thick, thick))
        cell = table.cell(0, 0)
        title = h.get("title") or self.exam.get("title") or ""
        p = cell.paragraphs[0]
        self.add_rich_text(p, title, size=t["sizes"]["title"], font=heading, bold=True)
        self.para_format(p, alignment="CENTER", line_spacing_percent=130, spacing_before_pt=4)
        date = str(h.get("date") or "").strip()
        if date:
            dp = cell.add_paragraph("")
            self.add_rich_text(dp, date, size=t["sizes"]["header_row"], font=heading)
            self.para_format(dp, alignment="CENTER", line_spacing_percent=130, spacing_after_pt=4)
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
        """안내 상자 (유의 사항 / 문항 배점 안내). framed 가 False 면 테두리 없이 안내 줄만 (원본에 테두리가 없던 ※ 줄)."""
        t = self.tpl
        size = t["sizes"]["box"]
        p_anchor = anchor or self.doc.add_paragraph("")
        lines = box.get("lines", [])
        table = None
        if box.get("framed") is False:
            paragraphs = [p_anchor] + [self.doc.add_paragraph("") for _ in lines[1:]]
        else:
            table = p_anchor.add_table(1, 1, width=self.column_width(), border_fill_id_ref=self.border("0.12 mm", "0.12 mm", "0.12 mm", "0.12 mm"))
            cell = table.cell(0, 0)
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
                alignment=line.get("align", "LEFT"),
                line_spacing_percent=t["line_spacing"]["box"],
                indent_left_mm=0,
                first_line_indent_mm=-3.5 if hanging else 0,
            )
        if table is not None:
            self.para_format(p_anchor, line_spacing_percent=100, spacing_after_pt=3)
        else:
            self.para_format(paragraphs[-1], spacing_after_pt=6)
        return table

    def build_section_title(self, title: str, break_before: str | None = None):
        t = self.tpl
        p_anchor = self.doc.add_paragraph("")
        self.set_break(p_anchor, break_before)
        table = p_anchor.add_table(1, 1, width=self.column_width(), border_fill_id_ref=self.border("0.4 mm", "0.4 mm", "0.4 mm", "0.4 mm"))
        p = table.cell(0, 0).paragraphs[0]
        p.add_run(title, char_pr_id_ref=self.run_style(size=t["sizes"]["section_title"], font=t["fonts"]["heading"]))
        self.para_format(p, alignment="CENTER", line_spacing_percent=130)
        # 부분 제목이 단 맨 아래에 홀로 남지 않게 다음 문항과 붙인다
        self.para_format(p_anchor, line_spacing_percent=100, spacing_before_pt=10, spacing_after_pt=10, keep_with_next=True)

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

    def scaled_figure_width_mm(self, fig: dict, default: float = 50) -> float:
        source_width = fig.get("width_mm") or (fig.get("size_mm") or [default])[0]
        return float(source_width) * self.tpl["figure"].get("scale", 1.0)

    def figure_width_mm(self, fig: dict) -> float:
        column_mm = self.column_width() / MM
        limit = column_mm * self.tpl["figure"]["right_max_ratio"] if fig.get("place") == "right" else column_mm - 1
        return min(self.scaled_figure_width_mm(fig), limit)

    def figure_height_budget_mm(self) -> float:
        margins = self.tpl["margins_mm"]
        body_height = self.tpl["paper"]["height_mm"] - sum(margins.get(k, 0) for k in ("top", "bottom", "header", "footer"))
        work_space = max(self.tpl.get("work_space_mm", {}).values(), default=0)
        return max(20, body_height - work_space - 20)  # 문제 글과 풀이 공간을 위한 자리

    @staticmethod
    def fit_picture_size(png: bytes, width_mm: float, height_limit_mm: float) -> tuple[float, float]:
        px_w, px_h = png_size(png)
        aspect = px_h / px_w
        width_mm = min(width_mm, height_limit_mm / aspect)
        return width_mm, width_mm * aspect

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
        w_mm, h_mm = self.fit_picture_size(png, self.figure_width_mm(fig), self.figure_height_budget_mm())
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
        """그림 자리: 그림이 아직 없을 때 크기만큼 비워 둔다 (연한 점선 상자).
        placeholder_note 가 있으면(사진·읽지 못한 그림) 상자 안에 작게 적는다."""
        w_mm, h_mm = fig.get("size_mm", [fig.get("width_mm", 50), 40])
        w_mm = min(float(w_mm), self.column_width() / MM - 1)
        p_anchor = self.doc.add_paragraph("")
        bf = self.doc.styles.ensure_border_fill(border_color="#C8C8C8", border_width="0.12 mm", border_type="DASH")
        table = p_anchor.add_table(1, 1, width=mm(w_mm), border_fill_id_ref=bf)
        self._set_row_height(table, 0, mm(max(8.0, float(h_mm))))
        note = fig.get("placeholder_note")
        if note:
            p = table.cell(0, 0).paragraphs[0]
            p.add_run(str(note), char_pr_id_ref=self.run_style(size=self.tpl["sizes"]["box"]))
            self.para_format(p, alignment="CENTER", line_spacing_percent=130)
        self.para_format(p_anchor, alignment=align, line_spacing_percent=100,
                         indent_left_mm=0, first_line_indent_mm=0, spacing_before_pt=6, spacing_after_pt=6)

    @staticmethod
    def picture_choices(item: dict, figures: list) -> bool:
        """선택지가 모두 그림인 문항인지: 그림이 선택지마다 하나씩 있고 선택지 글은 비어 있다.
        (AI 는 이런 문항을 선택지 수만큼 빈 선택지 + 그림 여러 개, 또는 선택지 없이 그림 4~5개로 읽는다)"""
        if "choice_figures" in item:
            return bool(item["choice_figures"]) and len(figures) >= 2
        choices = item.get("choices") or []
        # 선택지마다 그림이 하나씩 (그림 수 = 선택지 수, 4개 이상): 선택지 글이 있어도 그림과 같이 둔다
        if len(choices) >= 4 and len(figures) == len(choices):
            return True
        def empty(choice) -> bool:
            return not any(
                (isinstance(p, dict) and (str(p.get("t", "")).strip() or str(p.get("m", "")).strip())) or (isinstance(p, str) and p.strip())
                for p in (choice or [])
            )
        if choices and not all(empty(c) for c in choices):
            return False
        n = len(figures)
        if choices:
            return n == len(choices) and n >= 2
        # 선택지를 아예 비워 읽은 경우: 묻는 문장(…것은?)이고 그림이 4~5개일 때만 (서술형의 그림 여러 개는 아님)
        stem = "".join(str(p.get("t", "")) for p in item.get("stem") or [] if isinstance(p, dict))
        return n in (4, 5) and "?" in stem and not item.get("label")

    def build_choice_figures(self, figures: list, no, choices: list | None = None):
        """선택지 그림 ①~⑤ 를 테두리 없는 표에 차례로 넣는다. 칸마다 번호 줄, 그 아래 그림,
        선택지 글이 있으면 그 아래 가운데에 (원본의 그림 밑 설명처럼)."""
        t = self.tpl
        size = t["sizes"]["choice"]
        column_mm = self.column_width() / MM
        captions = [self.split_paragraphs(c) if c else [] for c in choices or []]
        # 긴 설명을 좁은 칸에 끼워 넣으면 수식이나 글이 옆 칸과 닿을 수 있다.
        cols = 1 if any(
            self.piece_width_mm(line, size) > column_mm / 2 - 4.5
            for caption in captions for line in caption
        ) else 2
        rows = (len(figures) + cols - 1) // cols
        p_anchor = self.doc.add_paragraph("")
        none = self.border(None, None, None, None)
        table = p_anchor.add_table(rows, cols, width=self.column_width(), border_fill_id_ref=none)
        for r in range(rows):
            for c in range(cols):
                table.set_cell_border_fill(r, c, none)
        cell_mm = column_mm / cols
        picture_height_limit = max(8, self.figure_height_budget_mm() / rows - 8)  # 번호와 설명 줄
        row_heights = [0] * rows
        for i, fig in enumerate(figures):
            cell = table.cell(i // cols, i % cols)
            label = cell.paragraphs[0]
            mark = CHOICE_MARKS[i] if i < len(CHOICE_MARKS) else f"({i + 1})"
            label.add_run(mark, char_pr_id_ref=self.run_style(size=size))
            self.para_format(label, alignment="LEFT", line_spacing_percent=100, indent_left_mm=0, first_line_indent_mm=0)
            height = int(round(size * 100))
            p = cell.add_paragraph("")
            png = self.figure_png(fig)
            if png is None:
                if fig.get("render_error"):
                    self.warnings.append(f"{no}번 선택지 {mark} 그림: 그림을 만들지 못해 빈 자리로 넣음 - {fig['render_error']}")
                p.add_run(str(fig.get("placeholder_note") or "(그림 자리)"), char_pr_id_ref=self.run_style(size=t["sizes"]["box"]))
                self.para_format(p, alignment="CENTER", line_spacing_percent=100, indent_left_mm=0, first_line_indent_mm=0,
                                 spacing_after_pt=4)
                height += int(round((t["sizes"]["box"] + 4) * 100))
            else:
                width_mm = min(self.scaled_figure_width_mm(fig, default=cell_mm), cell_mm - 4)
                w_mm, h_mm = self.fit_picture_size(png, width_mm, picture_height_limit)
                pic = p.add_picture(self.add_image(png), width=mm(w_mm), height=mm(h_mm), treat_as_char=True, align="CENTER")
                hancom_picture_sizes(pic.element, png)
                self.para_format(p, alignment="CENTER", line_spacing_percent=100, indent_left_mm=0, first_line_indent_mm=0,
                                 spacing_after_pt=2)
                height += mm(h_mm) + 200
            caption = captions[i] if i < len(captions) else []
            for j, part in enumerate(caption):
                cp = cell.add_paragraph("")
                self.add_pieces(cp, part, size=size, where=f"{no}번 선택지 {i + 1}")
                last = j == len(caption) - 1
                self.para_format(cp, alignment="CENTER", line_spacing_percent=t["line_spacing"]["choice"],
                                 indent_left_mm=0, first_line_indent_mm=0, spacing_after_pt=4 if last else 0)
                lines = max(1, math.ceil(self.piece_width_mm(part, size) / (cell_mm - 4.5)))
                height += lines * self.choice_line_height(cp, size) + (400 if last else 0)
            row = i // cols
            row_heights[row] = max(row_heights[row], height)
        self.set_choice_table_heights(table, row_heights)
        self.para_format(p_anchor, alignment="LEFT", line_spacing_percent=100, indent_left_mm=0, first_line_indent_mm=0,
                         spacing_before_pt=4, spacing_after_pt=2)

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

    @staticmethod
    def extra_before_pt(item: dict) -> float:
        extra = item.get("_extra_before_mm")
        return extra * 72 / 25.4 if isinstance(extra, (int, float)) and extra > 0 else 0.0

    def build_item(self, item: dict, is_first: bool, section_title: str = ""):
        """문항 하나. 문항의 문단들은 '다음 문단과 함께'·'문단 보호'로 묶어 단·쪽 사이에서 잘리지 않게 한다."""
        start = len(self.doc.paragraphs)
        self._build_item(item, is_first, section_title)
        if item.get("split_ok"):
            return  # 원본에서도 다음 단으로 이어진 문항: 원본처럼 단 사이에서 나뉘게 둔다
        made = self.doc.paragraphs[start:]
        for k, p in enumerate(made):
            self.para_format(p, keep_lines=True, **({"keep_with_next": True} if k < len(made) - 1 else {}))

    def _build_item(self, item: dict, is_first: bool, section_title: str):
        t = self.tpl
        size = t["sizes"]["body"]
        no = item["no"]
        label = item.get("label") or f"{no}."
        paragraphs = self.split_paragraphs(item.get("stem", []))
        # 읽은 문제에 이미 총 배점(예: [6점-부분점수])이 있으면 다시 붙이지 않는다.
        # 소문항의 부분 배점은 총 배점과 다를 수 있으므로 삭제하지 않는다.
        points = item.get("points")
        stem_text = "".join(str(part.get("t", "")) for part in item.get("stem", []) if isinstance(part, dict))
        score_present = bool(points is not None and re.search(
            r"[\[(]\s*(?:총\s*)?" + re.escape(str(points)) + r"\s*점(?:\s*[-–−]\s*부분\s*점수)?\s*[\])]", stem_text
        ))
        # 소문항 (1)·(2) 가 있으면 그림은 원본처럼 큰 물음 다음, 소문항 앞에 둔다 (서술형5)
        sub_at = next((k for k, pieces in enumerate(paragraphs)
                       if k > 0 and re.match(r"^\s*(\(\s*1\s*\)|⑴|1\))", "".join(str(x.get("t", "")) for x in pieces if isinstance(x, dict) and "t" in x))), None)
        first = None
        brk = item.get("break_before")
        # 문항 앞의 안내 상자 (쪽 중간의 "서술형 유의사항" 같은 것). 단·쪽 나눔은 상자 앞에서 한다
        for b, box in enumerate(item.get("boxes_before") or []):
            pa = self.doc.add_paragraph("")
            if b == 0:
                self.set_break(pa, brk)
                brk = None
            self.build_box(box, anchor=pa)
        figures = [f for f in [item.get("figure"), *(item.get("extra_figures") or [])] if f]
        # 선택지를 표로 인쇄한 문항(번호 ①~⑤ 가 든 표): 그 표가 곧 선택지라 선택지 자리에 한글 표로 넣는다
        dup = [f for f in figures if self.is_choice_table(f, item)]
        choice_table = None
        if dup:
            figures = [f for f in figures if not any(f is d for d in dup)]
            choice_table = self.native_table_of(dup[0])
        picture_choices = self.picture_choices(item, figures)
        # 문제 글은 왼쪽 정렬 (2026-11-01 사용자 요청). 양쪽 정렬이면 수식이 든 줄·그림 옆 좁은 줄에서 낱말 사이가 크게 벌어졌다
        align = "LEFT"
        right_count = sum(figure.get("place") == "right" and bool(figure.get("png")) for figure in figures)
        widest_word = 0.0
        if right_count and not picture_choices:
            # 오른쪽 그림 옆에는 수식 개체나 한 어절이 온전히 들어갈 폭이 필요하다.
            for pieces in paragraphs:
                for piece in pieces:
                    if not isinstance(piece, dict):
                        piece = {"t": piece}
                    words = [piece] if "m" in piece else [{"t": word} for word in str(piece.get("t") or "").split()]
                    for word in words:
                        widest_word = max(widest_word, self.piece_width_mm([word], size))

        def put_figures():
            if picture_choices:
                return
            for figure in figures:
                # 선·글자 없이 표 하나뿐인 자료는 고칠 수 있는 한글 표로 (안 되면 그림으로)
                spec = self.native_table_of(figure)
                if spec and self.build_native_table(spec, self.figure_width_mm(figure), no):
                    continue
                if figure.get("place") == "right" and figure.get("png"):
                    # 내어쓰기 5.5 mm와 그림 왼쪽 바깥 여백 3 mm를 뺀 폭이다.
                    column_mm = self.column_width() / MM
                    width = self.scaled_figure_width_mm(figure)
                    beside = column_mm - width - 8.5
                    if (right_count > 1 or width > column_mm * t["figure"]["right_max_ratio"]
                            or beside < max(widest_word, column_mm * 0.55)):
                        figure = {**figure, "place": "below"}
                self.build_figure({**item, "figure": figure}, first)

        for k, pieces in enumerate(paragraphs):
            if sub_at is not None and k == sub_at:
                put_figures()
            p = self.doc.add_paragraph("")
            if k == 0:
                first = p
                self.set_break(p, brk)
                p.add_run(f"{label} ", char_pr_id_ref=self.run_style(size=size))
            self.add_pieces(p, pieces, size=size, where=f"{no}번 문제 글")
            # 배점은 문제 글 끝에 (3단계에서 확인받은 자리). 읽은 글에 이미 있으면 다시 붙이지 않는다
            if k == len(paragraphs) - 1 and points and not score_present:
                p.add_run(f" [{points}점]", char_pr_id_ref=self.run_style(size=size))
            if k == 0:
                self.para_format(
                    p, alignment=align, line_spacing_percent=t["line_spacing"]["body"],
                    # 내어쓰기: 첫 줄(문제 번호)은 단 왼쪽 끝에서, 다음 줄부터 5.5mm 들여 시작한다.
                    # 한글은 왼쪽 여백에서 첫 줄을 시작하고 내어쓰기 값만큼 나머지 줄을 민다 (왼쪽 여백 0 이어야 번호가 선택지 번호와 같은 세로줄에 선다)
                    indent_left_mm=0, first_line_indent_mm=-5.5,
                    # 문항 사이: 양식 간격 + 원본처럼 풀이 공간 (balance_columns 가 단의 빈 곳을 나눠 준 만큼)
                    spacing_before_pt=0 if (is_first or item.get("break_before")) else round(t["item_gap_pt"] + self.extra_before_pt(item), 1),
                )
            else:
                # 둘째 문단부터는 번호 다음 글자와 같은 세로줄에서 시작한다
                self.para_format(p, alignment=align, line_spacing_percent=t["line_spacing"]["body"],
                                 indent_left_mm=5.5, first_line_indent_mm=0, spacing_before_pt=2)
        if sub_at is None:
            put_figures()
        if item.get("cond_box"):
            # 예전(GPT 판) 읽기 결과에서 옮긴 조건 상자 (지금 읽기는 조건을 문제 글 문단으로 넣는다)
            self.build_bogi(item["cond_box"], no, title=None)
        if item.get("bogi"):
            self.build_bogi(item["bogi"], no)
        if picture_choices:
            self.build_choice_figures(figures, no, item.get("choices") or [])
        elif choice_table and self.build_native_table(choice_table, self.column_width() / MM - 4, no):
            pass  # 선택지 표 (원본처럼)
        else:
            if dup:
                self.warnings.append(f"{no}번: 선택지를 담은 표를 한글 표로 넣지 못해 선택지 글로 넣었습니다")
            self.build_choices(item.get("choices") or [], no, item.get("choice_layout"))

        # 마지막 문항에도 풀이 자리가 필요하므로 다음 문항의 앞 간격에 의존하지 않는다.
        written = re.search(r"서술형|단답형", f"{section_title} {label}")
        kind = "choice" if not written and (picture_choices or choice_table or item.get("choices")) else "written"
        work_mm = t.get("work_space_mm", {}).get(kind, 0)
        if work_mm > 0:
            if item.get("split_ok"):
                self.para_format(self.doc.paragraphs[-1], keep_with_next=True)
            p = self.doc.add_paragraph("", include_run=False)
            p.add_run("\u00a0", char_pr_id_ref=self.run_style(size=1))
            self.para_format(p, line_spacing_percent=100, indent_left_mm=0, first_line_indent_mm=0,
                             spacing_before_pt=round(work_mm * 72 / 25.4, 1), keep_lines=True)

        # 문항 뒤의 안내 상자 (마지막 쪽의 저작권 안내 같은 것)
        for box in item.get("boxes_after") or []:
            pa = self.doc.add_paragraph("")
            self.para_format(pa, spacing_before_pt=8)
            self.build_box(box, anchor=pa)

    # ------------------------------------------------------------------ 선택지
    def piece_width_mm(self, pieces: list, size: float) -> float:
        """선택지 글·수식 조각이 한 줄로 차지하는 너비(mm, 넉넉하게 어림)."""
        total = 0.0
        for piece in pieces or []:
            if not isinstance(piece, dict):
                piece = {"t": str(piece)}
            if "m" in piece:
                try:
                    script = to_eqedit(str(piece["m"]), upright_uppercase=self.tpl.get("upright_point_names", True))
                    base_unit = int(round(size * 100))
                    total += (measure_equation_sized(script_for_measure(script), base_unit).width + base_unit * .22) / MM
                except Exception:  # noqa: BLE001 - 재지 못하면 길게 본다
                    total += len(str(piece["m"])) * size * 0.25
            else:
                text = re.sub(r"\*\*|__", "", str(piece.get("t") or ""))
                total += estimate_text_width(text, size) / MM if text else 0
        return total

    def choice_columns(self, choices: list, layout: str | None = None) -> int:
        """선택지를 한 줄에 몇 개씩 둘지. 원본 배치(layout: row 한 줄에 모두, grid 여러 줄에 나눠, column 한 줄에 하나)를 따르되
        단 너비에 들어가지 않으면 한 줄에 넣는 개수를 줄인다. 배치를 모르면 한 줄에 하나씩(3단계에서 확인받은 모양)."""
        n = len(choices)
        if n < 2 or layout not in ("row", "grid"):
            return 1
        size = self.tpl["sizes"]["choice"]
        widest = max(self.piece_width_mm(c, size) for c in choices)
        col_mm = self.column_width() / MM
        mark_mm = 6.5  # "①  " 너비와 선택지 사이 여유
        tries = (n, 3, 2) if layout == "row" else (3, 2)
        for cols in tries:
            if 2 <= cols <= n and widest + mark_mm <= col_mm / cols - 3.6:
                return cols
        return 1

    def choice_line_height(self, paragraph, size: float) -> int:
        """한 줄에 든 글자와 수식 개체의 높이, 선택지 줄 간격까지 HWPUNIT으로 계산한다."""
        text_height = int(round(size * 100))
        object_height = max(
            (int(box.get("height", "0")) for box in paragraph.element.iterfind(f".//{_HP}equation/{_HP}sz")),
            default=0,
        )
        leading = text_height * (self.tpl["line_spacing"]["choice"] - 100) / 100
        return math.ceil(max(text_height, object_height) + leading)

    @staticmethod
    def set_choice_table_heights(table, row_heights: list[int]):
        # python-hwpx의 새 표 행은 약 1 mm로 저장된다. 한글처럼 행을 자동으로 늘리지 않는
        # 뷰어에서도 다음 행의 번호·수식·그림이 겹치지 않도록 실제 높이를 적는다.
        margin = table.element.find(f"{_HP}inMargin")
        padding = int(margin.get("top", "0")) + int(margin.get("bottom", "0")) if margin is not None else 0
        heights = [height + padding for height in row_heights]
        for row, height in enumerate(heights):
            for col in range(table.column_count):
                table.cell(row, col).set_size(height=height)
        table.element.find(f"{_HP}sz").set("height", str(sum(heights)))

    def build_choices(self, choices: list, no, layout: str | None = None):
        """선택지: 원본에서 나란히 있던 것은 나란히(한 줄 또는 여러 줄), 아니면 한 줄에 하나씩."""
        t = self.tpl
        size = t["sizes"]["choice"]
        cols = self.choice_columns(choices, layout)
        if cols == 1:
            for i, choice in enumerate(choices):
                cp = self.doc.add_paragraph("")
                mark = CHOICE_MARKS[i] if i < len(CHOICE_MARKS) else f"({i + 1})"
                cp.add_run(f"{mark}  ", char_pr_id_ref=self.run_style(size=size))
                self.add_pieces(cp, choice, size=size, where=f"{no}번 선택지 {i + 1}")
                # 긴 선택지의 둘째 줄은 번호 뒤 글자에 맞춘다 (내어쓰기: 한글은 왼쪽 여백 0 에서 첫 줄을 시작하고 나머지 줄을 이만큼 민다)
                hang = round(estimate_text_width(f"{mark}  ", size) / MM, 1)
                self.para_format(cp, alignment="LEFT", line_spacing_percent=t["line_spacing"]["choice"],
                                 indent_left_mm=0, first_line_indent_mm=-hang, spacing_before_pt=4 if i == 0 else 0)
            return
        # 테두리 없는 표에 나란히 (칸마다 번호와 내용. 한글에서 고칠 수 있는 글자·수식 그대로)
        rows = (len(choices) + cols - 1) // cols
        p_anchor = self.doc.add_paragraph("")
        none = self.border(None, None, None, None)
        table = p_anchor.add_table(rows, cols, width=self.column_width(), border_fill_id_ref=none)
        row_heights = [0] * rows
        for r in range(rows):
            for c in range(cols):
                table.set_cell_border_fill(r, c, none)
        for i, choice in enumerate(choices):
            cp = table.cell(i // cols, i % cols).paragraphs[0]
            mark = CHOICE_MARKS[i] if i < len(CHOICE_MARKS) else f"({i + 1})"
            cp.add_run(f"{mark}  ", char_pr_id_ref=self.run_style(size=size))
            self.add_pieces(cp, choice, size=size, where=f"{no}번 선택지 {i + 1}")
            self.para_format(cp, alignment="LEFT", line_spacing_percent=t["line_spacing"]["choice"],
                             indent_left_mm=0, first_line_indent_mm=0)
            row = i // cols
            row_heights[row] = max(row_heights[row], self.choice_line_height(cp, size))
        self.set_choice_table_heights(table, row_heights)
        self.para_format(p_anchor, alignment="LEFT", line_spacing_percent=100, indent_left_mm=0, first_line_indent_mm=0,
                         spacing_before_pt=4, spacing_after_pt=0)

    @staticmethod
    def native_table_of(fig: dict) -> dict | None:
        """그림으로 읽은 표 가운데 선·글자 없이 표 하나뿐인 것의 표 명령 (한글 표로 넣을 수 있는 것)."""
        g = fig.get("graphic") if isinstance(fig, dict) else None
        if not isinstance(g, dict) or g.get("kind") != "table" or g.get("paths") or g.get("ellipses") or g.get("texts"):
            return None
        tables = g.get("tables") or []
        if len(tables) != 1 or not isinstance(tables[0], dict):
            return None
        t = tables[0]
        try:
            rows, cols = int(t.get("rows", 0)), int(t.get("cols", 0))
        except (TypeError, ValueError):
            return None
        if not (1 <= rows <= 30 and 1 <= cols <= 12):
            return None
        for cell in t.get("cells") or []:
            try:
                r, c, rs, cs = int(cell["row"]), int(cell["col"]), int(cell.get("row_span", 1)), int(cell.get("col_span", 1))
            except (KeyError, TypeError, ValueError):
                return None
            if r < 0 or c < 0 or rs < 1 or cs < 1 or r + rs > rows or c + cs > cols:
                return None
        return t

    def build_native_table(self, spec: dict, width_mm: float, no) -> bool:
        """표 명령을 고칠 수 있는 한글 표로 넣는다 (가는 테두리, 칸 글은 가운데). 넣지 못하면 False (그 문단은 비워 둔다)."""
        t = self.tpl
        size = t["sizes"]["choice"]
        thin = t["border"]["thin"]
        rows, cols = int(spec["rows"]), int(spec["cols"])
        width_mm = max(20.0, min(float(width_mm), self.column_width() / MM - 1))
        p_anchor = self.doc.add_paragraph("")
        before = list(p_anchor.element)
        try:
            table = p_anchor.add_table(rows, cols, width=mm(width_mm), border_fill_id_ref=self.border(thin, thin, thin, thin))
            weights = [float(w) for w in spec.get("col_widths") or []]
            if len(weights) == cols and all(w > 0 for w in weights):
                total = sum(weights)
                table.set_column_widths([w * 100 / total for w in weights])
            merges = []
            for cell in spec.get("cells") or []:
                r, c = int(cell["row"]), int(cell["col"])
                rs, cs = int(cell.get("row_span", 1)), int(cell.get("col_span", 1))
                text = str(cell.get("text") or "")
                if text:
                    lines = text.split("\n")
                    first_p = table.cell(r, c).paragraphs[0]
                    for k, line in enumerate(lines):
                        cp = first_p if k == 0 else table.cell(r, c).add_paragraph("")
                        self.add_rich_text(cp, line, size=size)
                        self.para_format(cp, alignment="CENTER", line_spacing_percent=130, indent_left_mm=0, first_line_indent_mm=0)
                if rs > 1 or cs > 1:
                    merges.append((r, c, r + rs - 1, c + cs - 1))
            for r in range(rows):
                for c in range(cols):
                    p = table.cell(r, c).paragraphs[0]
                    self.para_format(p, alignment="CENTER", line_spacing_percent=130, indent_left_mm=0, first_line_indent_mm=0)
            # 아래·오른쪽 것부터 합쳐 앞 칸의 자리가 바뀌지 않게 한다
            for r0, c0, r1, c1 in sorted(merges, reverse=True):
                table.merge_cells(r0, c0, r1, c1)
        except Exception as exc:  # noqa: BLE001 - 표로 못 넣으면 그림으로
            for child in list(p_anchor.element):
                if not any(child is old for old in before):
                    p_anchor.element.remove(child)
            self.warnings.append(f"{no}번 표를 한글 표로 넣지 못해 그림으로 넣었습니다 - {exc}")
            return False
        self.para_format(p_anchor, alignment="CENTER", line_spacing_percent=100, indent_left_mm=0, first_line_indent_mm=0,
                         spacing_before_pt=4, spacing_after_pt=4)
        return True

    @staticmethod
    def is_choice_table(fig: dict, item: dict) -> bool:
        """그림으로 읽은 표가 사실은 선택지 표인지 (칸에 ①②③… 번호가 들어 있고 선택지 글도 따로 있음)."""
        graphic = fig.get("graphic") if isinstance(fig, dict) else None
        if not isinstance(graphic, dict) or not graphic.get("tables"):
            return False
        if not any(any((isinstance(p, dict) and (p.get("t") or p.get("m"))) for p in (c or [])) for c in item.get("choices") or []):
            return False
        cells = " ".join(str(cell.get("text", "")) for table in graphic["tables"] for cell in table.get("cells", []) if isinstance(cell, dict))
        return sum(mark in cells for mark in CHOICE_MARKS[:5]) >= 3

    def build_bogi(self, lines: list, no, title: str | None = "<보기>"):
        """<보기> 상자: 문제 글과 같은 들여쓰기로, 가는 테두리 안에 항목(ㄱ, ㄴ, ㄷ …)을 한 줄씩.
        title 이 None 이면 제목 없는 조건 상자 ((가), (나) … 를 인쇄된 줄 그대로)."""
        t = self.tpl
        size = t["sizes"]["body"]
        indent = 5.5
        p_anchor = self.doc.add_paragraph("")
        thin = t["border"]["thin"]
        table = p_anchor.add_table(1, 1, width=self.column_width() - mm(indent), border_fill_id_ref=self.border(thin, thin, thin, thin))
        cell = table.cell(0, 0)
        if title:
            head = cell.paragraphs[0]
            head.add_run(title, char_pr_id_ref=self.run_style(size=size, font=t["fonts"]["heading"]))
            self.para_format(head, alignment="CENTER", line_spacing_percent=t["line_spacing"]["box"])
        for i, line in enumerate(lines):
            lp = cell.add_paragraph("") if (title or i > 0) else cell.paragraphs[0]
            self.add_pieces(lp, line, size=size, where=f"{no}번 보기 {i + 1}")
            first_text = next((piece.get("t", "") for piece in line if isinstance(piece, dict) and "t" in piece), "")
            # "ㄱ. " 처럼 기호로 시작하는 항목은 다음 줄을 기호 뒤 글자에 맞춘다
            hanging = bool(re.match(r"^\s*[ㄱ-ㅎ가-하①-⑳a-z0-9]\s*[.)]\s", first_text))
            # 제목 없는 조건 상자는 인쇄된 줄 그대로 들어온다: (가)·(1) 로 시작하지 않는 줄은 앞 항목의 이어지는 줄이라 기호 뒤에 맞춘다
            continued = (not title and i > 0 and not first_text.strip().startswith(("(", "[", "※", "-", "*"))
                         and not re.match(r"^\s*[ㄱ-ㅎ①-⑳]", first_text))
            self.para_format(lp, alignment="LEFT", line_spacing_percent=t["line_spacing"]["body"],
                             indent_left_mm=6 if continued else 0, first_line_indent_mm=-4.5 if hanging else 0)
        self.para_format(p_anchor, line_spacing_percent=100, indent_left_mm=indent, first_line_indent_mm=0,
                         spacing_before_pt=4, spacing_after_pt=4)

    def build_footer(self):
        """꼬리말: 위쪽 선, ( 쪽 / 전체 쪽 ), 오른쪽 학년·학교, 맨 아래 안내 문구."""
        t, f = self.tpl, self.exam.get("footer", {})
        footer = self.doc.page.set_footer(text="")
        anchor = footer.paragraphs[0]
        notice = str(f.get("notice") or "").strip()
        if notice and len(notice) <= 40 and not f.get("right_top") and not re.search(r"저작권|복제|무단|전재", notice):
            # 왼쪽 시험 이름 · 가운데 쪽 번호 · 오른쪽 학교 이름이 한 줄인 꼬리말 (대자중 등)
            return self.build_line_footer(footer, anchor, notice, str(f.get("right_bottom") or ""))
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

    def build_line_footer(self, footer, anchor, left: str, right: str):
        """한 줄 꼬리말: 위쪽 선 아래에 왼쪽 글, 가운데 '쪽/전체 쪽', 오른쪽 글."""
        t = self.tpl
        table = anchor.add_table(1, 3, width=self.text_width(), border_fill_id_ref=self.border(None, None, None, None))
        table.set_column_widths([40, 20, 40])
        top_line = self.border(None, None, "0.4 mm", None)
        for c in range(3):
            table.set_cell_border_fill(0, c, top_line)
        size = t["sizes"]["footer_right"]
        heading = t["fonts"]["heading"]
        lp = table.cell(0, 0).paragraphs[0]
        self.add_rich_text(lp, left, size=size, font=heading, bold=True)
        self.para_format(lp, alignment="LEFT", line_spacing_percent=130)
        cid = self.run_style(size=size, font=heading)
        pp = table.cell(0, 1).paragraphs[0]
        footer.add_page_number_field(paragraph=pp.element, format="page")
        pp.add_run("/", char_pr_id_ref=cid)
        footer._add_total_page_counter(pp.element, "DIGIT")
        for run in pp.element.findall(f"{_HP}run"):
            run.set("charPrIDRef", str(cid))
        self.para_format(pp, alignment="CENTER", line_spacing_percent=130)
        rp = table.cell(0, 2).paragraphs[0]
        self.add_rich_text(rp, right, size=size, font=heading, bold=True)
        self.para_format(rp, alignment="RIGHT", line_spacing_percent=130)
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
        for si, section in enumerate(self.exam.get("sections", [])):
            if section.get("title"):
                self.build_section_title(section["title"], section.get("break_before"))
            for j, item in enumerate(section.get("items", [])):
                start = len(self.doc.paragraphs)
                self.build_item(item, is_first=(j == 0), section_title=section.get("title") or "")
                self.item_spans.append((si, j, start, len(self.doc.paragraphs)))
        note = self.exam.get("page_end_note")
        if note:
            p = self.doc.add_paragraph("")
            p.add_run(note, char_pr_id_ref=self.run_style(size=self.tpl["sizes"]["body"], font=self.tpl["fonts"]["heading"]))
            self.para_format(p, alignment="RIGHT", spacing_before_pt=60)
        self.build_footer()
        report = self.doc.validate()
        if not getattr(report, "ok", True):
            self.warnings.append(f"검사 결과: {str(report)[:300]}")
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


def page_estimate(data: bytes):
    """한글이 이 파일을 어떻게 짤지 python-hwpx 의 쪽 어림 (문단마다 줄의 쪽·단·세로 자리). 못 재면 None.
    어림기가 다루지 못하는 '글 옆에 띄운 그림'은 빼고 잰다 (그 문항은 실제보다 조금 짧게 잡힌다)."""
    try:
        from hwpx.layout.pages import estimate_pages

        zin = zipfile.ZipFile(io.BytesIO(data))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zout:
            for info in zin.infolist():
                raw = zin.read(info.filename)
                if info.filename.startswith("Contents/section") and info.filename.endswith(".xml"):
                    text = raw.decode("utf-8")
                    text = re.sub(r'<hp:pic\b(?:(?!</hp:pic>).)*?treatAsChar="0"(?:(?!</hp:pic>).)*?</hp:pic>', "", text, flags=re.S)
                    raw = text.encode("utf-8")
                zout.writestr(info, raw)
        est = estimate_pages(buf.getvalue())
        return None if est.unsupported else est
    except Exception:  # noqa: BLE001 - 어림을 못 하면 맞추지 않고 그대로 만든다
        return None


def estimated_pages(data: bytes) -> int | None:
    """한글이 이 파일을 몇 쪽으로 짤지 (못 재면 None)."""
    est = page_estimate(data)
    return est.pages if est else None


def _item_columns(builder: "ExamBuilder", est) -> list[dict]:
    """문항마다 시작하는 쪽·단과 그 단에서 끝나는 세로 자리(HWPUNIT). 글 옆에 띄운 그림은 그 높이까지 친다."""
    out = []
    lines = est.lines
    for si, j, start, end in builder.item_spans:
        ls = [ln for k in range(start, min(end, len(lines))) for ln in lines[k]]
        if not ls:
            continue
        key = (ls[0].page, ls[0].column)
        bottom = max(ln.vertpos for ln in ls if (ln.page, ln.column) == key)
        item = builder.exam["sections"][si]["items"][j]
        for fig in [item.get("figure"), *(item.get("extra_figures") or [])]:
            if isinstance(fig, dict) and fig.get("place") == "right":
                w = builder.figure_width_mm(fig)
                size = fig.get("png_size") or fig.get("size_mm")
                if isinstance(size, (list, tuple)) and len(size) == 2 and size[0]:
                    bottom = max(bottom, ls[0].vertpos + mm(w * size[1] / size[0]))
        out.append({"si": si, "j": j, "col": key, "bottom": bottom, "split": any((ln.page, ln.column) != key for ln in ls)})
    return out


def balance_columns(exam: dict, tpl: dict, builder: "ExamBuilder", data: bytes):
    """원본 자리에서 단·쪽을 나눴는데 우리 글이 원본보다 짧아 단 아래가 크게 비면, 그 빈 곳을 그 단 문항들 아래에 고르게 나눠 준다
    (원본 시험지처럼 문항마다 풀이 공간). 2026-11-02 숭의중: 원본은 한 단에 두 문항씩 풀이 공간을 두고 실었는데
    우리는 문항을 붙여 실어 단마다 아래가 반쯤 비었다. 다시 만든 뒤 쪽 수와 문항 자리가 그대로일 때만 쓴다 (아니면 None).
    돌려주는 것: (한글 파일, 다시 만든 builder)"""
    est = page_estimate(data)
    if not est:
        return None
    t = tpl
    m = t["margins_mm"]
    body = mm(t["paper"]["height_mm"] - m["top"] - m["bottom"] - m.get("header", 0) - m.get("footer", 0))
    line = mm(t["sizes"]["body"] * t["line_spacing"]["body"] / 100 * 25.4 / 72)
    items = _item_columns(builder, est)
    groups: dict[tuple, list] = {}
    for it in items:
        groups.setdefault(it["col"], []).append(it)
    order = sorted(groups)
    sections = exam.get("sections", [])

    def forced(it) -> bool:
        section = sections[it["si"]]
        item = section["items"][it["j"]]
        brk = item.get("break_before") or (section.get("break_before") if it["j"] == 0 else None)
        return brk in ("column", "page")

    # 단의 빈 곳을 문항 수만큼 나눠, 둘째 문항부터 그 앞에 한 몫씩 넣는다 (마지막 문항 아래 한 몫은 단 아래에 그대로 남는다).
    # 문항 '아래' 간격으로 넣으면 단 나눔 너머 다음 단 맨 위로 넘어가 문항을 밀었다
    extra: dict[tuple[int, int], float] = {}
    for k, key in enumerate(order[:-1]):
        group = groups[key]
        nxt = groups[order[k + 1]][0]
        if len(group) < 2 or not forced(nxt) or any(g["split"] for g in group):
            continue  # 문항 하나뿐인 단, 원본 나눔이 아니라 차서 넘어간 단, 단 사이에 걸친 문항
        free = body - max(g["bottom"] for g in group) - line
        if free < mm(20):
            continue
        share = min(free * 0.9 / len(group) / MM, 100.0)
        for g in group[1:]:
            item = sections[g["si"]]["items"][g["j"]]
            if item.get("break_before") or (g["j"] == 0):
                continue  # 단·쪽 나눔이 있는 문항과 부분의 첫 문항(제목 상자 아래)은 앞 간격을 두지 않는다
            extra[(g["si"], g["j"])] = round(share, 1)
    if not extra:
        return None
    spaced = copy.deepcopy(exam)
    for (si, j), value in extra.items():
        spaced["sections"][si]["items"][j]["_extra_before_mm"] = value
    again = ExamBuilder(spaced, tpl)
    data2 = again.build()
    est2 = page_estimate(data2)
    if not est2 or est2.pages != est.pages:
        return None
    before = {(it["si"], it["j"]): it["col"] for it in items}
    after = {(it["si"], it["j"]): it["col"] for it in _item_columns(again, est2)}
    if before != after:
        return None
    return data2, again


def _without_breaks(exam: dict, kinds: set[str]) -> dict:
    copy_ = copy.deepcopy(exam)
    for section in copy_.get("sections", []):
        if section.get("break_before") in kinds:
            section.pop("break_before", None)
        for item in section.get("items", []):
            if item.get("break_before") in kinds:
                item.pop("break_before", None)
    return copy_


def build_exam(exam: dict, template: dict | None = None) -> tuple[bytes, list[str]]:
    """글자와 풀이 공간을 확보한 뒤, 들어갈 수 있는 범위에서 원본의 단·쪽 나눔을 따른다."""
    tpl = template or with_paper(get_template(exam.get("template")), exam.get("paper"))
    target = len(exam.get("source_pages") or [])
    has_breaks = any(s.get("break_before") or any(i.get("break_before") for i in s.get("items", []))
                     for s in exam.get("sections", []))
    builder = ExamBuilder(exam, tpl)
    data = builder.build()
    if not has_breaks:
        return data, builder.warnings

    pages = estimated_pages(data) if target else None
    if pages is not None and pages > target:
        # 원본 쪽 나눔은 유지하고 단 나눔부터 풀어 본다. 여전히 넘치면 문항을 두 단에 이어 넣는다.
        relaxed = ExamBuilder(_without_breaks(exam, {"column"}), tpl)
        relaxed_data = relaxed.build()
        relaxed_pages = estimated_pages(relaxed_data)
        if relaxed_pages is not None and relaxed_pages <= target:
            relaxed.warnings.append("풀이 공간을 확보하기 위해 일부 문항을 다음 단으로 옮겼습니다.")
            return relaxed_data, relaxed.warnings

        flowing = ExamBuilder(_without_breaks(exam, {"column", "page"}), tpl)
        data = flowing.build()
        flowing.warnings.append("글자 크기와 풀이 공간을 확보하기 위해 문항을 다음 단과 쪽으로 이어 배치했습니다.")
        return data, flowing.warnings

    # 원본 나눔을 유지했을 때 단 아래에 남는 공간은 문항 사이에도 나눠 준다.
    spaced = balance_columns(exam, tpl, builder, data)
    if spaced:
        return spaced[0], spaced[1].warnings
    return data, builder.warnings

