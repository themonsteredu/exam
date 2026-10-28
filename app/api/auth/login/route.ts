// 비밀번호 확인 → 로그인 쿠키.
// 같은 곳(IP)에서 15분에 10번, 모두 합쳐 15분에 50번, 24시간에 200번 틀리면 막는다 (숫자 4자리 비밀번호도 쓰므로
// 하나씩 맞혀 보기를 늦춘다). 시도를 먼저 적고 확인하므로 한꺼번에 많이 보내도 제한을 건너뛰지 못한다.
import { clientIp, isHttps, loginBlockedMessage, sessionVersion } from "@/lib/server/auth";
import { hashPassword, verifyPassword } from "@/lib/server/secrets";
import { makeSessionToken, sessionCookie } from "@/lib/server/session";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let password = "";
  try {
    const body = await req.json();
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    /* 아래에서 틀린 비밀번호로 처리 */
  }
  const store = getStore();
  const ip = clientIp(req);
  try {
    const gate = await store.loginBegin(ip);
    if (gate.id === null) return Response.json({ error: loginBlockedMessage(gate) }, { status: 429 });
    const { password_hash } = await store.getSettings(["password_hash"]);
    // 처음 한 번: 저장된 비밀번호가 없으면 환경변수 APP_INITIAL_PASSWORD 로 확인하고 해시를 저장한다
    const initial = process.env.APP_INITIAL_PASSWORD;
    const ok = password_hash ? verifyPassword(password, password_hash) : !!initial && password === initial;
    if (!ok) return Response.json({ error: "비밀번호가 맞지 않습니다." }, { status: 401 });
    await store.loginSucceeded(gate.id);
    if (!password_hash) await store.setSetting("password_hash", hashPassword(password));
    const { token, maxAge } = await makeSessionToken(await sessionVersion(true));
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", "set-cookie": sessionCookie(token, maxAge, isHttps(req)) },
    });
  } catch (err) {
    console.error("로그인 오류", err);
    return Response.json({ error: "저장소에 연결하지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}
