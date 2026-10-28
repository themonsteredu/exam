// AI 읽기 부품 점검 (AI 를 부르지 않는다. 요금 없음).
//   node scripts/check-ai.mjs
// 1) 쪽 읽기 답 모양이 구조화 출력 제한(선택 항목 24, anyOf 16, 지원하지 않는 키워드)을 지키는지
// 2) 그림 명령 검사기가 지금까지 만든 그림(예시 A~F, 시험지 데이터)을 모두 통과시키는지
// 3) 그림 읽기 지시문 속 예시가 모두 검사를 통과하는지
// 4) 직접 넣은 시험지 데이터를 "AI 가 완벽히 읽은 답"처럼 바꿔 합치면 원래 데이터로 돌아오는지
// 5) AI 답 읽기(JSON 꺼내기, 기준점 정리)와 사진 크기 계산

import { readFileSync } from "node:fs";
import path from "node:path";
import { EXAMPLES } from "@/lib/figure/examples";
import { checkFigureSpec } from "@/lib/figure/validate";
import { pageReadingJsonSchema, PageReadingS, type PageReading } from "@/lib/ai/page-schema";
import { FIGURE_SYSTEM } from "@/lib/ai/prompts";
import { assembleExam, figureKey, toExamPieces, type FigureResult } from "@/lib/ai/assemble";
import { figureCropRect, figureSendSize, fitForClaude, imageSizeFromBytes } from "@/lib/ai/image-geometry";
import { judge } from "@/lib/ai/read-figure";
import { compareExams } from "@/lib/ai/compare";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = process.env.EXAM_ROOT || process.cwd();
let failed = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) console.log(`  통과  ${what}`);
  else {
    failed++;
    console.log(`  실패  ${what}`);
  }
};

console.log("1) 쪽 읽기 답 모양");
{
  const schema = pageReadingJsonSchema();
  let optional = 0;
  let unions = 0;
  const bad: string[] = [];
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "allOf", "$ref", "$defs", "description", "title", "minItems", "format", "default"]);
  const walk = (n: any, p: string) => {
    if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (!n || typeof n !== "object") return;
    if (!p.endsWith(".properties") && !p.endsWith(".$defs")) for (const k of Object.keys(n)) if (!allowed.has(k)) bad.push(`${k} @${p}`);
    if (n.type === "object") {
      if (n.additionalProperties !== false) bad.push(`additionalProperties @${p}`);
      const req = new Set(n.required ?? []);
      for (const k of Object.keys(n.properties ?? {})) if (!req.has(k)) optional++;
    }
    if (n.anyOf || Array.isArray(n.type)) unions++;
    for (const [k, v] of Object.entries(n)) walk(v, `${p}.${k}`);
  };
  walk(schema, "$");
  ok(optional <= 24, `선택 항목 ${optional}개 (24개까지)`);
  ok(unions <= 16, `둘 중 하나 모양 ${unions}개 (16개까지)`);
  ok(bad.length === 0, `지원하지 않는 키워드 없음 ${bad.join(", ")}`);
}

console.log("2) 그림 명령 검사기 - 지금까지 만든 그림");
{
  for (const ex of EXAMPLES) {
    const r = checkFigureSpec(ex.spec);
    ok(r.errors.length === 0, `예시 ${ex.key} ${r.errors.join(" / ")}`);
  }
  for (const name of ["exam_p1_manual.json", "figure_right_demo.json"]) {
    const exam = JSON.parse(readFileSync(path.join(root, "data", name), "utf8"));
    for (const s of exam.sections) for (const it of s.items) {
      if (!it.figure) continue;
      const r = checkFigureSpec(it.figure.commands);
      ok(r.errors.length === 0, `${name} ${it.no}번 ${r.errors.join(" / ")}`);
    }
  }
  const broken = [
    { base: 10, elements: [{ type: "segment", points: ["A", "B"] }] },
    { base: 10, points: [{ id: "A", midpoint: ["B", "B"] }, { id: "B", midpoint: ["A", "A"] }], elements: [] },
    { base: 10, points: [{ id: "A", at: [0, 0] }, { id: "B", at: [1, 0] }, { id: "C", intersect: [{ through: ["A", "B"] }, { through: ["A"], angle: 180 }] }], elements: [] },
    { base: 10, elements: [{ type: "function", expr: "y=Math.sin(x)", domain: [0, 1] }] },
    { base: 10, elements: [{ type: "arc2" }] },
  ];
  broken.forEach((b, i) => ok(checkFigureSpec(b).errors.length > 0, `틀린 그림 명령 ${i + 1} 을 잡아냄`));
}

console.log("3) 그림 읽기 지시문 속 예시");
{
  const examples = FIGURE_SYSTEM.slice(FIGURE_SYSTEM.indexOf("# 예시"));
  const lines = examples.split("\n").filter((l) => l.startsWith('{"'));
  ok(lines.length >= 5, `예시 ${lines.length}개`);
  lines.forEach((l, i) => {
    const j = JSON.parse(l);
    const r = checkFigureSpec(j.commands ?? j);
    ok(r.errors.length === 0, `예시 ${i + 1} ${r.errors.join(" / ")}`);
  });
}

console.log("4) 합치기 - 직접 넣은 데이터로 되돌아오는지");
{
  const manual = JSON.parse(readFileSync(path.join(root, "data", "exam_p1_manual.json"), "utf8"));
  const toPieces = (ps: any[]) => ps.map((p) => ("m" in p ? { kind: "m" as const, text: p.m } : { kind: "t" as const, text: p.t }));
  const columns: Record<number, number> = { 1: 1, 2: 2, 3: 2 };
  const reading: PageReading = {
    header: { present: true, title: manual.header.title, target_label: manual.header.target_label, target: manual.header.target, date: manual.header.date },
    boxes: manual.boxes.map((b: any) => ({
      kind: b.kind,
      lines: b.lines.map((l: any) => (typeof l === "string" ? { text: l, center: false } : { text: l.text, center: l.align === "CENTER" })),
    })),
    sections: manual.sections.map((s: any) => ({
      title: s.title,
      items: s.items.map((it: any) => ({
        no: it.no,
        no_text: `${it.no}.`,
        points: it.points,
        column: columns[it.no],
        // AI 는 앞뒤에 빈칸을 붙이거나 줄바꿈 조각을 섞어 줄 수 있다
        stem: [{ kind: "t", text: " " }, ...toPieces(it.stem)],
        bogi: [],
        choices: it.choices.map(toPieces),
        figures: it.figure ? [{ x: it.figure.box.x, y: it.figure.box.y, w: it.figure.box.w, h: it.figure.box.h, place: it.figure.place, kind: "diagram" }] : [],
        source: { x: it.source.x, y: it.source.y, w: it.source.w, h: it.source.h },
        unsure: [],
      })),
    })),
    footer: { present: true, ...manual.footer },
    page_end_note: manual.page_end_note,
    print_area: { x: 40, y: 75, w: 1045, h: 1560 },
    unsure: [],
  };
  const fake = PageReadingS.safeParse(reading);
  ok(fake.success, `가짜 쪽 읽기 답이 답 모양에 맞음 ${fake.success ? "" : fake.error.message.slice(0, 300)}`);
  const original = { width: 1126, height: 2000 };
  const figures = new Map<string, FigureResult>();
  manual.sections.forEach((s: any, si: number) =>
    s.items.forEach((it: any, ii: number) => {
      if (!it.figure) return;
      const crop = figureCropRect(it.figure.box, 1, original);
      const { scale } = figureSendSize(crop.w, crop.h);
      const b = it.figure.box;
      figures.set(figureKey(1, si, ii, 0), {
        crop,
        scale,
        reading: {
          commands: it.figure.commands,
          anchors: [],
          contentBox: { x: (b.x - crop.x) * scale, y: (b.y - crop.y) * scale, w: b.w * scale, h: b.h * scale },
          unsure: [],
          notes: "",
          errors: [],
          warnings: [],
          attempts: 1,
        },
      });
    }),
  );
  const exam = assembleExam([{ meta: { page: 1, original, scale: 1 }, reading }], figures);
  const cmp = compareExams(manual, exam);
  ok(cmp.summary.textScore === 1, `글·수식·선택지 모두 같음 (${(cmp.summary.textScore * 100).toFixed(1)}%)`);
  for (const d of cmp.items.filter((x) => x.textScore < 1)) console.log("     다름:", d.no, JSON.stringify(d.diffs).slice(0, 300));
  const items = exam.sections[0].items;
  ok(items[1].break_before === "column" && !items[0].break_before && !items[2].break_before, "2번 앞에서만 단 나눔");
  for (const it of items) {
    const want = manual.sections[0].items.find((m: any) => m.no === it.no).figure.width_mm;
    ok(Math.abs(it.figure.width_mm - want) / want < 0.12, `${it.no}번 그림 너비 ${it.figure.width_mm}mm (직접 넣은 값 ${want}mm)`);
  }
  ok(exam.page_end_note === manual.page_end_note, "쪽 끝 안내");
  ok(JSON.stringify(exam.boxes) === JSON.stringify(manual.boxes), "안내 상자");
  ok(JSON.stringify(exam.footer) === JSON.stringify(manual.footer), "꼬리말");
}

console.log("5) 조각 정리, AI 답 읽기, 사진 크기");
{
  const pieces = toExamPieces([
    { kind: "t", text: "  그림과 같이 " },
    { kind: "m", text: " x " },
    { kind: "t", text: "의 값은?\n\n" },
    { kind: "t", text: "\n(단, x>0)  " },
  ]);
  ok(JSON.stringify(pieces) === JSON.stringify([{ t: "그림과 같이 " }, { m: "x" }, { t: "의 값은?" }, { t: "\n" }, { t: "(단, x>0)" }]), `조각 정리 ${JSON.stringify(pieces)}`);
  const answer = judge(
    'AI 설명\n```json\n{"commands":{"base":10,"points":[{"id":"A","at":[0,0]},{"id":"B","at":[10,0]}],"elements":[{"type":"segment","points":["A","B"]},],},"anchors":[{"at":"A","px":[10,20]},{"at":"Z","px":[1,1]},{"at":"B","px":[9999,1]}],"content_box":{"x":-5,"y":0,"w":50,"h":40},"unsure":["x"]}\n```',
    { width: 400, height: 300 },
  );
  ok(answer.commands && answer.errors.length === 0, "코드 블록·끝 쉼표가 있어도 읽음");
  ok(answer.anchors.length === 1 && answer.anchors[0].at === "A", "없는 점과 사진 밖 기준점은 뺌");
  ok(answer.contentBox?.x === 0 && answer.contentBox?.w === 45, "그림 사각형을 사진 안으로 줄임");
  ok(judge("죄송합니다", { width: 1, height: 1 }).errors.length === 1, "JSON 이 없으면 고칠 곳으로 알림");

  const big = fitForClaude(3024, 4032);
  ok(big.width * big.height <= 3_700_000 && Math.max(big.width, big.height) <= 2576, `휴대폰 사진 줄이기 ${big.width}×${big.height}`);
  ok(fitForClaude(1126, 2000).scale === 1, "작은 사진은 그대로");
  const send = figureSendSize(240, 300);
  ok(send.scale === 4, `작은 그림은 4배까지 키움 (${send.width}×${send.height})`);
  const png = readFileSync(path.join(root, "samples", "cubes_problem4.png"));
  const jpg = readFileSync(path.join(root, "samples", "exam_p1.jpg"));
  const ps = imageSizeFromBytes(png);
  const js = imageSizeFromBytes(jpg);
  ok(ps?.width === 651 && ps?.height === 564 && ps.type === "image/png", `PNG 크기 읽기 ${JSON.stringify(ps)}`);
  ok(js?.width === 1126 && js?.height === 2000 && js.type === "image/jpeg", `JPEG 크기 읽기 ${JSON.stringify(js)}`);
}

console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exitCode = failed ? 1 : 0;
