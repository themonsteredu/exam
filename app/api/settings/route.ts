// 설정 화면에 보여 줄 것: API 키 저장 여부(끝 4자리만), 고른 모델, 달마다 쓴 AI 요금.
// API 키 자체는 절대 돌려주지 않는다.
import { requireSession } from "@/lib/server/auth";
import { isModel, modelFor, type Pass } from "@/lib/ai/claude";
import { getStore } from "@/lib/server/store";
import { KRW_PER_USD, MODEL_INFO } from "@/lib/ai/models-info";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    const store = getStore();
    const [info, s, usage] = await Promise.all([store.apiKeyInfo(), store.getSettings(["models"]), store.monthlyUsage(12)]);
    const saved = (s.models ?? {}) as Partial<Record<Pass, unknown>>;
    return Response.json({
      apiKey: info.saved ? { saved: true, last4: info.last4 ?? "", savedAt: info.savedAt ?? "", broken: !!info.broken } : { saved: false },
      models: {
        page: isModel(saved.page) ? saved.page : modelFor("page"),
        figure: isModel(saved.figure) ? saved.figure : modelFor("figure"),
      },
      modelOptions: MODEL_INFO,
      usage,
      krwPerUsd: KRW_PER_USD,
      hwpxEndpoint: process.env.EXAM_STORE === "local" ? "/api/dev-hwpx" : "/api/hwpx",
    });
  } catch (err) {
    console.error("설정 읽기 실패", err);
    return Response.json({ error: "설정을 읽지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}
