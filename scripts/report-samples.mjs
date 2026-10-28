// AI 읽기 결과 비교 보고서 (요금 없음). 내용과 사용법은 scripts/report-samples.ts
//   node scripts/report-samples.mjs [--dir=output/ai] [--fonts=<부분 글꼴 폴더>]
import { runTs } from "./run-ts.mjs";
await runTs("scripts/report-samples.ts", process.argv.slice(2));
