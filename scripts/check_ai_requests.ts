// 실제 SDK와 HTTP 응답을 쓰되 네트워크는 가짜 fetch로 막는다. 유료 AI 호출 없음.
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { apiErrorDetail, ReadError } from "@/lib/ai/claude";
import { pageReadingJsonSchema, PageOutputS, PageReadingS } from "@/lib/ai/page-schema";
import { readPage } from "@/lib/ai/read-page";
import { api, ApiError } from "@/lib/client/api";
import { failFrom } from "@/lib/ai/http";

const schema = pageReadingJsonSchema();
function inspect(node: any): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "object") assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), "API에는 선택 칸을 보내지 않는다");
  for (const child of Object.values(node)) inspect(child);
}
inspect(schema);
assert.ok(schema.$defs, "반복되는 조각은 참조로 재사용한다");
const item = { no:1,no_text:"1.",points:4,column:1,stem:[{kind:"t",text:"조건을 읽으시오."}],bogi:[],choices:[],figures:[],source:{x:10,y:20,w:300,h:200},unsure:[],
  layout_blocks:[{role:"box",region:{x:20,y:80,w:260,h:80},title:"조건",choice_no:0,lines:[[{kind:"m",text:"l \\parallel m"}]]}] };
const page = { header:{present:false,title:"",target_label:"",target:"",date:""},boxes:[],sections:[{title:"",items:[item]}],
  footer:{present:false,right_top:"",right_bottom:"",notice:""},page_end_note:"",print_area:{x:0,y:0,w:1000,h:1500},unsure:[],page_artifacts:[],page_rules:[] };
const oldPage = { ...page, page_artifacts:undefined, page_rules:undefined, sections:[{title:"",items:[{...item,layout_blocks:undefined}]}] };
assert.ok(PageReadingS.safeParse(oldPage).success, "옛 보관함 결과와 호환된다");
assert.equal(PageOutputS.safeParse(oldPage).success, false, "새 변환에서 배치 정보 누락은 잡아낸다");

function streamReply(text: string): Response {
  const events = [
    {type:"message_start",message:{id:"msg_test",type:"message",role:"assistant",model:"claude-opus-5-5",content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:0}}},
    {type:"content_block_start",index:0,content_block:{type:"text",text:""}},
    {type:"content_block_delta",index:0,delta:{type:"text_delta",text}},
    {type:"content_block_stop",index:0},
    {type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:50}},
    {type:"message_stop"},
  ];
  return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
}
function rejected(message: string): Response {
  return new Response(JSON.stringify({type:"error",error:{type:"invalid_request_error",message}}),{status:400,headers:{"content-type":"application/json","request-id":"req_test"}});
}
const savedFetch = globalThis.fetch;
let calls: any[] = [];
let respond: (n: number) => Response = () => streamReply(JSON.stringify(page));
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url.split("?")[0], "https://api.anthropic.com/v1/messages", "테스트는 외부 네트워크를 사용하지 않는다");
  calls.push(await request.clone().json());
  return respond(calls.length);
};
const image = {data:"dGVzdA==",mediaType:"image/png" as const,width:1000,height:1500};
const read = () => readPage(image,{page:1,total:1,apiKey:"request-test-placeholder",deadline:Date.now()+120000});
try {
  const normal = await read();
  assert.equal(calls.length,1);
  assert.deepEqual(normal.reading.sections[0].items[0].layout_blocks,item.layout_blocks);
  assert.ok(calls[0].output_config.format);
  calls=[];
  respond = n => n === 1 ? rejected("Schema is too complex for compilation.") : streamReply("```json\n"+JSON.stringify(page)+"\n```");
  const recovered = await read();
  assert.equal(calls.length,2);
  assert.ok(calls[0].output_config.format);
  assert.equal(calls[1].output_config.format,undefined);
  assert.equal(calls[1].model,calls[0].model);
  assert.deepEqual(calls[1].messages,calls[0].messages);
  assert.ok(calls[1].system[0].text.includes("layout_blocks"));
  assert.deepEqual(recovered.reading.sections[0].items[0].layout_blocks,item.layout_blocks);
  assert.equal(recovered.usage.output,50);
  calls=[];
  respond = n => n === 1 ? rejected("Schema is too complex for compilation.") : streamReply(JSON.stringify(oldPage));
  await assert.rejects(read, (e: unknown) => e instanceof ReadError && e.code === "bad_answer" && e.usage?.output === 50);
  assert.equal(calls.length,2,"복구 답도 검사한다");
  calls=[];
  respond = () => rejected("Schema is too complex for compilation.");
  await assert.rejects(read,(e: unknown)=>e instanceof ReadError && !!e.detail?.includes("req_test"));
  assert.equal(calls.length,2,"복구는 한 번만 한다");
  calls=[];
  const realNow = Date.now;
  try {
    respond=()=>{ Date.now=()=>realNow()+115000; return rejected("Schema is too complex for compilation."); };
    await assert.rejects(read,(e: unknown)=>e instanceof ReadError && e.code === "timeout");
    assert.equal(calls.length,1,"마감 시간이 부족하면 복구 호출을 시작하지 않는다");
  } finally { Date.now=realNow; }
  for (const message of ["Your credit balance is too low", "max_tokens is invalid", "image source is invalid"]) {
    calls=[]; respond=()=>rejected(message);
    await assert.rejects(read,(e: unknown)=>e instanceof ReadError && !!e.detail?.includes(message));
    assert.equal(calls.length,1,"스키마 외 오류는 중복 호출하지 않는다");
  }
  calls=[];
  const stop = new AbortController();
  respond=()=>{ stop.abort(); return rejected("Schema is too complex for compilation."); };
  await assert.rejects(()=>readPage(image,{page:1,total:1,apiKey:"request-test-placeholder",signal:stop.signal}));
  assert.equal(calls.length,1,"취소 후에는 복구 호출을 보내지 않는다");
  const error = new Anthropic.BadRequestError(400,{error:{type:"invalid_request_error",message:"bad sk-ant-private-placeholder data:image/png;base64,"+"A".repeat(240)}},undefined,new Headers({"request-id":"req_safe"}));
  assert.ok(!apiErrorDetail(error).includes("private-placeholder"));
  assert.ok(!apiErrorDetail(error).includes("A".repeat(100)));
  globalThis.fetch=async()=>new Response(JSON.stringify({error:"요청 오류",detail:"Claude 400: schema unsupported · req_test"}),{status:502});
  await assert.rejects(()=>api("/api/read/page"),(e: unknown)=>e instanceof ApiError && e.status===502 && !!e.detail?.includes("req_test"));
  const body = await failFrom(new ReadError("bad_answer","검사 실패","layout_blocks 없음")).json();
  assert.equal(body.detail,"layout_blocks 없음");
  console.log("AI 요청: 선택 칸 0개·참조 재사용·400 복구·배치 검증·중복 호출 방지·취소·오류 상세·열쇠 숨김 통과");
} finally {
  globalThis.fetch=savedFetch;
}
