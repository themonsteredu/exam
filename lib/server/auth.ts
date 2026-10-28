// 서버 주소에서 쓰는 로그인 확인과 설정 읽기.

import { isModel, modelFor, type Pass, type Usage } from "@/lib/ai/claude";
import { openApiKey } from "./secrets";
import { readSessionToken, SESSION_COOKIE } from "./session";
import { getStore, LOGIN_LIMIT, type LoginGate, type UsageRow } from "./store";

let cachedVersion: { value: number; at: number } | null = null;

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

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** 로그인되어 있으면 null, 아니면 401 응답 */
export async function requireSession(req: Request): Promise<Response | null> {
  const session = await readSessionToken(cookieValue(req, SESSION_COOKIE));
  if (!session) return Response.json({ error: "로그인이 필요합니다" }, { status: 401 });
  try {
    if (session.version !== (await sessionVersion())) {
      return Response.json({ error: "비밀번호가 바뀌어 다시 로그인해야 합니다" }, { status: 401 });
    }
  } catch {
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

export function isHttps(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return new URL(req.url).protocol === "https:";
}

export type AiConfig = { apiKey: string | null; keyBroken: boolean; models: Record<Pass, string> };

/** 설정에 저장한 API 키(풀어서)와 모델 */
export async function aiConfig(): Promise<AiConfig> {
  const s = await getStore().getSettings(["anthropic_key", "models"]);
  const apiKey = s.anthropic_key ? openApiKey(s.anthropic_key) : null;
  const saved = (s.models ?? {}) as Partial<Record<Pass, unknown>>;
  return {
    apiKey,
    keyBroken: !!s.anthropic_key && !apiKey,
    models: {
      page: isModel(saved.page) ? saved.page : modelFor("page"),
      figure: isModel(saved.figure) ? saved.figure : modelFor("figure"),
    },
  };
}

/** AI 사용량을 월별 요금 기록에 넣는다. 기록이 실패해도 읽기 결과는 돌려준다 */
export async function logUsage(kind: UsageRow["kind"], usage: Usage | undefined, docId?: string): Promise<void> {
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
    });
  } catch (err) {
    console.error("사용량 기록 실패", err);
  }
}
