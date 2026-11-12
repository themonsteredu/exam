// 실제 보관함 컴포넌트를 가짜 문서 API로 열어 선택·검색·재시도·삭제를 검사한다. 운영 자료와 AI는 사용하지 않는다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const root = process.cwd();
const duplicateTime = "2026-11-12T00:00:01Z";
const docs = [
  ["one", "2026 중1-1 중간 서석중"], ["two", "2026 중1-2 기말 서석중"],
  ["two-copy", "2026 중1-2 기말 서석중", duplicateTime],
  ["three", "2025 중1-2 기말 서석중"], ["four", "2026 중2-2 중간 동성여중"],
  ["five", "2026 고1-2 기말 동아여고"], ["unknown", "분류 없는 시험지"],
  ["failed-one", "2025 중2-2 기말 동성여중"],
].map(([id, title, created_at = "2026-11-12T00:00:00Z"]) => ({ id, title, created_at, status: id.startsWith("failed") ? "failed" : "done", original_files: [{ name: title + ".pdf", path: `originals/${id}/1.pdf`, size: 7, type: "application/pdf" }], hwpx_path: id.startsWith("failed") ? null : `generated/${id}/exam.hwpx`, cost_usd: 0, item_count: id.startsWith("failed") ? 0 : 23, note: null }));
const bundle = await build({ stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import ArchivePage from "./app/(main)/archive/page"; createRoot(document.getElementById("root")).render(<ArchivePage />);', loader: "tsx", resolveDir: root }, bundle: true, write: false, jsx: "automatic", platform: "browser", format: "esm", define: { "process.env.NODE_ENV": '"production"' }, tsconfig: "tsconfig.json" });
const css = await Promise.all(["app/theme.css", "app/app.css"].map(file => readFile(file, "utf8")));
let retryBody;
const deleteRequests = [];
const server = createServer(async (req, res) => {
  if (req.method === "DELETE" && req.url.startsWith("/api/documents/")) {
    const id = req.url.split("/").at(-1);
    deleteRequests.push(id);
    const index = docs.findIndex(doc => doc.id === id);
    if (index >= 0) docs.splice(index, 1);
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.url === "/api/documents?limit=100&offset=0") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ docs })); }
  if (req.url === "/api/documents/failed-one") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ doc: docs.at(-1) })); }
  if (req.url === "/api/jobs" && req.method === "POST") { const chunks = []; for await (const chunk of req) chunks.push(chunk); retryBody = JSON.parse(Buffer.concat(chunks).toString()); res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ docId: "failed-one", runId: "test" })); }
  if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].text); }
  if (req.url === "/style.css") { res.setHeader("content-type", "text/css"); return res.end(css.join("\n")); }
  res.setHeader("content-type", "text/html");
  res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/app.js"></script></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : await chromium.executablePath();
let browser;
try {
  browser = await puppeteer.launch({ executablePath, args: chromium.args, headless: true });
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin);
  await page.waitForSelector('[aria-label="년도 선택"]');
  assert.equal(await page.$$eval(".archive-browser details", elements => elements.length), 0);
  assert.equal(await page.$eval('[aria-label="학년 선택"]', element => element.disabled), true);
  await page.select('[aria-label="년도 선택"]', "2026");
  await page.select('[aria-label="학년 선택"]', "middle:1");
  await page.select('[aria-label="학기 선택"]', "2");
  await page.select('[aria-label="시험 선택"]', "final");
  await page.waitForSelector(".archive-document");
  assert.equal(await page.$$eval(".archive-document", elements => elements.length), 2);
  await page.select('[aria-label="년도 선택"]', "2025");
  assert.equal(await page.$eval('[aria-label="학년 선택"]', element => element.value), "");
  assert.equal(await page.$eval('[aria-label="학기 선택"]', element => element.disabled), true);
  await page.type("#archive-school", "서석중학교");
  await page.waitForFunction(() => document.querySelectorAll(".archive-document").length === 4);
  assert.equal(await page.$$eval(".archive-document-context", elements => elements.length), 4, "검색 결과에서 각 문서의 년도·학년·학기·시험 표시");
  await page.setViewport({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "좁은 모바일에서도 가로 넘침 없음");
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "모바일 가로 넘침 없음");
  if (process.env.ARCHIVE_SCREENSHOTS) { await mkdir(process.env.ARCHIVE_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: `${process.env.ARCHIVE_SCREENSHOTS}/archive-search-mobile.png`, fullPage: true }); }
  await page.click(".archive-search button");
  await page.select('[aria-label="년도 선택"]', "2026");
  await page.select('[aria-label="학년 선택"]', "middle:1");
  await page.select('[aria-label="학기 선택"]', "2");
  await page.select('[aria-label="시험 선택"]', "final");
  if (process.env.ARCHIVE_SCREENSHOTS) { await page.screenshot({ path: `${process.env.ARCHIVE_SCREENSHOTS}/archive-select-mobile.png`, fullPage: true }); }
  const copyRow = `.archive-document:has(time[datetime="${duplicateTime}"])`;
  const deleteButton = `${copyRow} .archive-remove`;
  let confirmText = "";
  page.once("dialog", async dialog => { confirmText = dialog.message(); await dialog.dismiss(); });
  await page.click(deleteButton);
  assert.ok(confirmText.includes("2026 중1-2 기말 서석중") && confirmText.includes("9:00:01"), "삭제 확인에 제목과 한국 저장 시각 표시");
  assert.deepEqual(deleteRequests, [], "취소하면 삭제하지 않음");
  assert.equal(await page.$$eval(".archive-document", elements => elements.length), 2);
  page.once("dialog", dialog => dialog.accept());
  await page.click(deleteButton);
  await page.waitForSelector(copyRow, { hidden: true });
  assert.deepEqual(deleteRequests, ["two-copy"], "제목이 같아도 고른 문서 ID만 삭제");
  assert.equal(await page.$$eval(".archive-document", elements => elements.length), 1, "같은 제목의 나머지 시험지는 목록에 남음");
  assert.equal(await page.$eval(".archive-count", element => element.textContent), "1건");
  await page.click('.archive-views button:nth-child(2)');
  let dialogText = "";
  page.on("dialog", async dialog => { dialogText = dialog.message(); await dialog.accept(); });
  await page.click(".archive-work .archive-download");
  await page.waitForFunction(() => location.search.includes("job=failed-one"));
  assert.deepEqual(retryBody, { docId: "failed-one", mode: "retry" }, "새 문서 생성 없이 같은 원본 재시도");
  assert.ok(dialogText.includes("AI 요금"), "새 읽기 비용 안내");
  assert.deepEqual(errors, []);
  console.log("보관함 분류·학교 검색·모바일·실패 재시도·같은 제목에서 선택한 한 건만 삭제 검사 통과");
} finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
