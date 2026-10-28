// samples 사진을 AI 로 읽는다 (4단계 확인용). 요금이 든다.
//   node scripts/read-samples.mjs [사진 이름 …] [--cached] [--out=output/ai] [--page-model=…] [--figure-model=…] [--page-effort=medium] [--figure-effort=high]
//
// 사진 이름을 주지 않으면 samples 의 네 사진을 모두 읽는다.
//   exam_p1.jpg, cubes_problem4.png : 쪽 읽기 → 그림 읽기 → 시험지 JSON
//   cubes_worksheet.png, rect_p.jpg : 그림만 있는 사진이라 그림 읽기만
// --cached : 이미 읽어 둔 결과(output/ai/*.page.json, *.figures.json)가 있으면 AI 를 다시 부르지 않는다 (요금 없음)
// --out : 결과 폴더 (모델끼리 견줄 때 모델마다 다른 폴더로. 예: --out=output/ai/haiku --page-model=claude-haiku-5-5)
// --page-model, --figure-model : 쪽 읽기·그림 읽기에 쓸 모델 (claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5, claude-opus-5)
//
// 결과: output/ai/<이름>.page.json (쪽 읽기 답), <이름>.figures.json (그림 읽기 답), <이름>.exam.json (시험지 JSON),
//       output/ai/usage.json (이번에 쓴 토큰과 요금)

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { addUsage, isModel, modelFor, type Effort, type Usage } from "@/lib/ai/claude";
import { assembleExam, figureJobs, toExamPieces, type FigureResult, type PageMeta } from "@/lib/ai/assemble";
import { figureCropRect, figureSendSize, fitForClaude } from "@/lib/ai/image-geometry";
import type { PageReading } from "@/lib/ai/page-schema";
import { readFigure, type FigureContext } from "@/lib/ai/read-figure";
import { readPage, type ImageInput } from "@/lib/ai/read-page";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = process.env.EXAM_ROOT || process.cwd();

type Sample = { file: string; mode: "page" | "figure"; context?: FigureContext };

const SAMPLES: Sample[] = [
  { file: "exam_p1.jpg", mode: "page" },
  { file: "cubes_problem4.png", mode: "page" },
  {
    file: "cubes_worksheet.png",
    mode: "figure",
    context: { no: "학습지", stem: [{ t: "(문제 글 없음: 쌓기나무 모양이 그려진 학습지 사진입니다)" }], choices: [], bogi: [] },
  },
  {
    file: "rect_p.jpg",
    mode: "figure",
    context: { no: "그림", stem: [{ t: "(문제 글 없음: 그림만 있는 사진입니다)" }], choices: [], bogi: [] },
  },
];

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const cached = args.includes("--cached");
const pageEffort = (flag("page-effort") as Effort) || undefined;
const figureEffort = (flag("figure-effort") as Effort) || undefined;
const OUT = path.resolve(root, flag("out") ?? path.join("output", "ai"));
const pageModel = flag("page-model");
const figureModel = flag("figure-model");
for (const m of [pageModel, figureModel]) {
  if (m && !isModel(m)) {
    console.error(`모르는 모델 이름: ${m}`);
    process.exit(1);
  }
}
const names = args.filter((a) => !a.startsWith("--"));
const chosen = names.length ? SAMPLES.filter((s) => names.includes(s.file)) : SAMPLES;
if (names.length && chosen.length !== names.length) {
  console.error(`모르는 사진 이름이 있습니다. 쓸 수 있는 이름: ${SAMPLES.map((s) => s.file).join(", ")}`);
  process.exit(1);
}

let total: Usage | undefined;
const usageLog: Record<string, any> = {};
const won = (usd: number) => `${Math.round(usd * 1400).toLocaleString()}원`;

/** 원본 사진을 방향을 바로잡아 읽는다 (휴대폰 사진의 회전 정보) */
async function loadOriginal(file: string) {
  const { data, info } = await sharp(path.join(root, "samples", file)).rotate().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, png: file.toLowerCase().endsWith(".png") };
}

/** AI 에게 보낼 쪽 사진: 너무 크면 줄인다. PNG 원본은 PNG 로, 사진은 JPEG 로 */
async function pageImage(orig: { data: Buffer; width: number; height: number; png: boolean }): Promise<{ image: ImageInput; scale: number }> {
  const fit = fitForClaude(orig.width, orig.height);
  let pipe = sharp(orig.data);
  if (fit.scale < 1) pipe = pipe.resize(fit.width, fit.height, { kernel: "lanczos3" });
  const buf = orig.png ? await pipe.png().toBuffer() : await pipe.jpeg({ quality: 90 }).toBuffer();
  const meta = await sharp(buf).metadata();
  return {
    image: { data: buf.toString("base64"), mediaType: orig.png ? "image/png" : "image/jpeg", width: meta.width!, height: meta.height! },
    scale: meta.width! / orig.width,
  };
}

/** 원본에서 그림을 잘라 키운다 (선이 또렷하게 PNG 로) */
async function figureImage(orig: { data: Buffer }, crop: { x: number; y: number; w: number; h: number }) {
  const send = figureSendSize(crop.w, crop.h);
  const buf = await sharp(orig.data)
    .extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h })
    .resize(send.width, send.height, { kernel: "lanczos3" })
    .png()
    .toBuffer();
  const image: ImageInput = { data: buf.toString("base64"), mediaType: "image/png", width: send.width, height: send.height };
  return { image, scale: send.width / crop.w };
}

let failures = 0;

/** 읽은 결과를 저장한다. 실패한 그림이 들어 있으면 저장하지 않는다 (--cached 로 다시 쓸 때 실패를 되풀이하지 않게) */
async function cachedJson<T>(file: string, make: () => Promise<T>, complete: (v: T) => boolean = () => true): Promise<T> {
  if (cached && existsSync(file)) {
    console.log(`  저장해 둔 결과를 씁니다: ${path.relative(root, file)}`);
    return JSON.parse(await readFile(file, "utf8"));
  }
  const value = await make();
  if (complete(value)) await writeFile(file, JSON.stringify(value, null, 2));
  else console.log(`  실패한 것이 있어 ${path.relative(root, file)} 은 저장하지 않았습니다`);
  return value;
}

const allRead = (v: Record<string, { error?: string }>) => Object.values(v).every((r) => !r.error);

function note(label: string, usage: Usage | undefined, seconds: number) {
  if (!usage) return;
  total = addUsage(total, usage);
  usageLog[label] = { ...usage, seconds: Math.round(seconds) };
  console.log(`  ${label}: 입력 ${usage.input + usage.cacheRead + usage.cacheWrite}토큰, 출력 ${usage.output}토큰, 약 $${usage.usd.toFixed(3)} (${won(usage.usd)}), ${Math.round(seconds)}초`);
}

/** 그림 여러 개를 동시에 (한 번에 3개까지) 읽는다 */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function readFigureSaved(label: string, image: ImageInput, context: FigureContext) {
  const t0 = Date.now();
  try {
    const { figure, usage } = await readFigure(image, context, { model: figureModel, effort: figureEffort });
    note(label, usage, (Date.now() - t0) / 1000);
    return { reading: figure, usage };
  } catch (err) {
    failures++;
    console.log(`  ${label}: 실패 - ${err instanceof Error ? err.message : String(err)}`);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function runPage(sample: Sample) {
  const stem = path.parse(sample.file).name;
  const orig = await loadOriginal(sample.file);
  const { image, scale } = await pageImage(orig);
  console.log(`${sample.file}: 원본 ${orig.width}×${orig.height}, AI 에게 ${image.width}×${image.height} 로 보냄`);

  const pageFile = path.join(OUT, `${stem}.page.json`);
  const page = await cachedJson(pageFile, async () => {
    const t0 = Date.now();
    const { reading, usage } = await readPage(image, { page: 1, total: 1, model: pageModel, effort: pageEffort });
    note(`${stem} 쪽 읽기`, usage, (Date.now() - t0) / 1000);
    return { reading, usage, sent: { width: image.width, height: image.height, scale } };
  });
  const reading: PageReading = page.reading;
  const meta: PageMeta = { page: 1, original: { width: orig.width, height: orig.height }, scale: page.sent?.scale ?? scale };

  const jobs = figureJobs(1, reading);
  console.log(`  문항 ${reading.sections.reduce((n, s) => n + s.items.length, 0)}개, 그림 ${jobs.length}개`);
  const figFile = path.join(OUT, `${stem}.figures.json`);
  const figures: Record<string, FigureResult & { usage?: Usage }> = await cachedJson(figFile, async () => {
    const results = await pool(jobs, 3, async (job) => {
      const crop = figureCropRect(job.region, meta.scale, meta.original);
      const { image: fimg, scale: fscale } = await figureImage(orig, crop);
      const context: FigureContext = {
        no: job.item.no,
        stem: toExamPieces(job.item.stem),
        choices: job.item.choices.map(toExamPieces),
        bogi: job.item.bogi.map(toExamPieces),
      };
      const r = await readFigureSaved(`${stem} ${job.item.no}번 그림`, fimg, context);
      return [job.key, { crop, scale: fscale, ...r }] as const;
    });
    return Object.fromEntries(results);
  }, allRead);
  const exam = assembleExam([{ meta, reading }], new Map(Object.entries(figures)));
  await writeFile(path.join(OUT, `${stem}.exam.json`), JSON.stringify(exam, null, 2));
  console.log(`  시험지 JSON: ${path.relative(root, path.join(OUT, `${stem}.exam.json`))}`);
}

async function runFigure(sample: Sample) {
  const stem = path.parse(sample.file).name;
  const orig = await loadOriginal(sample.file);
  const crop = { x: 0, y: 0, w: orig.width, h: orig.height };
  const { image, scale } = await figureImage(orig, crop);
  console.log(`${sample.file}: 원본 ${orig.width}×${orig.height}, 그림으로 ${image.width}×${image.height} 로 보냄`);
  const figFile = path.join(OUT, `${stem}.figures.json`);
  await cachedJson(figFile, async () => {
    const r = await readFigureSaved(`${stem} 그림`, image, sample.context!);
    return { whole: { crop, scale, ...r } };
  }, allRead);
}

if (!cached && !process.env.ANTHROPIC_API_KEY) {
  console.error("AI 열쇠(ANTHROPIC_API_KEY)가 없어 AI 를 부를 수 없습니다. 저장해 둔 결과만 쓰려면 --cached 를 붙이세요.");
  process.exit(1);
}
await mkdir(OUT, { recursive: true });
console.log(`쪽 읽기 모델 ${modelFor("page", pageModel)}, 그림 읽기 모델 ${modelFor("figure", figureModel)}, 결과 폴더 ${path.relative(root, OUT)}`);
for (const sample of chosen) {
  try {
    if (sample.mode === "page") await runPage(sample);
    else await runFigure(sample);
  } catch (err) {
    failures++;
    console.log(`  ${sample.file}: 실패 - ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (total) {
  console.log(`\n이번에 쓴 요금: 약 $${total.usd.toFixed(3)} (${won(total.usd)}, 1달러 1400원으로 계산)`);
  const logFile = path.join(OUT, "usage.json");
  const old = existsSync(logFile) ? JSON.parse(await readFile(logFile, "utf8")) : [];
  old.push({ when: new Date().toISOString(), total, parts: usageLog });
  await writeFile(logFile, JSON.stringify(old, null, 2));
} else if (!failures) {
  console.log("\nAI 를 부르지 않았습니다 (저장해 둔 결과만 씀).");
}
if (failures) {
  console.log(`\n읽지 못한 것이 ${failures}개 있습니다 (위 안내를 확인해 주세요).`);
  process.exitCode = 1;
}
