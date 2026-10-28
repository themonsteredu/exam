// 비밀번호 바꾸기. 지금 비밀번호를 확인하고, 세션 판을 올려 다른 기기는 다시 로그인하게 한다.
// 지금 비밀번호 확인도 로그인과 같은 횟수 제한을 받는다 (쿠키를 훔친 사람이 비밀번호를 맞혀 보지 못하게).
import { clientIp, currentSessionKey, forgetSessionVersion, isHttps, loginBlockedMessage, requireSession, sessionVersion } from "@/lib/server/auth";
import { hashPassword, verifyPassword } from "@/lib/server/secrets";
import { makeSessionToken, sessionCookie } from "@/lib/server/session";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  let current = "";
  let next = "";
  try {
    const body = await req.json();
    current = typeof body.current === "string" ? body.current : "";
    next = typeof body.next === "string" ? body.next : "";
  } catch {
    /* 아래에서 처리 */
  }
  if (next.length < 4 || next.length > 100) {
    return Response.json({ error: "새 비밀번호는 4자 이상으로 해 주세요." }, { status: 400 });
  }
  const store = getStore();
  try {
    const gate = await store.loginBegin(clientIp(req));
    if (gate.id === null) return Response.json({ error: loginBlockedMessage(gate) }, { status: 429 });
    const { password_hash } = await store.getSettings(["password_hash"]);
    if (!verifyPassword(current, password_hash)) {
      return Response.json({ error: "지금 비밀번호가 맞지 않습니다." }, { status: 400 });
    }
    await store.loginSucceeded(gate.id);
    const version = (await sessionVersion(true)) + 1;
    await store.setSetting("password_hash", hashPassword(next));
    await store.setSetting("session_version", version);
    forgetSessionVersion();
    const { token, maxAge } = await makeSessionToken(version, await currentSessionKey());
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", "set-cookie": sessionCookie(token, maxAge, isHttps(req)) },
    });
  } catch {
    return Response.json({ error: "비밀번호를 바꾸지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}
