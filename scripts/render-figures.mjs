// 시험지 데이터(JSON)의 그림 명령을 PNG 로 그려 figure.png 에 붙인다.
// 화면 없는 브라우저(Playwright Chromium)에서 그림 엔진을 그대로 돌린다.
//
// 사용법: node scripts/render-figures.mjs <입력.json> <출력.json> [dpi]
//   글꼴: 점 이름용 Liberation Serif 는 public/fonts 에서, 한글(에스코어드림)은
//   FIGURE_FONT_DIR 폴더에 S-CoreDream-4Regular.woff / 5Medium.woff 가 있으면 그것을, 없으면 CDN 에서 받는다.
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [inPath, outPath, dpiArg] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("사용법: node scripts/render-figures.mjs <입력.json> <출력.json> [dpi]");
  process.exit(1);
}
const dpi = Number(dpiArg || 360);

const bundle = await build({
  entryPoints: [path.join(root, "scripts/figure-render-entry.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2020",
  tsconfig: path.join(root, "tsconfig.json"),
  logLevel: "warning",
});
const escapeScript = (s) => s.replace(/<\/script/gi, "<\\/script");
const appJs = escapeScript(bundle.outputFiles[0].text);
const jxgJs = escapeScript(await readFile(path.join(root, "node_modules/jsxgraph/distrib/jsxgraphcore.js"), "utf8"));

const dataUri = async (file, type) => `url(data:${type};base64,${(await readFile(file)).toString("base64")})`;
const faces = [
  `@font-face{font-family:"Liberation Serif";src:${await dataUri(path.join(root, "public/fonts/LiberationSerif-Regular.ttf"), "font/ttf")};font-style:normal}`,
  `@font-face{font-family:"Liberation Serif";src:${await dataUri(path.join(root, "public/fonts/LiberationSerif-Italic.ttf"), "font/ttf")};font-style:italic}`,
];
const fontDir = process.env.FIGURE_FONT_DIR;
for (const [weight, name] of [[400, "S-CoreDream-4Regular"], [500, "S-CoreDream-5Medium"]]) {
  const local = fontDir && path.join(fontDir, `${name}.woff`);
  const src = local && existsSync(local)
    ? await dataUri(local, "font/woff")
    : `url(https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_six@1.2/${name}.woff)`;
  faces.push(`@font-face{font-family:"S-Core Dream";src:${src} format("woff");font-weight:${weight}}`);
}

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${faces.join("\n")}</style></head>
<body><script>${jxgJs}</script><script>${appJs}</script></body></html>`;

const { chromium } = require("playwright");
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("그림 화면 오류:", e.message));
  await page.setContent(html, { waitUntil: "load" });
  const exam = JSON.parse(await readFile(inPath, "utf8"));
  const { exam: withPng, results } = await page.evaluate(([e, d]) => window.renderExam(e, d), [exam, dpi]);
  await writeFile(outPath, JSON.stringify(withPng, null, 2));
  for (const r of results) {
    console.log(r.ok ? `그림 ${r.no}번: ${r.size[0]}×${r.size[1]} 픽셀` : `그림 ${r.no}번: 실패 - ${r.error}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 2;
} finally {
  await browser.close();
}
