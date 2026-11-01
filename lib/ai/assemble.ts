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

/** 다시 그릴 수 없는 사진 (AI 에게 보내지 않고 한글 파일에는 빈 자리로 둔다. 원본을 잘라 붙이지 않는다) */
export const SKIP_KINDS = new Set(["photo"]);

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
        if (!SKIP_KINDS.has(region.kind) && region.w > 2 && region.h > 2) jobs.push({ key: figureKey(page, s, i, f), region, item });
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
  const examBox = (b: PageReading["boxes"][number]) => ({
    kind: b.kind,
    lines: b.lines.map((l) => (l.center ? { text: l.text, align: "CENTER" } : l.text)),
  });
  // 안내 상자: 첫 문항보다 앞(머리 아래)에 있는 것은 exam.boxes, 쪽 중간·끝의 상자는 그 다음 문항 앞(boxes_before)이나
  // 그 쪽 마지막 문항 뒤(boxes_after)에 둔다 (예전 읽기 결과처럼 before 가 없으면 첫 상자 쪽의 것만 머리 아래로)
  let topBoxesTaken = false;

  for (const { meta, reading } of pages) {
    const mmPerPx = mmPerOriginalPx(reading, meta, layout);
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

        // 그림이 여럿이면 모두 넣는다 (첫 그림은 figure, 나머지는 extra_figures. 선택지가 모두 그림이면 한글 파일에서 ①~⑤ 를 붙여 나란히 둔다)
        const all = it.figures
          .map((f, idx) => ({ f, idx }))
          .filter(({ f }) => f.w > 2 && f.h > 2)
          .map(({ f, idx }) => makeFigure(f, figures.get(figureKey(meta.page, s, i, idx)), meta, mmPerPx, layout, itemUnsure));
        if (all.length) item.figure = all[0];
        if (all.length > 1) item.extra_figures = all.slice(1);
        item.choices = it.choices.map(toExamPieces);
        // 선택지 배치(한 줄에 나란히 등)는 원본대로. 한 줄에 하나씩(column)이 기본이라 적지 않는다
        if (item.choices.length && (it.choice_layout === "row" || it.choice_layout === "grid")) item.choice_layout = it.choice_layout;
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
  // 쪽 끝 안내는 마지막 쪽 것만 (한글 파일에서는 쪽 나눔이 원본과 다를 수 있어 문서 끝에 하나만 둔다)
  const note = pages[pages.length - 1]?.reading.page_end_note;
  if (note) exam.page_end_note = note;
  exam.source_pages = pages.map(({ meta }) => ({ page: meta.page, width: meta.original.width, height: meta.original.height }));
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
    itemUnsure.push(`그림을 읽지 못해 자리만 비워 두었습니다: ${result.error}`);
  }
  if (result && r && region.kind !== "diagram") {
    // 표·지도·통계 그래프·삽화: 그리기 명령(graphic)으로 다시 그린다. 검사를 통과하지 못했으면 빈 자리
    if (r.graphic) fig.graphic = r.graphic;
    else {
      fig.placeholder_note = "그림 자리";
      itemUnsure.push(`자료를 다시 그리지 못해 자리만 비워 두었습니다: ${r.errors.slice(0, 3).join(" / ")}`);
    }
    for (const u of r.unsure) itemUnsure.push(`그림: ${u}`);
    if (r.notes) fig.notes = r.notes;
  } else if (result && r) {
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

/**
 * GPT 판(2026-11-01, 원본 배치 따라 하기)으로 만든 읽기 결과를 지금 모양으로 바꾼다 (보관함에서 "다시 만들기" 할 때).
 * - 원본 배치 정보(layout_mode, layout_blocks, 쪽 장식·선)와 원본 조각(original_png 등)을 뺀다
 * - 그림 크기를 원본 종이 크기 대신, 인쇄된 영역을 양식의 본문 가로에 맞춘 비율로 다시 정한다 (assembleExam 과 같게)
 * 이미 지금 모양이면 그대로 돌려준다.
 */
export function normalizeLegacyExam(exam: any, layout: Layout = SCHOOL_A_LAYOUT): any {
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
        const lines = b.lines.filter((line: any) => Array.isArray(line) && plain(line));
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
