// 2차 읽기: 그림 하나(잘라서 키운 사진) + 문제 글 → 그림 명령.
// 받는 것: { image: data URL 또는 base64, item: { no, stem, choices, bogi }, docId?, model? } (stem 등은 시험지 JSON 조각 {t}/{m})
// 돌려주는 것: { figure, usage } 또는 { error }. figure.errors 가 비어 있지 않으면 그림 명령에 고칠 곳이 남은 것
// API 키와 모델은 이 기기(브라우저)의 설정에 저장한 것을 쓰고, 쓴 요금을 그 열쇠의 월별 기록에 남긴다.
import { readFigure } from "@/lib/ai/read-figure";
import { isModel, ReadError } from "@/lib/ai/claude";
import { fail, failFrom, parseImage } from "@/lib/ai/http";
import { aiConfig, logUsage, requireSession } from "@/lib/server/auth";
import { DOC_ID } from "@/lib/server/store";
import { fakeFigure, fakeAiEnabled } from "@/lib/ai/fake";

export const runtime = "nodejs";
export const maxDuration = 300;
/** 함수 시간 한도(300초)보다 먼저 끝내도록 AI 읽기에 줄 시간 (받은 답과 요금 기록을 잃지 않게) */
const BUDGET_MS = 280_000;

const pieces = (v: unknown) => (Array.isArray(v) ? v.filter((p) => p && typeof p === "object") : []);

export async function POST(req: Request) {
  const deadline = Date.now() + BUDGET_MS;
  const denied = await requireSession(req);
  if (denied) return denied;
  let body: { image?: unknown; item?: Record<string, unknown>; model?: unknown; docId?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, "보낸 내용을 읽지 못했습니다");
  }
  const image = parseImage(body.image);
  if ("error" in image) return fail(400, image.error);
  const item = body.item ?? {};
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
    const fake = fakeFigure(item.no);
    await logUsage("figure", fake.usage, docId, config.keyTag);
    return Response.json(fake);
  }
  try {
    const { figure, usage } = await readFigure(
      image,
      {
        no: typeof item.no === "number" || typeof item.no === "string" ? item.no : "?",
        stem: pieces(item.stem),
        choices: Array.isArray(item.choices) ? item.choices.map(pieces) : [],
        bogi: Array.isArray(item.bogi) ? item.bogi.map(pieces) : [],
      },
      {
        model: isModel(body.model) ? body.model : config.models.figure,
        apiKey: config.apiKey,
        signal: req.signal,
        deadline,
      },
    );
    await logUsage("figure", usage, docId, config.keyTag);
    return Response.json({ figure, usage });
  } catch (err) {
    if (err instanceof ReadError) await logUsage("figure", err.usage, docId, config.keyTag);
    return failFrom(err);
  }
}
