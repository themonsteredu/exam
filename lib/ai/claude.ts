// Claude 부르기 (서버 전용: 열쇠는 서버에만 있다. 화면 코드로 보내지 않는다).
// 모델은 쪽 읽기·그림 읽기마다 고를 수 있다: ANTHROPIC_MODEL_PAGE / ANTHROPIC_MODEL_FIGURE, 없으면 ANTHROPIC_MODEL (기본 claude-opus-5-5).
// 안전 검사로 거절되면 서버 쪽에서 다른 모델로 한 번 더 시도하게 한다 (fallbacks "default". Haiku 는 이 기능이 없어 보내지 않는다).

import Anthropic from "@anthropic-ai/sdk";
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
    public code: "no_key" | "refusal" | "too_long" | "bad_answer" | "api" | "input",
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
    client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com", maxRetries: 3, timeout: 15 * 60 * 1000 });
    clients.set(key, client);
  }
  return client;
}

export type CallResult = { message: BetaMessage; text: string; usage: Usage };

/**
 * Claude 에게 한 번 묻는다. 길게 생각하고 길게 답할 수 있으므로 늘 스트리밍으로 받아 끝난 메시지를 쓴다.
 * jsonSchema 를 주면 답이 꼭 그 모양이 되게 한다(구조화 출력).
 */
export async function callClaude(req: {
  system: string;
  messages: BetaMessageParam[];
  model: string;
  effort: Effort;
  maxTokens: number;
  jsonSchema?: Record<string, unknown>;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<CallResult> {
  const anthropic = getClient(req.apiKey);
  const fallback = supportsFallback(req.model);
  let message: BetaMessage;
  try {
    const stream = anthropic.beta.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        // 같은 지시문을 여러 번 보내므로 캐시해 둔다 (두 번째부터 입력 요금이 크게 준다)
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: req.messages,
        thinking: { type: "adaptive" },
        output_config: {
          effort: req.effort,
          ...(req.jsonSchema ? { format: { type: "json_schema" as const, schema: req.jsonSchema } } : {}),
        },
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: req.signal },
    );
    message = await stream.finalMessage();
  } catch (err) {
    throw explainApiError(err);
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
  if (err instanceof Anthropic.AuthenticationError) {
    return new ReadError("api", "AI 열쇠(ANTHROPIC_API_KEY)가 맞지 않습니다. 열쇠를 다시 확인해 주세요.", err.message);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ReadError("api", "이 AI 열쇠로는 이 모델을 쓸 수 없습니다.", err.message);
  }
  if (err instanceof Anthropic.RateLimitError) {
    const body = JSON.stringify(err.error ?? {});
    if (body.includes("enforced_spend_limit_reached")) {
      return new ReadError("api", "이번 달 AI 사용 한도에 닿았습니다. Claude 콘솔의 결제(Billing) 화면에서 한도를 확인해 주세요.", err.message);
    }
    return new ReadError("api", "AI 를 너무 자주 불러 잠시 막혔습니다. 1분쯤 뒤에 다시 해 주세요.", err.message);
  }
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.message || "";
    if (/credit balance/i.test(msg)) {
      return new ReadError("api", "AI 사용 금액(크레딧)이 모자랍니다. Claude 콘솔의 결제(Billing) 화면에서 충전해 주세요.", msg);
    }
    if (/usage limits/i.test(msg)) {
      return new ReadError("api", "직접 정해 둔 AI 사용 한도에 닿았습니다. Claude 콘솔의 결제(Billing) 화면에서 한도를 올려 주세요.", msg);
    }
    return new ReadError("api", "AI 에게 보낸 요청에 문제가 있습니다.", msg);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ReadError("api", "AI 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 해 주세요.", err.message);
  }
  if (err instanceof Anthropic.APIError) {
    return new ReadError("api", `AI 서버에서 오류가 났습니다 (${err.status ?? "?"}). 잠시 뒤 다시 해 주세요.`, err.message);
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
