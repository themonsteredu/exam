// 대용량 저장·복구와 저장 중단 시 기존 체크포인트 보존을 네트워크 없이 검사한다.
import assert from "node:assert/strict";
import { loadExamCheckpoint, saveExamCheckpoint, EXAM_PART_BYTES } from "@/lib/client/exam-storage";
import { ApiError } from "@/lib/client/api";

const docId = "11111111-1111-4111-8111-111111111111";
const exam = { sections:[{items:[{no:1,stem:[{t:"문제"}]}]}], source_pages:[{page:1}], payload:"가".repeat(1_350_000) };
const oldFetch = globalThis.fetch;
const files = new Map<string, Blob>();
let number = 0, patches: any[] = [], uploadFailAt = 0, requests = 0;
globalThis.fetch = async (input, init) => {
  requests++;
  const url = String(input);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  if (url === "/api/files/upload-url") {
    const path = `generated/${docId}/${String(++number).padStart(5,"0")}.bin`;
    return Response.json({path,url:`https://storage.test/${number}`,headers:{"content-type":"application/octet-stream"}});
  }
  if (url.startsWith("https://storage.test/") && init?.method === "PUT") {
    if (number === uploadFailAt) return new Response("fail",{status:503});
    files.set(`generated/${docId}/${String(number).padStart(5,"0")}.bin`,init.body as Blob);
    return new Response("ok");
  }
  if (url === `/api/documents/${docId}` && init?.method === "PATCH") {
    patches.push(body); return Response.json({doc:{id:docId}});
  }
  if (url === "/api/files/download-url") return Response.json({url:`https://storage.test/get/${encodeURIComponent(body.path)}`});
  if (url.startsWith("https://storage.test/get/")) {
    const path=decodeURIComponent(url.slice("https://storage.test/get/".length));
    const file=files.get(path); return file ? new Response(file) : new Response("missing",{status:404});
  }
  throw new Error(`unexpected request: ${url}`);
};
try {
  const saved = await saveExamCheckpoint(docId,exam,2.401954,undefined,["쪽 안내"]);
  assert.equal(saved.parts.length,2);
  assert.ok(saved.bytes > EXAM_PART_BYTES);
  assert.equal(files.get(saved.parts[0])?.size,EXAM_PART_BYTES);
  assert.equal(patches.length,1);
  assert.equal(patches[0].cost_usd,2.401954);
  assert.equal(patches[0].item_count,1);
  assert.deepEqual(saved.pageProblems,["쪽 안내"]);
  assert.deepEqual(await loadExamCheckpoint(docId,saved),exam,"UTF-8 글자 사이에서 나뉘어도 원본대로 복원한다");
  assert.deepEqual(await loadExamCheckpoint(docId,exam),exam,"이전 보관함 데이터도 읽는다");
  const before=patches.length;
  uploadFailAt=number+2;
  await assert.rejects(()=>saveExamCheckpoint(docId,exam,3),e=>e instanceof ApiError);
  assert.equal(patches.length,before,"모든 조각을 저장하기 전에는 기존 결과를 바꾸지 않는다");
  assert.deepEqual(await loadExamCheckpoint(docId,saved),exam);
  const beforeBad=requests;
  await assert.rejects(()=>loadExamCheckpoint(docId,{...saved,parts:[`generated/22222222-2222-4222-8222-222222222222/part.bin`]}));
  await assert.rejects(()=>loadExamCheckpoint(docId,{...saved,parts:[saved.parts[0],saved.parts[0]]}));
  assert.equal(requests,beforeBad,"다른 문서나 중복 경로는 내려받지 않는다");
  await assert.rejects(()=>loadExamCheckpoint(docId,{...saved,bytes:saved.bytes+1}));
  console.log("대용량 읽기 결과: 4MB 조각 저장·한글 복원·중단 시 기존 결과 보존·경로 검사 통과");
} finally { globalThis.fetch=oldFetch; }
