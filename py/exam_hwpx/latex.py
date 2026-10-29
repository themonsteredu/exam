"""LaTeX → 한글 수식(EqEdit) 변환.

python-hwpx 의 latex_to_eqedit 앞뒤로 손질을 더한다.

- 점 이름처럼 대문자로 된 글자(A, AB, ABC)는 정자체로 쓴다 (교과서·시험지 관례: 점 이름은 정자, 변수 x 는 기울임).
  점 이름이 아닌 대문자(집합 A, 확률 P, 합 S_n 등)는 \\mathit{A} 나 \\textit{A} 로 감싸면 기울임으로 남는다.
- 라이브러리가 모르는 명령(호 AB, ∥, ⊥, □, 원 문자, 띄어쓰기 등)을 바꿔 준다. 이런 기호는 정자로 넣고, 관계 기호는 양옆을 띄운다.
- \\text{...} 안의 글은 띄어쓰기를 바꾸지 않고 넣는다 (\\% 같은 이스케이프만 글자로 푼다).

바꾸지 못하면 EquationError 를 낸다. 그때는 latex_to_plain() 으로 읽을 수 있는 글자로 넣는다.
"""

from __future__ import annotations

import re
import unicodedata

from hwpx.equation.authoring import latex_to_eqedit
from hwpx.equation.tokens import (
    ACCENTS,
    BIG_OPERATORS,
    DELIMITERS,
    FUNCTIONS,
    GREEK,
    MATRIX_ENVIRONMENTS,
    OPERATORS,
    STRUCTURAL,
)


class EquationError(ValueError):
    pass


# 글자 그대로 넣을 명령 (인수를 그대로 둔다)
_TEXT_COMMANDS = ("text", "mathrm", "textrm", "mbox", "operatorname", "textnormal")

# 대문자도 기울임으로 둘 명령 (점 이름이 아닌 대문자: 집합 A, 확률 P 등)
_ITALIC_COMMANDS = ("mathit", "textit", "mathnormal")

# 인수 없이 쓰는 기호 중 라이브러리가 모르는 것 → 정자로 넣을 글자
_SYMBOLS = {
    "square": "□",
    "Box": "□",
    "blacksquare": "■",
    "#": "#",
    "bigcirc": "○",
    # 시험지의 삼각형 기호는 정자체의 속이 빈 △로 표시한다.
    "triangle": "△",
    "triangleright": "▷",
    "star": "☆",
    "bigstar": "★",
    "|": "‖",
    "Vert": "‖",
    "lVert": "‖",
    "rVert": "‖",
}

# 관계 기호 중 라이브러리가 모르는 것 → 정자로, 양옆을 띄워 넣을 글자
_RELATIONS = {
    "parallel": "∥",
    "nparallel": "∦",
    "perp": "⊥",
    "bot": "⊥",
    "Leftrightarrow": "⇔",
    "Longleftrightarrow": "⇔",
    "iff": "⇔",
    "Leftarrow": "⇐",
    "fallingdotseq": "≒",
    "doteq": "≒",
    "backsim": "∽",
    "nsubset": "⊄",
    "nsubseteq": "⊈",
    "nsupset": "⊅",
    "nsupseteq": "⊉",
    "nequiv": "≢",
}

# \not 다음 기호 → 부정 기호
_NOT = {
    "in": r"\notin",
    "=": r"\neq",
    "subset": r"\nsubset",
    "subseteq": r"\nsubseteq",
    "supset": r"\nsupset",
    "supseteq": r"\nsupseteq",
    "parallel": r"\nparallel",
    "equiv": r"\nequiv",
}

# 다른 LaTeX 명령(또는 글자)으로 바꾸면 되는 것
_ALIASES = {
    "varnothing": r"\emptyset",
    "measuredangle": r"\angle",
    "degree": r"^{\circ}",
    "le": r"\leq",
    "ge": r"\geq",
    "leqq": r"\leq",
    "geqq": r"\geq",
    "leqslant": r"\leq",
    "geqslant": r"\geq",
    "ne": r"\neq",
    "gets": r"\leftarrow",
    "lt": "<",
    "gt": ">",
    "vert": "|",
    "lvert": "|",
    "rvert": "|",
    "setminus": "-",
    "colon": ":",
    "implies": r"\Rightarrow",
    "Longrightarrow": r"\Rightarrow",
    "longrightarrow": r"\rightarrow",
    "longleftarrow": r"\leftarrow",
    "longleftrightarrow": r"\leftrightarrow",
}

# 띄어쓰기
_SPACES = {" ": r"\,\,", ";": r"\,\,", ":": r"\,\,", ">": r"\,\,", "quad": r"\,\,\,\,", "qquad": r"\,\,\,\,\,\,\,\,", "!": ""}

# 지워도 되는 명령
_DROP = {"displaystyle", "textstyle", "scriptstyle", "limits", "nolimits", "rm", "it", "bf", "left.", "right.", "middle"}

# 라이브러리가 모르는 환경 → 행렬로 (array 의 열 맞춤 {l}, {cc} 는 버린다)
_ENVIRONMENTS = {"array": "matrix", "aligned": "matrix", "gathered": "matrix", "align": "matrix", "align*": "matrix"}

# \overset{위}{AB} 의 위 기호 → 장식
_ARC_TOPS = (r"\frown", r"\smile", "⌒")
_OVERSET_ACCENTS = {
    r"\rightarrow": r"\overrightarrow",  # 반직선 AB
    r"\to": r"\overrightarrow",
    r"\longrightarrow": r"\overrightarrow",
    "→": r"\overrightarrow",
    r"\leftrightarrow": r"\overleftrightarrow",  # 직선 AB
    r"\longleftrightarrow": r"\overleftrightarrow",
    "↔": r"\overleftrightarrow",
    "-": r"\overline",  # 선분 AB
    "−": r"\overline",
    r"\overline": r"\overline",
    r"\bar": r"\overline",
}

_CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
_CIRCLED_HANGUL = dict(zip("ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ", "㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭"))
_CIRCLED_HANGUL_SYLLABLE = dict(zip("가나다라마바사아자차카타파하", "㉮㉯㉰㉱㉲㉳㉴㉵㉶㉷㉸㉹㉺㉻"))
_CIRCLED_LOWER = {chr(ord("a") + i): chr(0x24D0 + i) for i in range(26)}
_CIRCLED_CHARS = frozenset(
    _CIRCLED_DIGITS + "".join(_CIRCLED_HANGUL.values()) + "".join(_CIRCLED_HANGUL_SYLLABLE.values())
    + "".join(_CIRCLED_LOWER.values())
)

# 사진에서 그대로 옮긴 유니코드 수학 기호 → LaTeX (라이브러리는 이런 글자를 받지 않는다)
_UNICODE = {
    "−": "-", "–": "-", "×": r"\times", "÷": r"\div", "·": r"\cdot", "∙": r"\cdot", "±": r"\pm", "∓": r"\mp",
    "≤": r"\leq", "≦": r"\leq", "≥": r"\geq", "≧": r"\geq", "≠": r"\neq", "≒": r"\fallingdotseq", "≈": r"\approx",
    "≡": r"\equiv", "∽": r"\backsim", "∼": r"\sim", "∥": r"\parallel", "⊥": r"\perp", "∠": r"\angle", "△": r"\triangle",
    "°": r"^{\circ}", "²": "^{2}", "³": "^{3}", "∞": r"\infty", "∴": r"\therefore", "∵": r"\because",
    "□": r"\square", "■": r"\blacksquare", "○": r"\bigcirc", "∈": r"\in", "∉": r"\notin", "⊂": r"\subset",
    "⊃": r"\supset", "⊆": r"\subseteq", "⊇": r"\supseteq", "⊄": r"\nsubset", "⊈": r"\nsubseteq", "∪": r"\cup",
    "∩": r"\cap", "∅": r"\emptyset", "→": r"\rightarrow", "←": r"\leftarrow", "↔": r"\leftrightarrow",
    "⇒": r"\Rightarrow", "⇔": r"\Leftrightarrow", "…": r"\cdots", "⋯": r"\cdots", "′": "'",
}

# 한글 수식 명령어 (대소문자 가리지 않음). 기울임으로 둘 글자 묶음이 이 낱말과 같으면 따옴표로 묶어 글자로 남긴다.
# python-hwpx 가 아는 낱말에, 한글이 기호로 그리는 낱말(DEG, INF, LINE, BOX 등, python-hwpx measure.py 참고)을 더했다.
_HANCOM_WORDS = frozenset(
    word.lower()
    for words in (GREEK, OPERATORS, FUNCTIONS, BIG_OPERATORS, ACCENTS, MATRIX_ENVIRONMENTS, STRUCTURAL)
    for word in words
) | frozenset({
    "rm", "it", "bold", "deg", "line", "vert", "box", "arch", "not", "under", "union", "inter", "perp", "parallel",
    "ni", "nsubset", "nsupset", "smallinter", "smallunion", "divide", "rarrow", "larrow", "lrarrow", "uparrow",
    "downarrow", "udarrow", "vee", "wedge", "lsub", "rsub", "hbar", "aleph", "dagger", "ddagger", "diamond",
    "centigrade", "fahrenheit", "angstrom", "ohm", "pile", "lpile", "rpile", "lbrace", "rbrace", "langle", "rangle",
    "lfloor", "rfloor", "lceil", "rceil", "bigg", "rel", "buildrel", "color", "scale", "ladder", "sladder",
    "longdiv", "eqalign", "exist", "identical", "imath", "jmath", "xor", "lnot", "prec", "succ", "asymp", "iso",
    "odot", "ominus", "odiv", "oslash", "sqcap", "sqcup", "uplus", "lll", "ggg", "and", "or",
})


def _circled(text: str) -> str | None:
    t = text.strip()
    if t.isdigit() and 1 <= int(t) <= 20:
        return _CIRCLED_DIGITS[int(t) - 1]
    return _CIRCLED_HANGUL.get(t) or _CIRCLED_HANGUL_SYLLABLE.get(t) or _CIRCLED_LOWER.get(t)


def _skip_spaces(s: str, i: int) -> int:
    while i < len(s) and s[i].isspace():
        i += 1
    return i


def _read_group(s: str, i: int) -> tuple[str, int]:
    """s[i] 에서 시작하는 인수 하나({...}, 명령 하나 또는 글자 하나)를 읽는다. (내용, 다음 위치)"""
    i = _skip_spaces(s, i)
    if i >= len(s):
        raise EquationError("인수가 빠졌습니다")
    if s[i] == "{":
        depth = 0
        j = i
        while j < len(s):
            if s[j] == "\\":  # \{ \} \\ 는 묶음 괄호가 아니다
                j += 2
                continue
            if s[j] == "{":
                depth += 1
            elif s[j] == "}":
                depth -= 1
                if depth == 0:
                    return s[i + 1 : j], j + 1
            j += 1
        raise EquationError("괄호 { } 짝이 맞지 않습니다")
    if s[i] == "\\":
        m = re.match(r"\\([A-Za-z]+|.)", s[i:], re.S)
        if not m:
            raise EquationError("명령이 끝나지 않았습니다")
        return m.group(0), i + len(m.group(0))
    return s[i], i + 1


def _read_bracket(s: str, i: int) -> tuple[str, int]:
    """s[i] == '[' 인 선택 인수 [...] 를 읽는다. (내용, 다음 위치)"""
    depth = 0
    j = i + 1
    while j < len(s):
        if s[j] == "\\":
            j += 2
            continue
        if s[j] == "{":
            depth += 1
        elif s[j] == "}":
            depth -= 1
        elif s[j] == "]" and depth == 0:
            return s[i + 1 : j], j + 1
        j += 1
    raise EquationError("괄호 [ ] 짝이 맞지 않습니다")


def _is_blank(s: str) -> bool:
    """띄어쓰기와 \\phantom{...} 만 있으면 빈칸이다 (\\boxed{\\quad}, \\boxed{\\phantom{0}})."""
    i = 0
    while i < len(s):
        if s[i].isspace() or s[i] == "~":
            i += 1
            continue
        m = re.match(r"\\([A-Za-z]+|.)", s[i:], re.S)
        if not m:
            return False
        name = m.group(1)
        i += len(m.group(0))
        if name in ("phantom", "hphantom", "vphantom"):
            try:
                _, i = _read_group(s, i)
            except EquationError:
                return False
        elif name not in _SPACES and name != ",":
            return False
    return True


# \text{...} 안의 이스케이프 → 글자
_TEXT_ESCAPES = {"%": "%", "&": "&", "#": "#", "$": "$", "_": "_", "{": "{", "}": "}"}
_TEXT_SPACES = {" ", ",", ";", ":", ">", "quad", "qquad", "enspace", "thinspace"}


def _text_arg(arg: str, command: str = "text") -> str:
    """\\text{...} 안의 글. \\% 같은 이스케이프는 글자로 풀고, 그 밖의 명령이나 $ 가 있으면 EquationError."""
    out: list[str] = []
    i = 0
    while i < len(arg):
        ch = arg[i]
        if ch == "\\":
            m = re.match(r"\\([A-Za-z]+|.)", arg[i:], re.S)
            name = m.group(1) if m else ""
            if name in _TEXT_ESCAPES:
                out.append(_TEXT_ESCAPES[name])
            elif name in _TEXT_SPACES:
                out.append(" ")
            else:
                raise EquationError(f"\\{command}{{...}} 안의 명령은 넣지 못합니다: \\{name}")
            i += len(m.group(0)) if m else 1
            continue
        if ch == "$":
            raise EquationError(f"\\{command}{{...}} 안의 $ 수식은 넣지 못합니다")
        if ch == "~":
            out.append(" ")
        elif ch not in "{}":  # 묶음 괄호는 글자가 아니다
            out.append(ch)
        i += 1
    return "".join(out)


class _Converter:
    def __init__(self, upright_uppercase: bool):
        self.upright = upright_uppercase
        self.slots: dict[str, str] = {}

    # 라이브러리를 거치지 않을 조각은 글자만으로 된 자리표시로 바꿔 두었다가 나중에 되돌린다
    def _slot(self, eqedit: str) -> str:
        key = "QZ" + "".join(chr(ord("a") + int(d)) for d in str(len(self.slots))) + "Z"
        self.slots[key] = eqedit
        return r"\mathrm{" + key + "}"

    @staticmethod
    def _quote(text: str) -> str:
        return '"' + text.replace('"', "'") + '"'

    # 라이브러리가 모르는 기호: 따옴표만 두르면 한글이 기울여 그리므로 \text 처럼 정자(rm)로 넣는다
    def _symbol(self, glyph: str) -> str:
        return self._slot("{rm " + self._quote(glyph) + " it}")

    # 관계 기호는 양옆을 보통 띄어쓰기(~)만큼 띄운다 (python-hwpx 가 \mid 를 ~|~ 로 쓰는 것과 같은 방식)
    def _relation(self, glyph: str) -> str:
        return self._slot("~{rm " + self._quote(glyph) + " it}~")

    def _letters(self, word: str) -> str:
        """영문 글자 묶음."""
        if self.upright:  # 대문자 묶음(점 이름)은 정자
            return re.sub(r"[A-Z]+", lambda m: r"\mathrm{" + m.group(0) + "}", word)
        # 기울임으로 둘 글자가 한글 수식 명령어(DEG, INF, LINE 등)와 같으면 따옴표로 묶어 글자로 남긴다
        return self._slot(self._quote(word)) if word.lower() in _HANCOM_WORDS else word

    def _italic(self, s: str) -> str:
        """\\mathit{...} 안: 대문자도 기울임으로 둔다."""
        upright, self.upright = self.upright, False
        try:
            return self.prepare(s)
        finally:
            self.upright = upright

    def prepare(self, s: str) -> str:
        """라이브러리가 읽을 수 있는 LaTeX 로 손질한다."""
        s = re.sub(r"\{\\rm\s*([^{}]*)\}", r"\\mathrm{\1}", s)  # {\rm AB}
        s = re.sub(r"\{\\it(?![A-Za-z])\s*([^{}]*)\}", r"\\mathit{\1}", s)  # {\it A}
        out: list[str] = []
        i = 0
        while i < len(s):
            ch = s[i]
            if ch == "\\":
                m = re.match(r"\\([A-Za-z]+|.)", s[i:], re.S)
                if not m:
                    out.append(ch)
                    i += 1
                    continue
                name = m.group(1)
                j = i + len(m.group(0))
                if name in _TEXT_COMMANDS:
                    arg, j = _read_group(s, j)
                    if name == "operatorname":
                        out.append(self._slot(f'{{rm {arg.strip()} it}}'))
                    else:
                        out.append(self._slot("{rm " + self._quote(_text_arg(arg, name)) + " it}"))
                elif name == "mathbb":
                    arg, j = _read_group(s, j)
                    out.append(self._slot("{rm " + self._quote(_text_arg(arg, name)) + " it}"))
                elif name in _ITALIC_COMMANDS:
                    arg, j = _read_group(s, j)
                    out.append("{" + self._italic(arg) + "}")
                elif name in ("frac", "dfrac", "tfrac", "binom"):
                    # 괄호 없이 쓴 인수(\frac12)도 LaTeX 처럼 한 글자씩 읽는다. 라이브러리는 12 를 한 덩어리로 읽는다
                    a, j = _read_group(s, j)
                    b, j = _read_group(s, j)
                    command = r"\binom" if name == "binom" else r"\frac"
                    out.append(command + "{" + self.prepare(a) + "}{" + self.prepare(b) + "}")
                elif name == "sqrt":
                    k = _skip_spaces(s, j)
                    index = None
                    if k < len(s) and s[k] == "[":
                        index, j = _read_bracket(s, k)
                    arg, j = _read_group(s, j)
                    root_index = "" if index is None else "[" + self.prepare(index) + "]"
                    out.append(r"\sqrt" + root_index + "{" + self.prepare(arg) + "}")
                elif name in ("overset", "stackrel"):
                    top, j = _read_group(s, j)
                    base, j = _read_group(s, j)
                    if top.strip() in _ARC_TOPS:
                        out.append(self._slot("arch {" + self.convert_inner(base) + "}"))
                    elif top.strip() in _OVERSET_ACCENTS:  # 화살표·막대는 위에 얹는 장식으로 (반직선, 직선, 선분)
                        out.append(_OVERSET_ACCENTS[top.strip()] + "{" + self.prepare(base) + "}")
                    else:
                        out.append(self._slot("{" + self.convert_inner(base) + "} ^{" + self.convert_inner(top) + "}"))
                elif name in ("overparen", "wideparen", "overarc", "arc", "widehat"):
                    arg, j = _read_group(s, j)
                    out.append(self._slot("arch {" + self.convert_inner(arg) + "}"))
                elif name in ("textcircled", "circled"):
                    arg, j = _read_group(s, j)
                    c = _circled(arg)
                    out.append(self._symbol(c) if c else self._slot("(" + self.convert_inner(arg) + ")"))
                elif name in ("boxed", "fbox", "framebox"):
                    arg, j = _read_group(s, j)
                    # 상자 안 내용만 넣는다 (빈 상자는 □. 띄어쓰기나 \phantom 만 있어도 빈 상자)
                    out.append(self._symbol("□") if _is_blank(arg) else self._slot("{" + self.convert_inner(arg) + "}"))
                elif name in ("phantom", "hphantom"):
                    # 보이지 않는 글자 자리: 글자 수만큼 띄운다 (빈칸 밑줄 \underline{\phantom{00}})
                    arg, j = _read_group(s, j)
                    width = len(re.sub(r"\s", "", latex_to_plain(arg)))
                    out.append(" ~" * max(2, 2 * width) + " ")
                elif name == "vphantom":
                    _, j = _read_group(s, j)
                    out.append(" ")
                elif name in ("begin", "end"):
                    # 환경 이름은 그대로 둔다. 라이브러리가 모르는 array, aligned 는 행렬로
                    env, j = _read_group(s, j)
                    env = env.strip()
                    if name == "begin" and env == "array":
                        k = _skip_spaces(s, j)
                        if k < len(s) and s[k] == "[":
                            _, j = _read_bracket(s, k)
                            k = _skip_spaces(s, j)
                        if k < len(s) and s[k] == "{":
                            _, j = _read_group(s, k)
                    out.append("\\" + name + "{" + _ENVIRONMENTS.get(env, env) + "} ")
                elif name == "\\":
                    # 줄 사이 간격 \\[2pt] 의 [2pt] 는 버린다
                    gap = re.match(r"\[\s*-?[0-9.]+\s*[a-z]{2}\s*\]", s[j:])
                    if gap:
                        j += len(gap.group(0))
                    out.append(r"\\ ")
                elif name == "not":
                    k = _skip_spaces(s, j)
                    nm = re.match(r"\\([A-Za-z]+)|=", s[k:])
                    target = (nm.group(1) or "=") if nm else ""
                    if target not in _NOT:
                        raise EquationError(f"\\not 다음 기호를 바꾸지 못했습니다: {s[k:k + 12]}")
                    out.append(self.prepare(_NOT[target]) + " ")
                    j = k + len(nm.group(0))
                elif name in _SYMBOLS:
                    out.append(self._symbol(_SYMBOLS[name]))
                elif name in _RELATIONS:
                    out.append(self._relation(_RELATIONS[name]))
                elif name in _ALIASES:
                    out.append(_ALIASES[name] + " ")
                elif name in _SPACES:
                    out.append(_SPACES[name])
                elif name in _DROP:
                    out.append(" ")
                else:
                    out.append(m.group(0))
                i = j
                continue
            if ch in "^_":
                # 괄호 없이 쓴 첨자(x^12)도 LaTeX 처럼 한 글자만 첨자로 읽는다
                arg, j = _read_group(s, i + 1)
                out.append(ch + "{" + self.prepare(arg) + "}")
                i = j
                continue
            if "A" <= ch <= "Z" or "a" <= ch <= "z":
                j = i
                while j < len(s) and ("A" <= s[j] <= "Z" or "a" <= s[j] <= "z"):
                    j += 1
                out.append(self._letters(s[i:j]))
                i = j
                continue
            if ch in _CIRCLED_CHARS:
                out.append(self._symbol(ch))
            elif ch in _UNICODE:
                out.append(" " + self.prepare(_UNICODE[ch]) + " ")
            else:
                out.append(ch)
            i += 1
        return "".join(out)

    def convert_inner(self, latex: str) -> str:
        try:
            return latex_to_eqedit(self.prepare(latex))
        except EquationError:
            raise
        except Exception as exc:  # 라이브러리 오류를 한 가지로 묶는다
            raise EquationError(str(exc)) from exc

    def finish(self, script: str) -> str:
        # 자리표시를 되돌린다. 안쪽 자리표시가 바깥 조각 안에 들어 있을 수 있어 여러 번 돈다
        for _ in range(8):
            changed = False
            for key, value in self.slots.items():
                for pattern in (f'{{rm "{key}" it}}', f'"{key}"', key):
                    if pattern in script:
                        script = script.replace(pattern, value)
                        changed = True
                        break
            if not changed:
                break
        return script


# JSON 에 백슬래시 하나로 쓴 명령(\frac, \times, \beta ...)은 \f, \t, \b 같은 제어 문자가 되어 들어온다.
# 라이브러리는 이것을 띄어쓰기로 보고 버려 'rac {1} {2}', '3 imes 4' 가 남는다.
_CONTROL = re.compile(r"([\x00-\x1f])([A-Za-z]*)")
_EATEN = {"\b": "b", "\f": "f", "\n": "n", "\r": "r", "\t": "t"}


def _eaten_command(m: re.Match) -> str | None:
    """제어 문자 + 글자가 백슬래시가 먹힌 명령이면 그 이름 (\\x0c + 'rac' → 'frac')."""
    ch, word = m.group(1), m.group(2)
    if ch not in _EATEN:
        return None
    # 뒤 글자와 합쳐 아는 명령이 될 때만 (\n + eq → \neq). 그냥 줄바꿈·탭은 띄어쓰기다
    name = _EATEN[ch] + word
    return name if name in _KNOWN_COMMANDS else None


def _check_control_characters(latex: str) -> None:
    for m in _CONTROL.finditer(latex):
        name = _eaten_command(m)
        if name:
            raise EquationError(f"백슬래시가 빠진 명령이 있습니다: \\{name}")
        if m.group(1) not in "\t\n\r":
            raise EquationError(f"보이지 않는 제어 문자가 있습니다: {m.group(1)!r}")


def to_eqedit(latex: str, *, upright_uppercase: bool = True) -> str:
    """LaTeX 수식을 한글 수식 문법으로 바꾼다. 못 바꾸면 EquationError."""
    if not isinstance(latex, str):
        raise EquationError(f"수식이 글이 아닙니다: {latex!r}")
    if not latex.strip():
        raise EquationError("빈 수식")
    _check_control_characters(latex)
    conv = _Converter(upright_uppercase)
    script = conv.finish(conv.convert_inner(latex))
    if "QZ" in script and re.search(r"QZ[a-j]+Z", script):
        raise EquationError("자리표시를 되돌리지 못했습니다")
    return script


def script_for_measure(script: str) -> str:
    """수식 상자 크기를 잴 때 쓸 스크립트. 문서에는 원래 스크립트를 넣는다.

    python-hwpx 의 측정기(measure_equation)가 모르는 것을 크기가 비슷한 것으로 바꾼다.
    - arch(호): 측정기는 네 글자 낱말로 재고 위 장식 높이를 주지 않는다 → overline 으로 잰다
    - 따옴표 안의 넓은 기호(□, ①, ㉠, ∥, ⊥ 등): 측정기는 반각 글자나 숫자 폭으로 잰다 → 한글 한 글자 폭으로 잰다
    """
    parts = re.split(r'("[^"]*")', script)
    for k, part in enumerate(parts):
        if k % 2:  # 따옴표 안
            parts[k] = "".join(
                "가" if ord(c) >= 0x2000 and not ("가" <= c <= "힣") and not unicodedata.combining(c) else c
                for c in part
            )
        else:
            parts[k] = re.sub(r"\barch\b", "overline", part)
    return "".join(parts)


# ---------------------------------------------------------------- 글자로 대신 넣기
# 명령 이름 → 글자. 이름 전체가 같을 때만 바꾼다 (\le 가 \left 의 앞부분을 바꾸지 않게)
_PLAIN = {
    "angle": "∠", "measuredangle": "∠", "triangle": "△", "circ": "°", "degree": "°", "times": "×", "div": "÷",
    "pm": "±", "mp": "∓", "cdot": "·", "ast": "*", "star": "☆", "bigstar": "★",
    "leq": "≤", "le": "≤", "leqq": "≤", "leqslant": "≤", "geq": "≥", "ge": "≥", "geqq": "≥", "geqslant": "≥",
    "neq": "≠", "ne": "≠", "lt": "<", "gt": ">", "approx": "≈", "fallingdotseq": "≒", "doteq": "≒",
    "equiv": "≡", "cong": "≡", "sim": "∽", "backsim": "∽", "simeq": "≃", "propto": "∝",
    "parallel": "∥", "nparallel": "∦", "perp": "⊥", "bot": "⊥",
    "square": "□", "Box": "□", "blacksquare": "■", "bigcirc": "○", "triangleright": "▷",
    "therefore": "∴", "because": "∵", "infty": "∞", "partial": "∂", "nabla": "∇", "prime": "′",
    "rightarrow": "→", "to": "→", "longrightarrow": "→", "leftarrow": "←", "gets": "←", "longleftarrow": "←",
    "leftrightarrow": "↔", "longleftrightarrow": "↔", "Rightarrow": "⇒", "implies": "⇒", "Longrightarrow": "⇒",
    "Leftarrow": "⇐", "Leftrightarrow": "⇔", "Longleftrightarrow": "⇔", "iff": "⇔", "mapsto": "↦",
    "in": "∈", "notin": "∉", "ni": "∋", "subset": "⊂", "subseteq": "⊆", "supset": "⊃", "supseteq": "⊇",
    "nsubset": "⊄", "nsubseteq": "⊈", "nsupset": "⊅", "nsupseteq": "⊉", "nequiv": "≢", "cup": "∪", "cap": "∩",
    "emptyset": "∅", "varnothing": "∅", "setminus": "-", "forall": "∀", "exists": "∃", "neg": "¬", "lnot": "¬",
    "land": "∧", "wedge": "∧", "lor": "∨", "vee": "∨", "mid": "|", "vert": "|", "lvert": "|", "rvert": "|",
    "|": "‖", "Vert": "‖", "lVert": "‖", "rVert": "‖", "colon": ":", "cdots": "…", "ldots": "…", "dots": "…",
    "vdots": "⋮", "lbrace": "{", "rbrace": "}", "langle": "⟨", "rangle": "⟩", "lfloor": "⌊", "rfloor": "⌋",
    "lceil": "⌈", "rceil": "⌉", "sum": "Σ", "prod": "Π", "int": "∫", "iint": "∬", "oint": "∮",
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε", "zeta": "ζ",
    "eta": "η", "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν",
    "xi": "ξ", "pi": "π", "varpi": "ϖ", "rho": "ρ", "varrho": "ϱ", "sigma": "σ", "varsigma": "ς", "tau": "τ",
    "upsilon": "υ", "phi": "φ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω", "Gamma": "Γ", "Delta": "Δ",
    "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ",
    "Omega": "Ω",
}
# 이름 그대로 쓰는 함수 (sin, log, lim ...)
_PLAIN_WORDS = frozenset(FUNCTIONS) | {"lim", "limsup", "liminf", "sup", "inf", "arg", "deg", "ker", "Pr", "lcm"}
_PLAIN_NOT = {"in": "∉", "=": "≠", "subset": "⊄", "subseteq": "⊈", "supset": "⊅", "supseteq": "⊉",
              "parallel": "∦", "equiv": "≢", "ni": "∌", "sim": "≁"}
# 인수의 내용만 남기는 명령 (글꼴, 위 장식 등)
_PLAIN_CONTENT = frozenset({
    "text", "textrm", "mathrm", "mbox", "textnormal", "operatorname", "mathit", "textit", "mathnormal", "mathbf",
    "textbf", "boldsymbol", "bm", "mathbb", "mathsf", "mathcal", "mathscr", "mathfrak", "emph", "overline", "bar",
    "vec", "hat", "widetilde", "tilde", "dot", "ddot", "check", "breve", "acute", "grave", "overrightarrow",
    "overleftrightarrow", "overleftarrow", "underbrace", "overbrace", "mathring", "pmb",
})
# 괄호 크기만 정하는 명령: 지우고 뒤의 괄호는 남긴다 (\left. 의 . 은 지운다)
_PLAIN_SIZES = frozenset({"left", "right", "middle", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr",
                          "biggl", "biggr", "Biggl", "Biggr"})
_PLAIN_DROP = frozenset({"displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "limits", "nolimits",
                         "rm", "it", "bf", "sf", "tt", "cal", "nonumber", "notag"})
_SUPERSCRIPT = str.maketrans("0123456789n", "⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ")

# 백슬래시가 먹혔는지 가릴 때 쓰는, 아는 명령 이름
_KNOWN_COMMANDS = frozenset(
    {
        latex[1:]
        for words in (GREEK, OPERATORS, FUNCTIONS, BIG_OPERATORS, ACCENTS, DELIMITERS)
        for latex in words.values()
        if re.fullmatch(r"\\[A-Za-z]+", latex)
    }
    | set(_PLAIN) | _PLAIN_WORDS | _PLAIN_CONTENT | _PLAIN_SIZES | _PLAIN_DROP | _DROP
    | set(_TEXT_COMMANDS) | set(_ITALIC_COMMANDS) | set(_SYMBOLS) | set(_RELATIONS) | set(_ALIASES) | set(_SPACES)
    | {"frac", "dfrac", "tfrac", "binom", "sqrt", "begin", "end", "not", "overset", "stackrel", "overparen",
       "wideparen", "overarc", "arc", "widehat", "textcircled", "circled", "boxed", "fbox", "framebox", "phantom",
       "hphantom", "vphantom", "underline", "hspace", "vspace", "color", "textcolor"}
)


def _take(s: str, i: int) -> tuple[str, int]:
    """latex_to_plain 용 인수 읽기. 괄호 짝이 맞지 않아도 오류 없이 남은 글을 돌려준다."""
    try:
        return _read_group(s, i)
    except EquationError:  # 인수가 없거나 { 의 짝이 없다
        i = _skip_spaces(s, i)
        return s[i + 1 :], len(s)


def _paren(text: str) -> str:
    """분수·첨자·루트 안의 글이 한 덩어리가 아니면 괄호로 묶는다 (√3/2, (x+1)/2, x^(n+1))."""
    t = text.strip()
    if not t or re.fullmatch(r"[√∛∜]?(?:\d+(?:\.\d+)?|\S)", t):
        return t
    if t.startswith("(") and t.endswith(")"):
        depth = 0
        for k, c in enumerate(t):
            depth += {"(": 1, ")": -1}.get(c, 0)
            if depth == 0:
                if k == len(t) - 1:
                    return t
                break
    return f"({t})"


def _plain_command(s: str, i: int, name: str) -> tuple[str, int]:
    """명령 하나를 글자로. (글자, 다음 위치)"""
    if name in _PLAIN:
        return _PLAIN[name], i
    if name in _PLAIN_WORDS:
        return name, i
    if name in _TEXT_ESCAPES:
        return _TEXT_ESCAPES[name], i
    if name in _SPACES or name == ",":
        return ("" if name == "!" else " "), i
    if name == "\\":  # 줄 바꿈 (연립방정식의 식과 식 사이)
        gap = re.match(r"\s*\[[^\]]*\]", s[i:])
        return ", ", i + (len(gap.group(0)) if gap else 0)
    if s[i : i + 1] == "*":  # \operatorname*, \hspace* 의 *
        i += 1
    if name in ("frac", "dfrac", "tfrac", "cfrac"):
        a, i = _take(s, i)
        b, i = _take(s, i)
        return f"{_paren(_plain(a))}/{_paren(_plain(b))}", i
    if name in ("binom", "dbinom", "tbinom"):
        a, i = _take(s, i)
        b, i = _take(s, i)
        return f"C({_plain(a).strip()}, {_plain(b).strip()})", i
    if name == "sqrt":
        index = ""
        k = _skip_spaces(s, i)
        end = s.find("]", k) if s[k : k + 1] == "[" else -1
        if end != -1:
            index, i = _plain(s[k + 1 : end]).strip(), end + 1
        a, i = _take(s, i)
        if index in ("", "2", "3", "4"):
            root = {"": "√", "2": "√", "3": "∛", "4": "∜"}[index]
        elif set(index) <= set("0123456789n"):
            root = index.translate(_SUPERSCRIPT) + "√"
        else:
            root = f"({index})√"
        return root + _paren(_plain(a)), i
    if name in ("overset", "stackrel", "underset"):
        top, i = _take(s, i)
        base, i = _take(s, i)
        return ("⌒" if top.strip() in _ARC_TOPS else "") + _plain(base), i
    if name in ("overparen", "wideparen", "overarc", "arc", "widehat"):
        a, i = _take(s, i)
        return "⌒" + _plain(a), i
    if name in ("textcircled", "circled"):
        a, i = _take(s, i)
        inner = _plain(a).strip()
        return _circled(inner) or f"({inner})", i
    if name in ("boxed", "fbox", "framebox"):
        a, i = _take(s, i)
        return ("□" if _is_blank(a) else _plain(a)), i
    if name == "underline":
        a, i = _take(s, i)
        return ("____" if _is_blank(a) else _plain(a)), i
    if name in ("phantom", "hphantom", "vphantom", "hspace", "vspace", "color"):
        _, i = _take(s, i)
        return " ", i
    if name in ("textcolor", "colorbox"):
        _, i = _take(s, i)
        a, i = _take(s, i)
        return _plain(a), i
    if name in ("begin", "end"):
        env, i = _take(s, i)
        env = env.strip()
        if name == "begin" and env == "array":  # 열 맞춤 [t]{l} 은 버린다
            k = _skip_spaces(s, i)
            end = s.find("]", k) if s[k : k + 1] == "[" else -1
            if end != -1:
                i = end + 1
                k = _skip_spaces(s, i)
            if s[k : k + 1] == "{":
                _, i = _take(s, k)
        return ("{ " if name == "begin" and env == "cases" else " "), i
    if name in _PLAIN_SIZES:
        k = _skip_spaces(s, i)
        return "", (k + 1 if s[k : k + 1] == "." else i)
    if name == "not":
        k = _skip_spaces(s, i)
        m = re.match(r"\\([A-Za-z]+)|=", s[k:])
        target = (m.group(1) or "=") if m else ""
        if target in _PLAIN_NOT:
            return _PLAIN_NOT[target], k + len(m.group(0))
        return "¬", i
    if name in _PLAIN_CONTENT:
        a, i = _take(s, i)
        return _plain(a), i
    if name in _PLAIN_DROP or name in _DROP:
        return "", i
    return name, i  # 모르는 명령은 이름을 글자로 남긴다 (지우면 뜻이 바뀐다)


def _plain(s: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\":
            m = re.match(r"\\([A-Za-z]+|.?)", s[i:], re.S)
            text, i = _plain_command(s, i + len(m.group(0)), m.group(1))
            out.append(text)
        elif ch == "{":
            arg, i = _take(s, i)
            out.append(_plain(arg))
        elif ch in "^_":
            arg, i = _take(s, i + 1)
            body = _plain(arg).strip()
            out.append(body if ch == "^" and body in ("°", "′") else ch + _paren(body))
        else:
            out.append({"}": "", "&": " ", "~": " ", "$": ""}.get(ch, ch))
            i += 1
    return "".join(out)


def latex_to_plain(latex: str) -> str:
    """수식으로 못 넣을 때 쓰는, 사람이 읽을 수 있는 글자."""
    if latex is None:
        return ""

    def restore(m: re.Match) -> str:  # JSON 에서 먹힌 백슬래시를 되살린다. 다른 제어 문자는 띄어쓰기로
        name = _eaten_command(m)
        return "\\" + name if name else " " + m.group(2)

    text = _plain(_CONTROL.sub(restore, str(latex)))
    text = re.sub(r"\s+", " ", text)
    return re.sub(r" ,", ",", text).strip()
