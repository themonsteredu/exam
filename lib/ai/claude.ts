// Claude 부르기 (서버 전용: 열쇠는 서버에만 있다. 화면 코드로 보내지 않는다).
// 모델은 쪽 읽기·그림 읽기마다 고를 수 있다: ANTHROPIC_MODEL_PAGE / ANTHROPIC_MODEL_FIGURE, 없으면 ANTHROPIC_MODEL (기본 claude-opus-5-5).
// 안전 검사로 거절되면 서버 쪽에서 다른 모델로 한 번 더 시도하게 한다 (fallbacks "default". Haiku 는 이 기능이 없어 보내지 않는다).

import Anthropic, { type APIError } from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const DEFAULT_MODEL = "claude-opus-5-5";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Pass = "page" | "figure";

/** 고를 수 있는 모델 (요청에서 모델을 바꿀 때도 이 가운데서만) */
export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5"] as const;
export type ModelId = (typeof MODELS)[number];

export function isModel(value: unknown): value is ModelId {
  return typeof value === "string" && (MODELS as readonly string[]).includes(value);
}

/** 이 단계(쪽 읽기·그림 읽기)에 쓸 모델 */
export function modelFor(pass: Pass, override?: string): string {
  if (override) return override;
  const env = pass === "page" ? process.env.ANTHROPIC_MODEL_PAGE : process.env.ANTHROPIC_MODEL_FIGURE;
  return env || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

/** 서버 쪽 대체 모델(fallbacks)을 받는 모델인지. Haiku 5.5 는 없다 (보내면 거절된 요청이 그대로 거절로 끝나거나 400) */
export function supportsFallback(model: string): boolean {
  return !model.startsWith("claude-haiku");
}

/** 읽기를 끝내지 못한 까닭. message 는 화면에 그대로 보여 줄 수 있는 말.
 *  usage: 실패했어도 AI 가 이미 쓴 토큰 (월별 요금 기록에 넣는다) */
export class ReadError extends Error {
  usage?: Usage;
  constructor(
    public code: "no_key" | "refusal" | "too_long" | "bad_answer" | "api" | "input" | "timeout",
    message: string,
    public detail?: string,
  ) {
    super(message);
  }
}

export type Usage = {
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** 대략의 요금 (미국 달러) */
  usd: number;
};

/** 100만 토큰당 요금(달러): 입력, 출력, 캐시 읽기 배율. 캐시 쓰기는 입력의 1.25배 */
const PRICES: [prefix: string, input: number, output: number, cacheRead: number][] = [
  ["claude-opus-5-5", 4, 20, 0.05],
  ["claude-opus-5", 5, 25, 0.1],
  ["claude-opus-4", 5, 25, 0.1],
  ["claude-sonnet-5-5", 2, 10, 0.05], // 캐시 읽기 $0.10 (공식 가격표)
  ["claude-sonnet-5", 2, 10, 0.1],
  ["claude-haiku-5", 0.1, 0.5, 0.1],
];

/** 요금 계산 (대략). Haiku 5.5 는 한 번에 보낸 입력이 10만 토큰을 넘으면 비싼 요금표를 쓴다 */
export function priceOf(model: string, t: { input: number; output: number; cacheWrite: number; cacheRead: number }): number {
  let [, pin, pout, cr] = PRICES.find(([prefix]) => model.startsWith(prefix)) ?? PRICES[0];
  if (model.startsWith("claude-haiku-5") && t.input + t.cacheWrite + t.cacheRead > 100_000) {
    pin = 0.5;
    pout = 2.5;
  }
  return (t.input * pin + t.cacheWrite * pin * 1.25 + t.cacheRead * pin * cr + t.output * pout) / 1_000_000;
}

type IterationUsage = {
  type: string;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

/**
 * 한 번 부른 값. 거절되어 다른 모델이 대신 답하면 맨 위 usage 에는 마지막 시도만 들어 있으므로,
 * 시도별 기록(usage.iterations)을 그 시도 모델의 요금으로 더한다.
 */
export function usageOf(message: BetaMessage, requestedModel = message.model): Usage {
  const u = message.usage;
  const iterations = (u as unknown as { iterations?: IterationUsage[] | null }).iterations;
  if (Array.isArray(iterations) && iterations.some((i) => i.type === "fallback_message")) {
    const total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    let usd = 0;
    for (const i of iterations) {
      const t = {
        input: i.input_tokens ?? 0,
        output: i.output_tokens ?? 0,
        cacheWrite: i.cache_creation_input_tokens ?? 0,
        cacheRead: i.cache_read_input_tokens ?? 0,
      };
      usd += priceOf(i.model || requestedModel, t);
      total.input += t.input;
      total.output += t.output;
      total.cacheWrite += t.cacheWrite;
      total.cacheRead += t.cacheRead;
    }
    return { model: `${requestedModel} → ${message.model}`, ...total, usd };
  }
  const t = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
  return { model: message.model, ...t, usd: priceOf(message.model, t) };
}

/** 중간에 멈춘 답의 어림 사용량: 입력은 처음에 받은 값, 출력은 받은 글자 수로 어림 (보이지 않는 생각은 셀 수 없어 실제보다 적다) */
function partialUsage(stream: { currentMessage?: BetaMessage } | undefined, model: string): Usage | undefined {
  let snap: BetaMessage | undefined;
  try {
    snap = stream?.currentMessage;
  } catch {
    return undefined;
  }
  if (!snap) return undefined;
  const u = snap.usage;
  const chars = snap.content.reduce((n, b) => n + (b.type === "text" ? b.text.length : b.type === "thinking" ? b.thinking.length : 0), 0);
  const t = {
    input: u?.input_tokens ?? 0,
    output: Math.max(u?.output_tokens ?? 0, Math.ceil(chars / 3)),
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
  };
  return { model, ...t, usd: priceOf(model, t) };
}

export function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return { ...b };
  return {
    model: a.model === b.model ? a.model : `${a.model}, ${b.model}`,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    usd: a.usd + b.usd,
  };
}

const clients = new Map<string, Anthropic>();

/** apiKey 를 주지 않으면 서버 환경변수 ANTHROPIC_API_KEY 를 쓴다 */
function getClient(apiKey?: string): Anthropic {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new ReadError("no_key", "AI 열쇠(API 키)가 없어 AI 읽기를 할 수 없습니다. 설정에서 열쇠를 넣어 주세요.");
  }
  let client = clients.get(key);
  if (!client) {
    // 주소는 공식 주소로 고정한다 (다른 프로그램이 ANTHROPIC_BASE_URL 을 바꿔 두었어도 열쇠가 다른 곳으로 가지 않게)
    client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com", maxRetries: 0, timeout: 15 * 60 * 1000 });
    clients.set(key, client);
  }
  return client;
}

export type CallResult = { message: BetaMessage; text: string; usage: Usage };

/** 진단에는 제공자의 오류 문구만 남긴다. 요청 본문·이미지·열쇠는 남기지 않는다. */
export function apiErrorDetail(err: APIError): string {
  const body = err.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const raw = body?.error?.message ?? body?.message ?? err.message;
  const message = String(raw)
    .replace(/sk-(?:ant-)?[A-Za-z0-9_-]+/g, "[API 키 숨김]")
    .replace(/Bearer\s+\S+/gi, "Bearer [숨김]")
    .replace(/data:image\/[^,\s]+,[A-Za-z0-9+/=]+/gi, "[이미지 숨김]")
    .replace(/[A-Za-z0-9+/=]{200,}/g, "[긴 데이터 숨김]")
    .slice(0, 800);
  const id = err.requestID && /^[\w-]+$/.test(err.requestID) ? ` · 요청 ID: ${err.requestID}` : "";
  return `Claude ${err.status ?? "API"}: ${message}${id}`;
}

function schemaRejected(err: unknown): err is APIError {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  const message = apiErrorDetail(err);
  return /grammar.{0,100}(?:too (?:large|complex)|compil|timed out)|schema.{0,100}(?:too complex|compil|not supported|unsupported|invalid)|(?:invalid|unsupported|not supported).{0,100}(?:schema|structured.?outputs?|output_config\.format)|(?:output_config\.format|structured.?outputs?).{0,100}(?:not supported|unsupported|invalid)/i.test(message);
}

/**
 * Claude 에게 한 번 묻는다. 길게 생각하고 길게 답할 수 있으므로 늘 스트리밍으로 받아 끝난 메시지를 쓴다.
 * jsonSchema의 기본은 구조화 출력. 복잡한 쪽 읽기는 jsonMode="validated"로
 * 스키마를 지시문에만 넣고, 호출자가 응답을 검사·복구한다. API 문법 컴파일은 사용하지 않는다.
 */
export async function callClaude(req: {
  system: string;
  messages: BetaMessageParam[];
  model: string;
  effort: Effort;
  maxTokens: number;
  jsonSchema?: Record<string, unknown>;
  jsonMode?: "strict" | "validated";
  apiKey?: string;
  signal?: AbortSignal;
  /** 이때(ms)까지 끝내야 한다 (서버 함수 시간 한도). 남은 시간에 맞춰 기다림과 다시 시도를 줄인다 */
  deadline?: number;
}): Promise<CallResult> {
  const anthropic = getClient(req.apiKey);
  const left = req.deadline ? req.deadline - Date.now() : undefined;
  if (left !== undefined && left < 15_000) {
    throw new ReadError("timeout", "시간이 모자라 AI 읽기를 시작하지 못했습니다. 다시 해 주세요.");
  }
  // SDK 의 timeout 은 응답 머리가 올 때까지만 잰다. 답을 흘려 받는 동안까지 재려고 전체 시간 제한을 따로 건다
  const overall = left !== undefined ? AbortSignal.timeout(left - 3_000) : undefined;
  const signal = overall ? (req.signal ? AbortSignal.any([req.signal, overall]) : overall) : req.signal;
  let stream: ReturnType<typeof anthropic.beta.messages.stream> | undefined;
  const fallback = supportsFallback(req.model);
  let message: BetaMessage;
  try {
    const ask = async (structured: boolean) => {
      const remaining = req.deadline ? req.deadline - Date.now() : undefined;
      if (remaining !== undefined && remaining < 15_000) throw new ReadError("timeout", "AI 읽기를 마칠 시간이 모자랍니다. 다시 해 주세요.");
      const system = !structured && req.jsonSchema
        ? `${req.system}\n\n다음 JSON 스키마를 따르는 JSON 객체 하나만 답한다. 설명이나 코드 블록은 넣지 않는다. 모든 필드를 채운다. 해당 내용이 없을 때만 필드 형식에 맞춰 빈 배열·빈 문자열·0·false를 쓴다. 인쇄된 문항·조건 상자·선택지·배치 정보를 임의로 생략하지 않는다.\n${JSON.stringify(req.jsonSchema)}`
        : req.system;
      // 복구 호출도 전체 마감 시각을 공유한다. 남은 시간이 짧으면 SDK의 재시도도 끈다.
      const limits = remaining !== undefined ? { timeout: remaining - 3_000, maxRetries: 0 } : {};
      stream = anthropic.beta.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          // 같은 지시문을 여러 번 보내므로 캐시해 둔다 (두 번째부터 입력 요금이 크게 준다)
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: req.messages,
          thinking: { type: "adaptive" },
          output_config: {
            effort: req.effort,
            ...(structured && req.jsonSchema ? { format: { type: "json_schema" as const, schema: req.jsonSchema } } : {}),
          },
          ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal, ...limits },
      );
      return stream.finalMessage();
    };
    try {
      message = await ask(req.jsonMode !== "validated");
    } catch (err) {
      // 스키마 문법을 컴파일하지 못한 400만 한 번 복구한다. 결제·인증·이미지 오류는 재호출하지 않는다.
      if (req.jsonMode === "validated" || !req.jsonSchema || !schemaRejected(err) || signal?.aborted) throw err;
      console.warn("AI 구조화 출력 요청 거절: 검증하는 JSON 읽기로 한 번 재시도", apiErrorDetail(err));
      message = await ask(false);
    }
  } catch (err) {
    if (overall?.aborted && !req.signal?.aborted) {
      const timeout = new ReadError("timeout", "AI 가 너무 오래 걸려 이번 읽기를 멈췄습니다. 잠시 뒤 다시 해 주세요.");
      // 멈추기 전까지 만든 답에도 요금이 든다 → 받은 만큼으로 어림해 기록에 남긴다
      timeout.usage = partialUsage(stream, req.model);
      throw timeout;
    }
    const explained = explainApiError(err);
    explained.usage ??= partialUsage(stream, req.model);
    throw explained;
  }
  const usage = usageOf(message, req.model);
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    const err = new ReadError("refusal", "AI 가 이 요청을 처리하지 않았습니다 (안전 검사에 걸림). 사진을 바꾸거나 다시 시도해 주세요.", category ?? undefined);
    err.usage = usage;
    throw err;
  }
  if (message.stop_reason === "max_tokens") {
    const err = new ReadError("too_long", "AI 의 답이 너무 길어 중간에 끊겼습니다. 사진을 나눠서 다시 읽어 주세요.");
    err.usage = usage;
    throw err;
  }
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { message, text, usage };
}

/** 앞서 받은 답을 대화에 다시 넣을 때 (생각 블록까지 그대로 돌려줘야 한다) */
export function assistantTurn(message: BetaMessage): BetaMessageParam {
  return { role: "assistant", content: message.content as unknown as BetaContentBlockParam[] };
}

/** API 오류를 화면에 보여 줄 말로 바꾼다 */
export function explainApiError(err: unknown): ReadError {
  if (err instanceof ReadError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ReadError("api", "읽기를 멈췄습니다.");
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ReadError("timeout", "AI 가 너무 오래 걸려 이번 읽기를 멈췄습니다. 잠시 뒤 다시 해 주세요.", apiErrorDetail(err));
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new ReadError("api", "AI 열쇠(ANTHROPIC_API_KEY)가 맞지 않습니다. 열쇠를 다시 확인해 주세요.", apiErrorDetail(err));
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ReadError("api", "이 AI 열쇠로는 이 모델을 쓸 수 없습니다.", apiErrorDetail(err));
  }
  if (err instanceof Anthropic.RateLimitError) {
    const body = JSON.stringify(err.error ?? {});
    if (body.includes("enforced_spend_limit_reached")) {
      return new ReadError("api", "이번 달 AI 사용 한도에 닿았습니다. Claude 콘솔의 결제(Billing) 화면에서 한도를 확인해 주세요.", apiErrorDetail(err));
    }
    return new ReadError("api", "AI 를 너무 자주 불러 잠시 막혔습니다. 1분쯤 뒤에 다시 해 주세요.", apiErrorDetail(err));
  }
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.message || "";
    const detail = apiErrorDetail(err);
    if (/credit balance/i.test(msg)) {
      return new ReadError("api", "AI 사용 금액(크레딧)이 모자랍니다. Claude 콘솔의 결제(Billing) 화면에서 충전해 주세요.", detail);
    }
    if (/usage limits/i.test(msg)) {
      return new ReadError("api", "직접 정해 둔 AI 사용 한도에 닿았습니다. Claude 콘솔의 결제(Billing) 화면에서 한도를 올려 주세요.", detail);
    }
    if (schemaRejected(err)) return new ReadError("api", "AI가 시험지 배치 정보의 요청 형식을 처리하지 못했습니다. 오류 상세를 확인해 주세요.", detail);
    if (/max_tokens|effort|thinking|fallbacks|anthropic-beta/i.test(detail)) return new ReadError("api", "선택한 AI 모델이 요청 옵션을 받지 못했습니다. 오류 상세를 확인해 주세요.", detail);
    if (/image|base64|media_type/i.test(detail)) return new ReadError("api", "AI가 보낸 이미지를 읽지 못했습니다. 오류 상세를 확인해 주세요.", detail);
    return new ReadError("api", "AI가 요청 형식을 거절했습니다. 오류 상세에서 사유를 확인해 주세요.", detail);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ReadError("api", "AI 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 해 주세요.", apiErrorDetail(err));
  }
  if (err instanceof Anthropic.APIError) {
    return new ReadError("api", `AI 서버에서 오류가 났습니다 (${err.status ?? "?"}). 잠시 뒤 다시 해 주세요.`, apiErrorDetail(err));
  }
  return new ReadError("api", "AI 읽기 중 알 수 없는 오류가 났습니다.", err instanceof Error ? err.message : String(err));
}

/** 답 글에서 JSON 객체를 꺼낸다 (코드 블록 표시나 앞뒤 설명이 붙어 와도) */
export function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("답에서 JSON 을 찾지 못했습니다");
  const body = s.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch (err) {
    // 흔한 실수: 닫는 괄호 앞의 쉼표
    try {
      return JSON.parse(body.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      throw new Error(`JSON 으로 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

