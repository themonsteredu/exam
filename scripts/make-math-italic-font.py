"""그림 속 기울인 글자(변수 x 등)에 쓸 글꼴 "Exam Math Italic" 을 만든다.

Latin Modern Math 의 수학 기울임 글자(𝑥 U+1D465 등)만 뽑아, 보통 글자 자리(x, a, θ …)에 옮겨 담는다.
한글 수식 글꼴(HyhwpEQ)의 x 와 가장 닮은 글꼴이다 (조사: 닮음 0.987, 이전에 쓰던 Liberation Serif Italic 은 0.089).
숫자·기호는 넣지 않는다: 그림에서는 이 글꼴 다음의 Liberation Serif(바로 선 글자)가 그린다 (한글 수식처럼 숫자는 세워 쓴다).
GUST 글꼴 사용 허락(LPPL 1.3c)이 바꾼 글꼴은 이름을 바꾸라고 하므로 이름을 바꾸고,
public/fonts/README-ExamMathItalic.txt 와 GUST-FONT-LICENSE.txt 를 함께 둔다.

사용법: python3 scripts/make-math-italic-font.py <latinmodern-math.otf> <출력.woff2>
원본: https://ctan.org/pkg/lm-math 의 latinmodern-math.otf (판 1.959)
"""
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._c_m_a_p import cmap_format_4

FAMILY = "Exam Math Italic"
PS_NAME = "ExamMathItalic-Regular"

src, out = sys.argv[1:3]
font = TTFont(src)
cmap = font.getBestCmap()

# 보통 글자 → 수학 기울임 글자의 글리프
pairs: dict[int, str] = {}
for i in range(26):
    pairs[ord("A") + i] = cmap[0x1D434 + i]
    # 수학 기울임 h 자리(U+1D455)는 비어 있고 U+210E(ℎ)가 그 글자다
    pairs[ord("a") + i] = cmap[0x210E if i == 7 else 0x1D44E + i]
for i in range(25):  # α … ω (끝 시그마 ς 도 같은 차례로 들어 있다)
    pairs[0x03B1 + i] = cmap[0x1D6FC + i]

opts = subset.Options()
opts.drop_tables += ["MATH"]
opts.layout_features = ["kern"]
opts.name_IDs = ["*"]
opts.notdef_outline = True
sub = subset.Subsetter(opts)
sub.populate(glyphs=sorted(set(pairs.values())))
sub.subset(font)

# 글자 자리를 보통 글자로 바꿔 단다 (수학 글자 자리는 두지 않는다)
tables = []
for platform, encoding in ((0, 3), (3, 1)):
    t = cmap_format_4(4)
    t.platformID, t.platEncID, t.language = platform, encoding, 0
    t.cmap = dict(pairs)
    tables.append(t)
font["cmap"].tables = tables

# 이름 바꾸기 (저작권 문구는 그대로 두고, 고친 글꼴임과 사용 허락을 적는다)
name = font["name"]
for rec in list(name.names):
    if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22):
        name.removeNames(nameID=rec.nameID)
notice = (
    "Exam Math Italic is a modified subset of Latin Modern Math 1.959 (math italic letters mapped to plain letter code points). "
    "It is distributed under the GUST Font License (LPPL 1.3c); see GUST-FONT-LICENSE.txt and README-ExamMathItalic.txt."
)
for nid, text in ((1, FAMILY), (2, "Regular"), (3, f"{PS_NAME};1.959"), (4, FAMILY), (6, PS_NAME), (13, notice),
                  (14, "http://www.gust.org.pl/fonts/licenses/GUST-FONT-LICENSE.txt")):
    name.setName(text, nid, 3, 1, 0x409)
    name.setName(text, nid, 1, 0, 0)

cff = font["CFF "].cff
cff.fontNames = [PS_NAME]
top = cff.topDictIndex[0]
top.FullName = FAMILY
top.FamilyName = FAMILY

os2 = font["OS/2"]
os2.recalcUnicodeRanges(font)
os2.usFirstCharIndex = min(pairs)
os2.usLastCharIndex = max(pairs)

font.flavor = "woff2"
font.save(out)
print(out, "글자", len(pairs), "글리프", len(font.getGlyphOrder()))
