// API 키 저장(먼저 Anthropic 에 맞는 키인지 확인. 모델 목록 보기라 요금이 들지 않는다) / 지우기.
// 키는 저장 창구가 암호로 바꿔 보관한다 (배포에서는 Vercel 에 키를 풀 열쇠가 없다).
import Anthropic from "@anthropic-ai/sdk";
import { requireSession } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  let key = "";
  try {
    const body = await req.json();
    key = typeof body.key === "string" ? body.key.trim() : "";
  } catch {
    /* 아래에서 처리 */
  }
  if (/^sk-ant-admin/.test(key)) {
    return Response.json({ error: "관리자용 키(sk-ant-admin…)가 아니라 일반 API 키(sk-ant-api…)를 넣어 주세요." }, { status: 400 });
  }
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
    return Response.json({ error: "API 키 모양이 아닙니다. sk-ant- 로 시작하는 키를 그대로 붙여 넣어 주세요." }, { status: 400 });
  }
  try {
    const client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com", maxRetries: 1, timeout: 20_000 });
    await client.models.list({ limit: 1 });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return Response.json({ error: "Anthropic 에서 이 키를 받아 주지 않았습니다. 키를 다시 복사해 넣어 주세요." }, { status: 400 });
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      return Response.json({ error: "이 키로는 쓸 수 없다고 합니다. 콘솔에서 키 권한을 확인해 주세요." }, { status: 400 });
    }
    return Response.json({ error: "Anthropic 에 연결해 키를 확인하지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 502 });
  }
  try {
    const info = await getStore().setApiKey(key);
    return Response.json({ ok: true, last4: info.last4, savedAt: info.savedAt });
  } catch (err) {
    console.error("키 저장 실패", err);
    return Response.json({ error: "키를 저장하지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}

export async function DELETE(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    await getStore().deleteApiKey();
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "키를 지우지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}
