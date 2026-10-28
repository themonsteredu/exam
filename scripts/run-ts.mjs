// TypeScript 로 쓴 스크립트를 묶어서 돌린다 (lib 의 TypeScript 코드를 그대로 쓰려고).
//   node scripts/run-ts.mjs <스크립트.ts> [인수 …]
// 묶은 파일은 node_modules/.cache 에 잠깐 두었다가 지운다 (node_modules 의 라이브러리를 찾을 수 있게).
import { build } from "esbuild";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runTs(entry, args = []) {
  const out = await build({
    entryPoints: [path.resolve(root, entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    tsconfig: path.join(root, "tsconfig.json"),
    logLevel: "warning",
  });
  const cache = path.join(root, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(path.join(cache, "run-ts-"));
  try {
    const file = path.join(dir, "script.mjs");
    await writeFile(file, out.outputFiles[0].text);
    process.env.EXAM_ROOT = root;
    process.argv = [process.argv[0], file, ...args];
    await import(pathToFileURL(file).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [entry, ...args] = process.argv.slice(2);
  if (!entry) {
    console.error("사용법: node scripts/run-ts.mjs <스크립트.ts> [인수 …]");
    process.exit(1);
  }
  await runTs(entry, args);
}
