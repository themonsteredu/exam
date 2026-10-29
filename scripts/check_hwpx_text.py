"""한글 문항의 강조·배점·삼각형 수식이 보존되는지 확인한다."""
import io
import pathlib
import sys
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'py'))
from exam_hwpx.builder import build_exam  # noqa: E402

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
assert '[5점]' in section and '{rm "△" it}' in section
hp = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
hh = '{http://www.hancom.co.kr/hwpml/2011/head}'
root = ET.fromstring(section)
run = next(e for e in root.iter(hp + 'run') if any(t.text == '않은' for t in e.iter(hp + 't')))
char = next(e for e in ET.fromstring(header).iter(hh + 'charPr') if e.get('id') == run.get('charPrIDRef'))
assert char.find(hh + 'underline').get('type') == 'BOTTOM'
print('한글 문항 강조, 배점, 삼각형 수식 확인 완료')
