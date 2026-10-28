// 설정 화면에 보여 줄 것: 이 기기의 API 키 저장 여부(끝 4자리만), 이 기기에서 고른 모델, 이 열쇠로 달마다 쓴 AI 요금.
// API 키 자체는 절대 돌려주지 않는다. AI 열쇠와 모델은 기기(브라우저)마다 따로다 (lib/server/device.ts).
import { pickModels, requireSession } from "@/lib/server/auth";
import { deviceOf } from "@/lib/server/device";
import { getStore, type DeviceInfo } from "@/lib/server/store";
import { KRW_PER_USD, MODEL_INFO } from "@/lib/ai/models-info";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    const store = getStore();
    const device = await deviceOf(req);
    const info: DeviceInfo = device ? await store.deviceInfo(device) : { apiKey: { saved: false }, models: null };
    const key = info.apiKey;
    const usage = key.saved && key.tag ? await store.monthlyUsage(key.tag, 12) : [];
    return Response.json({
      apiKey: key.saved ? { saved: true, last4: key.last4 ?? "", savedAt: key.savedAt ?? "", broken: !!key.broken } : { saved: false },
      models: pickModels(info.models),
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
