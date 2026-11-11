import { createHash } from "node:crypto";
import { getStore } from "./store";
import { READ_CACHE_REVISION } from "@/lib/client/read-cache";

/** API 키는 해시 표시만 사용한다. 다른 기기·모델·프롬프트의 읽기를 섞지 않는다. */
export async function serverReading<T extends { usage: any }>(kind: "page" | "figure", scope: string, input: unknown, run: () => Promise<T>, force = false): Promise<T & { cached?: boolean }> {
  const key = "exam_read_" + createHash("sha256").update(JSON.stringify([READ_CACHE_REVISION, scope, kind, input])).digest("hex");
  if (!force) {
    const hit: any = (await getStore().getSettings([key]))[key];
    if (hit?.at > Date.now() - 30 * 86400_000 && hit.value) return { ...hit.value, cached: true, usage: { model: hit.value.usage.model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 } };
  }
  const value: any = await run();
  const reusable = kind === "page" ? Array.isArray(value.reading?.sections) && !value.figureReviewNeeded
    : !!(value.figure?.commands?.elements?.length || (value.figure?.graphic && value.figure.graphic.kind !== "photo")) && !value.figure?.errors?.length;
  // 재사용 저장이 실패해도 이미 받은 읽기 결과는 정상적으로 이어서 보관한다.
  if (reusable && !force) await getStore().setSetting(key, { at: Date.now(), value }).catch(() => undefined);
  return value;
}
