// 이 기기의 제공자별 API 키 저장 / 지우기. 모델 목록 조회로 확인하며 유료 읽기는 하지 않는다.
// 키는 기기(브라우저)마다 따로 두고, 저장 창구가 암호로 바꿔 보관한다 (배포에서는 Vercel 에 키를 풀 열쇠가 없다).
import Anthropic from "@anthropic-ai/sdk";
import { fakeAiEnabled } from "@/lib/ai/fake";
import { requireSession } from "@/lib/server/auth";
import { deviceOf } from "@/lib/server/device";
import { apiKeyDevice, getStore } from "@/lib/server/store";
import { isProvider, validApiKeyFormat, type AiProvider } from "@/lib/ai/models";

const NO_DEVICE = "이 기기를 알아보지 못했습니다. 화면을 새로 고친 뒤 다시 해 주세요.";

export const runtime = "nodejs";

/** Anthropic 에 맞는 키인지 묻는다 (모델 목록 보기라 요금이 들지 않는다). 맞으면 null */
async function checkWithAnthropic(key: string): Promise<Response | null> {
  try {
    const client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com", maxRetries: 1, timeout: 20_000 });
    await client.models.list({ limit: 1 });
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return Response.json({ error: "Anthropic 에서 이 키를 받아 주지 않았습니다. 키를 다시 복사해 넣어 주세요." }, { status: 400 });
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      return Response.json({ error: "이 키로는 쓸 수 없다고 합니다. 콘솔에서 키 권한을 확인해 주세요." }, { status: 400 });
    }
    return Response.json({ error: "Anthropic 에 연결해 키를 확인하지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 502 });
  }
}

async function checkWithOpenAI(key: string, signal: AbortSignal): Promise<Response | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (response.ok) {
      await response.body?.cancel();
      return null;
    }
    await response.body?.cancel();
    if (response.status === 401) return Response.json({ error: "OpenAI에서 이 키를 받아 주지 않았습니다. GPT 키를 다시 확인해 주세요." }, { status: 400 });
    if (response.status === 403) return Response.json({ error: "이 OpenAI 키의 프로젝트와 모델 조회 권한을 확인해 주세요." }, { status: 400 });
    return Response.json({ error: "OpenAI에서 키를 확인하지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 502 });
  } catch {
    return Response.json({ error: "OpenAI에 연결하지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  let key = "";
  let provider: AiProvider = "anthropic";
  try {
    const body = await req.json();
    if (body.provider !== undefined && !isProvider(body.provider)) return Response.json({ error: "Claude 또는 GPT를 골라 주세요." }, { status: 400 });
    provider = body.provider ?? "anthropic";
    key = typeof body.key === "string" ? body.key.trim() : "";
  } catch {
    /* 아래에서 처리 */
  }
  if (!validApiKeyFormat(key, provider)) {
    const error = provider === "anthropic" ? "Claude의 일반 API 키(sk-ant-api…)를 넣어 주세요." : "OpenAI에서 발급한 GPT API 키(sk-…)를 넣어 주세요.";
    return Response.json({ error }, { status: 400 });
  }
  const device = await deviceOf(req);
  if (!device) return Response.json({ error: NO_DEVICE }, { status: 400 });
  // 화면 시험용 (이 작업 환경에서만): Anthropic 에 묻지 않고 저장한다
  const refused = fakeAiEnabled() ? null : provider === "openai" ? await checkWithOpenAI(key, req.signal) : await checkWithAnthropic(key);
  if (refused) return refused;
  try {
    const info = await getStore().setApiKey(apiKeyDevice(device, provider), key);
    return Response.json({ ok: true, last4: info.last4, savedAt: info.savedAt });
  } catch (err) {
    console.error("키 저장 실패", err);
    return Response.json({ error: "키를 저장하지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}

export async function DELETE(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const provider = new URL(req.url).searchParams.get("provider") ?? "anthropic";
  if (!isProvider(provider)) return Response.json({ error: "Claude 또는 GPT를 골라 주세요." }, { status: 400 });
  const device = await deviceOf(req);
  if (!device) return Response.json({ error: NO_DEVICE }, { status: 400 });
  try {
    await getStore().deleteApiKey(apiKeyDevice(device, provider));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "키를 지우지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}
