import assert from "node:assert/strict";
import { applyPaper, assembleExam, figureJobs, joinPrintedLines, layoutFor, paperOf, replaceFigureReading, reviewFigures, usableReading } from "@/lib/ai/assemble";
import { itemOrderRotations, uprightBox, uprightExam, voteTextDirection } from "@/lib/ai/orientation";
import { rotateSpec, shapeDeviation, uprightFigure } from "@/lib/figure/review";
import { itemFigures } from "@/lib/figure/item-figures";
import { attachFigurePngs } from "@/lib/figure/render-exam";
import { readCached, readingCacheKey } from "@/lib/client/read-cache";
import { ApiError } from "@/lib/client/api";
import { PageReadingS } from "@/lib/ai/page-schema";

const region = { x: 50, y: 200, w: 50, h: 40, kind: "diagram", place: "below" };
const item = { no: 14, no_text: "14.", points: 4, column: 1, choice_layout: "column",
  stem: [{ kind: "t", text: "다음 그림 중 옳은 것은?" }], choices: [[], [], [], [], []], bogi: [],
  figures: Array.from({length:5}, (_,i)=>({...region,x:50+i*60})),
  source: {x:40,y:130,w:400,h:300}, unsure: [] };
const reading: any = { header:{present:true,title:"수학 중간고사",target_label:"학년",target:"1학년",date:"2026년"},
  boxes:[],footer:{present:false,right_top:"",right_bottom:"",notice:""},page_end_note:"",print_area:{x:10,y:10,w:980,h:1380},
  sections:[{title:"선택형",items:[item]}],unsure:[] };
assert.ok(PageReadingS.safeParse(reading).success);
const jobs = figureJobs(1,reading);
assert.equal(jobs.length,5);
const found = new Map(jobs.map((j,i)=>[j.key,{crop:j.region,scale:1,reading:{commands:{base:10,points:[],elements:[]},
  anchors:[],errors:[],warnings:[],unsure:[],notes:"",attempts:1}}]));
const exam = assembleExam([{meta:{page:1,original:{width:1000,height:1414},scale:1},reading}],found);
assert.equal(itemFigures(exam.sections[0].items[0]).length,5,"all five choices survive assembly");
assert.equal(exam.layout_mode,undefined,"2단 본문 (원본 배치 따라 하기 없음)");
assert.equal(exam.header.title,"수학 중간고사","머리 제목은 글자로");
assert.ok(!JSON.stringify(exam).includes("original_png"),"원본 조각 없음");
const outputs = jobs.map((_,figureIndex)=>({section:0,index:0,figureIndex,no:14,png:"png"+figureIndex,size:[100,80] as [number,number]}));
const attached = attachFigurePngs(exam,outputs);
assert.deepEqual(itemFigures(attached.sections[0].items[0]).map(f=>f.png),["png0","png1","png2","png3","png4"]);
const legacy = {sections:[{items:[{no:1,figure:{commands:{}}}]}]};
assert.equal(itemFigures(legacy.sections[0].items[0]).length,1);
assert.equal(attachFigurePngs(legacy,[{section:0,index:0,figureIndex:0,no:1,png:"legacy"}]).sections[0].items[0].figure.png,"legacy");
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
// GPT 판 상자 글: 인쇄된 줄마다 끊긴 것을 잇는다 (항목 첫머리·문장 끝은 그대로, 조사로 시작하면 띄우지 않음)
{
  const joined=joinPrintedLines([
    [{t:"(가) 점 M은 선분 AB의 중점이고, 점 N은 선분 BC"}],[{t:"의 중점이다."}],
    [{t:"(나) "},{m:"x"},{t:"의 값은 "}],[{m:"y"},{t:"보다 크다."}],
    [{t:"직사각형의 넓이가 56일"}],[{t:"때, 다음을 구하시오."}],[{t:"(다) 새 항목"}],
  ]);
  const text=(l:any[])=>l.map((p:any)=>p.t??`[${p.m}]`).join("");
  assert.deepEqual(joined.map(text),[
    "(가) 점 M은 선분 AB의 중점이고, 점 N은 선분 BC의 중점이다.",
    "(나) [x]의 값은 [y]보다 크다.",
    "직사각형의 넓이가 56일 때, 다음을 구하시오.",
    "(다) 새 항목",
  ]);
}
// 원본 용지: B4 PDF(728×1031pt = 257×364mm) 면 B4 로, 나머지는 A4 (2026-11-01 호남삼육중: B4 를 A4 4쪽에 맞추느라 글자·그림이 줄어듦)
{
  assert.equal(paperOf({width_mm:256.9,height_mm:363.9}).name,"B4");
  assert.equal(paperOf({width_mm:250,height_mm:353}).name,"B4","ISO B4 도 B4");
  assert.equal(paperOf({width_mm:209.9,height_mm:296.9}).name,"A4");
  assert.equal(paperOf(undefined).name,"A4","사진(크기 모름)은 A4");
  assert.equal(paperOf({width_mm:364,height_mm:257}).name,"A4","가로 쪽은 A4");
  // 그림이 충분히 커야 최소 크기(12mm)에 걸리지 않는다
  const big:any={...reading,sections:[{title:"선택형",items:[{...item,figures:[{...region,w:300,h:200}]}]}]};
  const bigFound=new Map(figureJobs(1,big).map((j)=>[j.key,{crop:j.region,scale:1,reading:{commands:{base:10,points:[],elements:[]},
    anchors:[],errors:[],warnings:[],unsure:[],notes:"",attempts:1}}]));
  const a4=assembleExam([{meta:{page:1,original:{width:1000,height:1414},scale:1},reading:big}],bigFound);
  const b4=assembleExam([{meta:{page:1,original:{width:1000,height:1414},scale:1,paper_mm:{width_mm:256.9,height_mm:363.9}},reading:big}],bigFound);
  assert.equal(b4.paper?.name,"B4","B4 원본이면 exam.paper");
  assert.equal(a4.paper,undefined,"A4 원본은 용지를 적지 않음");
  const w4=itemFigures(a4.sections[0].items[0])[0].width_mm, wb=itemFigures(b4.sections[0].items[0])[0].width_mm;
  assert.ok(Math.abs(wb/w4-257/210)<0.02,`그림 크기는 용지 너비 비율로 (${w4} → ${wb})`);
  assert.equal(b4.source_pages[0].width_mm,256.9);
  // 보관함 '다시 만들기': A4 크기로 읽은 결과를 B4 로 옮김 (그림 크기 늘림, PNG 지움, 한 번만)
  const withPng=attachFigurePngs(a4,[{section:0,index:0,figureIndex:0,no:14,png:"old",size:[100,80]}]);
  const moved=applyPaper(withPng,paperOf({width_mm:257,height_mm:364}));
  const f0=itemFigures(moved.sections[0].items[0])[0];
  assert.ok(Math.abs(f0.width_mm/w4-257/210)<0.02 && f0.png===undefined,"applyPaper 가 그림을 늘리고 PNG 를 지움");
  assert.equal(applyPaper(moved,paperOf({width_mm:257,height_mm:364})),moved,"이미 용지가 있으면 그대로");
  assert.equal(applyPaper(withPng,paperOf({width_mm:210,height_mm:297})),withPng,"A4 면 그대로");
  assert.ok(Math.abs(layoutFor({width_mm:257}).columnWidthMm-89*257/210)<1e-9);
}
// 그림 다시 읽기: 그 그림의 확인할 곳만 바꾸고, 쓸 만한 결과일 때만 바꾸며, 같은 문제로 또 권하지 않는다
{
  const good = { commands: { base: 10, points: [{ id: "A", at: [0, 0] }, { id: "B", at: [5, 0] }, { id: "C", at: [0, 4] }], elements: [{ type: "segment", points: ["A", "B"] }] },
    anchors: [], errors: [], warnings: [], unsure: ["새 그림의 확인할 곳"], notes: "", attempts: 1 } as any;
  const item: any = { no: 3, unsure: ["그림이 2개 있습니다", "그림: 첫 그림 문장", "그림: 둘째 그림 문장"],
    figure: { box: { page: 1, x: 0, y: 0, w: 100, h: 80 }, commands: { base: 1, elements: [] }, unsure_notes: ["그림: 첫 그림 문장"] },
    extra_figures: [{ box: { page: 1, x: 0, y: 100, w: 100, h: 80 }, commands: { base: 1, elements: [] }, unsure_notes: ["그림: 둘째 그림 문장"] }] };
  assert.equal(usableReading({ crop: { x: 0, y: 0, w: 10, h: 10 }, scale: 1, reading: { ...good, commands: undefined, rawCommands: {}, errors: ["x"] } }, "diagram"), false, "망가진 결과는 쓰지 않음");
  assert.equal(usableReading({ crop: { x: 0, y: 0, w: 10, h: 10 }, scale: 1, error: "502" }, "diagram"), false);
  replaceFigureReading(item, 0, { crop: { x: 0, y: 0, w: 10, h: 10 }, scale: 1, reading: good }, "점 E 가 원본 자리와 많이 다릅니다");
  assert.deepEqual(item.unsure, ["그림이 2개 있습니다", "그림: 둘째 그림 문장", "그림: 새 그림의 확인할 곳"], "다른 그림과 문항 전체 알림은 그대로");
  assert.equal(item.figure.reread.count, 1);
  // 같은 문제(hint)로 이미 다시 읽은 그림은 또 권하지 않는다
  const exam: any = { sections: [{ items: [{ no: 1, figure: { box: { page: 1, x: 0, y: 0, w: 10, h: 10 }, placeholder_note: "그림 자리", reread: { count: 1, hint: "그림을 읽지 못해 빈 자리로 두었습니다" } } }, { no: 2, figure: { box: { page: 1, x: 0, y: 0, w: 10, h: 10 }, placeholder_note: "그림 자리" } }] }] };
  assert.deepEqual(reviewFigures(exam).map((t) => t.name), ["2번"], "같은 문제로 다시 읽은 그림은 다시 권하지 않음");
  // 검사를 통과하지 못한 명령도 멈추지 않고 다시 읽기를 권한다
  const broken: any = { sections: [{ items: [{ no: 7, figure: { box: { page: 1, x: 0, y: 0, w: 10, h: 10 }, commands: { base: 6, points: [{ id: "B", polar: { length: 3, angle: 90 } }], elements: [{ type: "angle", points: ["B", "A", "C"], label: "50°" }] } } }] }] };
  assert.equal(reviewFigures(broken)[0]?.name, "7번");
}
// 옆으로 누운 스캔 (2026-11-02 숭의중: 앞뒷면 B4 스캔이 쪽마다 90°·270° 로 누움)
{
  // 글자 줄 방향 다수결: 가로 줄무늬(글자 줄) 그림과 그것을 돌린 그림
  const W = 800, H = 1100, page = new Uint8ClampedArray(W * H).fill(255);
  for (let y = 40; y < H - 40; y += 24) for (let yy = y; yy < y + 12; yy++) for (let x = 60; x < W - 60; x++) if ((x * 7 + yy * 3) % 5 < 3) page[yy * W + x] = 0;
  const turned = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) turned[x * H + (H - 1 - y)] = page[y * W + x];
  assert.equal(voteTextDirection(page, W, H).direction, "horizontal");
  assert.equal(voteTextDirection(turned, H, W).direction, "vertical");
  // 자리 바로 세우기: 90° 는 (x, y) → (H − y, x)
  assert.deepEqual(uprightBox({ x: 100, y: 200, w: 50, h: 30 }, 3000, 2118, 90), { x: 1888, y: 100, w: 30, h: 50 });
  assert.deepEqual(uprightBox({ x: 100, y: 200, w: 50, h: 30 }, 3000, 2118, 270), { x: 200, y: 2850, w: 30, h: 50 });
  // 쪽마다 방향: 1쪽은 문항이 왼쪽→오른쪽(아래 반이 왼쪽 단), 2쪽은 오른쪽→왼쪽(앞뒷면)
  const src = (page: number, x: number, y: number) => ({ page, x, y, w: 500, h: 600 });
  const lying: any = {
    source_pages: [{ page: 1, width: 3000, height: 2118, width_mm: 363.9, height_mm: 256.9 }, { page: 2, width: 3000, height: 2118, width_mm: 363.9, height_mm: 256.9 }],
    sections: [{ items: [
      { no: 1, source: src(1, 786, 1317), figure: { box: { page: 1, x: 858, y: 1324, w: 347, h: 354 }, width_mm: 22.7, size_mm: [22.7, 22.9], anchors: [{ at: "A", px: [900, 1400] }] } },
      { no: 2, source: src(1, 1809, 1180) }, { no: 3, source: src(1, 439, 125) }, { no: 4, source: src(1, 1651, 125) },
      { no: 5, source: src(2, 2228, 170) }, { no: 6, source: src(2, 937, 170) }, { no: 7, source: src(2, 2385, 1088) }, { no: 8, source: src(2, 904, 1088) },
    ] }],
  };
  const turns = itemOrderRotations(lying);
  assert.deepEqual([...turns], [[1, 90], [2, 270]], "앞뒷면 스캔: 쪽마다 방향");
  const up = uprightExam(lying, turns);
  assert.equal(up.paper?.name, "B4", "누운 B4 스캔은 바로 세우면 B4");
  assert.deepEqual([up.source_pages[0].width, up.source_pages[0].height, up.source_pages[0].rotate], [2118, 3000, 90]);
  const f1 = up.sections[0].items[0].figure;
  assert.ok(f1.width_mm > 40 && f1.width_mm < 50, `그림 크기를 바로 세운 쪽으로 다시 잼 (${f1.width_mm}mm, 누운 채로는 22.7mm)`);
  assert.deepEqual(f1.anchors[0].px, [718, 900], "기준점도 바로 세움");
  assert.equal(uprightExam(up, turns), up, "이미 바로 세운 것은 그대로");
  // 누운 채로 그린 그림을 원본 방향으로: 원본 기준점은 바로 선 그림, AI 그림은 90° 돌아감
  const tri: any = { base: 6, points: [{ id: "A", at: [0, 0] }, { id: "B", at: [6, 0] }, { id: "C", at: [1, 4] }], elements: [{ type: "segment", points: ["A", "B"] }, { type: "label", at: "C", text: "C", dir: "N" }] };
  const anchors = [{ at: "A", px: [100, 500] }, { at: "B", px: [400, 500] }, { at: "C", px: [150, 300] }] as any;
  const lyingTri = rotateSpec(tri, 90)!;
  assert.ok(Math.abs(shapeDeviation(lyingTri, anchors)!.rotation + 90) < 1);
  const fixed = uprightFigure(lyingTri, anchors);
  assert.ok(fixed && shapeDeviation(fixed.spec, anchors)!.worst < 0.01 && fixed.change.includes("옆으로 누워"), "누운 그림을 바로 세움");
  assert.equal((fixed!.spec.elements[1] as any).dir, 90, "글자 방향도 같이 돈다");
  assert.equal(uprightFigure(tri, anchors), undefined, "바로 선 그림은 그대로");
  // 쪽 방향을 확인하지 못한 가로 쪽(누운 스캔일 수 있음)에서는 그림을 돌리지 않는다
  const fig = () => ({ box: { page: 1, x: 0, y: 0, w: 10, h: 10 }, commands: JSON.parse(JSON.stringify(lyingTri)), anchors });
  const unsure: any = { source_pages: [{ page: 1, width: 3000, height: 2118 }], sections: [{ items: [{ no: 1, figure: fig() }] }] };
  reviewFigures(unsure);
  assert.equal(unsure.sections[0].items[0].figure.auto_fixes, undefined, "확인 안 된 가로 쪽: 그림을 돌리지 않음");
  const sure: any = { source_pages: [{ page: 1, width: 2118, height: 3000, rotate: 90 }], sections: [{ items: [{ no: 1, figure: fig() }] }] };
  reviewFigures(sure);
  assert.ok(sure.sections[0].items[0].figure.auto_fixes?.[0]?.includes("옆으로 누워"), "바로 선 쪽: 누운 그림을 돌림");
}
console.log("그림 모두 넣기·머리 글자·모델별 재사용·같은 요청 한 번만·실패 요금·상자 글 줄 잇기·원본 용지(B4)·그림 다시 읽기·누운 스캔 검사 통과 (AI 요금 없음)");
