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
import { figureImage, openSources, pageImage, precheckFiles } from "./pages";
import { assertFresh } from "./version";

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
};

export type MakeResult = {
  exam: any;
  hwpx: Blob;
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

/** 한글 파일 만들기에 보낼 시험지 데이터(그림 PNG 포함)의 상한: Vercel 요청 한도 4.5MB 와 Python 함수의 4.4MB 보다 조금 작게 */
const MAX_HWPX_BODY = 4_300_000;

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
      throw new ApiError(`${i + 1}쪽을 읽지 못했습니다: ${err instanceof Error ? err.message : err}`, err instanceof ApiError ? err.status : 0);
    }
    tell({ usd: progress.usd + sumUsd(res.usage) });
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
            const r = await postJson<{ figure: FigureReading; usage: Usage }>("/api/read/figure", {
              image: `data:${cut.image.mediaType};base64,${cut.image.data}`,
              item,
              docId,
            }, signal);
            figures.set(job.key, { crop: cut.crop, scale: cut.scale, reading: r.figure });
            tell({ usd: progress.usd + sumUsd(r.usage) });
          } catch (err) {
            if (signal.aborted) throw err;
            figures.set(job.key, { crop: cut.crop, scale: cut.scale, error: err instanceof Error ? err.message : String(err) });
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
  // 읽은 결과를 먼저 보관한다 (뒤에서 한글 파일 만들기가 실패해도 요금을 낸 읽기 결과는 남게)
  await patchJson(`/api/documents/${docId}`, { exam_json: stripPngs(exam), cost_usd: progress.usd }).catch(() => undefined);
  tell({ step: "draw", message: "그림을 그리는 중입니다." });
  let rendered = await renderExamFigures(o.JXG, exam);
  let body = JSON.stringify(attachFigurePngs(exam, rendered));
  const bytes = (text: string) => new Blob([text]).size; // 한글은 글자 하나가 3바이트
  if (bytes(body) > MAX_HWPX_BODY) {
    // 그림이 아주 많으면 서버 한 번 요청 한도(4.5MB)를 넘는다 → 그림을 한도 안의 가장 낮은 해상도(300dpi)로 다시 그린다
    rendered = await renderExamFigures(o.JXG, exam, 300);
    body = JSON.stringify(attachFigurePngs(exam, rendered));
  }
  if (bytes(body) > MAX_HWPX_BODY) {
    throw new ApiError("그림이 너무 많아 한글 파일을 한 번에 만들 수 없습니다. PDF 를 몇 쪽씩 나눠서 다시 올려 주세요.", 413);
  }
  const withPng = JSON.parse(body);
  const failedFigures = rendered.filter((r) => !r.png).length;

  // 4) 한글 파일
  check();
  tell({ step: "hwpx", message: "한글 파일을 만드는 중입니다." });
  const res = await fetch(o.hwpxEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    credentials: "same-origin",
    signal,
  });
  if (!res.ok) {
    let msg = `한글 파일을 만들지 못했습니다 (${res.status}).`;
    try {
      const body = await res.json();
      if (body.error) msg = `${body.error}${body.detail ? ` (${body.detail})` : ""}`;
    } catch {
      /* 그대로 */
    }
    throw new ApiError(msg, res.status);
  }
  const hwpx = await res.blob();
  let warnings: string[] = [];
  try {
    warnings = JSON.parse(decodeURIComponent(res.headers.get("x-hwpx-warnings") || "[]"));
  } catch {
    /* 알림 없음 */
  }
  // PDF 에서 그리지 못한 쪽도 결과 알림에 남긴다
  warnings = [...pageProblems, ...warnings];

  // 5) 보관
  tell({ step: "save", message: "보관함에 저장하는 중입니다." });
  const fileName = `${(o.title || "시험지").replace(/[\\/:*?"<>|]/g, "_")}.hwpx`;
  const items = (exam.sections ?? []).reduce((n: number, s: any) => n + (s.items?.length ?? 0), 0);
  const problems: string[] = [];
  // 원본 보관이 실패해도 한글 파일과 시험지 데이터는 따로 보관한다
  let originalsError = "";
  try {
    await uploads;
  } catch (err) {
    originalsError = err instanceof Error ? err.message : String(err);
    problems.push(`원본 파일을 보관하지 못했습니다 (${originalsError})`);
  }
  let saved = false;
  try {
    const ref = await uploadFile(docId, "generated", new Blob([hwpx], { type: "application/hwp+zip" }), fileName, 0, o.signal);
    await patchJson(`/api/documents/${docId}`, {
      hwpx_path: ref.path,
      exam_json: stripPngs(exam),
      status: "done",
      cost_usd: progress.usd,
      item_count: items,
      ...(originalsError ? { note: `원본을 보관하지 못했습니다: ${originalsError}`.slice(0, 500) } : {}),
    });
    saved = true;
  } catch (err) {
    problems.unshift(`한글 파일을 보관함에 저장하지 못했습니다 (${err instanceof Error ? err.message : String(err)})`);
  }
  return {
    exam: withPng,
    hwpx,
    fileName,
    warnings,
    usd: progress.usd,
    unsure: countUnsure(exam),
    failedFigures,
    saved,
    saveProblem: problems.length ? problems.join(" / ") : undefined,
  };
}
