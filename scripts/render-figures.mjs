// 시험지 데이터(JSON)의 그림 명령을 PNG 로 그려 figure.png 에 붙인다.
// 화면 없는 브라우저(Playwright Chromium)에서 그림 엔진을 그대로 돌린다.
//
// 사용법: node scripts/render-figures.mjs <입력.json> <출력.json> [dpi]
//   글꼴: 점 이름용 Liberation Serif 와 기울인 글자용 Exam Math Italic 은 public/fonts 에서, 한글(에스코어드림)은
//   FIGURE_FONT_DIR 폴더에 S-CoreDream-4Regular.woff / 5Medium.woff 가 있으면 그것을, 없으면 CDN 에서 받는다.
//   Playwright 와 Chromium 이 있어야 한다 (package.json 에는 없다. 없으면 무엇을 설치할지 알려 준다).
// 끝 코드: 0 모두 그림, 2 출력은 만들었지만 그리지 못한 그림이 있음(그 그림에 render_error), 1 출력을 못 만듦
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
  `@font-face{font-family:"Exam Math Italic";src:${await dataUri(path.join(root, "public/fonts/ExamMathItalic.woff2"), "font/woff2")};font-style:normal}`,
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

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error(
    "그림을 그리려면 Playwright(화면 없이 도는 브라우저)가 필요한데 찾지 못했습니다.\n" +
      "  설치: npm install --no-save playwright && npx playwright install chromium",
  );
  process.exit(1);
}
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
let browser;
try {
  browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
} catch (err) {
  console.error(
    "그림을 그릴 브라우저(Chromium)를 열지 못했습니다. 설치되어 있지 않으면: npx playwright install chromium\n" +
      `  (자세한 내용: ${String(err?.message || err).split("\n")[0]})`,
  );
  process.exit(1);
}
try {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("그림 화면 오류:", e.message));
  await page.setContent(html, { waitUntil: "load" });
  const exam = JSON.parse(await readFile(inPath, "utf8"));
  const { exam: withPng, results } = await page.evaluate(([e, d]) => window.renderExam(e, d), [exam, dpi]);
  await writeFile(outPath, JSON.stringify(withPng, null, 2));
  for (const r of results) {
    const note = r.warnings?.length ? ` (알림: ${r.warnings.join(" / ")})` : "";
    console.log(r.ok ? `그림 ${r.no}번: ${r.size[0]}×${r.size[1]} 픽셀${note}` : `그림 ${r.no}번: 실패 - ${r.error}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 2;
} finally {
  await browser.close();
}
