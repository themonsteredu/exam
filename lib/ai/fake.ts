// 화면 시험용 가짜 AI (AI 를 부르지 않고 직접 넣은 데이터 data/exam_p1_manual.json 을 돌려준다).
// EXAM_STORE=local 이고 EXAM_FAKE_AI=1 일 때만 쓴다. 배포에서는 쓰이지 않는다.
// samples/exam_p1.jpg 를 올렸을 때 좌표가 맞는다.

import manual from "@/data/exam_p1_manual.json";
import type { PageReading } from "./page-schema";
import type { FigureReading } from "./read-figure";
import type { Usage } from "./claude";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function fakeAiEnabled(): boolean {
  return process.env.EXAM_STORE === "local" && process.env.EXAM_FAKE_AI === "1";
}

const zero: Usage = { model: "fake", input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 };

const toPieces = (ps: any[]) => ps.map((p) => ("m" in p ? { kind: "m" as const, text: p.m } : { kind: "t" as const, text: p.t }));

export function fakePage(): { reading: PageReading; usage: Usage } {
  const m: any = manual;
  const columns: Record<number, number> = { 1: 1, 2: 2, 3: 2 };
  const reading: PageReading = {
    header: { present: true, title: m.header.title, target_label: m.header.target_label, target: m.header.target, date: m.header.date },
    boxes: m.boxes.map((b: any) => ({
      kind: b.kind,
      lines: b.lines.map((l: any) => (typeof l === "string" ? { text: l, center: false } : { text: l.text, center: l.align === "CENTER" })),
    })),
    sections: m.sections.map((s: any) => ({
      title: s.title,
      items: s.items.map((it: any) => ({
        no: it.no,
        no_text: `${it.no}.`,
        points: it.points ?? 0,
        column: columns[it.no] ?? 1,
        stem: toPieces(it.stem),
        bogi: [],
        choices: it.choices.map(toPieces),
        figures: it.figure ? [{ x: it.figure.box.x, y: it.figure.box.y, w: it.figure.box.w, h: it.figure.box.h, place: it.figure.place, kind: "diagram" }] : [],
        source: { x: it.source.x, y: it.source.y, w: it.source.w, h: it.source.h },
        unsure: it.no === 3 ? ["가짜 AI: 확인 표시가 화면에 어떻게 보이는지 보려고 넣은 것"] : [],
      })),
    })),
    footer: { present: true, ...m.footer },
    page_end_note: m.page_end_note ?? "",
    print_area: { x: 40, y: 75, w: 1045, h: 1560 },
    unsure: [],
  };
  return { reading, usage: zero };
}

export function fakeFigure(no: unknown): { figure: FigureReading; usage: Usage } {
  const it = (manual as any).sections.flatMap((s: any) => s.items).find((x: any) => x.no === Number(no));
  return {
    figure: {
      commands: it?.figure?.commands,
      anchors: [],
      unsure: [],
      notes: "",
      errors: it?.figure ? [] : ["가짜 AI: 이 번호의 그림이 없습니다"],
      warnings: [],
      attempts: 1,
    },
    usage: zero,
  };
}
