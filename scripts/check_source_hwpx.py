"""원본 배치 출력: B4 용지, 페이지 수, 네모 조건 상자, 가로 선택지, 수식/글의 편집 가능성을 검사한다."""
import io
import sys
from pathlib import Path
import zipfile
from lxml import etree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'py'))
from exam_hwpx.builder import build_exam
from exam_hwpx.latex import to_eqedit
from exam_hwpx.template import mm

pages = [{'page': i, 'width': 1000, 'height': 1417, 'paper_mm': [257, 364]} for i in range(1, 5)]
blocks = [
    {'role': 'stem', 'box': {'x': 40, 'y': 120, 'w': 430, 'h': 50}, 'lines': [[{'t': '다음 조건을 만족하는 것은? [5점]'}]]},
    {'role': 'box', 'title': '조건', 'box': {'x': 40, 'y': 190, 'w': 430, 'h': 130}, 'lines': [[{'m': r'l \parallel m'},{'t':'일 때'}]]},
] + [{'role': 'choice', 'choice_no': i + 1, 'box': {'x': 40 + i * 86, 'y': 350, 'w': 78, 'h': 32}, 'lines': [[{'m': str(i + 1)}]]} for i in range(5)]
exam = {'layout_mode': 'source', 'source_pages': pages, 'sections': [{'items': [
    {'no': i, 'source': {'page': i, 'x': 40, 'y': 120, 'w': 430, 'h': 280}, 'layout_blocks': blocks} for i in range(1, 5)
]}]}
data, warnings = build_exam(exam)
assert not warnings, warnings
ns = {'hp': 'http://www.hancom.co.kr/hwpml/2011/paragraph', 'hh': 'http://www.hancom.co.kr/hwpml/2011/head'}
with zipfile.ZipFile(io.BytesIO(data)) as z:
    sections = [n for n in z.namelist() if n.startswith('Contents/section') and n.endswith('.xml')]
    assert len(sections) == 4
    for path in sections:
        root = ET.fromstring(z.read(path))
        paper = root.find('.//hp:pagePr', ns)
        assert paper.get('width') == str(mm(257)) and paper.get('height') == str(mm(364))
        tables = root.findall('.//hp:tbl', ns)
        assert len(tables) == 7
        assert all(t.get('pageBreak') == 'NONE' for t in tables)
        positions = [t.find('hp:pos', ns) for t in tables]
        assert all(p.get('vertRelTo') == 'PAGE' and p.get('treatAsChar') == '0' for p in positions)
        assert len({p.get('vertOffset') for p in positions[2:]}) == 1
        assert len({p.get('horzOffset') for p in positions[2:]}) == 5
        assert '조건' in ''.join(root.itertext())
        assert 'parallel' in ''.join(root.itertext())
    header = ET.fromstring(z.read('Contents/header.xml'))
    fills = {b.get('id'): b for b in header.findall('.//hh:borderFill', ns)}
    bf = fills[tables[1].get('borderFillIDRef')]
    assert all(bf.find(f'hh:{side}Border', ns).get('type') == 'SOLID' for side in ('left','right','top','bottom'))
assert to_eqedit(r'l \parallel n') == 'l ~parallel~ n'
print('원본 4쪽·B4·조건 네모·가로 선택지·평행 수식 검사 통과')
