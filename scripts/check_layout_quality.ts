// AI 응답 대신 원본 위치 메타데이터를 넣어 페이지·조건·선택지 좌표와 글자 충돌 회피를 검사한다.
import assert from "node:assert/strict";
import { assembleExam } from "@/lib/ai/assemble";
import { PageReadingS } from "@/lib/ai/page-schema";
import { arrangeLabels, strokeHits, rectOverlap } from "@/lib/figure/label-layout";

const reading = PageReadingS.parse({
  header: { present: false, title: "", target_label: "", target: "", date: "" }, boxes: [],
  footer: { present: false, right_top: "", right_bottom: "", notice: "" },
  print_area: { x: 20, y: 20, w: 960, h: 1380 }, page_end_note: "", unsure: [],
  sections: [{ title: "", items: [{ no: 3, no_text: "3.", points: 5, column: 1,
    stem: [{ kind: "t", text: "조건을 만족하는 것은?" }], bogi: [], choices: [], figures: [],
    source: { x: 30, y: 100, w: 450, h: 500 }, unsure: [],
    layout_blocks: [{ role: "box", region: { x: 40, y: 220, w: 420, h: 130 }, title: "조건", choice_no: 0,
      lines: [[{ kind: "m", text: "AB=AC" }]] }],
  }] }], page_artifacts: [],
});
const exam = assembleExam([{ meta: { page: 1, original: { width: 2000, height: 2834 }, scale: .5, paperMm: { width: 257, height: 364 } }, reading }], new Map());
assert.equal(exam.layout_mode, "source");
assert.deepEqual(exam.source_pages[0].paper_mm, [257, 364]);
assert.deepEqual(exam.sections[0].items[0].layout_blocks[0].box, { x: 80, y: 440, w: 840, h: 260 });
assert.equal(exam.sections[0].items[0].layout_blocks[0].title, "조건");
const region = { x: 100, y: 400, w: 120, h: 80, place: "below", kind: "diagram" } as const;
reading.sections[0].items[0].figures.push(region);
const withFigure = assembleExam([{ meta: { page: 1, original: { width: 2000, height: 2834 }, scale: .5, paperMm: { width: 257, height: 364 } }, reading }],
  new Map([["1-0-0-0", { crop: region, scale: 1, reading: { commands: { elements: [] }, anchors: [], errors: [], warnings: [], unsure: [], notes: "" } } as any]]));
const sourceFigure = withFigure.sections[0].items[0].figure;
assert.deepEqual(sourceFigure.box, { page: 1, x: 200, y: 800, w: 240, h: 160 });
assert.equal(sourceFigure.layout_box, undefined);
assert.equal(sourceFigure.width_mm, 30.8);
const strokes = [{ a: { x: -10, y: 0 }, b: { x: 10, y: 0 } }];
const placed = arrangeLabels([{ x: 0, y: 0, w: .8, h: 1, direction: { x: 0, y: 1 }, strictDirection: true }, { x: .2, y: 0, w: .8, h: 1 }], strokes);
assert.equal(placed.remaining, 0);
assert.equal(placed.shifts[0].x, 0); // 각도 글자는 이등분선 위에서만 이동
assert.ok(placed.shifts[0].y > 0);
assert.ok(placed.placed.every(p => !strokeHits(p, strokes[0])));
assert.ok(!rectOverlap(placed.placed[0], placed.placed[1]));
console.log("원본 용지·좌표·조건 상자 및 그림 글자 충돌 회피 검사 통과");
