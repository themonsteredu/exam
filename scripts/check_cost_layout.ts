import assert from "node:assert/strict";
import { assembleExam, figureJobs } from "@/lib/ai/assemble";
import { itemFigures } from "@/lib/figure/item-figures";
import { attachFigurePngs } from "@/lib/figure/render-exam";
import { readCached, readingCacheKey } from "@/lib/client/read-cache";
import { ApiError } from "@/lib/client/api";
import { PageOutputS } from "@/lib/ai/page-schema";

const region = { x: 50, y: 200, w: 50, h: 40, kind: "diagram", place: "below" };
const item = { no: 14, no_text: "14.", points: 4, column: 1,
  stem: [{ kind: "t", text: "다음 그림 중 옳은 것은?" }], choices: [[], [], [], [], []], bogi: [],
  figures: Array.from({length:5}, (_,i)=>({...region,x:50+i*60})),
  source: {x:40,y:130,w:400,h:300}, unsure: [], layout_blocks: [] };
const reading: any = { header:{present:true,title:"수학 중간고사",target_label:"학년",target:"1학년",date:"2026년"},
  boxes:[],footer:{present:false,right_top:"",right_bottom:"",notice:""},page_end_note:"",print_area:{x:10,y:10,w:980,h:1380},
  sections:[{title:"선택형",items:[item]}],unsure:[],page_rules:[],
  page_artifacts:[{kind:"header",region:{x:40,y:20,w:800,h:60},boxed:true,lines:[[{kind:"t",text:"수학 중간고사"}]]}] };
assert.ok(PageOutputS.safeParse(reading).success);
const jobs = figureJobs(1,reading);
assert.equal(jobs.length,5);
const found = new Map(jobs.map((j,i)=>[j.key,{crop:j.region,scale:1,reading:{commands:{base:10,points:[],elements:[]},
  anchors:[],errors:[],warnings:[],unsure:[],notes:"",attempts:1}}]));
const exam = assembleExam([{meta:{page:1,original:{width:1000,height:1414},scale:1},reading}],found);
assert.equal(itemFigures(exam.sections[0].items[0]).length,5,"all five choices survive assembly");
assert.deepEqual(exam.source_pages[0].text_blocks[0].lines, [[{t:"수학 중간고사"}]]);
assert.equal(exam.source_pages[0].decorations.length,0,"header is not cropped");
const outputs = jobs.map((_,figureIndex)=>({section:0,index:0,figureIndex,no:14,png:"png"+figureIndex,size:[100,80] as [number,number]}));
const attached = attachFigurePngs(exam,outputs);
assert.deepEqual(itemFigures(attached.sections[0].items[0]).map(f=>f.png),["png0","png1","png2","png3","png4"]);
const legacy = {sections:[{items:[{no:1,figure:{commands:{}}}]}]};
assert.equal(itemFigures(legacy.sections[0].items[0]).length,1);
assert.equal(attachFigurePngs(legacy,[{section:0,index:0,no:1,png:"legacy"}]).sections[0].items[0].figure.png,"legacy");
const input = {image:"image-a",model:"claude-sonnet-5-5",page:1,docId:"first"};
assert.equal(await readingCacheKey("page",input,"owner-a"),await readingCacheKey("page",{...input,docId:"second"},"owner-a"));
assert.notEqual(await readingCacheKey("page",input,"owner-a"),await readingCacheKey("page",{...input,model:"claude-opus-5-5"},"owner-a"));
assert.notEqual(await readingCacheKey("page",input,"owner-a"),await readingCacheKey("page",input,"owner-b"));
let calls=0;
const savedFetch=globalThis.fetch;
const usage={model:"claude-sonnet-5-5",input:100,output:20,cacheWrite:0,cacheRead:0,usd:.25};
try {
  globalThis.fetch=async()=>{calls++; return Response.json({reading,usage});};
  const signal=new AbortController().signal;
  const first:any=await readCached("page",input,"owner-a",signal);
  const second:any=await readCached("page",{...input,docId:"second"},"owner-a",signal);
  assert.equal(calls,1,"reupload reuses the paid result");
  assert.equal(first.usage.usd,.25); assert.equal(second.usage.usd,0); assert.equal(second.cached,true);
  const concurrent:any[]=await Promise.all([readCached("page",{...input,image:"parallel"},"owner-a",signal),readCached("page",{...input,image:"parallel"},"owner-a",signal)]);
  assert.equal(calls,2,"concurrent identical requests share one call");
  assert.equal(concurrent.reduce((n,r)=>n+r.usage.usd,0),.25);
  globalThis.fetch=async()=>{calls++;return Response.json({error:"timeout",usage:{usd:.13}},{status:504});};
  for(let i=0;i<2;i++) await assert.rejects(readCached("page",{...input,image:"failure"},"owner-a",signal),(e:any)=>e instanceof ApiError&&e.usage?.usd===.13);
  assert.equal(calls,4,"failed responses are not cached");
  globalThis.fetch=async()=>{calls++;return Response.json({figure:{errors:["invalid"]},usage});};
  await readCached("figure",input,"owner-a",signal); await readCached("figure",input,"owner-a",signal);
  assert.equal(calls,6,"invalid figure commands are not cached");
  const stopped=new AbortController();stopped.abort();
  await assert.rejects(readCached("page",input,"owner-a",stopped.signal));
  assert.equal(calls,6,"cancellation cannot start a paid call");
} finally {globalThis.fetch=savedFetch;}
console.log("All figures, editable headers, per-model reuse, deduplication and failure-cost checks passed (no paid AI).");
