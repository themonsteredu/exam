// samples 사진을 AI 로 읽는다 (요금이 든다). 내용과 사용법은 scripts/read-samples.ts
//   node scripts/read-samples.mjs [사진 이름 …] [--cached]
import { runTs } from "./run-ts.mjs";
await runTs("scripts/read-samples.ts", process.argv.slice(2));
