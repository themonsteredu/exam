// 실제 서버 워크플로 + Chromium + Python, AI만 고정 응답. 사용자의 API 키를 쓰지 않는다.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const origin = "http://localhost:3197";
const secret = "background-regression-only-not-a-real-secret-0123456789";
const body = `v1.${Math.floor(Date.now() / 1000) + 3600}.1`;
const token = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
const device = "a".repeat(43);
const cookie = `exam_session=${token}; exam_device=${device}`;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3197"], {
  env: { ...process.env, EXAM_STORE: "local", EXAM_FAKE_AI: "1", APP_SECRET: secret, WORKFLOW_MAX_INLINE_STEPS: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", d => { logs = (logs + d).slice(-20000); });
server.stderr.on("data", d => { logs = (logs + d).slice(-20000); });
const pause = ms => new Promise(r => setTimeout(r, ms));
async function call(url, method = "GET", value) {
  const res = await fetch(origin + url, { method, headers: { cookie, "content-type": "application/json" }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
  const data = await res.json(); assert.ok(res.ok, `${url}: ${JSON.stringify(data)}`); return data;
}
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(origin + "/internal-render")).ok) break; } catch {}
    if (i === 59) throw new Error("서버 시작 시간 초과");
    await pause(1000);
  }
  assert.equal((await fetch(origin + "/api/jobs")).status, 401, "인증 없는 접수 차단");
  await call("/api/settings/api-key", "POST", { key: "sk-ant-api03-fixture-only-" + "b".repeat(40) });
  const { doc } = await call("/api/documents", "POST", { title: "서버 제작 창 닫기 검증" });
  const bytes = await readFile("samples/exam_p1.jpg");
  const signed = await call("/api/files/upload-url", "POST", { docId: doc.id, kind: "original", name: "exam_p1.jpg", type: "image/jpeg", size: bytes.length, index: 0 });
  const put = await fetch(new URL(signed.url, origin), { method: "PUT", headers: signed.headers, body: bytes }); assert.ok(put.ok);
  await call(`/api/documents/${doc.id}`, "PATCH", { original_files: [{ path: signed.path, name: "exam_p1.jpg", size: bytes.length, type: "image/jpeg" }] });
  browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
  await browser.setCookie({ name: "exam_session", value: token, domain: "localhost", path: "/" }, { name: "exam_device", value: device, domain: "localhost", path: "/" });
  const tab = await browser.newPage(); await tab.goto(origin + "/internal-render");
  const started = await tab.evaluate(async id => {
    const res = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ docId: id }) });
    return { status: res.status, ...await res.json() };
  }, doc.id);
  assert.equal(started.status, 202, JSON.stringify(started));
  await browser.close(); browser = null;
  console.log("제작을 요청한 브라우저를 종료했습니다.");
  const again = await call("/api/jobs", "POST", { docId: doc.id });
  assert.equal(again.runId, started.runId, "중복 접수는 같은 작업");
  await pause(10000); // 창·상태 조회 없이도 서버가 진행하는 구간
  let finished;
  for (let i = 0; i < 90; i++) {
    const status = await call(`/api/jobs/${doc.id}`);
    if (status.job?.status === "failed") throw new Error(status.job.error);
    if (status.job?.status === "completed") { finished = status; break; }
    if (i % 10 === 0) console.log(status.job?.progress?.message || "접수 대기");
    await pause(3000);
  }
  assert.ok(finished, "서버 제작 시간 초과");
  assert.equal(finished.doc.status, "done");
  assert.equal(finished.doc.cost_usd, 0);
  assert.equal(finished.doc.original_files[0].path, signed.path);
  const file = await readFile(`.data/files/${finished.doc.hwpx_path}`);
  assert.equal(file.subarray(0, 2).toString(), "PK", "완성된 HWPX 저장");
  const chunks = await Promise.all(finished.doc.exam_json.parts.map(p => readFile(`.data/files/${p}`)));
  const exam = JSON.parse(Buffer.concat(chunks).toString());
  assert.ok(exam.sections.flatMap(s => s.items).some(it => it.figure?.png), "서버 그림 렌더링");
  const store = JSON.parse(await readFile(".data/store.json", "utf8"));
  assert.ok(store.usage.every(u => u.model === "fake" && u.usd === 0), "유료 AI 없음");
  async function waitForRun(runId) {
    for (let i = 0; i < 90; i++) {
      const status = await call(`/api/jobs/${doc.id}`);
      if (status.job?.runId === runId && status.job.status === "failed") throw new Error(status.job.error);
      if (status.job?.runId === runId && status.job.status === "completed") return status;
      await pause(2000);
    }
    throw new Error("다시 만들기 완료 시간 초과");
  }
  const figureIndex = exam.sections[0].items.findIndex(it => it.figure?.commands && it.figure.box);
  assert.ok(figureIndex >= 0);
  const reread = await call("/api/jobs", "POST", { docId: doc.id, mode: "reread", targets: [{ section: 0, index: figureIndex, figureIndex: 0, name: "그림", reasons: ["통합 검사"] }] });
  assert.notEqual(reread.runId, started.runId);
  const rereadResult = await waitForRun(reread.runId);
  assert.equal(rereadResult.doc.status, "done");
  const readsBefore = JSON.parse(await readFile(".data/store.json", "utf8")).usage.length;
  await call("/api/settings/api-key", "DELETE");
  const rebuilt = await call("/api/jobs", "POST", { docId: doc.id, mode: "rebuild" });
  assert.notEqual(rebuilt.runId, reread.runId);
  const rebuiltResult = await waitForRun(rebuilt.runId);
  assert.equal(rebuiltResult.doc.status, "done");
  assert.equal(JSON.parse(await readFile(".data/store.json", "utf8")).usage.length, readsBefore, "다시 만들기는 API 키·AI 호출 불필요");
  const cancelled = await call("/api/jobs", "POST", { docId: doc.id, mode: "rebuild" });
  await call(`/api/jobs/${doc.id}`, "DELETE");
  await pause(3000);
  const cancelledResult = await call(`/api/jobs/${doc.id}`);
  assert.equal(cancelledResult.job.runId, cancelled.runId);
  assert.equal(cancelledResult.job.status, "cancelled");
  assert.equal(cancelledResult.doc.hwpx_path, rebuiltResult.doc.hwpx_path, "취소해도 기존 완성 파일 유지");
  console.log("브라우저 종료 → 서버 제작 완료 → 원본·도형·한글 보관 / 중복 접수·인증 검사 통과");
  console.log("선택 그림 다시 읽기·API 키 없는 다시 만들기·접수 직후 취소 검사 통과");
} catch (err) {
  console.error(logs); throw err;
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
