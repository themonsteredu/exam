"""한글 문항의 강조·배점·삼각형 수식이 보존되는지 확인한다."""
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
def prev_of(para):
    margin = pp[para.get('paraPrIDRef')].find('.//' + hh + 'margin')
    return int(margin.find(hc + 'prev').get('value'))
starts = [p for p in sec if p.tag == hp + 'p' and ''.join(t.text or '' for t in p.iter(hp + 't')).startswith(('2.', '4.'))]
assert len(starts) == 2 and all(prev_of(p) > 1200 * 5 for p in starts), [prev_of(p) for p in starts]
from exam_hwpx.builder import estimated_pages  # noqa: E402
assert estimated_pages(spaced_data) == 2, estimated_pages(spaced_data)
print('한글 문항 강조, 배점, 삼각형 수식, B4 용지, 조건 수식 나누기, 단 아래 빈 곳 나누기 확인 완료')
