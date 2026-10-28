// 서버 주소에서 쓰는 로그인 확인과 설정 읽기.

import { isModel, modelFor, type Pass, type Usage } from "@/lib/ai/claude";
import { deviceOf } from "./device";
import { cookieValue, readSessionToken, SESSION_COOKIE } from "./session";
import { getStore, LOGIN_LIMIT, type LoginGate, type UsageRow } from "./store";

export { isHttps } from "./session";

let cachedVersion: { value: number; at: number } | null = null;
let cachedKey: { value: string; at: number } | null = null;

/** 로그인 쿠키 서명 열쇠 (저장 창구가 만들어 준다). 서버마다 10분 캐시 */
export async function currentSessionKey(): Promise<string> {
  if (cachedKey && Date.now() - cachedKey.at < 600_000) return cachedKey.value;
  const value = await getStore().sessionKey();
  if (!value || value.length < 32) throw new Error("쿠키 서명 열쇠가 이상합니다");
  cachedKey = { value, at: Date.now() };
  return value;
}

/** 지금 세션 판 (비밀번호를 바꾸면 오른다). 서버마다 60초 캐시 */
export async function sessionVersion(fresh = false): Promise<number> {
  if (!fresh && cachedVersion && Date.now() - cachedVersion.at < 60_000) return cachedVersion.value;
  const { session_version } = await getStore().getSettings(["session_version"]);
  const value = Number(session_version ?? 1) || 1;
  cachedVersion = { value, at: Date.now() };
  return value;
}

export function forgetSessionVersion() {
  cachedVersion = null;
}

/** 로그인되어 있으면 null, 아니면 401 응답. 쿠키 서명과 세션 판을 모두 본다 (미들웨어는 모양과 만료만 본다) */
export async function requireSession(req: Request): Promise<Response | null> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return Response.json({ error: "로그인이 필요합니다" }, { status: 401 });
  try {
    const session = await readSessionToken(token, await currentSessionKey());
    if (!session) return Response.json({ error: "로그인이 필요합니다" }, { status: 401 });
    let current = await sessionVersion();
    // 다른 서버에서 비밀번호를 막 바꿨으면 이 서버의 기억(60초)이 낡았을 수 있다 → 쿠키 판이 더 높으면 새로 읽어 본다
    if (session.version > current) current = await sessionVersion(true);
    if (session.version !== current) {
      return Response.json({ error: "비밀번호가 바뀌어 다시 로그인해야 합니다" }, { status: 401 });
    }
  } catch (err) {
    console.error("로그인 확인 실패", err);
    return Response.json({ error: "저장소에 연결하지 못했습니다. 잠시 뒤 다시 해 주세요" }, { status: 503 });
  }
  return null;
}

/** 로그인 제한에 걸렸을 때 보여 줄 말 */
export function loginBlockedMessage(gate: LoginGate): string {
  return gate.day >= LOGIN_LIMIT.day
    ? "오늘 비밀번호를 너무 많이 틀려 막았습니다. 내일 다시 해 주세요."
    : "비밀번호를 여러 번 틀려 잠시 막았습니다. 15분 뒤에 다시 해 주세요.";
}

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

export type AiConfig = { apiKey: string | null; keyBroken: boolean; keyTag: string | null; models: Record<Pass, string> };

/** 저장된 모델 고르기 (없거나 모르는 모델이면 기본값) */
export function pickModels(saved: unknown): Record<Pass, string> {
  const s = (saved ?? {}) as Partial<Record<Pass, unknown>>;
  return {
    page: isModel(s.page) ? s.page : modelFor("page"),
    figure: isModel(s.figure) ? s.figure : modelFor("figure"),
  };
}

/** 이 기기(브라우저)에 저장한 API 키(저장 창구가 풀어 준다)와 모델. 기기 표시가 없으면 키 없음 */
export async function aiConfig(req: Request): Promise<AiConfig> {
  const device = await deviceOf(req);
  const saved = device ? await getStore().getApiKey(device) : null;
  return {
    apiKey: saved?.key ?? null,
    keyBroken: !!saved?.broken,
    keyTag: saved?.tag ?? null,
    models: pickModels(saved?.models),
  };
}

/** AI 사용량을 월별 요금 기록에 넣는다 (열쇠별로 묶는 표시와 함께). 기록이 실패해도 읽기 결과는 돌려준다 */
export async function logUsage(kind: UsageRow["kind"], usage: Usage | undefined, docId: string | undefined, keyTag: string | null): Promise<void> {
  if (!usage) return;
  try {
    await getStore().addUsage({
      kind,
      model: usage.model,
      input: usage.input,
      output: usage.output,
      cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead,
      usd: usage.usd,
      docId,
      keyTag: keyTag ?? undefined,
    });
  } catch (err) {
    console.error("사용량 기록 실패", err);
  }
}
