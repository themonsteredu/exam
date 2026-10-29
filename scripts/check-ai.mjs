// AI 읽기 부품 점검 (AI 를 부르지 않는다. 요금 없음). 내용은 scripts/check-ai.ts
//   node scripts/check-ai.mjs
import { runTs } from "./run-ts.mjs";
await runTs("scripts/check-ai.ts", process.argv.slice(2));
