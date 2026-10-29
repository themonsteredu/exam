// 시험지 만들기 전체 흐름 (브라우저):
//  파일 확인 → 보관함 문서 만들기 → 원본 보관 → 쪽마다 [그림으로 바꾸기 → 쪽 읽기 → 그림 잘라 읽기(동시에 3개까지)]
//  → 합치기 → 그림 PNG → 한글 파일 → 내려받기·보관
//  요금이 드는 AI 읽기 전에 파일을 먼저 열어 보고, 도중에 크게 실패하면 남은 그림 읽기도 멈춘다 (쓰지 못할 결과에 요금이 들지 않게).

import { assembleExam, figureJobs, toExamPieces, type FigureResult, type PageMeta } from "@/lib/ai/assemble";
import type { Usage } from "@/lib/ai/claude";
import type { PageReading } from "@/lib/ai/page-schema";
import type { FigureReading } from "@/lib/ai/read-figure";
import { continuationHint } from "@/lib/ai/read-page";
import { attachFigurePngs, renderExamFigures } from "@/lib/figure/render-exam";
import { ApiError, patchJson, postJson, uploadFile, type FileRef } from "./api";
import { saveExamCheckpoint } from "./exam-storage";
import { figureImage, openSources, pageImage, precheckFiles, sourceFigureImage } from "./pages";
import { assertFresh } from "./version";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Step = "upload" | "page" | "figure" | "draw" | "review" | "hwpx" | "save";

export type Progress = {
  step: Step;
  message: string;
  pagesDone: number;
  pagesTotal: number;
  figuresDone: number;
  figuresTotal: number;
  usd: number;
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
  reviewFigures?: (exam: any, signal: AbortSignal) => Promise<any>;
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
      if (it.figure) {
        delete it.figure.png;
        delete it.figure.png_size;
      }
    }
  }
  return copy;
}

export function countUnsure(exam: any): number {
  let n = (exam.unsure ?? []).length;
  for (const s of exam.sections ?? []) for (const it of s.items ?? []) n += (it.unsure ?? []).length;
  return n;
}

export async function makeExam(o: {
  files: File[];
  title: string;
  /** 보관함 문서를 만든다 (파일을 열어 본 뒤에 부른다). 만든 문서 id */
  createDoc: () => Promise<string>;
  /** PDF 에 그리지 못하는 쪽이 있을 때 계속할지 묻는다 (AI 요금이 들기 전에). 없으면 묻지 않고 계속한다 */
  confirmProblems?: (message: string) => boolean;
  JXG: any;
  hwpxEndpoint: string;
  onProgress: (p: Progress) => void;
  signal: AbortSignal;
  reviewFigures?: (exam: any, signal: AbortSignal) => Promise<any>;
  onRecoverable?: (work: Recovery) => void;
}): Promise<MakeResult> {
  // 도중에 실패하면 남은 그림 읽기도 멈추도록 안에서 쓰는 멈춤 신호 (화면의 멈춤 버튼도 따른다)
  const inner = new AbortController();
  const follow = () => inner.abort();
  o.signal.addEventListener("abort", follow);
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
    createDoc: () => Promise<string>;
    confirmProblems?: (message: string) => boolean;
    JXG: any;
    hwpxEndpoint: string;
    onProgress: (p: Progress) => void;
    signal: AbortSignal;
    reviewFigures?: (exam: any, signal: AbortSignal) => Promise<any>;
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
    let res: { reading: PageReading; usage: Usage };
    try {
      res = await postJson("/api/read/page", {
        image: `data:${image.mediaType};base64,${image.data}`,
        page: i + 1,
        total: sources.length,
        before: continuationHint(lastSection, lastNo),
        docId,
      }, signal);
    } catch (err) {
      throw new ApiError(`${i + 1}쪽을 읽지 못했습니다: ${err instanceof Error ? err.message : err}`, err instanceof ApiError ? err.status : 0, err instanceof ApiError ? err.detail : undefined);
    }
    tell({ usd: progress.usd + sumUsd(res.usage) });
    const page = i + 1;
    const decorations: NonNullable<PageMeta["decorations"]> = [];
    for (const a of res.reading.page_artifacts ?? []) {
      try {
        const cut = sourceFigureImage(canvas, { ...a.region, kind: "other", place: "below" }, scale);
        decorations.push({ box: cut.crop, png: cut.image.data });
      } catch {
        res.reading.unsure.push(`${a.kind}: 원본 안내 영역을 보존하지 못했습니다`);
      }
    }
    pages.push({ meta: { page, original: { width: canvas.width, height: canvas.height }, scale, paperMm: sources[i].paperMm, decorations }, reading: res.reading });
    for (const s of res.reading.sections) {
      if (s.title) lastSection = s.title;
      if (s.items.length) lastNo = s.items[s.items.length - 1].no;
    }

    // 그림: 지금 쪽 그림에서 잘라 두고, 읽기는 뒤에서 동시에
    const jobs = figureJobs(page, res.reading);
    tell({ figuresTotal: progress.figuresTotal + jobs.length });
    for (const job of jobs) {
      const nonGeometry = job.region.kind !== "diagram";
      let original: { sourcePng?: string; sourcePngSize?: [number, number] } = {};
      let rawCut: ReturnType<typeof sourceFigureImage> | undefined;
      if (nonGeometry) {
        try {
          const cut = sourceFigureImage(canvas, job.region, scale);
          rawCut = cut;
          original = { sourcePng: cut.image.data, sourcePngSize: [cut.image.width, cut.image.height] };
          if (job.region.kind === "photo") {
            figures.set(job.key, { crop: cut.crop, scale: cut.image.width / cut.crop.w, ...original });
            tell({ figuresDone: progress.figuresDone + 1 });
            continue;
          }
        } catch (err) {
          figures.set(job.key, { crop: { x: 0, y: 0, w: 0, h: 0 }, scale: 1, error: err instanceof Error ? err.message : String(err) });
          tell({ figuresDone: progress.figuresDone + 1 });
          continue;
        }
      }
      const cut = rawCut ? { ...rawCut, scale: rawCut.image.width / rawCut.crop.w } : figureImage(canvas, job.region, scale);
      const item = {
        no: job.item.no,
        stem: toExamPieces(job.item.stem),
        choices: job.item.choices.map(toExamPieces),
        bogi: job.item.bogi.map(toExamPieces),
      };
      const task = runFigure(async () => {
          check();
          try {
            const r = await postJson<{ figure: FigureReading; usage: Usage }>("/api/read/figure", {
              image: `data:${cut.image.mediaType};base64,${cut.image.data}`,
              item,
              kind: job.region.kind,
              docId,
            }, signal);
            figures.set(job.key, { crop: cut.crop, scale: cut.scale, reading: r.figure, ...original });
            tell({ usd: progress.usd + sumUsd(r.usage) });
          } catch (err) {
            if (signal.aborted) throw err;
            const detail = err instanceof ApiError && err.detail ? ` (${err.detail})` : "";
            figures.set(job.key, { crop: cut.crop, scale: cut.scale, error: `${err instanceof Error ? err.message : String(err)}${detail}`, ...original });
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
  let exam = assembleExam(pages, figures);
  if (o.title) exam.title = o.title;
  const work: Recovery = { docId, title: o.title || "시험지", exam: stripPngs(exam), usd: progress.usd, pageProblems };
  o.onRecoverable?.(work);
  return finishExam(o, work, signal, progress, uploads);
}

/** 보관함 또는 현재 화면의 읽기 결과에서 AI 호출 없이 한글 파일 만들기를 다시 시작한다. */
export async function resumeExam(o: FinishOptions, work: Recovery): Promise<MakeResult> {
  await assertFresh();
  const figures = (work.exam.sections ?? []).reduce((n: number, s: any) => n + (s.items ?? []).filter((it: any) => it.figure).length, 0);
  const pages = Array.isArray(work.exam.source_pages) ? work.exam.source_pages.length : 0;
  const progress: Progress = { step: "draw", message: "저장된 읽기 결과를 준비하는 중입니다.", pagesDone: pages, pagesTotal: pages, figuresDone: figures, figuresTotal: figures, usd: work.usd };
  o.onProgress({ ...progress });
  return finishExam(o, work, o.signal, progress);
}

async function finishExam(o: FinishOptions, work: Recovery, signal: AbortSignal, progress: Progress, uploads?: Promise<FileRef[]>): Promise<MakeResult> {
  const { docId, pageProblems } = work;
  const tell = (patch: Partial<Progress>) => { Object.assign(progress, patch); o.onProgress({ ...progress }); };
  const check = () => { if (signal.aborted) throw new ApiError("멈췄습니다.", 0); };
  let exam = work.exam;
  // 데이터가 커도 조각을 모두 저장하고 나서만 보관함의 참조를 바꾼다.
  tell({ step: "draw", message: "AI가 읽은 결과를 보관하는 중입니다." });
  await saveExamCheckpoint(docId, stripPngs(exam), progress.usd, signal, pageProblems);
  check();
  tell({ step: "draw", message: "그림을 그리는 중입니다." });
  let rendered = await renderExamFigures(o.JXG, exam);
  if (o.reviewFigures && exam.sections.some((s: any) => s.items.some((it: any) => it.figure?.original_png))) {
    tell({ step: "review", message: "원본과 재작성한 자료를 확인해 주세요." });
    exam = await o.reviewFigures(attachFigurePngs(exam, rendered, true), signal);
    check();
    o.onRecoverable?.({ ...work, exam: stripPngs(exam), usd: progress.usd });
    rendered = await renderExamFigures(o.JXG, exam);
  }
  const withPng = attachFigurePngs(exam, rendered, true);
  const failedFigures = rendered.filter((r) => !r.png).length;

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
