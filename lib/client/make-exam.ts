// 시험지 만들기 전체 흐름 (브라우저):
//  파일 확인 → 보관함 문서 만들기 → 원본 보관 → 쪽마다 [그림으로 바꾸기 → 쪽 읽기 → 그림 잘라 읽기(동시에 3개까지)]
//  → 합치기 → 그림 PNG → 한글 파일 → 내려받기·보관
//  요금이 드는 AI 읽기 전에 파일을 먼저 열어 보고, 도중에 크게 실패하면 남은 그림 읽기도 멈춘다 (쓰지 못할 결과에 요금이 들지 않게).

import { assembleExam, figureJobs, normalizeLegacyExam, replaceFigureReading, reviewFigures, tidyExam, toExamPieces, usableReading, type FigureResult, type FigureSuspect, type PageMeta } from "@/lib/ai/assemble";
import type { Usage } from "@/lib/ai/claude";
import type { PageReading } from "@/lib/ai/page-schema";
import type { FigureReading } from "@/lib/ai/read-figure";
import { continuationHint } from "@/lib/ai/read-page";
import { attachFigurePngs, renderExamFigures } from "@/lib/figure/render-exam";
import { ApiError, patchJson, postJson, uploadFile, type FileRef } from "./api";
import { saveExamCheckpoint } from "./exam-storage";
import { figureImage, openSources, orientationImage, pageImage, precheckFiles, rotateCanvas, textDirectionOf } from "./pages";
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
  /** 보관함 문서 */
  docId: string;
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
  /** 제목과 PDF 쪽 문제 (결과 화면에서 그림을 다시 읽을 때 그대로 쓴다) */
  title: string;
  pageProblems: string[];
  /** 그림 다시 읽기로 만든 경우: 고른 그림 수, 바꾼 그림 수, 다시 읽지 못한 그림과 까닭 */
  reread?: { asked: number; replaced: number; failed: string[] };
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
    let canvas = await sources[i].render();
    // 옆으로 누운 스캔(글자 줄이 세로)이면 방향을 AI 에게 물어(작은 사진, 쪽당 1원 남짓) 바로 세운 뒤 읽는다.
    // 2026-11-02 숭의중: 누운 채로 읽어 그림이 절반 크기로 작아지고 몇 개는 누운 채로 그려졌다. 앞뒷면 스캔은 쪽마다 방향이 다르다
    const direction = textDirectionOf(canvas);
    let rotate: number | undefined = direction === "horizontal" ? 0 : undefined;
    if (direction === "vertical") {
      tell({ message: `쪽 ${i + 1} 이 옆으로 누워 있어 방향을 확인하는 중입니다.` });
      try {
        const o2 = orientationImage(canvas);
        const r = await postJson<{ rotate: number | null; usage: Usage }>("/api/read/orient", {
          image: `data:${o2.mediaType};base64,${o2.data}`,
          model: o.models?.page,
          docId,
        }, signal);
        tell({ usd: progress.usd + sumUsd(r.usage) });
        // AI 가 바로 서 있다(0)고 하면 돌리지 않고 확인한 쪽으로, 답을 못 읽었으면(null) 확인하지 못한 쪽으로
        if (r.rotate === 0 || r.rotate === 90 || r.rotate === 180 || r.rotate === 270) rotate = r.rotate;
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof ApiError && [400, 401, 402, 403].includes(err.status)) throw err;
        pageProblems.push(`${sources[i].label}: 쪽이 옆으로 누워 있는데 방향을 알아내지 못해 누운 채로 읽었습니다`);
      }
      if (rotate) {
        const turned = rotateCanvas(canvas, rotate);
        canvas.width = 0;
        canvas.height = 0;
        canvas = turned;
      }
    }
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
    const paper0 = sources[i].paperMm;
    // 바로 세운 쪽의 종이 크기 (90°·270° 로 돌렸으면 가로세로를 바꾼다: 누운 B4 스캔 → B4)
    const paper = paper0 && (rotate === 90 || rotate === 270) ? { width_mm: paper0.height_mm, height_mm: paper0.width_mm } : paper0;
    pages.push({
      meta: { page, original: { width: canvas.width, height: canvas.height }, scale, ...(paper ? { paper_mm: paper } : {}), ...(rotate !== undefined ? { rotate } : {}) },
      reading: res.reading,
    });
    const upright = rotate !== undefined;
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
                  // 쪽 방향을 확인했는지 (모르면 그림 방향을 고치지 않게)
                  upright,
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
  // GPT 판으로 읽은 결과도 지금의 2단 본문 모양으로 바꿔서 만든다. 그림의 뻔한 실수(각 글자와 다른 방향각)도 AI 없이 고친다
  const work: Recovery = { ...saved, exam: tidyExam(normalizeLegacyExam(saved.exam)) };
  reviewFigures(work.exam);
  const figures = (work.exam.sections ?? []).reduce((n: number, s: any) => n + (s.items ?? []).reduce((count: number, it: any) => count + itemFigures(it).length, 0), 0);
  const pages = Array.isArray(work.exam.source_pages) ? work.exam.source_pages.length : 0;
  const progress: Progress = { step: "draw", message: "저장된 읽기 결과를 준비하는 중입니다.", pagesDone: pages, pagesTotal: pages, figuresDone: figures, figuresTotal: figures, usd: work.usd };
  o.onProgress({ ...progress });
  return finishExam(o, work, o.signal, progress);
}

/**
 * 그림 하나를 다시 읽는 AI 요금 어림 (달러): 보통과 많을 때.
 * 2026-11 기록: 그림 읽기 한 번에 Opus 평균 0.06·많을 때 0.14, Sonnet 평균 0.03·많을 때 0.08.
 * 다시 읽기를 권하는 그림은 검사에 걸린 그림이라 AI 에게 한 번 더 살피게 하는 일이 잦다 → 많을 때는 두 번으로 어림한다
 */
export function figureRereadUsd(model?: string): { usual: number; most: number } {
  if (!model || /opus/i.test(model)) return { usual: 0.08, most: 0.3 };
  if (/sonnet/i.test(model)) return { usual: 0.04, most: 0.16 };
  return { usual: 0.02, most: 0.08 };
}

/**
 * 고른 그림만 AI 로 다시 읽고 한글 파일을 다시 만든다 (요금은 그 그림들만).
 * 원본 파일을 보관함에서 받아 그 쪽을 다시 그리고, 처음 읽을 때와 같은 자리를 잘라 보낸다. 지난 그림에서 찾은 문제를 함께 알려 준다.
 */
export async function rereadFigures(
  o: FinishOptions & { originals: FileRef[]; models?: { page: string; figure: string }; cacheScope?: string },
  saved: Recovery,
  targets: FigureSuspect[],
): Promise<MakeResult> {
  await assertFresh();
  const signal = o.signal;
  const check = () => {
    if (signal.aborted) throw new ApiError("멈췄습니다.", 0);
  };
  const work: Recovery = { ...saved, exam: tidyExam(normalizeLegacyExam(JSON.parse(JSON.stringify(saved.exam)))) };
  const progress: Progress = { step: "figure", message: "원본 파일을 받는 중입니다.", pagesDone: 0, pagesTotal: 0, figuresDone: 0, figuresTotal: targets.length, usd: work.usd };
  const tell = (patch: Partial<Progress>) => { Object.assign(progress, patch); o.onProgress({ ...progress }); };
  tell({});
  if (!o.originals.length) throw new ApiError("보관함에 원본 파일이 없어 그림을 다시 읽을 수 없습니다.", 400);
  // 1) 원본 받기 (요금이 들기 전에 열 수 있는 파일인지까지 본다)
  const files: File[] = [];
  for (const ref of o.originals) {
    check();
    let blob: Blob;
    try {
      const { url } = await postJson<{ url: string }>("/api/files/download-url", { path: ref.path }, signal);
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(String(res.status));
      blob = await res.blob();
    } catch (err) {
      if (signal.aborted) throw new ApiError("멈췄습니다.", 0);
      throw new ApiError(`보관함에서 원본 파일(${ref.name || "원본"})을 받지 못했습니다. 인터넷 연결을 확인하고 다시 해 주세요.`, 0, err instanceof Error ? err.message : String(err));
    }
    files.push(new File([blob], ref.name || "원본", { type: ref.type || blob.type }));
  }
  let sources: Awaited<ReturnType<typeof openSources>>;
  try {
    await precheckFiles(files);
    sources = await openSources(files);
  } catch (err) {
    throw new ApiError(`원본 파일을 이 기기에서 열지 못했습니다: ${err instanceof Error ? err.message : String(err)}`, 0);
  }
  // 2) 그림마다: 그 쪽 그림 → 처음과 같은 자리 잘라 → 다시 읽기 (잠깐의 실패는 두 번 더, 열쇠·크레딧처럼 다시 해도 같은 실패는 바로 멈춤)
  const canvases = new Map<number, HTMLCanvasElement>();
  let replaced = 0;
  const failed: string[] = [];
  try {
    for (const t of targets) {
      check();
      const item = work.exam.sections?.[t.section]?.items?.[t.index];
      const fig: any = itemFigures(item)[t.figureIndex];
      const page = Number(fig?.box?.page);
      if (!item || !fig?.box || !(page >= 1 && page <= sources.length)) {
        failed.push(`${t.name}: 원본에서 그림 자리를 찾지 못했습니다`);
        tell({ figuresDone: progress.figuresDone + 1 });
        continue;
      }
      tell({ message: `${t.name} 그림을 다시 읽는 중입니다.` });
      const pageInfo = (Array.isArray(work.exam.source_pages) ? work.exam.source_pages : []).find((p: any) => p?.page === page);
      let canvas = canvases.get(page);
      if (!canvas) {
        // 처음 읽을 때 바로 세운 쪽이면 같은 방향으로 돌린다 (그림 자리 box 는 바로 세운 쪽 기준)
        const rendered = await sources[page - 1].render();
        canvas = rotateCanvas(rendered, Number(pageInfo?.rotate) || 0);
        if (canvas !== rendered) {
          rendered.width = 0;
          rendered.height = 0;
        }
        canvases.set(page, canvas);
      }
      // 쪽 방향을 확인했는지: 방향을 적어 둔 쪽이나 세로로 긴 쪽 (가로로 긴 쪽은 누운 스캔일 수 있다)
      const upright = !!pageInfo && ("rotate" in pageInfo || !(pageInfo.width > pageInfo.height));
      // 처음 읽을 때와 같은 자리 (box 는 원본 쪽 그림의 픽셀)
      const kind = fig.asset_kind ?? "diagram";
      const cut = figureImage(canvas, { x: fig.box.x, y: fig.box.y, w: fig.box.w, h: fig.box.h, kind, place: fig.place ?? "below" } as any, 1);
      const hint = t.reasons.join(" / ").slice(0, 600);
      let result: FigureResult | undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await readCached<{ figure: FigureReading; usage: Usage }>("figure", {
            image: `data:${cut.image.mediaType};base64,${cut.image.data}`,
            item: { no: item.no, stem: item.stem ?? [], choices: item.choices ?? [], bogi: item.bogi ?? [] },
            kind,
            model: o.models?.figure,
            docId: work.docId,
            hint,
            upright,
            // 같은 그림을 또 다시 읽을 때 읽기 기억(같은 요청의 지난 답)이 아니라 새로 읽게
            attempt: Number(fig.reread?.count ?? 0) + 1,
          }, o.cacheScope ?? "", signal);
          tell({ usd: progress.usd + sumUsd(r.usage), reused: (progress.reused ?? 0) + (r.cached ? 1 : 0) });
          result = { crop: cut.crop, scale: cut.scale, reading: r.figure };
          break;
        } catch (err) {
          if (err instanceof ApiError && err.usage) tell({ usd: progress.usd + err.usage.usd });
          if (signal.aborted) throw err;
          if (!transient(err)) throw err; // 열쇠가 틀림, 크레딧 부족 등: 남은 그림도 같으니 멈추고 알린다
          if (attempt < 3) {
            await wait(attempt === 1 ? 4_000 : 15_000, signal);
            continue;
          }
          const detail = err instanceof ApiError && err.detail ? ` (${err.detail})` : "";
          failed.push(`${t.name}: ${err instanceof Error ? err.message : String(err)}${detail}`);
          break;
        }
      }
      // 쓸 만한 결과일 때만 바꾼다 (다시 읽은 답이 망가졌으면 지난 그림을 그대로 둔다)
      if (result && usableReading(result, kind)) {
        replaceFigureReading(item, t.figureIndex, result, hint);
        replaced++;
      } else if (result) {
        failed.push(`${t.name}: 다시 읽은 그림 명령에 고칠 곳이 남아 지난 그림을 그대로 두었습니다 (${(result.reading?.errors ?? []).slice(0, 2).join(" / ")})`);
      }
      tell({ figuresDone: progress.figuresDone + 1 });
    }
  } finally {
    for (const c of canvases.values()) {
      c.width = 0;
      c.height = 0;
    }
  }
  reviewFigures(work.exam);
  work.usd = progress.usd;
  const out = await finishExam(o, work, signal, progress);
  return { ...out, reread: { asked: targets.length, replaced, failed } };
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
    docId,
    title: work.title,
    pageProblems,
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

