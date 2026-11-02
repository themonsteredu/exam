// 옆으로 누운(90° 돌아간) 시험지 쪽 다루기 (AI 없이 하는 부분).
// 2026-11-02 숭의중: 복사기가 B4 시험지를 옆으로 눕혀 스캔해 PDF 쪽이 가로로 길고 글자가 누워 있었다.
// 누운 그대로 읽어 그림 크기를 누운 쪽 기준으로 재는 바람에 그림이 절반쯤으로 작아지고, 쪽 아래가 비었으며, 그림 몇 개는 누운 채로 그려졌다.
//  - voteTextDirection: 쪽을 작은 칸으로 나눠 칸마다 빈 가로줄과 빈 세로줄 비율을 견주고 다수결로 글자 줄이 가로인지 세로인지 본다
//    (보관된 시험지 11개: 바로 놓인 쪽은 가로 칸이 많고(35:11, 33:0 …), 누운 쪽은 세로 칸이 많다(4:26, 2:23 …))
//  - 이미 누운 채로 읽은 결과는 문항 순서로 어느 쪽으로 돌려야 하는지 알아내고(itemOrderRotation), 자리와 크기를 바로 세운다(uprightExam)

import { layoutFor, paperOf } from "./assemble";
import { itemFigures } from "@/lib/figure/item-figures";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type TextDirection = "horizontal" | "vertical" | "unknown";

/**
 * 흑백 쪽 그림(밝기 0~255, 긴 변 1600px 쯤)에서 글자 줄 방향을 다수결로 본다.
 * 거의 빈 칸·거의 검은 칸은 빼고, 빈 가로줄이 빈 세로줄보다 8%p 넘게 많으면 가로 칸, 반대면 세로 칸으로 센다.
 * 세로 칸이 8개 이상이고 가로 칸의 1.5배 넘으면 'vertical' (방향은 AI 에게 다시 묻는다), 가로 칸이 8개 이상이고 세로 칸의 1.3배 넘으면 'horizontal', 나머지는 모름.
 * 보관된 시험지 11개: 바로 놓인 쪽 가장 애매한 것 28:20, 누운 쪽 가장 애매한 것 8:23.
 */
export function voteTextDirection(gray: ArrayLike<number>, width: number, height: number, grid = 8): { horizontal: number; vertical: number; direction: TextDirection } {
  const th = Math.floor(height / grid), tw = Math.floor(width / grid);
  let horizontal = 0, vertical = 0;
  if (th < 8 || tw < 8) return { horizontal, vertical, direction: "unknown" };
  const rowInk = new Int32Array(th), colInk = new Int32Array(tw);
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      rowInk.fill(0);
      colInk.fill(0);
      let ink = 0;
      for (let y = 0; y < th; y++) {
        const base = (i * th + y) * width + j * tw;
        for (let x = 0; x < tw; x++) {
          if (gray[base + x] < 150) {
            rowInk[y]++;
            colInk[x]++;
            ink++;
          }
        }
      }
      const fill = ink / (th * tw);
      if (fill < 0.02 || fill > 0.4) continue;
      let blankRows = 0, blankCols = 0;
      for (let y = 0; y < th; y++) if (rowInk[y] <= tw * 0.01) blankRows++;
      for (let x = 0; x < tw; x++) if (colInk[x] <= th * 0.01) blankCols++;
      const r = blankRows / th, c = blankCols / tw;
      if (r > c + 0.08) horizontal++;
      else if (c > r + 0.08) vertical++;
    }
  }
  const direction: TextDirection = vertical >= 8 && vertical > horizontal * 1.5 ? "vertical" : horizontal >= 8 && horizontal > vertical * 1.3 ? "horizontal" : "unknown";
  return { horizontal, vertical, direction };
}

/** 누운 쪽 그림의 점 (x, y) 를, 쪽을 시계 방향으로 rotate 도 돌려 바로 세운 그림의 점으로 (W×H 는 누운 그림 크기) */
export function uprightPoint(x: number, y: number, W: number, H: number, rotate: number): [number, number] {
  switch (((rotate % 360) + 360) % 360) {
    case 90:
      return [H - y, x];
    case 180:
      return [W - x, H - y];
    case 270:
      return [y, W - x];
    default:
      return [x, y];
  }
}

type Box = { x: number; y: number; w: number; h: number };

export function uprightBox(b: Box, W: number, H: number, rotate: number): Box {
  const [x1, y1] = uprightPoint(b.x, b.y, W, H, rotate);
  const [x2, y2] = uprightPoint(b.x + b.w, b.y + b.h, W, H, rotate);
  return { x: Math.round(Math.min(x1, x2)), y: Math.round(Math.min(y1, y2)), w: Math.round(Math.abs(x2 - x1)), h: Math.round(Math.abs(y2 - y1)) };
}

/**
 * 누운 채로 읽은 시험지를 쪽마다 어느 쪽으로 돌려야 하는지 문항 차례로 알아낸다 (쪽 번호 → 90 또는 270).
 * 바로 세운 쪽에서는 같은 단의 다음 문항이 아래에 있고, 단이 바뀌면 오른쪽에 있어야 한다. 두 방향으로 돌려 보고 차례가 맞는 쪽.
 * 앞뒷면을 함께 스캔한 PDF 는 쪽마다 방향이 번갈아 다르다 (2026-11-02 숭의중: 1·3·5쪽 90°, 2·4쪽 270°).
 * 문항이 하나뿐이라 모르는 쪽은 두 쪽 앞(같은 면)의 방향을, 그것도 모르면 남긴다.
 */
export function itemOrderRotations(exam: any): Map<number, 90 | 270> {
  const pages = new Map<number, any>();
  for (const p of Array.isArray(exam?.source_pages) ? exam.source_pages : []) pages.set(p.page, p);
  const items: any[] = (exam?.sections ?? []).flatMap((s: any) => s.items ?? []).filter((it: any) => it?.source && pages.has(it.source.page));
  const out = new Map<number, 90 | 270>();
  const score = (page: number, rotate: number) => {
    let good = 0, bad = 0;
    for (let k = 1; k < items.length; k++) {
      const a = items[k - 1].source, b = items[k].source;
      if (a.page !== page || b.page !== page) continue;
      const pg = pages.get(page);
      const ba = uprightBox(a, pg.width, pg.height, rotate), bb = uprightBox(b, pg.width, pg.height, rotate);
      const pageWidth = rotate === 90 || rotate === 270 ? pg.height : pg.width;
      const sameColumn = Math.abs(ba.x - bb.x) < pageWidth * 0.2;
      if ((sameColumn && bb.y > ba.y) || (!sameColumn && bb.x > ba.x)) good++;
      else bad++;
    }
    return { good, bad };
  };
  const sorted = [...pages.keys()].sort((a, b) => a - b);
  for (const page of sorted) {
    const a = score(page, 90), b = score(page, 270);
    if (a.good >= 1 && a.bad === 0 && b.good < a.good) out.set(page, 90);
    else if (b.good >= 1 && b.bad === 0 && a.good < b.good) out.set(page, 270);
  }
  for (const page of sorted) if (!out.has(page) && out.has(page - 2)) out.set(page, out.get(page - 2)!);
  return out;
}

/**
 * 누운 채로 읽은 시험지의 자리(문항·그림 사각형, 기준점)와 쪽 크기를 바로 세우고, 용지(B4 등)와 그림 크기를 다시 정한다.
 * 이미 바로 세운 시험지(source_pages 에 rotate 가 있음)는 그대로 돌려준다. 누운 채로 그린 그림은 reviewFigures 가 원본 방향으로 돌린다.
 */
export function uprightExam(exam: any, rotations: Map<number, 90 | 180 | 270>): any {
  const pagesIn: any[] = Array.isArray(exam?.source_pages) ? exam.source_pages : [];
  if (!pagesIn.length || !rotations.size || pagesIn.some((p) => p && "rotate" in p)) return exam;
  const copy = JSON.parse(JSON.stringify(exam));
  const dims = new Map<number, { W: number; H: number; rotate: number }>(pagesIn.map((p) => [p.page, { W: p.width, H: p.height, rotate: rotations.get(p.page) ?? 0 }]));
  copy.source_pages = pagesIn.map((p) => {
    const rotate = rotations.get(p.page) ?? 0;
    const swap = rotate === 90 || rotate === 270;
    return {
      page: p.page,
      width: swap ? p.height : p.width,
      height: swap ? p.width : p.height,
      ...(p.width_mm ? { width_mm: swap ? p.height_mm : p.width_mm, height_mm: swap ? p.width_mm : p.height_mm } : {}),
      // 방향을 알아낸 쪽만 rotate 를 적는다 (적힌 쪽은 바로 선 쪽으로 믿고 그림 방향도 고친다)
      ...(rotations.has(p.page) ? { rotate } : {}),
    };
  });
  const turnBox = (b: any) => {
    const d = dims.get(b?.page);
    return d && b ? { ...b, ...uprightBox(b, d.W, d.H, d.rotate) } : b;
  };
  // 용지: 바로 세운 쪽 크기로 (B4 원본이면 B4)
  const first = copy.source_pages.find((p: any) => "rotate" in p) ?? copy.source_pages[0];
  const paper = paperOf(first.width_mm ? { width_mm: first.width_mm, height_mm: first.height_mm } : undefined);
  if (paper.name !== "A4") copy.paper = { ...paper };
  else delete copy.paper;
  const layout = layoutFor(copy.paper);
  // 쪽마다 인쇄 영역 가로(바로 세운 픽셀): 그 쪽 문항들이 차지한 가로 폭 (모르면 쪽 너비의 90%)
  const printWidth = new Map<number, number>();
  for (const s of copy.sections ?? []) {
    for (const it of s.items ?? []) {
      if (it?.source) it.source = turnBox(it.source);
      const src = it?.source;
      if (!src) continue;
      const cur = printWidth.get(src.page) as any;
      const span = cur ? { l: Math.min(cur.l, src.x), r: Math.max(cur.r, src.x + src.w) } : { l: src.x, r: src.x + src.w };
      printWidth.set(src.page, span as any);
    }
  }
  const mmPerPx = (page: number) => {
    const pg = copy.source_pages.find((p: any) => p.page === page);
    const span: any = printWidth.get(page);
    const w = span ? span.r - span.l : 0;
    return layout.textWidthMm / (pg && w > pg.width * 0.5 ? w : (pg?.width ?? 1) * 0.9);
  };
  for (const s of copy.sections ?? []) {
    for (const it of s.items ?? []) {
      for (const fig of itemFigures(it) as any[]) {
        if (!fig?.box) continue;
        const d = dims.get(fig.box.page);
        if (!d) continue;
        fig.box = turnBox(fig.box);
        if (Array.isArray(fig.anchors)) {
          fig.anchors = fig.anchors.map((a: any) => (Array.isArray(a?.px) ? { ...a, px: uprightPoint(a.px[0], a.px[1], d.W, d.H, d.rotate).map(Math.round) } : a));
        }
        const maxW = layout.columnWidthMm * (fig.place === "right" ? layout.rightMaxRatio : 0.95);
        const width = Math.max(12, Math.min(maxW, fig.box.w * mmPerPx(fig.box.page)));
        fig.width_mm = Math.round(width * 10) / 10;
        fig.size_mm = [fig.width_mm, Math.round((fig.box.h / Math.max(1, fig.box.w)) * width * 10) / 10];
        delete fig.png;
        delete fig.png_size;
      }
    }
  }
  return copy;
}
