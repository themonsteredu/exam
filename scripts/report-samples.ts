// AI 읽기 결과 비교 보고서 (AI 를 부르지 않는다. 요금 없음).
//   node scripts/report-samples.mjs [--dir=output/ai] [--fonts=<부분 글꼴 폴더>]
// scripts/read-samples.mjs 가 저장한 결과를 직접 넣은 데이터(data/exam_p1_manual.json)와 검증용 예시 A~F 에 견준다.
// 결과: <dir>/report.html (글은 나란히, 그림은 원본 · AI · 직접 만든 것 세 장을 나란히)
// --fonts: subset-fonts.py 가 만든 에스코어드림 woff2 폴더. 주면 글꼴을 파일 안에 넣는다 (따로 여는 점검 페이지로 올릴 때)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { EXAMPLES } from "@/lib/figure/examples";
import type { FigureSpec } from "@/lib/figure/types";
import { compareExams, type FieldDiff } from "@/lib/ai/compare";
import { compareCubes, comparePoints } from "@/lib/ai/figure-compare";
import { piecesToHtml } from "@/lib/ai/latex-view";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = process.env.EXAM_ROOT || process.cwd();
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const dir = path.resolve(root, flag("dir") ?? "output/ai");
const fontsDir = flag("fonts");

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const load = async (file: string) => (existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined);
const example = (key: string) => EXAMPLES.find((e) => e.key === key)!;

type Box = { x: number; y: number; w: number; h: number };
type FigCase = {
  title: string;
  photo?: { file: string; box: Box };
  ai?: any;
  aiError?: string;
  ref: FigureSpec;
  refNote: string;
  kind: "points" | "cubes";
  widthMm: number;
  unsure?: string[];
  notes?: string;
};

const cases: FigCase[] = [];
const blocks: string[] = [];
const summary: string[] = [];
let usd = 0;

/** 원본 사진 조각 (보고서에서 견주어 보는 데만 쓴다) */
async function photoCrop(file: string, box: Box, maxW = 460): Promise<string> {
  const img = sharp(path.join(root, "samples", file)).rotate();
  const meta = await img.metadata();
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(meta.width! - x, Math.round(box.w));
  const h = Math.min(meta.height! - y, Math.round(box.h));
  let pipe = sharp(await img.toBuffer()).extract({ left: x, top: y, width: Math.max(1, w), height: Math.max(1, h) });
  if (w > maxW) pipe = pipe.resize(maxW);
  return `data:image/png;base64,${(await pipe.png().toBuffer()).toString("base64")}`;
}

function sumUsage(obj: any) {
  if (!obj || typeof obj !== "object") return;
  if (obj.usage?.usd) usd += obj.usage.usd;
  for (const v of Object.values(obj)) if (v && typeof v === "object" && (v as any).usage?.usd) usd += (v as any).usage.usd;
}

function diffRows(diffs: FieldDiff[]): string {
  return diffs
    .map(
      (d) => `<tr><td>${esc(d.field)}</td><td>${esc(d.expected)}</td><td>${esc(d.got)}</td>
        <td class="${d.score === 1 ? "same" : "diff"}">${d.score === 1 ? "띄어쓰기만 다름" : `내용 ${pct(d.score)} 같음`}</td></tr>`,
    )
    .join("");
}

// ---------------------------------------------------------------- exam_p1: 글과 수식
const examP1 = await load(path.join(dir, "exam_p1.exam.json"));
if (examP1) {
  sumUsage(await load(path.join(dir, "exam_p1.page.json")));
  sumUsage(await load(path.join(dir, "exam_p1.figures.json")));
  const manual = JSON.parse(await readFile(path.join(root, "data", "exam_p1_manual.json"), "utf8"));
  const cmp = compareExams(manual, examP1);
  const s = cmp.summary;
  summary.push(
    `<li><b>exam_p1.jpg</b> (시험지 1쪽): 문항 ${s.found}/${s.items}개 찾음, 문제 글·수식·선택지 내용 ${pct(s.textScore)} 같음, 배점 ${s.pointsSame}/${s.items}, 그림 자리 ${s.figureSame}/${s.items}, 머리 표 ${pct(s.headerScore)}, 안내 상자 ${pct(s.boxesScore)}, 꼬리말 ${pct(s.footerScore)}${cmp.extraItems.length ? `, 더 찾은 문항 ${cmp.extraItems.join(", ")}` : ""}</li>`,
  );
  const items: string[] = [];
  const aiItems = (examP1.sections ?? []).flatMap((sec: any) => sec.items ?? []);
  for (const m of manual.sections.flatMap((sec: any) => sec.items)) {
    const a = aiItems.find((x: any) => x.no === m.no);
    const c = cmp.items.find((x) => x.no === m.no)!;
    const src = a?.source ?? m.source;
    const photo = await photoCrop("exam_p1.jpg", src, 520);
    const marks = "①②③④⑤⑥⑦⑧";
    const choiceList = (chs: any[] | undefined) =>
      (chs ?? []).map((ch: any, i: number) => `<span class="choice">${marks[i] ?? i + 1} ${piecesToHtml(ch)}</span>`).join("");
    const choiceRows = m.choices?.length || a?.choices?.length ? `<tr><td>선택지</td><td>${choiceList(m.choices)}</td><td>${choiceList(a?.choices)}</td></tr>` : "";
    items.push(`
      <div class="item">
        <h3>${m.no}번 <span class="score ${c.textScore === 1 ? "same" : "diff"}">내용 ${pct(c.textScore)} 같음${c.diffs.some((d) => d.score === 1) ? " · 띄어쓰기 다른 곳 있음" : ""}</span></h3>
        <div class="row">
          <img class="photo" src="${photo}" alt="원본 ${m.no}번">
          <table class="cmp">
            <tr><th></th><th>직접 넣은 것</th><th>AI 가 읽은 것</th></tr>
            <tr><td>문제 글</td><td>${piecesToHtml(m.stem)}</td><td>${piecesToHtml(a?.stem)}</td></tr>
            ${choiceRows}
            <tr><td>배점</td><td>${esc(m.points)}</td><td>${esc(a?.points ?? "없음")}</td></tr>
            <tr><td>그림</td><td>${m.figure ? `${m.figure.place === "right" ? "글 오른쪽" : "글 아래"}, 너비 ${m.figure.width_mm}mm` : "없음"}</td>
                <td>${a?.figure ? `${a.figure.place === "right" ? "글 오른쪽" : "글 아래"}, 너비 ${a.figure.width_mm}mm` : "없음"}</td></tr>
          </table>
        </div>
        ${c.diffs.length ? `<details><summary>다른 곳 ${c.diffs.length}군데 (원래 글자로 보기)</summary><table class="diffs"><tr><th>칸</th><th>직접 넣은 것</th><th>AI</th><th></th></tr>${diffRows(c.diffs)}</table></details>` : ""}
        ${a?.unsure?.length ? `<p class="unsure">AI 가 확신이 낮다고 표시한 곳: ${a.unsure.map(esc).join(" / ")}</p>` : ""}
      </div>`);
    if (m.figure) {
      cases.push({
        title: `exam_p1 ${m.no}번 그림`,
        photo: { file: "exam_p1.jpg", box: a?.figure?.box ?? m.figure.box },
        ai: a?.figure?.commands,
        aiError: a?.figure ? undefined : "AI 가 이 문항의 그림을 찾지 못했습니다",
        ref: m.figure.commands,
        refNote: `2단계에서 확인한 예시 ${"ABC"[m.no - 1] ?? ""}`,
        kind: "points",
        widthMm: m.figure.width_mm,
        unsure: a?.unsure?.filter((u: string) => u.startsWith("그림")),
        notes: a?.figure?.notes,
      });
    }
  }
  blocks.push(`
    <section>
      <h2>exam_p1.jpg - 글과 수식</h2>
      ${cmp.header.length ? `<details open><summary>머리 표 · 안내 상자 · 꼬리말에서 다른 곳 ${cmp.header.length}군데</summary><table class="diffs"><tr><th>칸</th><th>직접 넣은 것</th><th>AI</th><th></th></tr>${diffRows(cmp.header)}</table></details>` : "<p>머리 표, 안내 상자, 꼬리말은 직접 넣은 것과 같습니다.</p>"}
      ${examP1.unsure?.length ? `<p class="unsure">AI 가 확신이 낮다고 표시한 곳: ${examP1.unsure.map(esc).join(" / ")}</p>` : ""}
      ${items.join("")}
    </section>`);
}

// ---------------------------------------------------------------- cubes_problem4: 쪽 읽기 + 그림
const cubes4 = await load(path.join(dir, "cubes_problem4.exam.json"));
if (cubes4) {
  sumUsage(await load(path.join(dir, "cubes_problem4.page.json")));
  sumUsage(await load(path.join(dir, "cubes_problem4.figures.json")));
  const it = (cubes4.sections ?? []).flatMap((sec: any) => sec.items ?? []).find((x: any) => x.figure);
  cases.push({
    title: "cubes_problem4 쌓기나무 11개",
    photo: it?.figure ? { file: "cubes_problem4.png", box: it.figure.box } : undefined,
    ai: it?.figure?.commands,
    aiError: it ? undefined : "AI 가 그림을 찾지 못했습니다",
    ref: example("D").spec,
    refNote: "2단계에서 확인한 예시 D",
    kind: "cubes",
    widthMm: 110,
    unsure: it?.unsure,
    notes: it?.figure?.notes,
  });
  const text = it ? `${it.no}번: ${piecesToHtml(it.stem)}` : "문항을 찾지 못했습니다";
  blocks.push(`<section><h2>cubes_problem4.png - 문제 글</h2><p>${text}</p></section>`);
}

// ---------------------------------------------------------------- 그림만 있는 사진
for (const [file, key, title, kind] of [
  ["cubes_worksheet.png", "E", "cubes_worksheet 쌓기나무 네 모양", "cubes"],
  ["rect_p.jpg", "F", "rect_p 직사각형과 점 P", "points"],
] as const) {
  const stem = path.parse(file).name;
  const figs = await load(path.join(dir, `${stem}.figures.json`));
  if (!figs) continue;
  sumUsage(figs);
  const w = figs.whole;
  cases.push({
    title,
    photo: { file, box: w.crop },
    ai: w.reading?.commands ?? w.reading?.rawCommands,
    aiError: w.error ?? (w.reading?.errors?.length ? `그림 명령에 고칠 곳이 남음: ${w.reading.errors.join(" / ")}` : undefined),
    ref: example(key).spec,
    refNote: `2단계에서 확인한 예시 ${key}`,
    kind,
    widthMm: example(key).printWidthMm,
    unsure: w.reading?.unsure,
    notes: w.reading?.notes,
  });
}

// ---------------------------------------------------------------- 그림 그리기 (AI 것과 직접 만든 것)
const pngs: { ai?: string; aiErr?: string; ref?: string; refErr?: string }[] = cases.map(() => ({}));
if (cases.length) {
  const items: any[] = [];
  cases.forEach((c, k) => {
    if (c.ai) items.push({ no: `${k}-ai`, stem: [], figure: { width_mm: Math.min(c.widthMm, 80), commands: c.ai } });
    items.push({ no: `${k}-ref`, stem: [], figure: { width_mm: Math.min(c.widthMm, 80), commands: c.ref } });
  });
  const tmp = await mkdtemp(path.join(dir, ".render-"));
  try {
    const input = path.join(tmp, "in.json");
    const output = path.join(tmp, "out.json");
    await writeFile(input, JSON.stringify({ sections: [{ items }] }));
    const proc = spawnSync("node", [path.join(root, "scripts", "render-figures.mjs"), input, output, "150"], { encoding: "utf8" });
    if (proc.status !== 0 && proc.status !== 2) throw new Error(`그림을 그리지 못했습니다: ${proc.stderr || proc.stdout}`);
    const rendered = JSON.parse(await readFile(output, "utf8"));
    for (const it of rendered.sections[0].items) {
      const [k, which] = String(it.no).split("-");
      const slot = pngs[Number(k)];
      if (it.figure.png) slot[which as "ai" | "ref"] = `data:image/png;base64,${it.figure.png}`;
      else slot[`${which}Err` as "aiErr" | "refErr"] = it.figure.render_error;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const figBlocks: string[] = [];
for (let k = 0; k < cases.length; k++) {
  const c = cases[k];
  const p = pngs[k];
  const photo = c.photo ? await photoCrop(c.photo.file, c.photo.box, 420) : "";
  let verdict = "";
  if (c.ai && !c.aiError) {
    try {
      if (c.kind === "cubes") {
        const cc = compareCubes(c.ref, c.ai);
        const right = cc.same.filter(Boolean).length;
        verdict = `쌓기나무 모양 ${cc.shapes}개 가운데 ${right}개의 칸별 개수가 같음`;
        // 칸별 개수를 앞줄부터 [왼쪽 … 오른쪽] 으로 보여 준다
        const rows = (shapes: number[][][]) => shapes.map((h) => h.map((r) => `[${r.join(" ")}]`).join(" ")).join(" · ");
        if (right < cc.shapes) verdict += `<br>칸별 개수 (앞줄부터, 줄마다 왼쪽→오른쪽) AI: ${esc(rows(cc.got))} / 직접: ${esc(rows(cc.ref))}`;
        summary.push(`<li><b>${esc(c.title)}</b>: ${verdict}</li>`);
      } else {
        const pc = comparePoints(c.ref, c.ai);
        const worst = Object.entries(pc.perPoint).sort((a, b) => b[1] - a[1])[0];
        verdict = Number.isFinite(pc.rms)
          ? `이름이 같은 점 ${pc.common.length}개의 위치 차이: 그림 크기의 ${pct(pc.rms)}${worst ? ` (가장 큰 곳: 점 ${worst[0]} ${pct(worst[1])})` : ""}`
          : "이름이 같은 점이 2개보다 적어 위치를 견줄 수 없음";
        if (pc.missing.length) verdict += ` · AI 에 없는 점 ${pc.missing.join(", ")}`;
        summary.push(`<li><b>${esc(c.title)}</b>: ${verdict}</li>`);
      }
    } catch (err) {
      verdict = `비교하지 못함: ${esc(err instanceof Error ? err.message : String(err))}`;
    }
  } else {
    summary.push(`<li><b>${esc(c.title)}</b>: ${esc(c.aiError ?? "AI 그림 명령 없음")}</li>`);
  }
  figBlocks.push(`
    <div class="fig">
      <h3>${esc(c.title)}</h3>
      <div class="three">
        <figure>${photo ? `<img src="${photo}" alt="원본">` : "<div class=\"none\">원본 없음</div>"}<figcaption>원본 사진 (견주어 보기용)</figcaption></figure>
        <figure>${p.ai ? `<img src="${p.ai}" alt="AI">` : `<div class="none">${esc(c.aiError ?? p.aiErr ?? "그리지 못함")}</div>`}<figcaption>AI 가 쓴 그림 명령으로 그림</figcaption></figure>
        <figure>${p.ref ? `<img src="${p.ref}" alt="직접">` : `<div class="none">${esc(p.refErr ?? "")}</div>`}<figcaption>${esc(c.refNote)}</figcaption></figure>
      </div>
      ${verdict ? `<p>${verdict}</p>` : ""}
      ${c.notes ? `<p class="unsure">AI 메모: ${esc(c.notes)}</p>` : ""}
      ${c.unsure?.length ? `<p class="unsure">AI 가 확신이 낮다고 표시한 곳: ${c.unsure.map(esc).join(" / ")}</p>` : ""}
    </div>`);
}
if (figBlocks.length) blocks.push(`<section><h2>그림</h2>${figBlocks.join("")}</section>`);

// ---------------------------------------------------------------- 글꼴과 HTML
async function fontFaces(): Promise<string> {
  const faces: string[] = [];
  for (const [file, weight] of [["S-CoreDream-4Regular", 400], ["S-CoreDream-5Medium", 500], ["S-CoreDream-6Bold", 700]] as const) {
    const local = fontsDir && path.join(fontsDir, `${file}.woff2`);
    const src = local && existsSync(local)
      ? `url(data:font/woff2;base64,${(await readFile(local)).toString("base64")}) format("woff2")`
      : `url(https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_six@1.2/${file}.woff) format("woff")`;
    faces.push(`@font-face{font-family:"S-Core Dream";src:${src};font-weight:${weight};font-display:swap}`);
  }
  return faces.join("\n");
}

const won = Math.round(usd * 1400).toLocaleString();
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 읽기 비교</title>
<style>
${await fontFaces()}
:root{--bg:#fbfaf7;--ink:#1f2328;--muted:#5d6670;--line:#dcd8cf;--card:#ffffff;--same:#1d7a46;--diff:#b4471f;--accent:#2f5d8a}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#17191c;--ink:#e8e6e1;--muted:#a5adb5;--line:#383d43;--card:#1f2226;--same:#6fcf97;--diff:#f0a07a;--accent:#8db7e0}}
:root[data-theme="dark"]{--bg:#17191c;--ink:#e8e6e1;--muted:#a5adb5;--line:#383d43;--card:#1f2226;--same:#6fcf97;--diff:#f0a07a;--accent:#8db7e0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"S-Core Dream","Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-weight:400;line-height:1.6}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-weight:700;font-size:1.6rem;margin:0 0 4px}
h2{font-weight:700;font-size:1.25rem;margin:40px 0 12px;padding-bottom:6px;border-bottom:2px solid var(--line)}
h3{font-weight:500;font-size:1.05rem;margin:0 0 10px}
.lead{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.summary li{margin:4px 0}
.item,.fig{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
.row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}
.photo{max-width:100%;width:420px;border:1px solid var(--line);border-radius:6px;background:#fff}
table{border-collapse:collapse;font-size:.92rem}
.cmp{flex:1;min-width:280px}
td,th{border:1px solid var(--line);padding:6px 8px;vertical-align:top;text-align:left}
td:first-child{white-space:nowrap;color:var(--muted)}
.cmp td:not(:first-child){width:45%}
.choice{display:inline-block;margin-right:14px;white-space:nowrap}
th{font-weight:500;color:var(--muted);background:transparent}
.score{font-size:.85rem;font-weight:400;margin-left:8px}
.same{color:var(--same)}.diff{color:var(--diff)}
.unsure{color:var(--muted);font-size:.9rem}
details{margin-top:10px}summary{cursor:pointer;color:var(--accent)}
.diffs{margin-top:8px;width:100%}
.three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
@media (max-width:720px){.three{grid-template-columns:1fr}}
figure{margin:0}figure img{width:100%;border:1px solid var(--line);border-radius:6px;background:#fff}
figcaption{font-size:.85rem;color:var(--muted);margin-top:4px}
.none{padding:24px 8px;border:1px dashed var(--line);border-radius:6px;color:var(--diff);font-size:.9rem}
.math i{font-family:"Times New Roman",serif}
.frac{display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;font-size:.85em;line-height:1.1}
.frac span:first-child{border-bottom:1px solid currentColor}
</style></head>
<body><main>
<h1>AI 읽기 비교</h1>
<p class="lead">samples 사진을 AI 가 읽은 결과를, 직접 넣은 데이터와 2단계에서 확인한 그림에 견주었습니다. 원본 사진 조각은 견주어 보는 데만 씁니다.</p>
<div class="card"><h3>한눈에 보기</h3><ul class="summary">${summary.join("")}</ul>
<p>이 결과를 만드는 데 든 AI 요금: 약 ${won}원 ($${usd.toFixed(2)}, 1달러 1400원으로 계산)</p></div>
${blocks.join("\n")}
</main></body></html>`;

const outFile = path.join(dir, "report.html");
await writeFile(outFile, html);
console.log(`보고서: ${path.relative(root, outFile)} (${Math.round(html.length / 1024)}KB)`);
if (!cases.length && !examP1) console.log("읽어 둔 결과가 없습니다. 먼저 node scripts/read-samples.mjs 를 돌려 주세요.");
