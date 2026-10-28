// 브라우저에서 올린 PDF·사진을 쪽 그림으로 바꾸고, AI 에게 보낼 크기로 줄이거나 그림을 잘라 낸다.
// 큰 그림을 한꺼번에 들고 있지 않게 쪽마다 그렸다가 바로 놓는다.

import { figureCropRect, figureSendSize, fitForClaude } from "@/lib/ai/image-geometry";
import type { FigureRegion } from "@/lib/ai/page-schema";
import type { ImageInput } from "@/lib/ai/read-page";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type PageSource = {
  /** 화면에 보여 줄 이름 (예: 시험지.pdf 3쪽) */
  label: string;
  /** 쪽 그림 (원본 해상도). 다 쓰면 release */
  render(): Promise<HTMLCanvasElement>;
};

/** PDF 를 그릴 때의 긴 변 (픽셀). A4 에서 약 260dpi: 작은 그림 글자도 잘라서 읽을 수 있게 */
const PDF_LONG_EDGE = 3000;
/** 사진이 이보다 크면 줄인다 (휴대폰 사진 등) */
const PHOTO_LONG_EDGE = 4000;

let pdfjsPromise: Promise<any> | null = null;

async function loadPdfjs(): Promise<any> {
  pdfjsPromise ??= (async () => {
    const pdfjs: any = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return pdfjs;
  })();
  return pdfjsPromise;
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

/** 올린 파일들 → 쪽 목록 (PDF 는 쪽마다, 사진은 한 장마다) */
export async function openSources(files: File[]): Promise<PageSource[]> {
  const out: PageSource[] = [];
  for (const file of files) {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (isPdf) {
      const pdfjs = await loadPdfjs();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      for (let n = 1; n <= doc.numPages; n++) {
        out.push({
          label: `${file.name} ${n}쪽`,
          async render() {
            const page = await doc.getPage(n);
            const base = page.getViewport({ scale: 1 });
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
        });
      }
    } else if (file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic)$/i.test(file.name)) {
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

/** 미리보기용 작은 그림 */
export function thumbnail(page: HTMLCanvasElement, maxWidth = 360): string {
  const s = Math.min(1, maxWidth / page.width);
  return resized(page, page.width * s, page.height * s).toDataURL("image/jpeg", 0.8);
}
