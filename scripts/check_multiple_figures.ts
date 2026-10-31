// 한 문항의 여러 그림을 한글 출력 단계까지 빠짐없이 전달한다. 실제 AI 호출 없음.
import assert from "node:assert/strict";
import { assembleExam, figureKey } from "@/lib/ai/assemble";
import { PageReadingS } from "@/lib/ai/page-schema";
import { attachFigurePngs } from "@/lib/figure/render-exam";

const reading = PageReadingS.parse({
  header: { present: false, title: "", target_label: "", target: "", date: "" }, boxes: [],
  footer: { present: false, right_top: "", right_bottom: "", notice: "" },
  print_area: { x: 0, y: 0, w: 1000, h: 1400 }, page_end_note: "", unsure: [], page_artifacts: [],
  sections: [{ title: "", items: [{
    no: 14, no_text: "14.", points: 4, column: 1,
    stem: [{ kind: "t", text: "다음 중 나머지와 합동이 아닌 것은?" }],
    bogi: [], choices: [[], [], [], [], []],
    figures: Array.from({length: 5}, (_, i) => ({ x: 40 + (i % 2) * 180, y: 200 + Math.floor(i / 2) * 150, w: 100, h: 100, place: "below", kind: "diagram" })),
    source: { x: 20, y: 100, w: 470, h: 600 }, unsure: [], layout_blocks: [],
  }] }],
});
const results = new Map<string, any>();
for (let i = 0; i < 5; i++) results.set(figureKey(1, 0, 0, i), {
  crop: { x: 0, y: 0, w: 100, h: 100 }, scale: 1,
  reading: { commands: { elements: [{ id: "figure-" + i }] }, anchors: [], unsure: [], notes: "", errors: [], warnings: [], attempts: 1 },
});
const exam = assembleExam([{ meta: { page: 1, original: { width: 1000, height: 1400 }, scale: 1 }, reading }], results);
const item = exam.sections[0].items[0];
assert.equal(item.extra_figures.length, 4);
assert.deepEqual([item.figure, ...item.extra_figures].map((f: any) => f.commands.elements[0].id), ["figure-0","figure-1","figure-2","figure-3","figure-4"]);
const attached = attachFigurePngs(exam, Array.from({length:5}, (_, figureIndex) => ({
  section: 0, index: 0, figureIndex, no: 14, png: "PNG-" + figureIndex, size: [100, 100] as [number, number]
})));
assert.deepEqual([attached.sections[0].items[0].figure, ...attached.sections[0].items[0].extra_figures].map((f: any) => f.png), ["PNG-0","PNG-1","PNG-2","PNG-3","PNG-4"]);
assert.equal(item.figure.png, undefined); // 저장한 읽기 결과를 변형하지 않는다.
console.log("한 문항의 그림 5개가 읽기 결과와 출력 데이터에 모두 보존됨");
