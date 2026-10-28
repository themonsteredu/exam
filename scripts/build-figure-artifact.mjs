// 2단계 그림 엔진 확인 화면을 한 개의 HTML 파일로 묶는다 (따로 여는 점검 페이지용).
// 사용법: node scripts/build-figure-artifact.mjs <출력 html 경로> <글꼴 폴더>
//   글꼴 폴더에는 S-CoreDream-4Regular / 5Medium / 6Bold 와 LiberationSerif Regular / Italic 이
//   woff2(부분 글꼴) 로 들어 있어야 한다 (scripts/subset-fonts.py 가 만든다).
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [outPath, fontDir] = process.argv.slice(2);
if (!outPath || !fontDir) {
  console.error("사용법: node scripts/build-figure-artifact.mjs <출력 html> <글꼴 폴더>");
  process.exit(1);
}

// react, react-dom, jsxgraph 는 CDN 전역 값으로 연결한다
const globals = {
  react: "window.React",
  "react-dom": "window.ReactDOM",
  "react-dom/client": "window.ReactDOM",
  jsxgraph: "window.JXG",
};
const globalsPlugin = {
  name: "globals",
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom|react-dom\/client|jsxgraph|react\/jsx-runtime)$/ }, (args) => ({
      path: args.path,
      namespace: "globals",
    }));
    b.onLoad({ filter: /.*/, namespace: "globals" }, (args) => {
      if (args.path === "react/jsx-runtime") {
        return {
          contents: `
            const R = window.React;
            const make = (type, props, key) => R.createElement(type, key === undefined ? props : { ...props, key });
            export const jsx = make; export const jsxs = make; export const Fragment = R.Fragment;`,
          loader: "js",
        };
      }
      return { contents: `module.exports = ${globals[args.path]};`, loader: "js" };
    });
  },
};

const result = await build({
  entryPoints: [path.join(root, "artifact/figure-test-entry.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2020",
  minify: true,
  jsx: "automatic",
  tsconfig: path.join(root, "tsconfig.json"),
  plugins: [globalsPlugin],
  logLevel: "warning",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const font = async (file, family, weight, style = "normal") => {
  const data = await readFile(path.join(fontDir, file));
  return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${data.toString("base64")}) format("woff2");font-weight:${weight};font-style:${style};font-display:block}`;
};
const fonts = [
  await font("S-CoreDream-4Regular.woff2", "S-Core Dream", 400),
  await font("S-CoreDream-5Medium.woff2", "S-Core Dream", 500),
  await font("S-CoreDream-6Bold.woff2", "S-Core Dream", 700),
  await font("LiberationSerif-Regular.woff2", "Liberation Serif", 400),
  await font("LiberationSerif-Italic.woff2", "Liberation Serif", 400, "italic"),
].join("\n");

const theme = await readFile(path.join(root, "app/theme.css"), "utf8");
const pageCss = await readFile(path.join(root, "components/figure-test/figure-test.css"), "utf8");

const html = `<title>시험지 그림 엔진</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${theme}
${pageCss}
</style>
<style>
${fonts}
</style>
<div id="root"><main class="page"><p class="ft-boot">그림 도구를 불러오는 중입니다.</p></main></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/jsxgraph@1.13.3/distrib/jsxgraphcore.js"></script>
<script>
${js}
</script>
`;
await writeFile(outPath, html);
console.log(`저장: ${outPath} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
