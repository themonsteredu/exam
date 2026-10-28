"""LaTeX → 한글 수식(EqEdit) 변환.

python-hwpx 의 latex_to_eqedit 앞뒤로 손질을 더한다.

- 점 이름처럼 대문자로 된 글자(A, AB, ABC)는 정자체로 쓴다 (교과서·시험지 관례: 점 이름은 정자, 변수 x 는 기울임).
- 라이브러리가 모르는 명령(호 AB, ∥, ⊥, □, 원 문자, 띄어쓰기 등)을 바꿔 준다.
- \\text{...} 안의 글은 띄어쓰기를 바꾸지 않고 그대로 넣는다.

바꾸지 못하면 EquationError 를 낸다. 그때는 latex_to_plain() 으로 읽을 수 있는 글자로 넣는다.
"""

from __future__ import annotations

import re

from hwpx.equation.authoring import latex_to_eqedit


class EquationError(ValueError):
    pass


# 글자 그대로 넣을 명령 (인수를 그대로 둔다)
_TEXT_COMMANDS = ("text", "mathrm", "textrm", "mbox", "operatorname", "textnormal")

# 인수 없이 쓰는 기호 중 라이브러리가 모르는 것 → 그대로 넣을 글자
_SYMBOLS = {
    "square": "□",
    "Box": "□",
    "blacksquare": "■",
    "parallel": "∥",
    "nparallel": "∦",
    "perp": "⊥",
    "bot": "⊥",
    "Leftrightarrow": "⇔",
    "leftrightarrow": "↔",
    "Leftarrow": "⇐",
    "lt": "<",
    "gt": ">",
    "#": "#",
    "bigcirc": "○",
    "triangleright": "▷",
    "star": "☆",
    "bigstar": "★",
}

# 다른 LaTeX 명령으로 바꾸면 되는 것
_ALIASES = {
    "varnothing": r"\emptyset",
    "measuredangle": r"\angle",
    "degree": r"^{\circ}",
    "dfrac": r"\frac",
    "tfrac": r"\frac",
    "le": r"\leq",
    "ge": r"\geq",
    "ne": r"\neq",
    "gets": r"\leftarrow",
}

# 띄어쓰기
_SPACES = {" ": r"\,\,", ";": r"\,\,", ":": r"\,\,", ">": r"\,\,", "quad": r"\,\,\,\,", "qquad": r"\,\,\,\,\,\,\,\,", "!": ""}

# 지워도 되는 명령
_DROP = {"displaystyle", "textstyle", "scriptstyle", "limits", "nolimits", "rm", "it", "bf", "left.", "right."}

_CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
_CIRCLED_HANGUL = dict(zip("ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ", "㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭"))
_CIRCLED_HANGUL_SYLLABLE = dict(zip("가나다라마바사아자차카타파하", "㉮㉯㉰㉱㉲㉳㉴㉵㉶㉷㉸㉹㉺㉻"))
_CIRCLED_LOWER = {chr(ord("a") + i): chr(0x24D0 + i) for i in range(26)}


def _circled(text: str) -> str | None:
    t = text.strip()
    if t.isdigit() and 1 <= int(t) <= 20:
        return _CIRCLED_DIGITS[int(t) - 1]
    return _CIRCLED_HANGUL.get(t) or _CIRCLED_HANGUL_SYLLABLE.get(t) or _CIRCLED_LOWER.get(t)


def _read_group(s: str, i: int) -> tuple[str, int]:
    """s[i] 에서 시작하는 인수 하나({...} 또는 글자 하나)를 읽는다. (내용, 다음 위치)"""
    while i < len(s) and s[i] == " ":
        i += 1
    if i >= len(s):
        raise EquationError("인수가 빠졌습니다")
    if s[i] == "{":
        depth = 0
        for j in range(i, len(s)):
            if s[j] == "{" and (j == 0 or s[j - 1] != "\\"):
                depth += 1
            elif s[j] == "}" and s[j - 1] != "\\":
                depth -= 1
                if depth == 0:
                    return s[i + 1 : j], j + 1
        raise EquationError("괄호 { } 짝이 맞지 않습니다")
    if s[i] == "\\":
        m = re.match(r"\\([A-Za-z]+|.)", s[i:])
        assert m
        return m.group(0), i + len(m.group(0))
    return s[i], i + 1


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

    def prepare(self, s: str) -> str:
        """라이브러리가 읽을 수 있는 LaTeX 로 손질한다."""
        s = re.sub(r"\{\\rm\s*([^{}]*)\}", r"\\mathrm{\1}", s)  # {\rm AB}
        out: list[str] = []
        i = 0
        while i < len(s):
            ch = s[i]
            if ch == "\\":
                m = re.match(r"\\([A-Za-z]+|.)", s[i:])
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
                        out.append(self._slot("{rm " + self._quote(arg) + " it}"))
                elif name == "mathbb":
                    arg, j = _read_group(s, j)
                    out.append(self._slot("{rm " + self._quote(arg) + " it}"))
                elif name in ("overset", "stackrel"):
                    top, j = _read_group(s, j)
                    base, j = _read_group(s, j)
                    if top.strip() in (r"\frown", r"\smile", "⌒"):
                        out.append(self._slot("arch {" + self.convert_inner(base) + "}"))
                    else:
                        out.append(self._slot("{" + self.convert_inner(base) + "} ^{" + self.convert_inner(top) + "}"))
                elif name in ("overparen", "wideparen", "overarc", "arc", "widehat"):
                    arg, j = _read_group(s, j)
                    out.append(self._slot("arch {" + self.convert_inner(arg) + "}"))
                elif name in ("textcircled", "circled"):
                    arg, j = _read_group(s, j)
                    c = _circled(arg)
                    out.append(self._slot(self._quote(c) if c else "(" + self.convert_inner(arg) + ")"))
                elif name in ("boxed", "fbox", "framebox"):
                    arg, j = _read_group(s, j)
                    # 상자 안 내용만 넣는다 (빈 상자는 □)
                    out.append(self._slot("{" + self.convert_inner(arg) + "}") if arg.strip() else self._slot(self._quote("□")))
                elif name in _SYMBOLS:
                    out.append(self._slot(self._quote(_SYMBOLS[name])))
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
            if self.upright and "A" <= ch <= "Z":
                j = i
                while j < len(s) and "A" <= s[j] <= "Z":
                    j += 1
                out.append(r"\mathrm{" + s[i:j] + "}")
                i = j
                continue
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


def to_eqedit(latex: str, *, upright_uppercase: bool = True) -> str:
    """LaTeX 수식을 한글 수식 문법으로 바꾼다. 못 바꾸면 EquationError."""
    if not latex or not latex.strip():
        raise EquationError("빈 수식")
    conv = _Converter(upright_uppercase)
    script = conv.finish(conv.convert_inner(latex))
    if "QZ" in script and re.search(r"QZ[a-j]+Z", script):
        raise EquationError("자리표시를 되돌리지 못했습니다")
    return script


# ---------------------------------------------------------------- 글자로 대신 넣기
_PLAIN = {
    r"\angle": "∠", r"\triangle": "△", r"\circ": "°", r"\times": "×", r"\div": "÷", r"\pm": "±",
    r"\leq": "≤", r"\le": "≤", r"\geq": "≥", r"\ge": "≥", r"\neq": "≠", r"\ne": "≠", r"\cdot": "·",
    r"\pi": "π", r"\alpha": "α", r"\beta": "β", r"\theta": "θ", r"\parallel": "∥", r"\perp": "⊥",
    r"\square": "□", r"\cong": "≡", r"\equiv": "≡", r"\sim": "∽", r"\therefore": "∴", r"\because": "∵",
    r"\infty": "∞", r"\rightarrow": "→", r"\to": "→", r"\Rightarrow": "⇒", r"\cdots": "…", r"\ldots": "…",
    r"\%": "%", r"\,": " ", r"\ ": " ", r"\;": " ", r"\quad": " ", r"\!": "",
}


def latex_to_plain(latex: str) -> str:
    """수식으로 못 넣을 때 쓰는, 사람이 읽을 수 있는 글자."""
    s = latex
    s = re.sub(r"\\(?:overline|overrightarrow|overleftrightarrow|bar|vec|mathrm|text|textrm|operatorname)\s*\{([^{}]*)\}", r"\1", s)
    s = re.sub(r"\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}", r"\1/\2", s)
    s = re.sub(r"\\sqrt\s*\{([^{}]*)\}", r"√\1", s)
    s = re.sub(r"\^\{\\circ\}|\^\\circ", "°", s)
    for k in sorted(_PLAIN, key=len, reverse=True):
        s = s.replace(k, _PLAIN[k])
    s = re.sub(r"\^\{([^{}]*)\}", r"^\1", s)
    s = re.sub(r"_\{([^{}]*)\}", r"_\1", s)
    s = re.sub(r"\\[A-Za-z]+", "", s)
    s = s.replace("{", "").replace("}", "")
    return re.sub(r"\s+", " ", s).strip()
