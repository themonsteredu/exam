// API 호출 없이 AI 응답 검사·원본 복구·사진 처리 분류·병합 표·출력 경로를 검사한다.
import assert from "node:assert/strict";
import sample from "@/data/graphic_example.json";
import { checkGraphic } from "@/lib/graphic/schema";
import { judgeGraphic } from "@/lib/ai/read-graphic";
import { assembleExam, figureKey } from "@/lib/ai/assemble";
import { tableCells } from "@/lib/graphic/render";
import { attachFigurePngs } from "@/lib/figure/render-exam";
import type { PageReading } from "@/lib/ai/page-schema";

const r = judgeGraphic(JSON.stringify({ graphic: sample, unsure: ["도로 형태 확인", 123], notes: "test" }));
assert.equal(r.errors.length, 0); assert.equal(r.graphic?.kind, "map"); assert.equal(r.unsure.length, 1);
assert.ok(checkGraphic({ ...sample, texts: sample.texts.slice(0, 2) }).errors.some(e => e.includes("C")));
assert.ok(checkGraphic({ ...sample, paths: [{ ...sample.paths[0], points: [[0,0],[1100,0]] }] }).errors.length);
assert.ok(checkGraphic({ ...sample, svg: "<script>alert(1)</script>" }).errors.length);
const photo = judgeGraphic(JSON.stringify({ graphic: { ...sample, kind: "photo", paths: [], ellipses: [], texts: [], critical_labels: [] } }));
assert.equal(photo.graphic?.kind, "photo");
const table = { x:0,y:0,w:1000,h:600,rows:2,cols:2,col_widths:[1,2],row_heights:[1,1],size:30,
  cells:[{row:0,col:0,row_span:1,col_span:2,text:"제목"},{row:1,col:0,row_span:1,col_span:1,text:"1"},{row:1,col:1,row_span:1,col_span:1,text:"2"}] };
assert.equal(checkGraphic({ ...sample, kind:"table", paths:[],ellipses:[],texts:[],tables:[table],critical_labels:["제목","1","2"] }).errors.length,0);
assert.equal(tableCells(table)[0].w,1000);
assert.ok(checkGraphic({...sample,tables:[{...table,cells:[...table.cells,{row:0,col:1,row_span:1,col_span:1,text:"중복"}]}]}).errors.some(e=>e.includes("겹칩니다")));
const reading: PageReading = {
  header:{present:false,title:"",target_label:"",target:"",date:""}, boxes:[], footer:{present:false,right_top:"",right_bottom:"",notice:""},print_area:{x:0,y:0,w:1000,h:1500}, page_end_note:"",unsure:[],
  sections:[{title:"",items:[{no:10,no_text:"10.",points:4,column:1,stem:[],choices:[],bogi:[],figures:[{x:50,y:100,w:400,h:240,kind:"map",place:"below"}],source:{x:0,y:0,w:500,h:700},unsure:[]}]}],
};
const args = [{ meta:{page:1,original:{width:1000,height:1500},scale:1},reading }];
const figures = new Map([[figureKey(1,0,0,0),{crop:{x:50,y:100,w:400,h:240},scale:1,sourcePng:"original",sourcePngSize:[400,240] as [number,number],reading:r}]]);
const exam=assembleExam(args,figures), fig=exam.sections[0].items[0].figure;
assert.equal(fig.render_mode,"redraw"); assert.equal(fig.original_png,"original"); assert.ok(fig.graphic);
const fallback=assembleExam(args,new Map([[figureKey(1,0,0,0),{crop:{x:50,y:100,w:400,h:240},scale:1,sourcePng:"original",error:"AI timeout"}]]));
assert.equal(fallback.sections[0].items[0].figure.render_mode,"original");
const reviewed=attachFigurePngs(exam,[{section:0,index:0,no:10,png:"redraw",size:[400,240]}],true);
assert.equal(reviewed.sections[0].items[0].figure.original_png,"original");
assert.equal(reviewed.sections[0].items[0].figure.png,"redraw");
assert.equal(fig.png,undefined);
console.log("지도/표 재작성·필수 표기·사진 분류·원본 복구·비교 자료 검사 통과");
