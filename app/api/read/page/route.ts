// 1차 읽기: 시험지 한 쪽 사진 → 머리 표, 안내 상자, 문항, 그림 위치.
// 받는 것: { image: data URL 또는 base64 (긴 변 2576px, 370만 픽셀 이하), page, total, before?, docId?, model? (claude.ts 의 MODELS 가운데, 시험용) }
// 돌려주는 것: { reading, usage } 또는 { error }
// API 키와 모델은 이 기기(브라우저)의 설정에 저장한 것을 쓰고, 쓴 요금을 그 열쇠의 월별 기록에 남긴다.
import { readPage } from "@/lib/ai/read-page";
import { isModel, ReadError } from "@/lib/ai/claude";
import { fail, failFrom, parseImage } from "@/lib/ai/http";
import { aiConfig, logUsage, requireSession } from "@/lib/server/auth";
import { DOC_ID } from "@/lib/server/store";
import { fakePage, fakeAiEnabled } from "@/lib/ai/fake";

export const runtime = "nodejs";
export const maxDuration = 300;
/** 함수 시간 한도(300초)보다 먼저 끝내도록 AI 읽기에 줄 시간 (받은 답과 요금 기록을 잃지 않게) */
const BUDGET_MS = 280_000;

export async function POST(req: Request) {
  const deadline = Date.now() + BUDGET_MS;
  const denied = await requireSession(req);
  if (denied) return denied;
  let body: { image?: unknown; page?: unknown; total?: unknown; before?: unknown; model?: unknown; docId?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, "보낸 내용을 읽지 못했습니다");
  }
  const image = parseImage(body.image);
  if ("error" in image) return fail(400, image.error);
  const page = Number.isInteger(body.page) && (body.page as number) > 0 ? (body.page as number) : 1;
  const total = Number.isInteger(body.total) && (body.total as number) >= page ? (body.total as number) : page;
  const docId = typeof body.docId === "string" && DOC_ID.test(body.docId) ? body.docId : undefined;
  let config;
  try {
    config = await aiConfig(req);
  } catch {
    return fail(503, "설정을 읽지 못했습니다. 잠시 뒤 다시 해 주세요");
  }
  if (config.keyBroken) return fail(400, "저장된 API 키를 풀지 못했습니다. 설정에서 키를 다시 넣어 주세요");
  // 서버 환경변수의 열쇠로 넘어가지 않게 (요금은 이 기기에 넣은 열쇠로만)
  if (!config.apiKey) return fail(400, "이 기기에는 AI 열쇠(API 키)가 없습니다. 설정에서 열쇠를 넣어 주세요");
  // 화면 시험용 (이 작업 환경에서만): AI 를 부르지 않고 직접 넣은 데이터를 돌려준다 (열쇠 확인과 요금 기록은 실제와 같이)
  if (fakeAiEnabled()) {
    const fake = fakePage();
    await logUsage("page", fake.usage, docId, config.keyTag);
    return Response.json(fake);
  }
  try {
    const { reading, usage } = await readPage(image, {
      page,
      total,
      before: typeof body.before === "string" ? body.before.slice(0, 300) : undefined,
      model: isModel(body.model) ? body.model : config.models.page,
      apiKey: config.apiKey,
      signal: req.signal,
      deadline,
    });
    await logUsage("page", usage, docId, config.keyTag);
    return Response.json({ reading, usage });
  } catch (err) {
    if (err instanceof ReadError) await logUsage("page", err.usage, docId, config.keyTag);
    return failFrom(err);
  }
}
