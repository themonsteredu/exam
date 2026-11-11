"""한글 시험지의 글, 수식, 풀이 공간과 그림 배치를 확인한다."""
import base64
import io
import pathlib
import sys
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'py'))
from exam_hwpx.builder import build_exam, split_condition_list  # noqa: E402

# 쉼표로 나열한 조건 수식은 하나씩 나눈다 (한글 수식은 줄을 못 바꿔 앞 줄 끝이 빈다). 순서쌍·집합·관계식 아닌 나열은 그대로
assert split_condition_list(r'\angle A=70^{\circ}, \angle C=30^{\circ}') == [r'\angle A=70^{\circ}', r'\angle C=30^{\circ}']
assert split_condition_list(r'l \parallel m, m \perp n') == [r'l \parallel m', r'm \perp n']
for keep in (r'(1, 2)', r'A=\{1, 2\}', r'b-a, n', r'x=1, 2', r'a\,,b', r'[0, 1)'):
    assert split_condition_list(keep) == [keep], keep

exam = {'title': '시험', 'sections': [{'items': [
    {'no': 5, 'points': 3, 'stem': [{'t': '옳지 __않은__ 것은? [3점] '}, {'m': r'\triangle ABC'}]},
    {'no': 1, 'label': '서술형 1.', 'points': 6, 'stem': [
        {'t': '구하시오. [6점-부분점수]'}, {'t': '\n'}, {'t': '(1) 모두 구하시오. [3점]'}]},
    {'no': 3, 'points': 5, 'stem': [{'t': '모두 고른 것은?'}, {'t': '\n'}, {'t': '㉠ 조건'}]},
]}]}
data, warnings = build_exam(exam)
assert not warnings, warnings
with zipfile.ZipFile(io.BytesIO(data)) as z:
    section = z.read('Contents/section0.xml').decode()
    header = z.read('Contents/header.xml').decode()
assert '__않은__' not in section
assert section.count('[3점]') == 2
assert '[6점-부분점수]' in section and '[6점]' not in section
assert '[5점]' in section and 'TRIANGLE' in section
hp = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
hh = '{http://www.hancom.co.kr/hwpml/2011/head}'
root = ET.fromstring(section)
run = next(e for e in root.iter(hp + 'run') if any(t.text == '않은' for t in e.iter(hp + 't')))
char = next(e for e in ET.fromstring(header).iter(hh + 'charPr') if e.get('id') == run.get('charPrIDRef'))
assert char.find(hh + 'underline').get('type') == 'BOTTOM'
# 원본이 B4 면 B4 용지로 (여백·단 사이도 용지 너비 비율로 늘림, 글자 크기는 그대로)
b4, _ = build_exam({**exam, 'paper': {'name': 'B4', 'width_mm': 257, 'height_mm': 364}})
with zipfile.ZipFile(io.BytesIO(b4)) as z:
    b4_section = z.read('Contents/section0.xml').decode()
page = next(ET.fromstring(b4_section).iter(hp + 'pagePr'))
assert (page.get('width'), page.get('height')) == ('72851', '103181'), (page.get('width'), page.get('height'))
margin = page.find(hp + 'margin')
assert abs(int(margin.get('left')) - round(12 * 257 / 210 * 283.465)) <= 1, margin.get('left')
assert 'width="59528"' in section, 'A4 는 그대로'
for bad in ({'width_mm': 'x'}, {'width_mm': 5000, 'height_mm': 9000}, 'B4'):
    data_bad, _ = build_exam({**exam, 'paper': bad})
    with zipfile.ZipFile(io.BytesIO(data_bad)) as z:
        assert 'width="59528"' in z.read('Contents/section0.xml').decode(), bad
listed, _ = build_exam({'sections': [{'items': [{'no': 1, 'stem': [{'t': '다음 그림에서 '}, {'m': r'\angle A=70^{\circ}, \angle C=30^{\circ}'}, {'t': '일 때'}]}]}]})
with zipfile.ZipFile(io.BytesIO(listed)) as z:
    assert z.read('Contents/section0.xml').decode().count('<hp:equation') == 2, '조건 두 개는 수식 두 개'
# 원본 자리에서 단을 나눴는데 우리 글이 짧아 단 아래가 크게 비면, 그 빈 곳을 단의 문항 사이에 나눠 준다 (원본처럼 풀이 공간)
def q(no, brk=None):
    item = {'no': no, 'stem': [{'t': f'{no}번 문제 글입니다. 다음 중 옳은 것은?'}], 'choices': [[{'t': '가'}], [{'t': '나'}], [{'t': '다'}]]}
    if brk:
        item['break_before'] = brk
    return item
short = {'source_pages': [{'page': 1, 'width': 1000, 'height': 1414}, {'page': 2, 'width': 1000, 'height': 1414}],
         'sections': [{'items': [q(1), q(2), q(3, 'column'), q(4), q(5, 'page'), q(6)]}]}
spaced_data, _ = build_exam(short)
with zipfile.ZipFile(io.BytesIO(spaced_data)) as z:
    sec = ET.fromstring(z.read('Contents/section0.xml'))
    head = ET.fromstring(z.read('Contents/header.xml'))
hc = '{http://www.hancom.co.kr/hwpml/2011/core}'
pp = {e.get('id'): e for e in head.iter(hh + 'paraPr')}
def prev_of(para, styles):
    margin = styles[para.get('paraPrIDRef')].find('.//' + hh + 'margin')
    return int(margin.find(hc + 'prev').get('value'))
starts = [p for p in sec if p.tag == hp + 'p' and ''.join(t.text or '' for t in p.iter(hp + 't')).startswith(('2.', '4.'))]
assert len(starts) == 2 and all(prev_of(p, pp) > 1200 * 5 for p in starts), [prev_of(p, pp) for p in starts]
from exam_hwpx.builder import estimated_pages  # noqa: E402
assert estimated_pages(spaced_data) == 2, estimated_pages(spaced_data)

# 한 쪽에 들어갈 수 없는 시험지도 글자 크기와 문항별 풀이 자리를 유지한다.
written = []
for no in range(1, 7):
    stem = []
    for part in range(1, 11):
        if stem:
            stem.append({'t': '\n'})
        stem.append({'t': f'({part}) 조건에 맞는 값을 구하시오.'})
    written.append({'no': no, 'label': f'서술형 {no}.', 'stem': stem})
roomy, _ = build_exam({
    'source_pages': [{'page': 1, 'width': 1000, 'height': 1414}],
    'sections': [{'items': [q(1)]}, {'title': '서술형', 'break_before': 'column', 'items': written}],
})
with zipfile.ZipFile(io.BytesIO(roomy)) as z:
    sec = ET.fromstring(z.read('Contents/section0.xml'))
    head = ET.fromstring(z.read('Contents/header.xml'))
assert (estimated_pages(roomy) or 0) > 1, '풀이 공간이 한 쪽에 들어가지 않으면 쪽 수를 늘린다'
assert any(c.get('colCount') == '2' for c in sec.iter(hp + 'colPr')), '시험지 본문은 2단'

def text_of(node):
    return ''.join(t.text or '' for t in node.iter(hp + 't'))

styles = {e.get('id'): e for e in head.iter(hh + 'paraPr')}
font_heights = {e.get('id'): int(e.get('height')) for e in head.iter(hh + 'charPr')}
paras = sec.findall(hp + 'p')
body_runs = [r for p in paras if text_of(p).startswith(('1. 1번 문제 글입니다.', '서술형 '))
             for r in p.findall(hp + 'run') if text_of(r).strip()]
choice_runs = [r for r in sec.iter(hp + 'run') if text_of(r).startswith('①  ')]
for runs in (body_runs, choice_runs):
    assert runs and {font_heights[r.get('charPrIDRef')] for r in runs} == {1200}, '본문과 선택지는 12pt'
spaces = [p for p in paras if text_of(p) == '\u00a0']
assert len(spaces) == 1 + len(written), '마지막 문항에도 풀이 자리를 둔다'
last_written = next(p for p in paras if text_of(p).startswith('서술형 6.'))
assert paras.index(spaces[-1]) > paras.index(last_written), '마지막 풀이 자리는 마지막 문항 뒤'
for p, minimum_mm in zip(spaces, [12] + [28] * len(written)):
    space_run = next(r for r in p.findall(hp + 'run') if text_of(r) == '\u00a0')
    height = prev_of(p, styles) + font_heights[space_run.get('charPrIDRef')]
    assert height >= round(minimum_mm * 283.465), (minimum_mm, height)

# ①②③ / ④⑤처럼 둘째 행이 있는 선택지 표에는 뷰어가 그대로 쓸 수 있는 행 높이를 저장한다.
# 분수가 들어간 첫 행은 숫자만 있는 둘째 행보다 높아야 한다.
choices = [[{'m': r'\frac{1}{2}'}], [{'m': '2'}], [{'t': '세 번째'}], [{'m': '4'}], [{'m': '5'}]]
grid, _ = build_exam({'sections': [{'items': [
    {'no': 1, 'stem': [{'t': '다음 중 옳은 것은?'}], 'choice_layout': 'grid', 'choices': choices},
]}]})
with zipfile.ZipFile(io.BytesIO(grid)) as z:
    sec = ET.fromstring(z.read('Contents/section0.xml'))
table = next(tbl for tbl in sec.iter(hp + 'tbl')
             if tbl.get('rowCnt') == '2' and tbl.get('colCnt') == '3'
             and '①  ' in ''.join(t.text or '' for t in tbl.iter(hp + 't')))
rows = table.findall(hp + 'tr')
heights = [[int(cell.find(hp + 'cellSz').get('height')) for cell in row] for row in rows]
assert heights[0][0] > heights[1][0] >= 1760, heights
assert all(len(set(row)) == 1 for row in heights), heights
assert int(table.find(hp + 'sz').get('height')) == sum(row[0] for row in heights), heights
assert len(list(table.iter(hp + 'equation'))) == 4, '선택지 수식은 개체로 남긴다'
assert [''.join(t.text or '' for t in row.iter(hp + 't')) for row in rows] == ['①  ②  ③  세 번째', '④  ⑤  ']

# 오른쪽에 떠 있는 그림이 긴 수식 개체의 폭을 침범하거나 같은 자리에 둘 이상 겹치지 않게 한다.
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrGQAAAAASUVORK5CYII=')
right = {'place': 'right', 'width_mm': 40, 'png': png}
positions, _ = build_exam({'sections': [{'items': [
    {'no': 1, 'stem': [{'t': '그림을 보시오.'}], 'figure': right},
    {'no': 2, 'stem': [{'m': 'x+y+z+a+b+c+d+e+f=0'}, {'t': '일 때의 그림.'}], 'figure': right},
    {'no': 3, 'stem': [{'t': '두 그림을 보시오.'}], 'figure': right, 'extra_figures': [right]},
]}]})
with zipfile.ZipFile(io.BytesIO(positions)) as z:
    sec = ET.fromstring(z.read('Contents/section0.xml'))
assert [pic.find(hp + 'pos').get('treatAsChar') for pic in sec.iter(hp + 'pic')] == ['0', '1', '1', '1']

picture_grid, _ = build_exam({'sections': [{'items': [
    {'no': 1, 'stem': [{'t': '다음 중 옳은 것은?'}], 'figure': right, 'extra_figures': [right, right, right, right],
     'choices': [[] for _ in range(5)]},
]}]})
with zipfile.ZipFile(io.BytesIO(picture_grid)) as z:
    sec = ET.fromstring(z.read('Contents/section0.xml'))
table = next(tbl for tbl in sec.iter(hp + 'tbl') if tbl.get('rowCnt') == '3' and tbl.get('colCnt') == '2')
assert len(list(table.iter(hp + 'pic'))) == 5, '그림 선택지 다섯 개를 모두 보존한다'
for cell in table.iter(hp + 'tc'):
    pic = next(cell.iter(hp + 'pic'), None)
    if pic is not None:
        assert int(cell.find(hp + 'cellSz').get('height')) >= int(pic.find(hp + 'sz').get('height')) + 1100
print('한글 문항 강조, 배점, 수식, B4 용지, 단 아래 빈 곳, 선택지 행 높이, 그림 배치 확인 완료')
