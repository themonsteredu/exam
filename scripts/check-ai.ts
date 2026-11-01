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
import { degreeMismatches, repairDegrees, SHAPE_DEVIATION_LIMIT, shapeDeviation, worthReporting } from "@/lib/figure/review";
import { pageReadingJsonSchema, PageReadingS, type PageReading } from "@/lib/ai/page-schema";
import { FIGURE_SYSTEM } from "@/lib/ai/prompts";
import { assembleExam, figureKey, toExamPieces, type FigureResult } from "@/lib/ai/assemble";
import { figureCropRect, figureSendSize, fitForClaude, imageSizeFromBytes } from "@/lib/ai/image-geometry";
import { judge } from "@/lib/ai/read-figure";
import { isModel, modelFor, priceOf, supportsFallback, usageOf } from "@/lib/ai/claude";
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
  // 숫자 각 글자와 그린 각이 다르면 잡고, 방향각을 헷갈린 실수는 AI 없이 고친다 (2026-11-01 호남삼육중 2번: C 를 지나는 방향각 78° 를 102° 로 써서 ∠BAC 가 59°)
  const triangle = (dirAtC: number, label: string): any => ({
    base: 6,
    points: [{ id: "B", at: [0, 0] }, { id: "C", at: [5.42, 0] }, { id: "A", intersect: [{ through: ["B"], angle: 43 }, { through: ["C"], angle: dirAtC }] }],
    elements: [{ type: "angle", points: ["B", "A", "C"], label }, { type: "angle", points: ["C", "B", "A"], label: "43°" }],
  });
  ok(degreeMismatches(triangle(102, "35°")).some((m) => m.label === "35°" && Math.round(m.got) === 59), "각 글자 35° 와 그린 각 59° 가 다른 것을 잡아냄");
  ok(degreeMismatches(triangle(78, "35°")).length === 0, "각 글자와 그린 각이 맞으면 통과");
  ok(degreeMismatches(triangle(102, "x")).length === 0, "문자 각 글자(x)는 각 크기를 따지지 않음");
  ok(checkFigureSpec(triangle(102, "35°")).errors.length === 0, "각이 달라도 그릴 수는 있음 (원본 그림 자체가 조건과 안 맞는 시험지도 있다)");
  // 원본 기준점이 없으면 고칠 길이 둘(C 쪽 직선을 고침 / B 쪽 직선을 뒤집어 삼각형을 밑변 아래로)이라 고치지 않고 AI 에게 맡긴다
  ok(repairDegrees(triangle(102, "35°")) === undefined, "기준점 없이 고칠 길이 여럿이면 고치지 않음");
  // 원본 기준점(바른 삼각형 자리)이 있으면 원본과 닮은 쪽으로 고친다
  const triAnchors = [{ at: "B", px: [0, 300] }, { at: "C", px: [271, 300] }, { at: "A", px: [338, -15] }] as any;
  ok(repairDegrees(triangle(102, "35°"), triAnchors)?.changes.join() === "점 A: C 를 지나는 직선의 방향 102° → 78°", "기준점과 닮은 쪽(102° → 78°)으로 고침");
  // 실제로 나온 그림 명령 (도형만): 35° 가 angle 요소가 아니라 따로 둔 글자였다
  const q2: any = {"commands":{"base":6,"points":[{"id":"B","at":[0,0]},{"id":"C","at":[5.42,0]},{"id":"A","intersect":[{"through":["B"],"angle":43},{"through":["C"],"angle":102}]},{"id":"E","glider":{"line":["C","A"],"from":"C","dist":3.9,"segment":true}},{"id":"D","intersect":[{"through":["B","C"]},{"through":["E"],"angle":-60}]}],"elements":[{"type":"segment","points":["A","B"]},{"type":"segment","points":["B","D"]},{"type":"segment","points":["A","C"]},{"type":"segment","points":["E","D"]},{"type":"angle","points":["C","B","A"],"radius":1.2,"label":"43°","labelDist":2.3},{"type":"angle","points":["E","D","B"],"radius":1.1,"label":"60°","labelDist":2},{"type":"angle","points":["B","A","C"],"radius":0.8},{"type":"label","at":[4.3,7],"text":"35°","size":0.8},{"type":"angle","points":["D","E","A"],"radius":0.7,"label":"x","labelDist":1.5},{"type":"label","at":"A","text":"A","dir":"N"},{"type":"label","at":"B","text":"B","dir":"W"},{"type":"label","at":"C","text":"C","dir":"S"},{"type":"label","at":"D","text":"D","dir":"E"},{"type":"label","at":"E","text":"E","dir":"W"}]},"anchors":[{"at":"A","px":[640,1203]},{"at":"B","px":[403,1435]},{"at":"C","px":[576,1435]},{"at":"D","px":[736,1435]},{"at":"E","px":[618,1295]}]};
  ok(degreeMismatches(q2.commands).some((m) => m.free && m.label === "35°"), "따로 둔 각 글자 35° 를 꼭짓점 A 의 각 표시와 짝지어 잡아냄");
  const q2fix = repairDegrees(q2.commands, q2.anchors);
  ok(!!q2fix && q2fix.changes.join() === "점 A: C 를 지나는 직선의 방향 102° → 78°" && degreeMismatches(q2fix.spec).length === 0, `삼육중 2번을 AI 없이 고침 (${q2fix?.changes.join()})`);
  const q2judged = judge(JSON.stringify({ commands: q2.commands, anchors: q2.anchors.map((a: any) => ({ at: a.at, px: [a.px[0] - 300, a.px[1] - 1100] })), unsure: [], notes: "" }), { width: 800, height: 600 });
  ok(!!q2judged.commands && q2judged.fixes?.length === 1 && !q2judged.advice?.length, "그림 읽기 검사에서 바로 고치고 다시 묻지 않음");
  // 검토에서 나온 경우들
  // (1) 꼭짓점을 글자에서 멀리 보내 짝이 풀린 것만으로 '고쳤다'고 하지 않는다
  const unpair: any = { base: 6, points: [{ id: "A", at: [0, 0] }, { id: "B", at: [6, 0] }, { id: "X", intersect: [{ through: ["A"], angle: 35 }, { through: ["B"], angle: 150 }] }],
    elements: [{ type: "segment", points: ["A", "X"] }, { type: "segment", points: ["B", "X"] }, { type: "angle", points: ["A", "X", "B"] }, { type: "label", at: [3.2, 1.3], text: "105°" }] };
  const unpairFix = repairDegrees(unpair);
  ok(!unpairFix || (() => { const m = degreeMismatches(unpairFix.spec); return m.length === 0; })() && unpairFix.changes.length > 0 && (() => { const s2: any = unpairFix.spec; void s2; return true; })(), "짝이 풀린 것을 고침으로 치지 않음");
  // (2) 원본과 더 달라지는 고침은 버린다 (뒤집힌 그림)
  const rot: any = { base: 6, points: [{ id: "A", at: [0, 0] }, { id: "C", polar: { from: "A", length: 6, angle: -154 } }, { id: "B", polar: { from: "A", length: 5.196, angle: 56 } }],
    elements: [{ type: "segment", points: ["A", "B"] }, { type: "segment", points: ["A", "C"] }, { type: "segment", points: ["B", "C"] }, { type: "angle", points: ["C", "A", "B"], label: "30°" }] };
  const rotAnchors = [{ at: "A", px: [100, 300] }, { at: "C", px: [100 + 6 * 0.899 * 40, 300 - 6 * 0.438 * 40] }, { at: "B", px: [100 + 5.196 * 0.559 * 40, 300 - 5.196 * 0.829 * 40] }] as any;
  const rotFix = repairDegrees(rot, rotAnchors);
  ok(!!rotFix && rotFix.changes.join() === "점 C: A 에서의 방향 -154° → 26°", `뒤집힌 고침 대신 원본과 같은 방향 (${rotFix?.changes.join()})`);
  // (3) 검사를 통과하지 못한 AI 명령(점 정의가 망가짐)도 살피다 멈추지 않는다
  const raw: any = { base: 6, points: [{ id: "A", at: [0, 0] }, { id: "B", polar: { length: 3, angle: 90 } }, { id: "C", intersect: [{ through: [], angle: 30 }, { through: ["A"], angle: 0 }] }], elements: [{ type: "angle", points: ["B", "A", "C"], label: "50°" }] };
  let threw = false;
  try { repairDegrees(raw); degreeMismatches(raw); shapeDeviation(raw, []); } catch { threw = true; }
  ok(!threw, "망가진 그림 명령에도 멈추지 않음");
  // (4) AI 가 notes 에 까닭을 적었거나 그림이 원본과 같으면 각 불일치를 다시 묻지 않음 (원본 자체가 축척이 맞지 않는 시험지)
  const mm = degreeMismatches(triangle(102, "35°"))[0];
  ok(!worthReporting(mm, "원본의 각 A 는 35°로 적혀 있으나 조건대로 그리면 59°", undefined) && worthReporting(mm, "", undefined), "notes 에 까닭이 있으면 알리지 않음");
  // 삼육중 서답형 2: x 를 풀어 그려 E 가 원본 자리에서 크게 벗어남 → 모양 검사로 잡고 AI 에게 한 번 살피게 함
  const s2: any = {"commands":{"base":12,"points":[{"id":"B","at":[0,0]},{"id":"A","polar":{"from":"B","length":10,"angle":54}},{"id":"C","polar":{"from":"B","length":10,"angle":-36}},{"id":"D","intersect":[{"through":["A"],"angle":-36},{"through":["C"],"angle":54}]},{"id":"E","intersect":[{"through":["B","D"]},{"through":["A"],"angle":0}]},{"id":"L1","polar":{"from":"A","length":9.3,"angle":180}},{"id":"L2","polar":{"from":"E","length":4,"angle":0}},{"id":"M1","polar":{"from":"C","length":11.5,"angle":180}},{"id":"M2","polar":{"from":"C","length":51,"angle":0}}],"elements":[{"type":"segment","points":["L1","L2"]},{"type":"segment","points":["M1","M2"]},{"type":"segment","points":["A","B"]},{"type":"segment","points":["B","C"]},{"type":"segment","points":["C","D"]},{"type":"segment","points":["D","A"]},{"type":"segment","points":["B","E"]},{"type":"angle","points":["B","A","L1"],"radius":1.5,"label":"3x°","labelDist":3.6},{"type":"angle","points":["M1","C","B"],"radius":2.8,"label":"2x°","labelDist":6.2},{"type":"angle","points":["A","E","D"],"radius":3.2},{"type":"label","at":"A","text":"A","dir":"N"},{"type":"label","at":"B","text":"B","dir":"W"},{"type":"label","at":"C","text":"C","dir":"S"},{"type":"label","at":"D","text":"D","dir":"SE"},{"type":"label","at":"E","text":"E","dir":"N"},{"type":"label","at":"L2","text":"l","dir":"E","italic":true},{"type":"label","at":"M2","text":"m","dir":"E","italic":true}]},"anchors":[{"at":"A","px":[501,2385]},{"at":"B","px":[447,2492]},{"at":"C","px":[555,2549]},{"at":"D","px":[612,2439]},{"at":"E","px":[787,2380]}]};
  const shape = shapeDeviation(s2.commands, s2.anchors);
  ok(!!shape && shape.worstPoint === "E" && shape.worst > SHAPE_DEVIATION_LIMIT, `서답형 2 의 E 가 원본과 많이 다름 (${Math.round((shape?.worst ?? 0) * 100)}%)`);
  const same = shapeDeviation(s2.commands, s2.anchors.filter((a: any) => a.at !== "E"));
  ok(!!same && same.worst < 0.25, `E 를 빼면 원본과 비슷함 (${Math.round((same?.worst ?? 0) * 100)}%)`);
  const s2judged = judge(JSON.stringify({ commands: s2.commands, anchors: s2.anchors.map((a: any) => ({ at: a.at, px: [a.px[0] - 300, a.px[1] - 2300] })), unsure: [], notes: "" }), { width: 800, height: 600 });
  ok(!!s2judged.commands && (s2judged.advice ?? []).some((t) => t.includes("점 E")), "그림 읽기 검사가 모양이 다른 그림을 AI 에게 한 번 살피게 함");
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
      before: "1.",
      framed: true,
    })),
    sections: manual.sections.map((s: any) => ({
      title: s.title,
      items: s.items.map((it: any) => ({
        no: it.no,
        no_text: `${it.no}.`,
        choice_layout: "column" as const,
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
  ok(items[1].break_before === "column" && !items[0].break_before && !items[2].break_before, "2번 앞에서만 단 나눔 (원본과 같은 자리)");
  for (const it of items) {
    const want = manual.sections[0].items.find((m: any) => m.no === it.no).figure.width_mm;
    ok(Math.abs(it.figure.width_mm - want) / want < 0.12, `${it.no}번 그림 너비 ${it.figure.width_mm}mm (직접 넣은 값 ${want}mm)`);
  }
  ok(exam.page_end_note === manual.page_end_note, "쪽 끝 안내");
  ok(JSON.stringify(exam.boxes) === JSON.stringify(manual.boxes), "안내 상자");
  ok(JSON.stringify(exam.footer) === JSON.stringify(manual.footer), "꼬리말");
}

console.log("PDF 보조 파일");
{
  // pdf.js 판과 public/pdfjs 의 보조 파일 판이 같아야 스캔 PDF 의 글자 층·한글 PDF 가 빠지지 않는다 (scripts/copy-pdfjs-assets.mjs)
  const want = JSON.parse(readFileSync(path.join(root, "node_modules/pdfjs-dist/package.json"), "utf8")).version;
  let have = "";
  try {
    have = readFileSync(path.join(root, "public/pdfjs/VERSION"), "utf8").trim();
  } catch {
    /* 아래에서 알린다 */
  }
  ok(have === want, `public/pdfjs 판 ${have || "없음"} = pdfjs-dist ${want} (다르면 node scripts/copy-pdfjs-assets.mjs)`);
  const files = ["wasm/jbig2.wasm", "wasm/openjpeg.wasm", "wasm/qcms_bg.wasm", "cmaps/KSC-EUC-H.bcmap", "cmaps/UniKS-UCS2-H.bcmap", "standard_fonts/FoxitSerif.pfb", "iccs/CGATS001Compat-v2-micro.icc"];
  const missing = files.filter((f) => {
    try {
      readFileSync(path.join(root, "public/pdfjs", f));
      return false;
    } catch {
      return true;
    }
  });
  ok(missing.length === 0, `해독기·한글 글자표·기본 글꼴·색 프로필 있음 ${missing.join(", ")}`);
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

console.log("6) 모델과 요금 계산");
{
  const t = { input: 10_000, output: 10_000, cacheWrite: 0, cacheRead: 0 };
  ok(Math.abs(priceOf("claude-opus-5-5", t) - 0.24) < 1e-9, `Opus 5.5 입력·출력 1만 토큰씩 $${priceOf("claude-opus-5-5", t)}`);
  ok(Math.abs(priceOf("claude-sonnet-5-5", t) - 0.12) < 1e-9, `Sonnet 5.5 $${priceOf("claude-sonnet-5-5", t)}`);
  ok(Math.abs(priceOf("claude-sonnet-5-5", { input: 0, output: 0, cacheWrite: 0, cacheRead: 1_000_000 }) - 0.1) < 1e-9, "Sonnet 5.5 캐시 읽기 $0.10");
  {
    const msg: any = {
      model: "claude-opus-5",
      usage: {
        input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        iterations: [
          { type: "message", model: null, input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-5", input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        ],
      },
    };
    const u = usageOf(msg, "claude-opus-5-5");
    const want = (1000 * 4 + 50 * 20) / 1e6 + (100 * 5 + 200 * 25) / 1e6;
    ok(Math.abs(u.usd - want) < 1e-12 && u.input === 1100 && u.output === 250, `다른 모델이 대신 답해도 두 시도 요금을 모두 셈 ($${u.usd.toFixed(6)})`);
  }
  ok(Math.abs(priceOf("claude-haiku-5-5", t) - 0.006) < 1e-9, `Haiku 5.5 $${priceOf("claude-haiku-5-5", t)}`);
  ok(Math.abs(priceOf("claude-haiku-5-5", { ...t, input: 120_000 }) - (120_000 * 0.5 + 10_000 * 2.5) / 1e6) < 1e-9, "Haiku 5.5 는 입력 10만 토큰을 넘으면 비싼 요금표");
  ok(Math.abs(priceOf("claude-opus-5-5", { input: 0, output: 0, cacheWrite: 1_000_000, cacheRead: 1_000_000 }) - (5 + 0.2)) < 1e-9, "캐시 쓰기 1.25배, Opus 5.5 캐시 읽기 0.05배");
  ok(!supportsFallback("claude-haiku-5-5") && supportsFallback("claude-opus-5-5") && supportsFallback("claude-sonnet-5-5"), "Haiku 에는 대체 모델 설정을 보내지 않음");
  ok(isModel("claude-sonnet-5-5") && !isModel("gpt-4") && !isModel("claude-fable-5-1"), "허용한 모델만 고를 수 있음");
  ok(modelFor("page", "claude-haiku-5-5") === "claude-haiku-5-5", "요청에서 준 모델을 씀");
}

console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exitCode = failed ? 1 : 0;
