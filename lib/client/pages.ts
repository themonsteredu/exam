// 브라우저에서 올린 PDF·사진을 쪽 그림으로 바꾸고, AI 에게 보낼 크기로 줄이거나 그림을 잘라 낸다.
// 큰 그림을 한꺼번에 들고 있지 않게 쪽마다 그렸다가 바로 놓는다.

import { figureCropRect, figureSendSize, fitForClaude } from "@/lib/ai/image-geometry";
import type { FigureRegion } from "@/lib/ai/page-schema";
import type { ImageInput } from "@/lib/ai/read-page";
import { voteTextDirection, type TextDirection } from "@/lib/ai/orientation";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type PageSource = {
  /** 화면에 보여 줄 이름 (예: 시험지.pdf 3쪽) */
  label: string;
  /** PDF 를 꼼꼼히 읽어 봤을 때 그리지 못하는 부분이 있던 쪽이면 그 설명 (글이나 그림이 빠질 수 있다) */
  problem?: string;
  /** 쪽 그림 (원본 해상도). 다 쓰면 release */
  render(): Promise<HTMLCanvasElement>;
  /** 원본 종이 크기(mm). PDF 쪽은 render() 뒤에 알 수 있다 (사진은 모른다) */
  paperMm?: { width_mm: number; height_mm: number };
};

/** PDF 쪽 크기(1/72 인치 단위)를 mm 로 */
const PT_TO_MM = 25.4 / 72;

/** PDF 를 그릴 때의 긴 변 (픽셀). A4 에서 약 260dpi: 작은 그림 글자도 잘라서 읽을 수 있게 */
const PDF_LONG_EDGE = 3000;
/** 사진이 이보다 크면 줄인다 (휴대폰 사진 등) */
const PHOTO_LONG_EDGE = 4000;

let pdfjsPromise: Promise<any> | null = null;

async function loadPdfjs(): Promise<any> {
  // legacy 판: 2026년 이전 브라우저(예: 예전 아이패드의 Safari)에서도 PDF 글자가 빠지지 않게 (새 판은 최신 브라우저 기능을 쓴다)
  pdfjsPromise ??= (async () => {
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
    return pdfjs;
  })();
  return pdfjsPromise;
}

/**
 * pdf.js 보조 파일 자리 (scripts/copy-pdfjs-assets.mjs 가 public/pdfjs 에 둔다).
 * 없으면 pdf.js 는 스캔 PDF 의 흑백 글자 층(CCITT·JBIG2), 글꼴이 박히지 않은 한글 PDF 같은 부분을 오류 없이 건너뛰고 그린다
 * (2026-10-29: 복사기로 스캔한 시험지의 인쇄 글자가 모두 빠져 AI 가 읽지 못했다).
 * strict: 그리지 못하는 부분이 있으면 건너뛰지 않고 실패로 알린다 (미리 확인할 때만)
 */
function pdfOptions(strict: boolean) {
  const base = new URL("/pdfjs/", window.location.origin).href;
  return {
    wasmUrl: `${base}wasm/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    iccUrl: `${base}iccs/`,
    stopAtErrors: strict,
  };
}

/**
 * 그리지 못하는 부분이 있는 쪽을 찾는다 (그림으로 그리지는 않으므로 빠르다).
 * pdf.js 6.4 는 엄격하게 읽어도 오류를 내지 않고 그 쪽의 그리기 명령을 비워 버린다 (확인: 해독기를 막으면 보통 25개, 엄격 0개).
 * 그래서 같은 쪽을 보통·엄격 두 가지로 읽어 그리기 명령 수가 다르거나 엄격 쪽이 실패하면 빠진 것으로 본다.
 */
async function brokenPages(pdfjs: any, bytes: Uint8Array, doc: any): Promise<Set<number>> {
  const broken = new Set<number>();
  const count = async (d: any, n: number) => {
    const page = await d.getPage(n);
    const ops = (await within(page.getOperatorList(), 60_000, "쪽 확인 시간 초과") as any).fnArray.length as number;
    page.cleanup();
    return ops;
  };
  // 이 판의 pdf.js 는 문서가 아니라 여는 작업(loadingTask)을 닫는다 (시간이 넘어 못 연 경우도 함께 멈춘다)
  const task = pdfjs.getDocument({ data: bytes.slice(), ...pdfOptions(true) });
  try {
    const strict = await within(task.promise, 60_000, "PDF 확인 시간 초과") as any;
    for (let n = 1; n <= doc.numPages; n++) {
      try {
        const [usual, careful] = [await count(doc, n), await count(strict, n)];
        if (careful < usual) broken.add(n);
      } catch {
        broken.add(n);
      }
    }
  } catch {
    for (let n = 1; n <= doc.numPages; n++) broken.add(n);
  } finally {
    await task.destroy().catch(() => undefined);
  }
  return broken;
}

/** 정해진 시간 안에 끝나지 않으면 알린다 (PDF 열기가 멈춰서 화면이 하염없이 기다리지 않게) */
function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 보관함 한 파일 한도 (Supabase exam-files 50MB) */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const isPdfFile = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isImageFile = (f: File) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name);

/** AI 를 부르기 전에 파일을 확인한다: 크기, 종류, 이 브라우저에서 열리는 사진인지 (요금이 들기 전에 알리려고) */
export async function precheckFiles(files: File[]): Promise<void> {
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) throw new Error(`${f.name}: 파일이 너무 큽니다. 50MB 까지 올릴 수 있습니다.`);
    if (f.size === 0) throw new Error(`${f.name}: 빈 파일입니다.`);
    if (isPdfFile(f)) continue;
    if (!isImageFile(f)) throw new Error(`${f.name}: PDF 나 사진(JPG, PNG) 파일만 올릴 수 있습니다.`);
    try {
      const bitmap = await createImageBitmap(f);
      bitmap.close();
    } catch {
      const heic = /\.hei[cf]$/i.test(f.name) || /hei[cf]/i.test(f.type);
      throw new Error(
        heic
          ? `${f.name}: 아이폰 사진(HEIC)은 이 브라우저에서 열 수 없습니다. 사진을 JPG 로 저장해서 다시 올려 주세요.`
          : `${f.name}: 사진을 열 수 없습니다. 파일이 망가졌을 수 있습니다. 다른 파일로 해 주세요.`,
      );
    }
  }
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

/** 올린 파일들 → 쪽 목록 (PDF 는 쪽마다, 사진은 한 장마다) */
/** PDF 첫 쪽의 종이 크기(mm). 열지 못하면 undefined (보관함 '다시 만들기'에서 원본이 B4 인지 알아볼 때 쓴다) */
export async function pdfPaperMm(bytes: ArrayBuffer): Promise<{ width_mm: number; height_mm: number } | undefined> {
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), ...pdfOptions(false) }).promise;
    try {
      const base = (await doc.getPage(1)).getViewport({ scale: 1 });
      return { width_mm: base.width * PT_TO_MM, height_mm: base.height * PT_TO_MM };
    } finally {
      await doc.destroy?.();
    }
  } catch {
    return undefined;
  }
}

/** PDF 첫 쪽의 글자 줄 방향 (보관함 '다시 만들기'에서 누운 스캔으로 읽은 예전 결과인지 볼 때). 열지 못하면 'unknown' */
export async function pdfTextDirection(bytes: ArrayBuffer): Promise<TextDirection> {
  try {
    const [source] = await openSources([new File([bytes], "원본.pdf", { type: "application/pdf" })]);
    if (!source) return "unknown";
    const canvas = await source.render();
    try {
      return textDirectionOf(canvas);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch {
    return "unknown";
  }
}

export async function openSources(files: File[]): Promise<PageSource[]> {
  const out: PageSource[] = [];
  for (const file of files) {
    if (isPdfFile(file)) {
      const pdfjs = await loadPdfjs();
      const bytes = new Uint8Array(await file.arrayBuffer());
      let doc: any;
      try {
        doc = await within(
          // pdf.js 는 받은 자료를 일꾼(worker)에게 넘겨 버리므로 복사본을 준다 (엄격한 확인에 원본을 한 번 더 쓴다)
          pdfjs.getDocument({ data: bytes.slice(), ...pdfOptions(false) }).promise,
          60_000,
          `${file.name}: PDF 를 여는 데 너무 오래 걸립니다. 다른 브라우저(크롬 최신판)로 해 보거나 사진으로 올려 주세요.`,
        );
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(file.name)) throw err;
        throw new Error(`${file.name}: PDF 를 열 수 없습니다. 암호가 걸렸거나 망가진 파일일 수 있습니다.`);
      }
      const broken = await brokenPages(pdfjs, bytes, doc);
      for (let n = 1; n <= doc.numPages; n++) {
        const source: PageSource = {
          label: `${file.name} ${n}쪽`,
          problem: broken.has(n) ? "프로그램이 그리지 못하는 부분이 있어 글이나 그림이 빠질 수 있습니다" : undefined,
          async render() {
            const page = await doc.getPage(n);
            const base = page.getViewport({ scale: 1 });
            // 원본 종이 크기 (B4 원본이면 한글 파일도 B4 로 만든다)
            source.paperMm = { width_mm: base.width * PT_TO_MM, height_mm: base.height * PT_TO_MM };
            const scale = PDF_LONG_EDGE / Math.max(base.width, base.height);
            const viewport = page.getViewport({ scale });
            const canvas = canvasOf(viewport.width, viewport.height);
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, canvas, viewport }).promise;
            page.cleanup();
            return canvas;
          },
        };
        out.push(source);
      }
    } else if (isImageFile(file)) {
      out.push({
        label: file.name,
        async render() {
          // 휴대폰 사진의 회전 정보를 따라 바로 세운다
          const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
          const s = Math.min(1, PHOTO_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
          const canvas = canvasOf(bitmap.width * s, bitmap.height * s);
          const ctx = canvas.getContext("2d")!;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
          return canvas;
        },
      });
    } else {
      throw new Error(`${file.name}: PDF 나 사진(JPG, PNG) 파일만 올릴 수 있습니다.`);
    }
  }
  return out;
}

function resized(src: HTMLCanvasElement, width: number, height: number, sx = 0, sy = 0, sw = src.width, sh = src.height): HTMLCanvasElement {
  const c = canvasOf(width, height);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

function toInput(c: HTMLCanvasElement, type: "image/jpeg" | "image/png", quality = 0.92): ImageInput {
  const url = c.toDataURL(type, quality);
  return { data: url.slice(url.indexOf(",") + 1), mediaType: type, width: c.width, height: c.height };
}

/** 서버 한 번 요청 한도(Vercel 4.5MB) 안에 들어가게: 보낼 글자(base64)가 이보다 길면 JPEG 로, 그래도 길면 화질을 낮춘다 */
const MAX_IMAGE_CHARS = 3_400_000;

function toInputWithin(c: HTMLCanvasElement, type: "image/jpeg" | "image/png"): ImageInput {
  let input = toInput(c, type);
  if (input.data.length <= MAX_IMAGE_CHARS) return input;
  // 휴대폰으로 찍은 사진은 PNG 로 줄어들지 않아 커진다
  for (const quality of [0.92, 0.85, 0.75, 0.6]) {
    input = toInput(c, "image/jpeg", quality);
    if (input.data.length <= MAX_IMAGE_CHARS) break;
  }
  return input;
}

/** AI 에게 보낼 쪽 사진 (긴 변 2576px, 370만 픽셀 이하) 과 줄인 비율 */
export function pageImage(page: HTMLCanvasElement): { image: ImageInput; scale: number } {
  const fit = fitForClaude(page.width, page.height);
  const c = fit.scale < 1 ? resized(page, fit.width, fit.height) : page;
  return { image: toInputWithin(c, "image/jpeg"), scale: c.width / page.width };
}

/** 쪽 읽기에서 받은 그림 자리를 원본 쪽 그림에서 잘라 키운다 */
export function figureImage(page: HTMLCanvasElement, region: FigureRegion, pageScale: number) {
  const crop = figureCropRect(region, pageScale, { width: page.width, height: page.height });
  const send = figureSendSize(crop.w, crop.h);
  const c = resized(page, send.width, send.height, crop.x, crop.y, crop.w, crop.h);
  return { image: toInputWithin(c, "image/png"), crop, scale: send.width / crop.w };
}

/**
 * 쪽 그림의 글자 줄 방향 (가로/세로/모름). 긴 변 1600px 흑백으로 줄여 칸마다 다수결 (lib/ai/orientation voteTextDirection).
 * 세로면 옆으로 누운 스캔이다 (2026-11-02 숭의중)
 */
export function textDirectionOf(page: HTMLCanvasElement): TextDirection {
  const s = Math.min(1, 1600 / Math.max(page.width, page.height));
  const c = resized(page, page.width * s, page.height * s);
  try {
    const { data } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    const gray = new Uint8ClampedArray(c.width * c.height);
    for (let i = 0, k = 0; k < gray.length; i += 4, k++) gray[k] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    return voteTextDirection(gray, c.width, c.height).direction;
  } finally {
    c.width = 0;
    c.height = 0;
  }
}

/** 쪽 그림을 시계 방향으로 deg 도 돌린 새 그림 (0 이면 그대로) */
export function rotateCanvas(page: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const d = ((deg % 360) + 360) % 360;
  if (!d) return page;
  const swap = d === 90 || d === 270;
  const out = canvasOf(swap ? page.height : page.width, swap ? page.width : page.height);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(page, -page.width / 2, -page.height / 2);
  return out;
}

/** 방향을 물을 작은 쪽 사진 (긴 변 1024px JPEG) */
export function orientationImage(page: HTMLCanvasElement): ImageInput {
  const s = Math.min(1, 1024 / Math.max(page.width, page.height));
  const c = resized(page, page.width * s, page.height * s);
  try {
    return toInput(c, "image/jpeg", 0.8);
  } finally {
    c.width = 0;
    c.height = 0;
  }
}

/** 미리보기용 작은 그림 */
export function thumbnail(page: HTMLCanvasElement, maxWidth = 360): string {
  const s = Math.min(1, maxWidth / page.width);
  return resized(page, page.width * s, page.height * s).toDataURL("image/jpeg", 0.8);
}
