// 쪽 읽기(1차)와 그림 읽기(2차) 결과를 합쳐 시험지 JSON 을 만든다.
// 시험지 JSON 은 data/exam_p1_manual.json 과 같은 모양이고, 한글 파일 만드는 쪽(py/exam_hwpx)이 그대로 받는다.
// 사진 속 위치(box, source, anchors)는 모두 원본 사진의 픽셀로 바꿔 둔다 (확인 화면에서 원본과 비교할 때 쓴다).

import type { FigureRegion, ItemReading, PageReading, Piece, Region } from "./page-schema";
import type { FigureReading } from "./read-figure";

/** 시험지 JSON 의 글 조각: 글 {t} 또는 수식 {m}. {t: "\n"} 은 문단 나눔 */
export type ExamPiece = { t: string } | { m: string };

export type PageMeta = {
  /** 1부터 */
  page: number;
  /** 원본 사진 크기 */
  original: { width: number; height: number };
  /** AI 에게 보낸 사진 픽셀 = 원본 픽셀 × scale */
  scale: number;
};

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

/** 양식에서 그림 크기를 정하는 데 쓰는 값 (py/exam_hwpx/template.py 와 같게) */
export type Layout = { textWidthMm: number; columnWidthMm: number; rightMaxRatio: number };

export const SCHOOL_A_LAYOUT: Layout = { textWidthMm: 210 - 12 - 12, columnWidthMm: (210 - 12 - 12 - 8) / 2, rightMaxRatio: 0.5 };

export function figureKey(page: number, section: number, item: number, figure: number): string {
  return `${page}-${section}-${item}-${figure}`;
}

/** 쪽마다 읽을 그림 목록 (그림 읽기에 넘길 것) */
export function figureJobs(page: number, reading: PageReading) {
  const jobs: { key: string; region: FigureRegion; item: ItemReading }[] = [];
  reading.sections.forEach((section, s) =>
    section.items.forEach((item, i) =>
      item.figures.forEach((region, f) => {
        if (region.kind === "diagram" && region.w > 2 && region.h > 2) jobs.push({ key: figureKey(page, s, i, f), region, item });
      }),
    ),
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
  const layout = o.layout ?? SCHOOL_A_LAYOUT;
  const exam: any = { template: o.template ?? "school-A-2026", header: {}, footer: {}, boxes: [], sections: [] };
  const unsure: string[] = [];
  let prev: { page: number; column: number } | undefined;

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
  const boxes = first((r) => (r.boxes.length ? r.boxes : undefined)) ?? [];
  exam.boxes = boxes.map((b) => ({
    kind: b.kind,
    lines: b.lines.map((l) => (l.center ? { text: l.text, align: "CENTER" } : l.text)),
  }));

  for (const { meta, reading } of pages) {
    const mmPerPx = mmPerOriginalPx(reading, meta, layout);
    for (const u of reading.unsure) unsure.push(`${meta.page}쪽: ${u}`);
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

        const diagrams = it.figures.map((f, idx) => ({ f, idx })).filter(({ f }) => f.w > 2 && f.h > 2);
        if (diagrams.length) {
          const { f, idx } = diagrams.find(({ f }) => f.kind === "diagram") ?? diagrams[0];
          if (diagrams.length > 1) itemUnsure.push(`그림이 ${diagrams.length}개 있어 첫 그림만 넣었습니다`);
          item.figure = makeFigure(f, figures.get(figureKey(meta.page, s, i, idx)), meta, mmPerPx, layout, itemUnsure);
        }
        item.choices = it.choices.map(toExamPieces);
        item.source = { page: meta.page, ...toOriginal(it.source, meta.scale) };
        if (itemUnsure.length) item.unsure = itemUnsure;

        // 원본에서 단이나 쪽이 바뀐 곳은 그대로 나눈다. 부분 제목 상자 바로 앞이면 제목 상자에서 나눈다
        const column = it.column === 2 ? 2 : 1;
        if (prev) {
          const brk = meta.page !== prev.page ? "page" : column !== prev.column ? "column" : undefined;
          if (brk) {
            if (i === 0 && target.items.length === 0 && target.title) target.break_before = brk;
            else item.break_before = brk;
          }
        }
        prev = { page: meta.page, column };
        target.items.push(item);
      });
    });
  }
  // 쪽 끝 안내는 마지막 쪽 것만 (한글 파일에서는 쪽 나눔이 원본과 다를 수 있어 문서 끝에 하나만 둔다)
  const note = pages[pages.length - 1]?.reading.page_end_note;
  if (note) exam.page_end_note = note;
  exam.source_pages = pages.map(({ meta }) => ({ page: meta.page, width: meta.original.width, height: meta.original.height }));
  if (unsure.length) exam.unsure = unsure;
  return exam;
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
  if (region.kind !== "diagram") itemUnsure.push(region.kind === "table" ? "표는 아직 옮기지 못해 자리만 비워 두었습니다" : "그림 모양을 알 수 없어 자리만 비워 두었습니다");

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

  if (result?.error) itemUnsure.push(`그림을 읽지 못했습니다: ${result.error}`);
  if (result && r) {
    if (r.commands) fig.commands = r.commands;
    else {
      fig.commands = r.rawCommands;
      itemUnsure.push(`그림 명령에 고칠 곳이 남아 있습니다: ${r.errors.slice(0, 3).join(" / ")}`);
    }
    // 겹쳐 보기 기준점: 원본 사진 픽셀로
    fig.anchors = r.anchors.map((a) => ({
      at: a.at,
      px: [Math.round(result.crop.x + a.px[0] / result.scale), Math.round(result.crop.y + a.px[1] / result.scale)],
    }));
    for (const u of r.unsure) itemUnsure.push(`그림: ${u}`);
    if (r.notes) fig.notes = r.notes;
    if (r.warnings.length) fig.check_warnings = r.warnings;
  }
  return fig;
}
