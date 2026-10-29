// PDF 를 그림으로 바꾸는 pdf.js 가 쓰는 보조 파일을 public/pdfjs 에 옮겨 둔다 (화면에서 /pdfjs/... 로 받는다).
//   wasm/           스캔 PDF 의 흑백 글자 층(CCITT·JBIG2), JPEG2000 그림, 색 프로필을 푸는 해독기
//   cmaps/          글꼴이 박히지 않은 한글·한자 PDF 의 글자표
//   standard_fonts/ 글꼴이 박히지 않은 PDF 의 기본 글꼴 (Times, Helvetica 등)
//   iccs/           색 프로필
// 이것이 없으면 pdf.js 는 오류 없이 그 부분을 건너뛰고 그린다 (2026-10-29: 복사기 스캔 PDF 의 글자가 모두 빠져 AI 가 읽지 못함).
// pdfjs-dist 판을 바꾸면 다시 돌린다: node scripts/copy-pdfjs-assets.mjs  (판이 다르면 scripts/check-ai.mjs 가 알린다)
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules/pdfjs-dist");
const dst = path.join(root, "public/pdfjs");
const { version } = JSON.parse(await readFile(path.join(src, "package.json"), "utf8"));

await rm(dst, { recursive: true, force: true });
await mkdir(dst, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "iccs"]) {
  await cp(path.join(src, dir), path.join(dst, dir), { recursive: true });
}
// 해독기만 (quickjs 는 PDF 속 스크립트용이라 쓰지 않는다)
const wasm = [
  "jbig2.wasm", "jbig2_nowasm_fallback.js", "openjpeg.wasm", "openjpeg_nowasm_fallback.js", "qcms_bg.wasm",
  "LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_PDFJS_JBIG2", "LICENSE_PDFJS_OPENJPEG", "LICENSE_PDFJS_QCMS", "LICENSE_QCMS",
];
await mkdir(path.join(dst, "wasm"), { recursive: true });
for (const f of wasm) await cp(path.join(src, "wasm", f), path.join(dst, "wasm", f));
await cp(path.join(src, "LICENSE"), path.join(dst, "LICENSE"));
await writeFile(path.join(dst, "VERSION"), `${version}\n`);
console.log(`public/pdfjs 에 pdfjs-dist ${version} 보조 파일을 옮겼습니다`);
