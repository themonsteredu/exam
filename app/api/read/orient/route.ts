// 옆으로 누운 쪽의 방향 묻기: { image (작은 쪽 사진), docId?, model? } → { rotate: 0|90|180|270, usage } 또는 { error }
// 글자가 세로로 누운 쪽만 화면이 부른다 (lib/client/make-exam). 요금은 쪽 읽기로 기록한다.
import { readOrientation } from "@/lib/ai/read-orient";
import { isModel, ReadError } from "@/lib/ai/claude";
import { fail, failFrom, parseImage } from "@/lib/ai/http";
import { aiConfig, logUsage, requireSession } from "@/lib/server/auth";
import { DOC_ID } from "@/lib/server/store";
import { fakeAiEnabled } from "@/lib/ai/fake";

export const runtime = "nodejs";
export const maxDuration = 120;
const BUDGET_MS = 100_000;

export async function POST(req: Request) {
  const deadline = Date.now() + BUDGET_MS;
  const denied = await requireSession(req);
  if (denied) return denied;
  let body: { image?: unknown; model?: unknown; docId?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, "보낸 내용을 읽지 못했습니다");
  }
  const image = parseImage(body.image);
  if ("error" in image) return fail(400, image.error);
  const docId = typeof body.docId === "string" && DOC_ID.test(body.docId) ? body.docId : undefined;
  let config;
  try {
    config = await aiConfig(req);
  } catch {
    return fail(503, "설정을 읽지 못했습니다. 잠시 뒤 다시 해 주세요");
  }
  if (config.keyBroken) return fail(400, "저장된 API 키를 풀지 못했습니다. 설정에서 키를 다시 넣어 주세요");
  if (!config.apiKey) return fail(400, "이 기기에는 AI 열쇠(API 키)가 없습니다. 설정에서 열쇠를 넣어 주세요");
  // 화면 시험용 (이 작업 환경에서만): 시험 사진은 바로 서 있다
  if (fakeAiEnabled()) return Response.json({ rotate: 0, usage: { model: "fake", input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 } });
  try {
    const { rotate, usage } = await readOrientation(image, {
      model: isModel(body.model) ? body.model : config.models.page,
      apiKey: config.apiKey,
      signal: req.signal,
      deadline,
    });
    await logUsage("page", usage, docId, config.keyTag);
    return Response.json({ rotate, usage });
  } catch (err) {
    if (err instanceof ReadError) await logUsage("page", err.usage, docId, config.keyTag);
    return failFrom(err);
  }
}
