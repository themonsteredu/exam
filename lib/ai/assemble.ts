// 쪽 읽기(1차)와 그림 읽기(2차) 결과를 합쳐 시험지 JSON 을 만든다.
// 시험지 JSON 은 data/exam_p1_manual.json 과 같은 모양이고, 한글 파일 만드는 쪽(py/exam_hwpx)이 그대로 받는다.
// 사진 속 위치(box, source, anchors)는 모두 원본 사진의 픽셀로 바꿔 둔다 (확인 화면에서 원본과 비교할 때 쓴다).

import type { FigureRegion, ItemReading, PageReading, Piece, Region } from "./page-schema";
import type { FigureReading } from "./read-figure";
import { figureRegionKey, validFigureRegion, type Size } from "./image-geometry";
import { itemFigures } from "@/lib/figure/item-figures";
import {
  degreeMismatches,
  degreeMismatchNote,
  overlappingLabels,
  repairDegrees,
  SHAPE_DEVIATION_LIMIT,
  shapeDeviation,
  shapeDeviationNote,
  uprightFigure,
  withShape,
  worthReporting,
  type Anchor,
} from "@/lib/figure/review";
import { checkFigureSpec } from "@/lib/figure/validate";
import type { FigureSpec } from "@/lib/figure/types";

/** 시험지 JSON 의 글 조각: 글 {t} 또는 수식 {m}. {t: "\n"} 은 문단 나눔 */
export type ExamPiece = { t: string } | { m: string };

export type PageMeta = {
  /** 1부터 */
  page: number;
  /** 원본 사진 크기 */
  original: { width: number; height: number };
  /** AI 에게 보낸 사진 픽셀 = 원본 픽셀 × scale */
  scale: number;
  /** 원본 종이 크기(mm). PDF 쪽에서만 안다 (사진은 모른다). 바로 세운 쪽 기준 */
  paper_mm?: { width_mm: number; height_mm: number };
  /** 읽기 전에 쪽 그림을 시계 방향으로 돌린 각 (0·90·180·270). 글자 방향을 확인한 쪽만 (모르면 없음) */
  rotate?: number;
};

/** 용지 (mm) */
export type Paper = { name: string; width_mm: number; height_mm: number };
export const A4: Paper = { name: "A4", width_mm: 210, height_mm: 297 };
export const B4: Paper = { name: "B4", width_mm: 257, height_mm: 364 };

/**
 * 원본 종이 크기를 표준 용지로: B4(257×364, 250×353 도)에 가까우면 B4, 나머지(A4, 모르는 크기, 가로 쪽, 사진)는 A4.
 * 2026-11-01 호남삼육중: B4 4쪽 원본을 A4 4쪽에 맞추느라 글자 9.5pt·그림 0.65배까지 줄어 품질이 떨어졌다 → 원본이 B4 면 B4 로 만든다.
 */
export function paperOf(size?: { width_mm?: number; height_mm?: number }): Paper {
  const w = Number(size?.width_mm), h = Number(size?.height_mm);
  if (!(w > 0) || !(h > 0)) return A4;
  const near = (pw: number, ph: number) => Math.abs(w / pw - 1) < 0.04 && Math.abs(h / ph - 1) < 0.04;
  return near(257, 364) || near(250, 353) ? B4 : A4;
}

/** 용지에 맞춘 양식 값: A4 양식의 여백·단 사이를 용지 너비 비율로 늘린다 (py/exam_hwpx/template.py 의 with_paper 와 같게) */
export function layoutFor(paper?: { width_mm?: number }): Layout {
  const r = paper?.width_mm && paper.width_mm > 0 ? paper.width_mm / A4.width_mm : 1;
  return { textWidthMm: SCHOOL_A_LAYOUT.textWidthMm * r, columnWidthMm: SCHOOL_A_LAYOUT.columnWidthMm * r, rightMaxRatio: SCHOOL_A_LAYOUT.rightMaxRatio };
}

/**
 * A4 양식 크기로 만든 읽기 결과를 다른 용지(B4)로 옮긴다: exam.paper 를 적고 그림 크기를 용지 너비 비율로 늘린다.
 * 이미 용지가 적혀 있거나 A4 면 그대로 둔다 (보관함 '다시 만들기'에서 원본 PDF 크기로 용지를 알아냈을 때 쓴다).
 */
export function applyPaper(exam: any, paper: Paper): any {
  if (!exam || exam.paper || paper.name === "A4") return exam;
  const copy = JSON.parse(JSON.stringify(exam));
  copy.paper = { ...paper };
  const r = paper.width_mm / A4.width_mm;
  const layout = layoutFor(paper);
  for (const s of copy.sections ?? []) {
    for (const it of s.items ?? []) {
      for (const fig of [it.figure, ...(Array.isArray(it.extra_figures) ? it.extra_figures : [])]) {
        if (!fig || !(Number(fig.width_mm) > 0)) continue;
        const maxW = layout.columnWidthMm * (fig.place === "right" ? layout.rightMaxRatio : 0.95);
        const width = Math.min(maxW, fig.width_mm * r);
        if (Array.isArray(fig.size_mm) && fig.size_mm[0] > 0) fig.size_mm = [round1(width), round1((fig.size_mm[1] / fig.size_mm[0]) * width)];
        fig.width_mm = round1(width);
        // 크기가 바뀌었으니 예전 PNG 는 쓰지 않는다 (다시 그린다)
        delete fig.png;
        delete fig.png_size;
      }
    }
  }
  return copy;
}

/** 그림 하나를 읽은 결과 */
export type FigureResult = {
  /** 원본 사진에서 잘라 낸 사각형 (원본 픽셀) */
  crop: Region;
  /** AI 에게 보낸 그림 사진 픽셀 = 잘라 낸 원본 픽셀 × scale */
  scale: number;
  reading?: FigureReading;
  /** 읽기에 실패한 까닭 */
  error?: string;
};

/** 다시 그릴 수 없는 사진 (AI 에게 보내지 않고 한글 파일에는 빈 자리로 둔다. 원본을 잘라 붙이지 않는다) */
export const SKIP_KINDS = new Set(["photo"]);

/** 양식에서 그림 크기를 정하는 데 쓰는 값 (py/exam_hwpx/template.py 와 같게) */
export type Layout = { textWidthMm: number; columnWidthMm: number; rightMaxRatio: number };

export const SCHOOL_A_LAYOUT: Layout = { textWidthMm: 210 - 12 - 12, columnWidthMm: (210 - 12 - 12 - 8) / 2, rightMaxRatio: 0.5 };

export function figureKey(page: number, section: number, item: number, figure: number): string {
  return `${page}-${section}-${item}-${figure}`;
}

/** 범위를 확인한 그림만 원래 순서로 읽고, 건너뛴 사각형은 문항의 확인할 곳에 표시한다. */
function figureRegions(figures: FigureRegion[], image?: Size) {
  const seen = new Set<string>();
  const regions: { region: FigureRegion; index: number }[] = [];
  let invalid = 0;
  let duplicate = 0;
  figures.forEach((region, index) => {
    if (!validFigureRegion(region, image)) {
      invalid++;
      return;
    }
    const key = figureRegionKey(region);
    if (seen.has(key)) {
      duplicate++;
      return;
    }
    seen.add(key);
    regions.push({ region, index });
  });
  return { regions, invalid, duplicate };
}

/** 쪽마다 읽을 그림 목록 (그림 읽기에 넘길 것) */
export function figureJobs(page: number, reading: PageReading, image?: Size) {
  const jobs: { key: string; region: FigureRegion; item: ItemReading }[] = [];
  reading.sections.forEach((section, s) =>
    section.items.forEach((item, i) => {
      for (const { region, index } of figureRegions(item.figures, image).regions) {
        if (!SKIP_KINDS.has(region.kind)) jobs.push({ key: figureKey(page, s, i, index), region, item });
      }
    }),
  );
  return jobs;
}

/** AI 조각 → 시험지 JSON 조각. 글 속 줄바꿈은 문단 나눔 조각으로, 맨 앞뒤 빈칸은 뺀다 */
export function toExamPieces(pieces: Piece[]): ExamPiece[] {
  const out: ExamPiece[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && "t" in last && last.t !== "\n" && t !== "\n") last.t += t;
    else out.push({ t });
  };
  for (const p of pieces) {
    if (p.kind === "m") {
      const m = p.text.trim();
      if (m) out.push({ m });
      continue;
    }
    p.text.replace(/\r/g, "").split("\n").forEach((part, i) => {
      if (i > 0) pushText("\n");
      pushText(part);
    });
  }
  // 문단 나눔 둘레와 맨 앞뒤의 빈칸 정리, 빈 문단 나눔 지우기
  const cleaned: ExamPiece[] = [];
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    if ("t" in p && p.t === "\n") {
      if (!cleaned.length || i === out.length - 1) continue;
      const prev = cleaned[cleaned.length - 1];
      if ("t" in prev && prev.t === "\n") continue;
      cleaned.push(p);
      continue;
    }
    cleaned.push(p);
  }
  const trimAt = (idx: number, side: "start" | "end") => {
    const p = cleaned[idx];
    if (!p || !("t" in p) || p.t === "\n") return;
    p.t = side === "start" ? p.t.replace(/^\s+/, "") : p.t.replace(/\s+$/, "");
    if (!p.t) cleaned.splice(idx, 1);
  };
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const p = cleaned[i];
    if ("t" in p && p.t === "\n") {
      trimAt(i + 1, "start");
      trimAt(i - 1, "end");
    }
  }
  trimAt(cleaned.length - 1, "end");
  trimAt(0, "start");
  return cleaned;
}

const toOriginal = (r: Region, scale: number): Region => ({
  x: Math.round(r.x / scale),
  y: Math.round(r.y / scale),
  w: Math.round(r.w / scale),
  h: Math.round(r.h / scale),
});

const round1 = (n: number) => Math.round(n * 10) / 10;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function assembleExam(
  pages: { meta: PageMeta; reading: PageReading }[],
  figures: Map<string, FigureResult>,
  o: { template?: string; layout?: Layout } = {},
): any {
  // 원본 PDF 가 B4 면 B4 용지로 (그림 크기도 B4 본문 너비로 정한다)
  const paper = paperOf(pages.find(({ meta }) => meta.paper_mm)?.meta.paper_mm);
  const layout = o.layout ?? layoutFor(paper);
  const exam: any = { template: o.template ?? "school-A-2026", header: {}, footer: {}, boxes: [], sections: [] };
  if (paper.name !== "A4") exam.paper = { ...paper };
  const unsure: string[] = [];
  let prev: { page: number; column: number; item: any } | undefined;

  const first = <T>(pick: (r: PageReading) => T | undefined) => {
    for (const { reading } of pages) {
      const v = pick(reading);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const header = first((r) => (r.header.present ? r.header : undefined));
  if (header) exam.header = { title: header.title, target_label: header.target_label || "응시대상", target: header.target, date: header.date };
  const footer = first((r) => (r.footer.present ? r.footer : undefined));
  if (footer) exam.footer = { right_top: footer.right_top, right_bottom: footer.right_bottom, notice: footer.notice };
  const examBox = (b: PageReading["boxes"][number]) => ({
    kind: b.kind,
    lines: b.lines.map((l) => (l.center ? { text: l.text, align: "CENTER" } : l.text)),
    ...(b.framed === false ? { framed: false } : {}),
  });
  // 안내 상자: 첫 문항보다 앞(머리 아래)에 있는 것은 exam.boxes, 쪽 중간·끝의 상자는 그 다음 문항 앞(boxes_before)이나
  // 그 쪽 마지막 문항 뒤(boxes_after)에 둔다 (예전 읽기 결과처럼 before 가 없으면 첫 상자 쪽의 것만 머리 아래로)
  let topBoxesTaken = false;

  for (const { meta, reading } of pages) {
    const mmPerPx = mmPerOriginalPx(reading, meta, layout);
    const image = { width: Math.round(meta.original.width * meta.scale), height: Math.round(meta.original.height * meta.scale) };
    for (const u of reading.unsure) unsure.push(`${meta.page}쪽: ${u}`);
    const pageItems: { it: ItemReading; item: any }[] = [];
    reading.sections.forEach((section, s) => {
      let target: any;
      if (s === 0 && !section.title && exam.sections.length) target = exam.sections[exam.sections.length - 1];
      else {
        target = { title: section.title, items: [] };
        exam.sections.push(target);
      }
      section.items.forEach((it, i) => {
        const item: any = { no: it.no };
        if (it.no_text && !new RegExp(`^${it.no}\\s*[.)]?$`).test(it.no_text.trim())) item.label = it.no_text.trim();
        if (it.points) item.points = it.points;
        item.stem = toExamPieces(it.stem);
        const bogi = it.bogi.map(toExamPieces).filter((line) => line.length);
        if (bogi.length) item.bogi = bogi;
        const itemUnsure = [...it.unsure];
        const { regions, invalid, duplicate } = figureRegions(it.figures, image);
        if (invalid) {
          itemUnsure.push("원본에서 범위를 확인하지 못한 그림이 있습니다");
        }
        if (duplicate) itemUnsure.push("같은 위치로 읽은 그림이 있어 원본을 확인해 주세요");

        // 그림이 여럿이면 모두 넣는다 (첫 그림은 figure, 나머지는 extra_figures. 선택지가 모두 그림이면 한글 파일에서 ①~⑤ 를 붙여 나란히 둔다)
        const all = regions.map(({ region, index }) =>
          makeFigure(region, figures.get(figureKey(meta.page, s, i, index)), meta, mmPerPx, layout, itemUnsure),
        );
        if (all.length) item.figure = all[0];
        if (all.length > 1) item.extra_figures = all.slice(1);
        item.choices = it.choices.map(toExamPieces);
        // 선택지 배치(한 줄에 나란히 등)는 원본대로. 한 줄에 하나씩(column)이 기본이라 적지 않는다
        if (item.choices.length && (it.choice_layout === "row" || it.choice_layout === "grid")) item.choice_layout = it.choice_layout;
        item.source = { page: meta.page, ...toOriginal(it.source, meta.scale) };
        if (itemUnsure.length) item.unsure = itemUnsure;

        // 원본에서 단이나 쪽이 바뀐 곳은 그대로 나눈다. 부분 제목 상자 바로 앞이면 제목 상자에서 나눈다
        // (2026-11-01 사용자: 이어서 흐르게 했더니 문항이 단·쪽 사이에서 잘림 → "원본과 동일하게" 나누기로 되돌림.
        //  문항 사이 빈 공간은 줄인 채로 두고, 한글 파일에서 한 문항은 한 단에 붙어 있게 한다)
        const column = it.column === 2 ? 2 : 1;
        if (prev) {
          let brk: string | undefined = meta.page !== prev.page ? "page" : column !== prev.column ? "column" : undefined;
          // 앞 문항이 원본에서 두 단에 걸쳐 있으면(12번의 선택지가 오른쪽 단 위에 이어짐) 이 문항은 단 맨 위가 아니다 → 단을 나누지 않는다
          if (brk === "column" && spansIntoNextColumn(prev.item, toOriginal(reading.print_area, meta.scale))) brk = undefined;
          if (brk) {
            if (i === 0 && target.items.length === 0 && target.title) target.break_before = brk;
            else item.break_before = brk;
          }
        }
        // 원본에서 다음 단까지 이어진 문항은 한글 파일에서도 단 사이에서 나뉘어도 된다 (원본과 같은 자리에서 이어지게)
        if (spansIntoNextColumn(item, toOriginal(reading.print_area, meta.scale))) item.split_ok = true;
        prev = { page: meta.page, column, item };
        target.items.push(item);
        pageItems.push({ it, item });
      });
    });
    // 이 쪽의 안내 상자 자리 정하기
    const norm = (t: string) => t.replace(/\s+/g, "");
    const examStarted = exam.sections.some((s: any) => s.items.some((x: any) => !pageItems.some((p) => p.item === x)));
    for (const b of reading.boxes) {
      const before = typeof b.before === "string" ? norm(b.before) : undefined;
      const hit = before ? pageItems.find((p) => norm(p.it.no_text || `${p.it.no}.`) === before) : undefined;
      const atTop = !topBoxesTaken && !examStarted && (before === undefined || (hit ? hit === pageItems[0] : !pageItems.length));
      if (atTop) exam.boxes.push(examBox(b));
      else if (hit) (hit.item.boxes_before ??= []).push(examBox(b));
      else {
        const last = pageItems[pageItems.length - 1]?.item ?? exam.sections.at(-1)?.items.at(-1);
        if (last) (last.boxes_after ??= []).push(examBox(b));
      }
    }
    if (exam.boxes.length) topBoxesTaken = true;
  }
  tidyExam(exam);
  reviewFigures(exam);
  // 쪽 끝 안내는 마지막 쪽 것만 (한글 파일에서는 쪽 나눔이 원본과 다를 수 있어 문서 끝에 하나만 둔다)
  const note = pages[pages.length - 1]?.reading.page_end_note;
  if (note) exam.page_end_note = note;
  exam.source_pages = pages.map(({ meta }) => ({
    page: meta.page,
    width: meta.original.width,
    height: meta.original.height,
    ...(meta.paper_mm ? { width_mm: round1(meta.paper_mm.width_mm), height_mm: round1(meta.paper_mm.height_mm) } : {}),
    // 그림 다시 읽기에서 같은 방향으로 돌려 자르려고, 그리고 방향을 확인한 쪽이라는 표시로
    ...(meta.rotate !== undefined ? { rotate: meta.rotate } : {}),
  }));
  if (unsure.length) exam.unsure = unsure;
  return exam;
}

/**
 * 읽은 결과의 뻔한 실수를 고친다 (요금 없이, 만들 때마다):
 * - 문항 번호: 앞뒤 번호 사이에 하나만 어긋난 번호(14 → 5 → 16)는 사이 번호(15)로 고치고 확인할 곳에 남긴다
 *   (빨간 펜 표시 등에 가려 앞자리를 못 읽은 경우). 서술형처럼 label 이 붙은 번호는 따로 센다.
 */
export function tidyExam(exam: any): any {
  const groups = new Map<string, any[]>();
  for (const s of exam?.sections ?? []) {
    for (const it of s.items ?? []) {
      if (typeof it.no !== "number") continue;
      const key = it.label ? String(it.label).replace(/[\d\s.)\]]+$/g, "") : "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(it);
    }
  }
  for (const list of groups.values()) {
    for (let i = 1; i < list.length - 1; i++) {
      const prev = list[i - 1].no, next = list[i + 1].no, cur = list[i];
      if (next === prev + 2 && cur.no !== prev + 1) {
        const was = cur.no;
        cur.no = prev + 1;
        if (cur.label) cur.label = String(cur.label).replace(String(was), String(cur.no));
        (cur.unsure ??= []).push(`번호를 ${was} 로 읽어 앞뒤 번호에 맞춰 ${cur.no} 로 고쳤습니다`);
      }
    }
  }
  return exam;
}

/** 다시 읽기를 권하는 그림 (원본·조건과 달라 보이거나 읽지 못한 그림) */
export type FigureSuspect = {
  section: number;
  index: number;
  /** 문항 안의 몇 번째 그림인지 (0 은 figure, 1 부터 extra_figures) */
  figureIndex: number;
  /** 화면에 보일 문항 이름 (예: "2번", "서답형 2.") */
  name: string;
  /** 찾은 문제 (짧은 문장) */
  reasons: string[];
};

const isSpec = (v: unknown): v is FigureSpec => !!v && typeof v === "object" && Array.isArray((v as FigureSpec).elements);

/**
 * 그림 명령을 원본·조건과 견줘 살핀다 (AI 없이, 만들 때와 보관함 '다시 만들기' 때 모두. 같은 시험지에 여러 번 해도 결과가 같다).
 * - 숫자 각 글자와 그린 각이 다르면 방향각을 헷갈린 실수를 고친다 (고친 곳은 그림의 auto_fixes 에 남긴다)
 * - 그래도 다르거나 원본 사진 속 점 자리와 모양이 크게 다른 그림, 읽지 못해 빈 자리로 둔 그림은 다시 읽기를 권하는 목록으로 돌려준다
 * 시험지 데이터를 그 자리에서 고친다.
 */
export function reviewFigures(exam: any): FigureSuspect[] {
  const suspects: FigureSuspect[] = [];
  // 바로 선 쪽인지: 방향을 확인한 쪽(rotate 가 적힘)이나 세로로 긴 쪽. 가로로 긴 쪽은 옆으로 누운 스캔일 수 있어,
  // 원본 사진과 그림의 방향이 달라도 그림 탓이라고 보지 않는다 (누운 사진을 보고 바로 세워 그린 그림을 다시 눕히지 않게)
  const pages = new Map<number, any>((Array.isArray(exam?.source_pages) ? exam.source_pages : []).map((p: any) => [p.page, p]));
  const uprightPage = (page: unknown) => {
    const p = pages.get(Number(page));
    return !p || "rotate" in p || !(p.width > p.height);
  };
  (exam?.sections ?? []).forEach((s: any, section: number) => {
    (s?.items ?? []).forEach((it: any, index: number) => {
      itemFigures(it).forEach((fig: any, figureIndex: number) => {
        let reasons: string[] = [];
        try {
          reasons = reviewOne(fig, uprightPage(fig?.box?.page));
        } catch (err) {
          // 살피다 생긴 문제로 시험지 만들기가 멈추지 않게 (그 그림은 그대로 둔다)
          reasons = [];
          void err;
        }
        // 같은 문제로 이미 다시 읽었는데 그대로면 또 권하지 않는다 (원본 그림 자체가 그렇게 생긴 경우. 또 읽어도 같은 답이 나온다)
        if (reasons.length && !fig.render_error && fig.reread?.hint && fig.reread.hint === reasons.join(" / ")) reasons = [];
        if (reasons.length) {
          const name = it.label ? String(it.label).trim() : `${it.no}번`;
          suspects.push({ section, index, figureIndex, name: figureIndex ? `${name} (그림 ${figureIndex + 1})` : name, reasons });
        }
      });
    });
  });
  return suspects;
}

/** 그림 하나 살피기 (고칠 수 있으면 고치고, 남은 문제를 돌려준다) */
function reviewOne(fig: any, upright: boolean): string[] {
  const reasons: string[] = [];
  if (fig.render_error && fig.box) reasons.push(`그림을 그리지 못했습니다: ${String(fig.render_error).slice(0, 80)}`);
  if (fig.commands && typeof fig.commands === "object") {
    const check = checkFigureSpec(fig.commands);
    if (!check.spec) {
      // AI 의 마지막 답이 검사를 통과하지 못한 그림 (그리지 못하거나 일부만 그려진다)
      if (fig.box && !fig.render_error) reasons.push("그림 명령에 고칠 곳이 남아 그리지 못했을 수 있습니다");
      return reasons;
    }
    const anchors: Anchor[] = Array.isArray(fig.anchors) ? fig.anchors.filter((a: any) => a && Array.isArray(a.px) && a.px.length === 2) : [];
    // 원본과 다른 방향(옆으로 눕거나 거꾸로)으로 그린 그림은 먼저 원본 방향으로 돌린다 (2026-11-02 숭의중: 누운 스캔을 읽어 누운 채로 그림)
    const up = upright && anchors.length ? uprightFigure(check.spec, anchors) : undefined;
    if (up) {
      fig.commands = up.spec;
      fig.auto_fixes = [...(Array.isArray(fig.auto_fixes) ? fig.auto_fixes : []), up.change];
      delete fig.png;
      delete fig.png_size;
    }
    const fixed = repairDegrees(up ? up.spec : check.spec, anchors);
    if (fixed) {
      fig.commands = fixed.spec;
      fig.auto_fixes = [...(Array.isArray(fig.auto_fixes) ? fig.auto_fixes : []), ...fixed.changes];
      // 예전 PNG 는 쓰지 않는다 (고친 명령으로 다시 그린다)
      delete fig.png;
      delete fig.png_size;
    }
    const shape = anchors.length ? shapeDeviation(fig.commands, anchors) : undefined;
    for (const m of withShape(degreeMismatches(fig.commands), shape)) if (worthReporting(m, fig.notes, shape)) reasons.push(degreeMismatchNote(m));
    if (shape && shape.worst > SHAPE_DEVIATION_LIMIT && (upright || Math.abs(shape.rotation) <= 45)) reasons.push(shapeDeviationNote(shape));
    if (fig.box) reasons.push(...overlappingLabels(fig.commands));
  } else if (!fig.render_error && !fig.graphic && fig.asset_kind !== "photo" && fig.placeholder_note !== "사진 자리" && fig.box) {
    reasons.push("그림을 읽지 못해 빈 자리로 두었습니다");
  }
  return reasons;
}

/** 다시 읽은 결과가 쓸 만한지: 그릴 수 있는 명령(검사 통과)이나 자료 그리기 명령이 있어야 한다 */
export function usableReading(result: FigureResult, kind: string): boolean {
  const r = result.reading;
  if (result.error || !r) return false;
  if (r.errors.length) return false;
  return kind !== "diagram" ? !!r.graphic && r.graphic.kind !== "photo" : !!r.commands?.elements?.length;
}

/** 지난 읽기의 '그림' 확인할 곳 문장인지 (문항 전체의 알림 '그림이 5개 있어 …' 같은 것은 아니다) */
const FIGURE_NOTE = /^(그림:|그림을 읽지 못해|그림을 다시 읽지 못해|그림 명령에 고칠 곳|자료를 다시 그리지|각 표시에 맞게)/;

/**
 * 그림 하나를 다시 읽은 결과로 바꾼다 (보관함·결과 화면의 '그림 다시 읽기'). 쓸 만한 결과일 때만 부른다 (usableReading).
 * 그 그림의 지난 명령·표시·확인할 곳은 지운다 (그림마다 남긴 unsure_notes 가 있으면 그것만, 없으면 그림이 하나뿐인 문항의 그림 문장만).
 * 그림 크기(width_mm·size_mm)와 원본 자리(box)는 그대로 둔다. 다시 읽은 횟수와 그때 알린 문제는 reread 에 남긴다 (같은 문제로 또 권하지 않게).
 */
export function replaceFigureReading(item: any, figureIndex: number, result: FigureResult, hint = ""): void {
  const figs = itemFigures(item);
  const fig: any = figs[figureIndex];
  if (!fig) return;
  const old = new Set<string>(Array.isArray(fig.unsure_notes) ? fig.unsure_notes : []);
  const keep = (u: unknown) => typeof u === "string" && (old.size ? !old.has(u) : figs.length > 1 || !FIGURE_NOTE.test(u));
  const unsure: string[] = (Array.isArray(item.unsure) ? item.unsure : []).filter(keep);
  const count = Number(fig.reread?.count ?? 0) + 1;
  for (const key of ["commands", "graphic", "anchors", "notes", "check_warnings", "auto_fixes", "png", "png_size", "render_error", "render_warnings", "placeholder_note", "unsure_notes"]) delete fig[key];
  const notes = figureNotes(fig, result, fig.asset_kind && fig.asset_kind !== "diagram" ? fig.asset_kind : "diagram");
  unsure.push(...notes);
  if (notes.length) fig.unsure_notes = notes;
  fig.reread = { count, hint };
  if (unsure.length) item.unsure = unsure;
  else delete item.unsure;
}

/** 왼쪽 단의 문항이 원본에서 오른쪽 단까지 이어지는지 (문항 영역이 쪽 가운데를 넉넉히 넘음) */
function spansIntoNextColumn(item: any, printArea: Region): boolean {
  const s = item?.source;
  if (!s || !(printArea.w > 0)) return false;
  const mid = printArea.x + printArea.w / 2;
  return s.x < mid && s.x + s.w > mid + printArea.w * 0.08;
}

/** 원본 사진 1픽셀이 양식에서 몇 mm 인지: 인쇄된 영역의 가로를 양식의 본문 가로에 맞춘다 */
function mmPerOriginalPx(reading: PageReading, meta: PageMeta, layout: Layout): number {
  const w = reading.print_area.w / meta.scale;
  if (w > meta.original.width * 0.3) return layout.textWidthMm / w;
  return layout.textWidthMm / meta.original.width;
}

function makeFigure(
  region: FigureRegion,
  result: FigureResult | undefined,
  meta: PageMeta,
  mmPerPx: number,
  layout: Layout,
  itemUnsure: string[],
): any {
  const box = toOriginal(region, meta.scale);
  const fig: any = { box: { page: meta.page, ...box }, place: region.place, align: "CENTER" };
  if (region.kind !== "diagram") fig.asset_kind = region.kind;
  if (SKIP_KINDS.has(region.kind)) {
    // 사진은 옮길 방법이 없다 (원본을 잘라 붙이지 않는다): 크기만큼 빈 자리
    fig.placeholder_note = "사진 자리";
    itemUnsure.push("사진은 옮기지 않고 자리만 비워 두었습니다");
  }

  // 그림이 실제로 차지하는 크기 (그림 읽기에서 받은 사각형이 있으면 그것, 없으면 쪽 읽기의 사각형)
  let content = box;
  const r = result?.reading;
  if (result && r?.contentBox) {
    const c = r.contentBox;
    content = { x: result.crop.x + c.x / result.scale, y: result.crop.y + c.y / result.scale, w: c.w / result.scale, h: c.h / result.scale };
  }
  const maxW = layout.columnWidthMm * (region.place === "right" ? layout.rightMaxRatio : 0.95);
  const width = Math.max(12, Math.min(maxW, content.w * mmPerPx));
  fig.width_mm = round1(width);
  fig.size_mm = [round1(width), round1((content.h / content.w) * width)];

  if (result?.error) {
    fig.placeholder_note = "그림 자리";
  }
  const notes = result ? figureNotes(fig, result, region.kind) : [];
  if (!result && !SKIP_KINDS.has(region.kind)) {
    fig.placeholder_note = "그림 자리";
    notes.push("그림 읽기 결과가 없어 자리를 비워 두었습니다");
  }
  for (const n of notes) itemUnsure.push(n);
  if (notes.length) fig.unsure_notes = notes;
  return fig;
}

/** 그림 읽기 결과를 그림에 넣고, 그 그림의 확인할 곳 문장들을 돌려준다 (만들 때와 다시 읽을 때 같이 쓴다) */
function figureNotes(fig: any, result: FigureResult, kind: string): string[] {
  const notes: string[] = [];
  const r = result.reading;
  const tag = (u: string) => (u.startsWith("그림") ? u : `그림: ${u}`);
  if (result.error || !r) {
    notes.push(`그림을 읽지 못해 자리만 비워 두었습니다: ${result.error ?? "결과 없음"}`);
    return notes;
  }
  if (kind !== "diagram") {
    // 표·지도·통계 그래프·삽화: 그리기 명령(graphic)으로 다시 그린다. 검사를 통과하지 못했으면 빈 자리
    if (r.graphic) fig.graphic = r.graphic;
    else {
      fig.placeholder_note = "그림 자리";
      notes.push(`자료를 다시 그리지 못해 자리만 비워 두었습니다: ${r.errors.slice(0, 3).join(" / ")}`);
    }
    for (const u of r.unsure) notes.push(tag(u));
    if (r.notes) fig.notes = r.notes;
    return notes;
  }
  if (r.commands) fig.commands = r.commands;
  else {
    fig.commands = r.rawCommands;
    fig.placeholder_note = "그림 자리";
    notes.push(`그림 명령에 고칠 곳이 남아 있습니다: ${r.errors.slice(0, 3).join(" / ")}`);
  }
  // 겹쳐 보기 기준점: 원본 사진 픽셀로
  fig.anchors = r.anchors.map((a) => ({
    at: a.at,
    px: [Math.round(result.crop.x + a.px[0] / result.scale), Math.round(result.crop.y + a.px[1] / result.scale)],
  }));
  for (const u of r.unsure) notes.push(tag(u));
  if (r.notes) fig.notes = r.notes;
  if (r.warnings.length) fig.check_warnings = r.warnings;
  if (r.fixes?.length) fig.auto_fixes = r.fixes;
  return notes;
}

// 상자 안 한 항목의 첫머리: (가) ㄱ. ① ㉠ ※ - • (1) 1. 같은 것
const LINE_HEAD = /^\s*(?:\(\s*[가-하]\s*\)|[가-하]\.|[ㄱ-ㅎ]\s*\.|[①-⑳]|[㉠-㉭]|※|[-•·▶◦○]|\(\s*\d+\s*\)|\d+\s*[.)])/;
// 이어지는 줄이 조사로 시작하면 앞 줄 끝 낱말에 붙여 쓴다 ("선분 BC" + "의 중점이다")
const LINE_PARTICLE = /^\s*(?:을|를|의|이|가|은|는|와|과|에|에서|로|으로|도|만|까지|부터|이다|이고|이며|이면|일|인)(?=[\s,.)?!]|$)/;

/**
 * GPT 판은 상자 글을 인쇄된 줄마다 따로 읽었다. 그대로 두면 한글 파일에서 줄마다 문단이 되어
 * "선분 BC / 의 중점이다", "56일 / 때" 처럼 낱말 중간에서 끊긴다 → 항목 첫머리((가) ㄱ. ① …)로 시작하지 않고,
 * 앞 줄이 문장 끝(. ? ! :)으로 끝나지 않은 줄은 앞 줄에 이어 붙인다. 조사로 시작하면 띄우지 않는다.
 */
export function joinPrintedLines(lines: any[][]): any[][] {
  const text = (pieces: any[]) => (pieces ?? []).map((p: any) => (typeof p?.t === "string" ? p.t : typeof p?.m === "string" ? "x" : "")).join("");
  const out: any[][] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const own = text(line);
    if (prev && !LINE_HEAD.test(own) && !/[.?!:]\s*$/.test(text(prev))) {
      const glue = LINE_PARTICLE.test(own) ? [] : [{ t: " " }];
      const head = line.map((p: any, k: number) => (k === 0 && typeof p?.t === "string" ? { ...p, t: p.t.replace(/^\s+/, "") } : p));
      const tail = prev.map((p: any, k: number) => (k === prev.length - 1 && typeof p?.t === "string" ? { ...p, t: p.t.replace(/\s+$/, "") } : p));
      out[out.length - 1] = [...tail, ...glue, ...head];
    } else out.push(line);
  }
  return out;
}

/**
 * GPT 판(2026-11-01, 원본 배치 따라 하기)으로 만든 읽기 결과를 지금 모양으로 바꾼다 (보관함에서 "다시 만들기" 할 때).
 * - 원본 배치 정보(layout_mode, layout_blocks, 쪽 장식·선)와 원본 조각(original_png 등)을 뺀다
 * - 그림 크기를 원본 종이 크기 대신, 인쇄된 영역을 양식의 본문 가로에 맞춘 비율로 다시 정한다 (assembleExam 과 같게)
 * 이미 지금 모양이면 그대로 돌려준다.
 */
export function normalizeLegacyExam(exam: any, layout: Layout = layoutFor(exam?.paper)): any {
  if (!exam || exam.layout_mode !== "source") return exam;
  const copy = JSON.parse(JSON.stringify(exam));
  delete copy.layout_mode;
  const pages = new Map<number, any>();
  for (const p of Array.isArray(copy.source_pages) ? copy.source_pages : []) pages.set(p.page, p);
  const mmPerPx = (page: number): number | undefined => {
    const p = pages.get(page);
    const w = p?.print_area?.w;
    if (!(w > 0) || !(p?.width > 0)) return undefined;
    return w > p.width * 0.3 ? layout.textWidthMm / w : layout.textWidthMm / p.width;
  };
  const plain = (pieces: any[]) => (pieces ?? []).map((p: any) => (typeof p?.t === "string" ? p.t : typeof p?.m === "string" ? p.m : "")).join("").replace(/\s+/g, "");
  for (const s of copy.sections ?? []) {
    for (const it of s.items ?? []) {
      // GPT 판 지시문 때문에 조건 상자·<보기> 가 layout_blocks 에만 들어간 문항이 있다 → 문제 글에 없으면 상자로 살린다
      const stemText = plain(it.stem);
      // 선택지 배치: GPT 판이 적어 둔 선택지 자리(layout_blocks 의 choice)로 원본처럼 한 줄·여러 줄을 알아낸다
      const spots = (Array.isArray(it.layout_blocks) ? it.layout_blocks : []).filter((b: any) => b?.role === "choice" && b.box);
      if (!it.choice_layout && Array.isArray(it.choices) && it.choices.length >= 2 && spots.length === it.choices.length) {
        const ys: number[] = spots.map((b: any) => Number(b.box.y)).sort((a: number, b: number) => a - b);
        const rows = ys.reduce((n: number, y: number, k: number) => (k && y - ys[k - 1] > 20 ? n + 1 : n), 1);
        if (rows === 1) it.choice_layout = "row";
        else if (rows < spots.length) it.choice_layout = "grid";
      }
      for (const b of Array.isArray(it.layout_blocks) ? it.layout_blocks : []) {
        if (b?.role !== "box" || !Array.isArray(b.lines) || !b.lines.length) continue;
        const lines = joinPrintedLines(b.lines.filter((line: any) => Array.isArray(line) && plain(line)));
        const head = plain(lines[0] ?? []).slice(0, 12);
        if (!head || stemText.includes(head)) continue;
        if (/보기/.test(String(b.title ?? ""))) {
          if (!it.bogi?.length) it.bogi = lines;
        } else if (!it.cond_box) it.cond_box = lines;
      }
      delete it.layout_blocks;
      for (const fig of [it.figure, ...(Array.isArray(it.extra_figures) ? it.extra_figures : [])]) {
        if (!fig) continue;
        for (const key of ["source_png", "source_png_size", "original_png", "original_size", "render_mode", "photo_adjustment", "png", "png_size", "render_error", "render_warnings"]) delete fig[key];
        const scale = fig.box ? mmPerPx(fig.box.page) : undefined;
        if (scale && fig.box.w > 0 && fig.box.h > 0) {
          const maxW = layout.columnWidthMm * (fig.place === "right" ? layout.rightMaxRatio : 0.95);
          const width = Math.max(12, Math.min(maxW, fig.box.w * scale));
          fig.width_mm = round1(width);
          fig.size_mm = [round1(width), round1((fig.box.h / fig.box.w) * width)];
        }
        // 다시 그릴 명령이 없는 그림(사진, 원본으로 두었던 자료)은 빈 자리
        if (!fig.commands && !fig.graphic) fig.placeholder_note ??= fig.asset_kind === "photo" ? "사진 자리" : "그림 자리";
      }
    }
  }
  // 원본에서 두 단에 걸친 문항 다음의 단 나눔은 지운다 (그 문항이 오른쪽 단에 이어지므로 다음 문항은 단 맨 위가 아니다)
  const ordered: any[] = (copy.sections ?? []).flatMap((s: any) => (s.items ?? []).map((it: any) => ({ it, section: s })));
  ordered.forEach(({ it, section }: any, k: number) => {
    const before = ordered[k - 1]?.it;
    const area = pages.get(it?.source?.page)?.print_area;
    if (area && spansIntoNextColumn(it, area)) it.split_ok = true;
    if (!before || !area || before.source?.page !== it.source?.page || !spansIntoNextColumn(before, area)) return;
    if (it.break_before === "column") delete it.break_before;
    if (section.items[0] === it && section.break_before === "column") delete section.break_before;
  });
  // GPT 판이 쪽마다 읽은 안내 상자(둘째 쪽부터, 예: "서술형 문항 풀이할 때 유의사항")를 살린다:
  // 그 쪽에서 새 부분(서술형 등)이 시작하면 그 첫 문항 앞에, 아니면 그 쪽 마지막 문항 뒤에
  for (const p of pages.values()) {
    if (!(p.page > 1) || !Array.isArray(p.boxes) || !p.boxes.length) continue;
    const onPage = ordered.filter(({ it }: any) => it?.source?.page === p.page);
    if (!onPage.length) continue;
    const startOfSection = onPage.find(({ it, section }: any) => section.items[0] === it && section.title);
    for (const b of p.boxes) {
      if (!b || !Array.isArray(b.lines) || !b.lines.length) continue;
      const box = { kind: b.kind || "notice", lines: b.lines.map((l: any) => (l && typeof l === "object" && "text" in l ? (l.center ? { text: l.text, align: "CENTER" } : l.text) : l)) };
      if (startOfSection) (startOfSection.it.boxes_before ??= []).push(box);
      else (onPage[onPage.length - 1].it.boxes_after ??= []).push(box);
    }
  }
  // GPT 판이 쪽마다 따로 읽은 안내 글(저작권 안내 등) 가운데 둘째 쪽부터의 것은 그 쪽 마지막 문항 뒤 상자로 살린다
  for (const p of pages.values()) {
    if (!(p.page > 1)) continue;
    for (const b of Array.isArray(p.text_blocks) ? p.text_blocks : []) {
      if (b?.artifact_kind !== "notice" || !Array.isArray(b.lines)) continue;
      const lines = b.lines.map((line: any) => (Array.isArray(line) ? line.map((x: any) => (typeof x?.t === "string" ? x.t : typeof x?.m === "string" ? x.m : "")).join("") : "")).filter((t: string) => t.trim());
      if (!lines.length) continue;
      const items = (copy.sections ?? []).flatMap((s: any) => s.items ?? []).filter((it: any) => it?.source?.page === p.page);
      const last = items[items.length - 1];
      // 줄바꿈으로 끊긴 글은 이어 붙인다 (한국어 낱말 중간에서 끊긴 줄은 띄어 쓰지 않는다)
      if (last) (last.boxes_after ??= []).push({ kind: "notice", lines: [lines.reduce((a: string, t: string) => a + (/[가-힣]$/.test(a) && /^[가-힣]/.test(t) ? "" : " ") + t.trim(), "").trim()] });
    }
  }
  copy.source_pages = [...pages.values()].map((p) => ({ page: p.page, width: p.width, height: p.height }));
  return tidyExam(copy);
}
