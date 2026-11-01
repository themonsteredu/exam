// API 호출 없이 AI 응답 검사·사진 처리·병합 표·빈 자리를 검사한다 (원본을 잘라 붙이지 않는다).
import assert from "node:assert/strict";
import sample from "@/data/graphic_example.json";
import { checkGraphic } from "@/lib/graphic/schema";
import { judgeGraphic } from "@/lib/ai/read-graphic";
import { assembleExam, figureJobs, figureKey } from "@/lib/ai/assemble";
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
const figures = new Map([[figureKey(1,0,0,0),{crop:{x:50,y:100,w:400,h:240},scale:1,reading:r}]]);
const exam=assembleExam(args,figures), fig=exam.sections[0].items[0].figure;
assert.ok(fig.graphic,"지도는 그리기 명령으로 다시 그린다"); assert.equal(fig.original_png,undefined,"원본을 잘라 붙이지 않는다");
const failed=assembleExam(args,new Map([[figureKey(1,0,0,0),{crop:{x:50,y:100,w:400,h:240},scale:1,error:"AI timeout"}]]));
assert.equal(failed.sections[0].items[0].figure.placeholder_note,"그림 자리","읽지 못한 그림은 빈 자리");
assert.equal(failed.sections[0].items[0].figure.original_png,undefined);
const photoPage: PageReading = { ...reading, sections:[{title:"",items:[{...reading.sections[0].items[0],figures:[{x:50,y:100,w:400,h:240,kind:"photo",place:"below"}]}]}] };
assert.equal(figureJobs(1,photoPage).length,0,"사진은 AI 에게 보내지 않는다");
assert.equal(assembleExam([{ meta:args[0].meta, reading:photoPage }],new Map()).sections[0].items[0].figure.placeholder_note,"사진 자리");
const drawn=attachFigurePngs(exam,[{section:0,index:0,figureIndex:0,no:10,png:"redraw",size:[400,240]}]);
assert.equal(drawn.sections[0].items[0].figure.png,"redraw");
const broken=attachFigurePngs(exam,[{section:0,index:0,figureIndex:0,no:10,error:"bad"}]);
assert.equal(broken.sections[0].items[0].figure.placeholder_note,"그림 자리");
assert.equal(fig.png,undefined);
console.log("지도/표 다시 그리기·필수 표기·사진은 빈 자리·읽기 실패는 빈 자리·원본 조각 없음 검사 통과");
