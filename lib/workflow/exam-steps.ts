import { FatalError, getWorkflowMetadata } from "workflow";
import { apiKeyDevice, getStore, type FileRef } from "@/lib/server/store";
import { currentSessionKey, logUsage, sessionVersion } from "@/lib/server/auth";
import { makeSessionToken, SESSION_COOKIE } from "@/lib/server/session";
import { checkpoint, download, fileUrl, getJob, loadCheckpoint, originalInput, readJson, setJob, upload, writeJson, type JobInput } from "@/lib/server/exam-job";
import { renderOnServer } from "@/lib/server/exam-render";
import { serverReading } from "@/lib/server/reading-cache";
import { assembleExam, figureJobs, normalizeLegacyExam, tidyExam, toExamPieces, replaceFigureReading, reviewFigures, usableReading } from "@/lib/ai/assemble";
import { itemFigures } from "@/lib/figure/item-figures";
import { readPage, continuationHint } from "@/lib/ai/read-page";
import { readOrientation } from "@/lib/ai/read-orient";
import { readFigure } from "@/lib/ai/read-figure";
import { readGraphic } from "@/lib/ai/read-graphic";
import { providerFor } from "@/lib/ai/models";
import { ReadError } from "@/lib/ai/claude";
import { fakeAiEnabled, fakeFigure, fakePage } from "@/lib/ai/fake";
import type { Progress } from "@/lib/client/make-exam";

async function active(job: JobInput) {
  const state = await getJob(job.docId);
  if (state && state.runId !== getWorkflowMetadata().workflowRunId) throw new FatalError("새 제작 작업이 시작되어 이전 작업을 종료합니다.");
  if (state?.status === "cancelled") throw new FatalError("제작을 취소했습니다.");
  if (!await getStore().getDoc(job.docId)) throw new FatalError("문서를 찾지 못했습니다.");
  return state;
}
async function config(job: JobInput, pass: "page" | "figure") {
  await active(job);
  const model = job.models[pass];
  const key = await getStore().getApiKey(apiKeyDevice(job.device, providerFor(model)));
  if (!key.key || key.broken) throw new FatalError("설정에서 제작을 시작한 기기의 API 키를 확인해 주세요.");
  return { model, apiKey: key.key, keyTag: key.tag };
}
const pngBytes = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
const signed = async (path: string, job: JobInput) => fileUrl(await getStore().downloadUrl(path), job.origin);

export async function begin(job: JobInput, runId: string) {
  "use step";
  const doc = await getStore().getDoc(job.docId);
  if (!doc?.original_files.length) throw new FatalError("원본 업로드를 먼저 마쳐 주세요.");
  const previous = await getJob(job.docId);
  if (previous?.status === "cancelled" && previous.runId === runId) throw new FatalError("취소한 작업입니다.");
  await setJob(job.docId, { runId, status: "running", progress: { step: "upload", message: "서버에서 제작을 시작합니다. 창을 닫아도 계속됩니다.", pagesDone: 0, pagesTotal: 0, figuresDone: 0, figuresTotal: 0, usd: doc.cost_usd } });
  await getStore().updateDoc(job.docId, { status: "reading", note: "서버에서 제작 중" });
  return { original_files: doc.original_files, cost_usd: Number(doc.cost_usd) || 0 };
}
export async function progress(job: JobInput, value: Progress) {
  "use step";
  const state = await active(job);
  if (!state) throw new FatalError("작업 상태가 없습니다.");
  await setJob(job.docId, { ...state, progress: value });
  await getStore().updateDoc(job.docId, { cost_usd: value.usd, note: value.message });
}
export async function inspectOriginal(job: JobInput, ref: FileRef): Promise<{ label: string; problem?: string }[]> {
  "use step";
  await active(job);
  const pages = await renderOnServer(job.origin, "inspect", await originalInput(ref, job.origin));
  if (pages.some((p: any) => p.problem)) throw new FatalError("PDF의 일부 글자나 그림을 열지 못했습니다. PDF를 다시 저장하거나 JPG로 올려 주세요. AI 읽기는 시작하지 않았습니다.");
  return pages;
}
export async function preparePage(job: JobInput, ref: FileRef, index: number, page: number) {
  "use step";
  const cfg = await config(job, "page");
  const raw = await renderOnServer(job.origin, "page", { ...await originalInput(ref, job.origin), index });
  let rotate: number | undefined = raw.direction === "horizontal" ? 0 : undefined;
  let usd = 0;
  if (raw.direction === "vertical") {
    try {
      const answer = fakeAiEnabled() ? { rotate: 0, usage: fakePage().usage } : await readOrientation(raw.orientation, { ...cfg, deadline: Date.now() + 70_000 });
      await logUsage("page", answer.usage, job.docId, cfg.keyTag);
      usd += answer.usage.usd;
      if (answer.rotate !== null) rotate = answer.rotate;
    } catch (err) {
      if (err instanceof ReadError) { await logUsage("page", err.usage, job.docId, cfg.keyTag); usd += err.usage?.usd || 0; }
      throw new FatalError("쪽 방향을 확인하지 못했습니다. 원본을 바로 세운 뒤 다시 시도해 주세요.");
    }
  }
  const rawPath = await upload(job.docId, pngBytes(raw.png), job.origin, "png");
  const prepared = await renderOnServer(job.origin, "prepare", { url: await signed(rawPath, job), rotate });
  const png = await upload(job.docId, pngBytes(prepared.png), job.origin, "png");
  const paper = raw.paper && (rotate === 90 || rotate === 270) ? { width_mm: raw.paper.height_mm, height_mm: raw.paper.width_mm } : raw.paper;
  const meta = { page, original: prepared.original, scale: prepared.scale, ...(paper ? { paper_mm: paper } : {}), ...(rotate !== undefined ? { rotate } : {}) };
  return { path: await writeJson(job, { png, image: prepared.image, meta }), usd };
}
preparePage.maxRetries = 0;

export async function readPageStep(job: JobInput, preparedPath: string, page: number, total: number, before?: string) {
  "use step";
  const cfg = await config(job, "page");
  const prepared = await readJson(preparedPath, job.origin);
  try {
    const answer = await serverReading("page", `${job.device}:${cfg.keyTag}`, { model: cfg.model, image: prepared.image, page, total, before },
      async () => fakeAiEnabled() ? fakePage() : readPage(prepared.image, { ...cfg, page, total, before, deadline: Date.now() + 260_000 }));
    if (!answer.cached) await logUsage("page", answer.usage, job.docId, cfg.keyTag);
    let section: string | undefined; let no: number | undefined;
    for (const s of answer.reading.sections) { if (s.title) section = s.title; if (s.items.length) no = s.items[s.items.length - 1].no; }
    return { path: await writeJson(job, { meta: prepared.meta, reading: answer.reading }), before: continuationHint(section, no), usd: answer.usage.usd };
  } catch (err) {
    if (err instanceof ReadError) await logUsage("page", err.usage, job.docId, cfg.keyTag);
    throw new FatalError(`${page}쪽을 읽지 못했습니다. ${err instanceof Error ? err.message : "다시 시도해 주세요."}`);
  }
}
readPageStep.maxRetries = 0;

export async function cropPage(job: JobInput, preparedPath: string, pagePath: string): Promise<string[]> {
  "use step";
  await active(job);
  const prepared = await readJson(preparedPath, job.origin);
  const page = await readJson(pagePath, job.origin);
  const jobs = figureJobs(page.meta.page, page.reading, { width: prepared.image.width, height: prepared.image.height });
  if (!jobs.length) return [];
  const cuts = await renderOnServer(job.origin, "crop", { url: await signed(prepared.png, job), scale: prepared.meta.scale, regions: jobs.map(j => j.region) });
  const paths = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    paths.push(await writeJson(job, { key: j.key, cut: cuts[i], kind: j.region.kind, upright: prepared.meta.rotate !== undefined,
      item: { no: j.item.no, stem: toExamPieces(j.item.stem), choices: j.item.choices.map(toExamPieces), bogi: j.item.bogi.map(toExamPieces) } }));
  }
  return paths;
}
export async function readFigureStep(job: JobInput, cutPath: string) {
  "use step";
  const cfg = await config(job, "figure");
  const { key, cut, kind, item, upright, hint } = await readJson(cutPath, job.origin);
  let result: any; let usd = 0;
  try {
    const reader = ["table", "map", "chart", "illustration", "photo", "other"].includes(kind) ? readGraphic : readFigure;
    const answer = await serverReading("figure", `${job.device}:${cfg.keyTag}`, { model: cfg.model, image: cut.image, item, kind, upright, hint },
      async () => fakeAiEnabled() ? fakeFigure(item.no) : reader(cut.image, item, { ...cfg, hint, pageUpright: upright, deadline: Date.now() + 260_000 }), job.mode === "reread");
    if (!answer.cached) await logUsage("figure", answer.usage, job.docId, cfg.keyTag);
    usd = answer.usage.usd;
    result = { crop: cut.crop, scale: cut.scale, reading: answer.figure };
  } catch (err) {
    if (err instanceof ReadError) { await logUsage("figure", err.usage, job.docId, cfg.keyTag); usd = err.usage?.usd || 0; }
    result = { crop: cut.crop, scale: cut.scale, error: err instanceof Error ? err.message : "그림을 읽지 못했습니다." };
  }
  return { path: await writeJson(job, { key, result }), usd };
}
readFigureStep.maxRetries = 0;

export async function assemble(job: JobInput, pages: string[], figures: string[], usd: number, pageProblems: string[]) {
  "use step";
  await active(job);
  const readings = await Promise.all(pages.map(p => readJson(p, job.origin)));
  const drawings = await Promise.all(figures.map(p => readJson(p, job.origin)));
  const exam = assembleExam(readings, new Map(drawings.map(d => [d.key, d.result])));
  exam.title = (await getStore().getDoc(job.docId))!.title;
  await active(job);
  await checkpoint(job, exam, usd, pageProblems);
  return writeJson(job, { exam, usd, pageProblems });
}
export async function rebuild(job: JobInput) {
  "use step";
  await active(job);
  const doc = (await getStore().getDoc(job.docId))!;
  const exam = tidyExam(normalizeLegacyExam(await loadCheckpoint(job, doc.exam_json)));
  return writeJson(job, { exam, usd: doc.cost_usd, pageProblems: (doc.exam_json as any)?.pageProblems || [] });
}
export async function prepareReread(job: JobInput, workPath: string, index: number) {
  "use step";
  await active(job);
  const target = job.targets![index];
  const work = await readJson(workPath, job.origin);
  const item = work.exam.sections?.[target.section]?.items?.[target.index];
  const fig: any = itemFigures(item)[target.figureIndex];
  if (!fig?.box?.page) throw new FatalError("다시 읽을 그림의 원본 위치가 없습니다.");
  const doc = (await getStore().getDoc(job.docId))!;
  let remaining = fig.box.page - 1;
  let raw: any;
  for (const ref of doc.original_files) {
    const info = await originalInput(ref, job.origin);
    const pages = await renderOnServer(job.origin, "inspect", info);
    if (remaining < pages.length) { raw = await renderOnServer(job.origin, "page", { ...info, index: remaining }); break; }
    remaining -= pages.length;
  }
  if (!raw) throw new FatalError("그림이 있던 원본 쪽을 찾지 못했습니다.");
  const source = work.exam.source_pages?.find((p: any) => p.page === fig.box.page);
  const rawPath = await upload(job.docId, pngBytes(raw.png), job.origin, "png");
  const prepared = await renderOnServer(job.origin, "prepare", { url: await signed(rawPath, job), rotate: source?.rotate || 0 });
  const png = await upload(job.docId, pngBytes(prepared.png), job.origin, "png");
  const kind = fig.asset_kind || "diagram";
  const [cut] = await renderOnServer(job.origin, "crop", { url: await signed(png, job), scale: 1, regions: [{ ...fig.box, kind, place: fig.place || "below" }] });
  const state = (await getJob(job.docId))!;
  await setJob(job.docId, { ...state, progress: { ...state.progress, step: "figure", message: `${target.name} 그림을 다시 읽고 있습니다.`, figuresDone: index, figuresTotal: job.targets!.length, usd: work.usd } });
  return writeJson(job, { key: String(index), cut, kind, item: { no: item.no, stem: item.stem || [], choices: item.choices || [], bogi: item.bogi || [] }, upright: !!source && ("rotate" in source || !(source.width > source.height)), hint: target.reasons.join(" / ").slice(0, 600) });
}
export async function applyReread(job: JobInput, workPath: string, answer: { path: string; usd: number }, index: number) {
  "use step";
  await active(job);
  const work = await readJson(workPath, job.origin);
  const { result } = await readJson(answer.path, job.origin);
  const target = job.targets![index];
  const item = work.exam.sections[target.section].items[target.index];
  const fig: any = itemFigures(item)[target.figureIndex];
  if (usableReading(result, fig.asset_kind || "diagram")) replaceFigureReading(item, target.figureIndex, result, target.reasons.join(" / "));
  else work.pageProblems.push(`${target.name}: 다시 읽지 못해 이전 그림을 유지했습니다.`);
  work.usd += answer.usd;
  reviewFigures(work.exam);
  await active(job);
  await checkpoint(job, work.exam, work.usd, work.pageProblems);
  return writeJson(job, work);
}
export async function draw(job: JobInput, workPath: string) {
  "use step";
  await active(job);
  const work = await readJson(workPath, job.origin);
  const output = await renderOnServer(job.origin, "draw", { exam: work.exam });
  await active(job);
  const record = await checkpoint(job, output.exam, work.usd, work.pageProblems);
  const warnings = output.rendered.flatMap((r: any) => [...(r.error ? [`${r.no}번: ${r.error}`] : []), ...(r.warnings || []).map((w: string) => `${r.no}번: ${w}`)]);
  return { record, warnings, usd: work.usd, pageProblems: work.pageProblems as string[] };
}
export async function finish(job: JobInput, drawn: Awaited<ReturnType<typeof draw>>) {
  "use step";
  const state = await active(job);
  if (!state) throw new FatalError("작업 상태가 없습니다.");
  await setJob(job.docId, { ...state, progress: { ...state.progress, step: "hwpx", message: "한글 파일을 만들고 있습니다.", usd: drawn.usd } });
  const { token } = await makeSessionToken(await sessionVersion(), await currentSessionKey());
  // 쿠키와 키는 단계 안에서만 쓰며 작업 이력이나 브라우저로 전달하지 않는다.
  const endpoint = `${job.origin}${process.env.EXAM_STORE === "local" ? "/api/dev-hwpx" : "/api/hwpx"}`;
  const headers: Record<string, string> = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${token}` };
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const res = await fetch(endpoint, { method: "POST", headers, redirect: "error", body: JSON.stringify({ input_paths: drawn.record.parts }), signal: AbortSignal.timeout(280_000) });
  const output = await res.json();
  if (!res.ok || typeof output.path !== "string" || !output.path.startsWith(`generated/${job.docId}/`) || !output.path.endsWith(".hwpx")) throw new Error(output.error || "한글 파일을 보관하지 못했습니다.");
  await active(job);
  const warnings = [...drawn.pageProblems, ...drawn.warnings, ...(output.warnings || [])];
  await getStore().updateDoc(job.docId, { status: "done", hwpx_path: output.path, cost_usd: drawn.usd, note: warnings.length ? warnings.slice(0, 8).join("\n").slice(0, 1500) : null });
  await setJob(job.docId, { ...state, status: "completed", warnings, progress: { ...state.progress, step: "save", message: "완료 보관함에 저장했습니다.", usd: drawn.usd } });
}
export async function failJob(job: JobInput, error: string) {
  "use step";
  const state = await getJob(job.docId);
  if (!state || state.status === "cancelled" || state.runId !== getWorkflowMetadata().workflowRunId) return;
  await setJob(job.docId, { ...state, status: "failed", error: error.slice(0, 1000) });
  const doc = await getStore().getDoc(job.docId);
  if (doc) await getStore().updateDoc(job.docId, { status: doc.hwpx_path ? "done" : "failed", note: error.slice(0, 1000) });
}
