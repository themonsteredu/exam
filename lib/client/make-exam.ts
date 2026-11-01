// 시험지 만들기 전체 흐름 (브라우저):
//  파일 확인 → 보관함 문서 만들기 → 원본 보관 → 쪽마다 [그림으로 바꾸기 → 쪽 읽기 → 그림 잘라 읽기(동시에 3개까지)]
//  → 합치기 → 그림 PNG → 한글 파일 → 내려받기·보관
//  요금이 드는 AI 읽기 전에 파일을 먼저 열어 보고, 도중에 크게 실패하면 남은 그림 읽기도 멈춘다 (쓰지 못할 결과에 요금이 들지 않게).

import { assembleExam, figureJobs, normalizeLegacyExam, toExamPieces, type FigureResult, type PageMeta } from "@/lib/ai/assemble";
import type { Usage } from "@/lib/ai/claude";
import type { PageReading } from "@/lib/ai/page-schema";
import type { FigureReading } from "@/lib/ai/read-figure";
import { continuationHint } from "@/lib/ai/read-page";
import { attachFigurePngs, renderExamFigures } from "@/lib/figure/render-exam";
import { ApiError, patchJson, postJson, uploadFile, type FileRef } from "./api";
import { saveExamCheckpoint } from "./exam-storage";
import { figureImage, openSources, pageImage, precheckFiles } from "./pages";
import { assertFresh } from "./version";
import { readCached } from "./read-cache";
import { itemFigures } from "@/lib/figure/item-figures";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Step = "upload" | "page" | "figure" | "draw" | "hwpx" | "save";

export type Progress = {
  step: Step;
  message: string;
  pagesDone: number;
  pagesTotal: number;
  figuresDone: number;
  figuresTotal: number;
  usd: number;
  reused?: number;
};

export type MakeResult = {
  exam: any;
  hwpxPath: string;
  fileName: string;
  warnings: string[];
  usd: number;
  unsure: number;
  failedFigures: number;
  /** 한글 파일을 보관함에 저장했는지 */
  saved: boolean;
  /** 보관하지 못한 것 (한글 파일 또는 원본) */
  saveProblem?: string;
};

export type Recovery = { docId: string; title: string; exam: any; usd: number; pageProblems: string[] };
type FinishOptions = {
  JXG: any;
  hwpxEndpoint: string;
  onProgress: (p: Progress) => void;
  signal: AbortSignal;
  onRecoverable?: (work: Recovery) => void;
};

function sumUsd(u?: Usage) {
  return u?.usd ?? 0;
}

/** 일을 n 개씩 동시에 돌린다 */
function limiter(n: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (running >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

export function stripPngs(exam: any): any {
  const copy = JSON.parse(JSON.stringify(exam));
  for (const s of copy.sections ?? []) {
    for (const it of s.items ?? []) {
      for (const figure of itemFigures(it)) {
        delete figure.png;
        delete figure.png_size;
      }
    }
  }
  return copy;
}

/** 잠깐의 실패인지 (인터넷이 끊김, 서버 함수가 죽음·시간 초과, AI 서버가 바쁨): 이런 실패는 조금 기다렸다 다시 해 본다.
 *  열쇠가 틀림, 크레딧 부족 같은 실패는 다시 해도 같으므로 바로 그 까닭을 남긴다. */
function transient(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true; // fetch 자체가 실패 (인터넷)
  if (err.status === 0) return !/멈췄습니다/.test(err.message);
  if ([408, 500, 503, 504].includes(err.status)) return true;
  return err.status === 502 && /AI 서버|너무 자주|연결/.test(err.message);
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(new ApiError("멈췄습니다.", 0)); };
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
  });

export function countUnsure(exam: any): number {
  let n = (exam.unsure ?? []).length;
  for (const s of exam.sections ?? []) for (const it of s.items ?? []) n += (it.unsure ?? []).length;
  return n;
}

export async function makeExam(o: {
  files: File[];
  title: string;
  models?: { page: string; figure: string };
  cacheScope?: string;
  /** 보관함 문서를 만든다 (파일을 열어 본 뒤에 부른다). 만든 문서 id */
  createDoc: () => Promise<string>;
  /** PDF 에 그리지 못하는 쪽이 있을 때 계속할지 묻는다 (AI 요금이 들기 전에). 없으면 묻지 않고 계속한다 */
  confirmProblems?: (message: string) => boolean;
  JXG: any;
  hwpxEndpoint: string;
  onProgress: (p: Progress) => void;
  signal: AbortSignal;
  onRecoverable?: (work: Recovery) => void;
}): Promise<MakeResult> {
  // 도중에 실패하면 남은 그림 읽기도 멈추도록 안에서 쓰는 멈춤 신호 (화면의 멈춤 버튼도 따른다)
  const inner = new AbortController();
  const follow = () => inner.abort();
  o.signal.addEventListener("abort", follow);
  if (o.signal.aborted) inner.abort();
  try {
    return await run(o, inner.signal);
  } finally {
    inner.abort();
    o.signal.removeEventListener("abort", follow);
  }
}

async function run(
  o: {
    files: File[];
    title: string;
    models?: { page: string; figure: string };
    cacheScope?: string;
    createDoc: () => Promise<string>;
    confirmProblems?: (message: string) => boolean;
    JXG: any;
    hwpxEndpoint: string;
    onProgress: (p: Progress) => void;
    signal: AbortSignal;
    onRecoverable?: (work: Recovery) => void;
  },
  signal: AbortSignal,
): Promise<MakeResult> {
  const progress: Progress = { step: "upload", message: "원본 파일을 보관함에 올리는 중입니다.", pagesDone: 0, pagesTotal: 0, figuresDone: 0, figuresTotal: 0, usd: 0 };
  const tell = (patch: Partial<Progress>) => {
    Object.assign(progress, patch);
    o.onProgress({ ...progress });
  };
  const check = () => {
    if (signal.aborted) throw new ApiError("멈췄습니다.", 0);
  };
  tell({ message: "파일을 확인하는 중입니다." });

  // 0) 요금이 들기 전에: 이 화면이 지금 판인지, 파일을 열 수 있는지 (크기, 종류, 열리는 사진·PDF 인지)
  await assertFresh();
  await precheckFiles(o.files);
  const sources = await openSources(o.files);
  check();
  const pageProblems = sources.filter((s) => s.problem).map((s) => `${s.label}: ${s.problem}`);
  if (pageProblems.length) {
    const message = `${pageProblems.join("\n")}\n\n그래도 만들까요? (AI 요금이 듭니다)\n안 되면 PDF 를 사진(JPG)으로 바꿔 올리거나 다시 스캔해 주세요.`;
    if (o.confirmProblems && !o.confirmProblems(message)) throw new ApiError("멈췄습니다.", 0);
  }
  const docId = await o.createDoc();

  // 1) 원본 보관 (읽기와 함께 진행. 화면의 멈춤 버튼만 따른다: AI 읽기가 실패해도 원본은 보관함에 남게)
  tell({ message: "원본 파일을 보관함에 올리는 중입니다." });
  const uploads = (async () => {
    const refs: FileRef[] = [];
    for (let i = 0; i < o.files.length; i++) {
      refs.push(await uploadFile(docId, "original", o.files[i], o.files[i].name, i, o.signal));
    }
    await patchJson(`/api/documents/${docId}`, { original_files: refs });
    return refs;
  })();
  // 실패는 마지막(보관)에서 알린다. 그 사이 처리되지 않은 실패로 남지 않게
  uploads.catch(() => undefined);

  // 2) 쪽마다 읽기
  tell({ step: "page", pagesTotal: sources.length, message: `쪽 1/${sources.length} 을 읽는 중입니다.` });
  const pages: { meta: PageMeta; reading: PageReading }[] = [];
  const figures = new Map<string, FigureResult>();
  const figureTasks: Promise<void>[] = [];
  const runFigure = limiter(3);
  let lastSection: string | undefined;
  let lastNo: number | undefined;

  for (let i = 0; i < sources.length; i++) {
    check();
    tell({ step: "page", message: `쪽 ${i + 1}/${sources.length} 을 읽는 중입니다 (${sources[i].label}).` });
    const canvas = await sources[i].render();
    const { image, scale } = pageImage(canvas);
    let res: { reading: PageReading; usage: Usage; cached?: boolean };
    try {
      res = await readCached("page", {
        image: `data:${image.mediaType};base64,${image.data}`,
        page: i + 1,
        total: sources.length,
        before: continuationHint(lastSection, lastNo),
        model: o.models?.page,
        docId,
      }, o.cacheScope ?? "", signal);
    } catch (err) {
      if (err instanceof ApiError && err.usage) tell({ usd: progress.usd + err.usage.usd });
      throw new ApiError(`${i + 1}쪽을 읽지 못했습니다: ${err instanceof Error ? err.message : err}`, err instanceof ApiError ? err.status : 0, err instanceof ApiError ? err.detail : undefined);
    }
    tell({ usd: progress.usd + sumUsd(res.usage), reused: (progress.reused ?? 0) + (res.cached ? 1 : 0) });
    const page = i + 1;
    pages.push({ meta: { page, original: { width: canvas.width, height: canvas.height }, scale }, reading: res.reading });
    for (const s of res.reading.sections) {
      if (s.title) lastSection = s.title;
      if (s.items.length) lastNo = s.items[s.items.length - 1].no;
    }

    // 그림: 지금 쪽 그림에서 잘라 두고, 읽기는 뒤에서 동시에
    const jobs = figureJobs(page, res.reading);
    tell({ figuresTotal: progress.figuresTotal + jobs.length });
    for (const job of jobs) {
      // AI 에게 보낼 그림 사진 (읽기에만 쓴다. 한글 파일에는 원본을 잘라 붙이지 않는다)
      const cut = figureImage(canvas, job.region, scale);
      const item = {
        no: job.item.no,
        stem: toExamPieces(job.item.stem),
        choices: job.item.choices.map(toExamPieces),
        bogi: job.item.bogi.map(toExamPieces),
      };
      const task = runFigure(async () => {
          check();
          try {
            // 잠깐의 실패(인터넷, 서버 함수 오류·시간 초과, AI 서버 바쁨)면 두 번까지 다시 해 본다.
            // 그래도 안 되면 그 그림만 빈 자리로 두고 나머지로 한글 파일을 만든다 (그림 하나 때문에 전체를 멈추지 않는다)
            for (let attempt = 1; ; attempt++) {
              try {
                const r = await readCached<{ figure: FigureReading; usage: Usage }>("figure", {
                  image: `data:${cut.image.mediaType};base64,${cut.image.data}`,
                  item,
                  kind: job.region.kind,
                  model: o.models?.figure,
                  docId,
                }, o.cacheScope ?? "", signal);
                figures.set(job.key, { crop: cut.crop, scale: cut.scale, reading: r.figure });
                tell({ usd: progress.usd + sumUsd(r.usage), reused: (progress.reused ?? 0) + (r.cached ? 1 : 0) });
                break;
              } catch (err) {
                if (err instanceof ApiError && err.usage) tell({ usd: progress.usd + err.usage.usd });
                if (signal.aborted) throw err;
                if (attempt < 3 && transient(err)) {
                  await wait(attempt === 1 ? 4_000 : 15_000, signal);
                  continue;
                }
                const detail = err instanceof ApiError && err.detail ? ` (${err.detail})` : "";
                const tries = attempt > 1 ? ` (${attempt}번 시도)` : "";
                figures.set(job.key, { crop: cut.crop, scale: cut.scale, error: `${err instanceof Error ? err.message : String(err)}${tries}${detail}` });
                break;
              }
            }
          } finally {
            tell({ figuresDone: progress.figuresDone + 1 });
          }
        });
      // 쪽 읽기가 실패해 멈춘 뒤에 끝나는 그림 읽기가 처리되지 않은 실패로 남지 않게
      task.catch(() => undefined);
      figureTasks.push(task);
    }
    // 쪽 그림은 여기서 놓는다 (큰 그림을 여러 장 들고 있지 않게)
    canvas.width = 0;
    canvas.height = 0;
    tell({ pagesDone: i + 1 });
  }

  tell({ step: "figure", message: "그림을 읽는 중입니다." });
  await Promise.all(figureTasks);
  check();

  // 3) 합치기 → 그림 PNG
  const exam = assembleExam(pages, figures);
  if (o.title) exam.title = o.title;
  const work: Recovery = { docId, title: o.title || "시험지", exam: stripPngs(exam), usd: progress.usd, pageProblems };
  o.onRecoverable?.(work);
  return finishExam(o, work, signal, progress, uploads);
}

/** 보관함 또는 현재 화면의 읽기 결과에서 AI 호출 없이 한글 파일 만들기를 다시 시작한다. */
export async function resumeExam(o: FinishOptions, saved: Recovery): Promise<MakeResult> {
  await assertFresh();
  // GPT 판으로 읽은 결과도 지금의 2단 본문 모양으로 바꿔서 만든다
  const work: Recovery = { ...saved, exam: normalizeLegacyExam(saved.exam) };
  const figures = (work.exam.sections ?? []).reduce((n: number, s: any) => n + (s.items ?? []).reduce((count: number, it: any) => count + itemFigures(it).length, 0), 0);
  const pages = Array.isArray(work.exam.source_pages) ? work.exam.source_pages.length : 0;
  const progress: Progress = { step: "draw", message: "저장된 읽기 결과를 준비하는 중입니다.", pagesDone: pages, pagesTotal: pages, figuresDone: figures, figuresTotal: figures, usd: work.usd };
  o.onProgress({ ...progress });
  return finishExam(o, work, o.signal, progress);
}

async function finishExam(o: FinishOptions, work: Recovery, signal: AbortSignal, progress: Progress, uploads?: Promise<FileRef[]>): Promise<MakeResult> {
  const { docId, pageProblems } = work;
  const tell = (patch: Partial<Progress>) => { Object.assign(progress, patch); o.onProgress({ ...progress }); };
  const check = () => { if (signal.aborted) throw new ApiError("멈췄습니다.", 0); };
  const exam = work.exam;
  // 데이터가 커도 조각을 모두 저장하고 나서만 보관함의 참조를 바꾼다.
  tell({ step: "draw", message: "AI가 읽은 결과를 보관하는 중입니다." });
  await saveExamCheckpoint(docId, stripPngs(exam), progress.usd, signal, pageProblems);
  check();
  tell({ step: "draw", message: "그림을 그리는 중입니다." });
  const rendered = await renderExamFigures(o.JXG, exam);
  const withPng = attachFigurePngs(exam, rendered);
  const failedFigures = rendered.filter((r) => r.error).length;

  // 4) 한글 파일
  check();
  tell({ step: "hwpx", message: "그림을 보관하고 한글 파일을 만드는 중입니다." });
  const checkpoint = await saveExamCheckpoint(docId, withPng, progress.usd, signal, pageProblems);
  check();
  const res = await postJson<{ path: string; warnings?: string[] }>(o.hwpxEndpoint, { input_paths: checkpoint.parts }, signal);
  if (typeof res.path !== "string" || !res.path.startsWith(`generated/${docId}/`) || !res.path.endsWith(".hwpx")) {
    throw new ApiError("완성된 한글 파일의 보관 위치를 확인하지 못했습니다.", 502);
  }
  let warnings: string[] = Array.isArray(res.warnings) ? res.warnings.filter((w): w is string => typeof w === "string") : [];
  // PDF 에서 그리지 못한 쪽도 결과 알림에 남긴다
  warnings = [...pageProblems, ...warnings, ...rendered.flatMap(r => (r.warnings ?? []).map(w => `${r.no}번: ${w}`))];

  // 5) 보관
  tell({ step: "save", message: "보관함에 저장하는 중입니다." });
  const fileName = `${work.title.replace(/[\\/:*?"<>|]/g, "_")}.hwpx`;
  const items = (exam.sections ?? []).reduce((n: number, s: any) => n + (s.items?.length ?? 0), 0);
  const problems: string[] = [];
  // 원본 보관이 실패해도 한글 파일과 시험지 데이터는 따로 보관한다
  let originalsError = "";
  try {
    if (uploads) await uploads;
  } catch (err) {
    originalsError = err instanceof Error ? err.message : String(err);
    problems.push(`원본 파일을 보관하지 못했습니다 (${originalsError})`);
  }
  let saved = false;
  try {
    await patchJson(`/api/documents/${docId}`, {
      hwpx_path: res.path,
      status: "done",
      cost_usd: progress.usd,
      item_count: items,
      note: originalsError ? `원본을 보관하지 못했습니다: ${originalsError}`.slice(0, 500) : null,
    });
    saved = true;
  } catch (err) {
    problems.unshift(`한글 파일을 보관함에 저장하지 못했습니다 (${err instanceof Error ? err.message : String(err)})`);
  }
  return {
    exam: withPng,
    hwpxPath: res.path,
    fileName,
    warnings,
    usd: progress.usd,
    unsure: countUnsure(exam),
    failedFigures,
    saved,
    saveProblem: problems.length ? problems.join(" / ") : undefined,
  };
}

