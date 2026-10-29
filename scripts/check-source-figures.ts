// 지도·표의 영역이 문항 데이터에 보존되는지 점검한다. AI 호출 없음.
// node scripts/run-ts.mjs scripts/check-source-figures.ts
import assert from "node:assert/strict";
import { assembleExam, figureJobs, figureKey } from "@/lib/ai/assemble";
import type { PageReading } from "@/lib/ai/page-schema";

const reading: PageReading = {
  header: { present: false, title: "", target_label: "", target: "", date: "" },
  boxes: [], footer: { present: false, right_top: "", right_bottom: "", notice: "" },
  page_end_note: "", print_area: { x: 0, y: 0, w: 1000, h: 1500 }, unsure: [],
  sections: [{ title: "", items: [{
    no: 10, no_text: "10.", points: 4, column: 1,
    stem: [{ kind: "t", text: "지도 위에서 위치를 찾으시오." }], choices: [], bogi: [],
    figures: [{ x: 50, y: 100, w: 350, h: 200, place: "below", kind: "other" }],
    source: { x: 10, y: 20, w: 450, h: 450 }, unsure: [],
  }] }],
};
const jobs = figureJobs(1, reading);
assert.equal(jobs.length, 1);
assert.equal(jobs[0].region.kind, "other");
const figures = new Map([[figureKey(1, 0, 0, 0), {
  crop: { x: 50, y: 100, w: 350, h: 200 }, scale: 1,
  sourcePng: "cG5n", sourcePngSize: [350, 200] as [number, number],
}]]);
const exam = assembleExam([{ meta: { page: 1, original: { width: 1000, height: 1500 }, scale: 1 }, reading }], figures);
const item = exam.sections[0].items[0];
assert.equal(item.figure.source_png, "cG5n");
assert.deepEqual(item.figure.source_png_size, [350, 200]);
assert.ok(item.unsure.some((s: string) => s.includes("필기 표시")));
const missing = assembleExam([{ meta: { page: 1, original: { width: 1000, height: 1500 }, scale: 1 }, reading }], new Map());
assert.ok(missing.sections[0].items[0].unsure.some((s: string) => s.includes("가져오지 못했습니다")));
console.log("지도 등 원본 그림 보존·누락 경고 검사 통과");
