"""재작성 자료가 PNG 한 장이 아닌 편집 가능한 한글 선·글자·표로 들어가는지 검사한다."""
import base64
import io
import json
from pathlib import Path
import sys
import zipfile
from lxml import etree as ET

root=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(root/'py'))
from exam_hwpx.builder import build_exam

sample=json.loads((root/'data/graphic_example.json').read_text())
table={"x":0,"y":0,"w":1000,"h":600,"rows":2,"cols":2,"col_widths":[1,2],"row_heights":[1,1],"size":30,
"cells":[{"row":0,"col":0,"row_span":1,"col_span":2,"text":"제목"},{"row":1,"col":0,"row_span":1,"col_span":1,"text":"1"},{"row":1,"col":1,"row_span":1,"col_span":1,"text":"2"}]}
tab={**sample,"kind":"table","paths":[],"ellipses":[],"texts":[],"tables":[table],"critical_labels":["제목","1","2"]}
box={"page":1,"x":40,"y":100,"w":800,"h":480}
base={"layout_mode":"source","source_pages":[{"page":1,"width":1000,"height":1500,"paper_mm":[210,315]}]}
hp={'hp':'http://www.hancom.co.kr/hwpml/2011/paragraph'}
def run(g,**kw):
 ex={**base,"sections":[{"items":[{"no":10,"source":box,"layout_blocks":[{"role":"text","box":{"x":40,"y":40,"w":800,"h":40},"lines":[[{"t":"자료 검사"}]]}],"figure":{"box":box,"graphic":g,"render_mode":"redraw",**kw}}]}]}
 data,warnings=build_exam(ex)
 z=zipfile.ZipFile(io.BytesIO(data));return z,ET.fromstring(z.read('Contents/section0.xml')),warnings
z,s,w=run(sample)
assert not w,w
assert not any(p.startswith('BinData/') for p in z.namelist())
assert len(s.findall('.//hp:line',hp))+len(s.findall('.//hp:polygon',hp))>=4
assert 'A' in ''.join(s.itertext()) and 'B' in ''.join(s.itertext()) and 'C' in ''.join(s.itertext())
literal={**sample,'texts':[{**sample['texts'][0],'text':'__A__'}]}
_,literal_xml,_=run(literal)
assert '__A__' in ''.join(literal_xml.itertext())
z,s,w=run(tab)
assert not w,w
t=next(t for t in s.findall('.//hp:tbl',hp) if t.get('rowCnt')=='2')
assert len(t.findall('.//hp:tc',hp))==3
assert any(p.get('colSpan')=='2' for p in t.findall('.//hp:cellSpan',hp))
assert '제목' in ''.join(t.itertext())
# 부분 개체를 만들다 실패해도 원본으로 복구하며 중간에 만든 선은 지운다.
png=base64.b64encode(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQx8AAAAASUVORK5CYII=')).decode()
bad={**sample,'tables':[{**table,'rows':0}]}
z,s,w=run(bad,png=png,original_png=png)
assert any('원본 이미지' in x for x in w)
assert not s.findall('.//hp:polygon',hp)
assert len(s.findall('.//hp:pic',hp))==1
print('편집 가능한 지도 선·글자·병합 표 및 실패 시 원본 복구 검사 통과')
