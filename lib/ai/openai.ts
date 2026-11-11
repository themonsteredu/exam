// Server-side Responses API integration. The caller supplies the key belonging to this browser.
import { ReadError, type Usage } from "./claude";
import { OPENAI_PRICES } from "./models";
import type { AIRequest, AIResult, AITurn } from "./client";

type OutputItem = { type: string; content?: { type: string; text?: string; refusal?: string }[]; [key: string]: unknown };
export type OpenAIResponse = {
  id: string;
  model: string;
  status: string;
  output: OutputItem[];
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  } | null;
};

class OpenAIRequestError extends ReadError {
  constructor(public status: number, public apiCode: string, message: string, detail: string) {
    super("api", message, detail);
  }
}

export function openAIErrorDetail(status: number, message: string, requestId: string | null): string {
  const safe = message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[API 키 숨김]")
    .replace(/Bearer\s+\S+/gi, "Bearer [숨김]")
    .replace(/data:image\/[^,\s]+,[A-Za-z0-9+/=]+/gi, "[이미지 숨김]")
    .replace(/[A-Za-z0-9+/=]{200,}/g, "[긴 데이터 숨김]")
    .slice(0, 800);
  const id = requestId && /^[\w-]+$/.test(requestId) ? ` · 요청 ID ${requestId}` : "";
  return `OpenAI ${status}: ${safe}${id}`;
}

export function openAIUsage(response: OpenAIResponse, requestedModel = response.model): Usage {
  const rates = OPENAI_PRICES[requestedModel as keyof typeof OPENAI_PRICES];
  if (!rates) throw new ReadError("input", "설정에서 지원하는 GPT 모델을 골라 주세요.");
  const total = Math.max(0, response.usage?.input_tokens ?? 0);
  const cacheRead = Math.min(total, Math.max(0, response.usage?.input_tokens_details?.cached_tokens ?? 0));
  const cacheWrite = Math.min(total - cacheRead, Math.max(0, response.usage?.input_tokens_details?.cache_write_tokens ?? 0));
  const input = total - cacheRead - cacheWrite;
  const output = Math.max(0, response.usage?.output_tokens ?? 0);
  const longContext = total > 272_000;
  const inputCost = ((input + cacheWrite * 1.25) * rates.input + cacheRead * rates.cachedInput) * (longContext ? 2 : 1);
  const outputCost = output * rates.output * (longContext ? 1.5 : 1);
  return { model: response.model || requestedModel, input, output, cacheRead, cacheWrite, usd: (inputCost + outputCost) / 1_000_000 };
}

function inputTurns(turns: AITurn[]): Record<string, unknown>[] {
  return turns.flatMap<Record<string, unknown>>((turn) => {
    if ("provider" in turn) return turn.response.output;
    if (typeof turn.content === "string") return [{ role: turn.role, content: turn.content }];
    const content = turn.content.map((block) => {
      if (block.type === "text") return { type: "input_text", text: block.text };
      if (block.type === "image" && block.source.type === "base64") {
        return { type: "input_image", image_url: `data:${block.source.media_type};base64,${block.source.data}`, detail: "original" };
      }
      throw new ReadError("input", "GPT에 보낼 사진과 글의 형식을 확인해 주세요.");
    });
    return [{ role: turn.role, content }];
  });
}

function requestBody(request: AIRequest, structured: boolean): Record<string, unknown> {
  const system = !structured && request.jsonSchema
    ? `${request.system}\n\n다음 JSON 스키마에 맞는 JSON 객체 하나로 답한다. 인쇄 내용과 모든 필드를 정확히 옮긴다.\n${JSON.stringify(request.jsonSchema)}`
    : request.system;
  const previous = request.messages.filter((turn): turn is Extract<AITurn, { provider: "openai" }> => "provider" in turn).at(-1);
  return {
    model: request.model,
    store: false,
    stream: true,
    service_tier: "default",
    reasoning: { effort: request.effort, context: "all_turns" },
    include: ["reasoning.encrypted_content"],
    max_output_tokens: request.maxTokens,
    prompt_cache_options: { mode: "explicit", ttl: "30m", ...(previous ? { comparison_response_id: previous.response.id } : {}) },
    input: [
      { role: "developer", content: [{ type: "input_text", text: system, prompt_cache_breakpoint: { mode: "explicit" } }] },
      ...inputTurns(request.messages),
    ],
    text: {
      format: structured && request.jsonSchema
        ? { type: "json_schema", name: "exam_reading", schema: request.jsonSchema, strict: true }
        : { type: "json_object" },
    },
  };
}

async function responseError(response: Response): Promise<OpenAIRequestError> {
  const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
  const code = body.error?.code ?? "";
  let message = "GPT 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
  if (response.status === 401) message = "GPT API 키를 확인해 주세요. 설정에서 다시 등록할 수 있습니다.";
  if (response.status === 403 || response.status === 404) message = "이 OpenAI 계정에서 선택한 모델을 사용할 수 있는지 확인해 주세요.";
  if (response.status === 429) message = "GPT 요청이 몰렸습니다. 잠시 뒤 다시 시도해 주세요.";
  if (code === "insufficient_quota" || code === "billing_hard_limit_reached") message = "OpenAI API 잔액과 사용 한도를 확인해 주세요.";
  return new OpenAIRequestError(response.status, code, message,
    openAIErrorDetail(response.status, body.error?.message ?? response.statusText, response.headers.get("x-request-id")));
}

type StreamState = { response?: OpenAIResponse; characters: number };

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

async function readStream(response: Response, state: StreamState): Promise<OpenAIResponse> {
  if (!response.body) throw new ReadError("bad_answer", "GPT 응답이 비어 있습니다. 다시 읽어 주세요.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      if (chunk.done && buffer.trim()) blocks.push(buffer);
      for (const block of blocks) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data) as { type: string; response?: OpenAIResponse; delta?: string; message?: string };
        if (event.response) state.response = event.response;
        if (event.type === "response.output_text.delta") state.characters += event.delta?.length ?? 0;
        if (["response.completed", "response.incomplete", "response.failed"].includes(event.type) && event.response) return event.response;
        if (event.type === "error") throw new ReadError("api", "GPT 응답을 받는 중 오류가 났습니다.", openAIErrorDetail(502, event.message ?? "stream error", response.headers.get("x-request-id")));
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  throw new ReadError("bad_answer", "GPT 응답이 끝나기 전에 연결이 끊겼습니다. 다시 읽어 주세요.");
}

export async function callOpenAI(request: AIRequest): Promise<AIResult> {
  const key = request.apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new ReadError("no_key", "설정에서 GPT API 키를 등록해 주세요.");
  if (!(request.model in OPENAI_PRICES)) throw new ReadError("input", "설정에서 지원하는 GPT 모델을 골라 주세요.");
  const remaining = request.deadline ? request.deadline - Date.now() : 15 * 60_000;
  if (remaining < 15_000) throw new ReadError("timeout", "GPT 읽기를 마칠 시간이 부족합니다. 다시 시도해 주세요.");
  const timeout = AbortSignal.timeout(remaining - 3_000);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const state: StreamState = { characters: 0 };
  const ask = async (structured: boolean): Promise<OpenAIResponse> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      if (request.deadline && request.deadline - Date.now() < 15_000) throw new ReadError("timeout", "GPT 읽기를 마칠 시간이 부족합니다. 다시 시도해 주세요.");
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody(request, structured)),
        signal,
      });
      if (response.ok) return readStream(response, state);
      const error = await responseError(response);
      const transient = response.status === 429 || response.status >= 500;
      const quota = ["insufficient_quota", "billing_hard_limit_reached"].includes(error.apiCode);
      const enoughTime = !request.deadline || request.deadline - Date.now() > 150_000;
      if (attempt === 0 && transient && !quota && enoughTime) {
        const wait = Math.min(5_000, Math.max(200, Number(response.headers.get("retry-after") ?? 1) * 1_000 || 1_000));
        await retryDelay(wait, signal);
        continue;
      }
      throw error;
    }
    throw new ReadError("api", "GPT에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  };
  let response: OpenAIResponse;
  try {
    try {
      response = await ask(request.jsonMode !== "validated");
    } catch (error) {
      const schemaError = error instanceof OpenAIRequestError && error.status === 400 && /(?:schema|text\.format|json_schema)/i.test(error.detail ?? "");
      if (!schemaError || !request.jsonSchema || request.jsonMode === "validated" || signal.aborted) throw error;
      response = await ask(false);
    }
  } catch (error) {
    const explained = signal.aborted
      ? new ReadError(request.signal?.aborted ? "api" : "timeout", request.signal?.aborted ? "읽기를 중지했습니다." : "GPT 읽기 시간이 길어져 중지했습니다. 잠시 뒤 다시 시도해 주세요.")
      : error instanceof ReadError ? error : new ReadError("api", "GPT 응답을 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    if (state.response || state.characters) {
      const partial = state.response ?? { id: "", model: request.model, status: "in_progress", output: [] };
      explained.usage = openAIUsage({ ...partial, usage: { ...partial.usage, input_tokens: partial.usage?.input_tokens ?? 0, output_tokens: Math.max(partial.usage?.output_tokens ?? 0, Math.ceil(state.characters / 3)) } }, request.model);
    }
    throw explained;
  }
  const usage = openAIUsage(response, request.model);
  const refusal = response.output?.some((item) => item.content?.some((part) => part.type === "refusal"));
  let failure: ReadError | undefined;
  if (refusal || response.incomplete_details?.reason === "content_filter") failure = new ReadError("refusal", "GPT가 이 사진을 처리하지 못했습니다. 원본을 확인하고 다시 읽어 주세요.");
  else if (response.status === "incomplete") failure = new ReadError("too_long", "GPT 답이 길어 중간에 끝났습니다. 문항을 나누어 다시 읽어 주세요.");
  else if (response.status !== "completed") failure = new ReadError("api", "GPT가 읽기를 마치지 못했습니다.", openAIErrorDetail(502, response.error?.message ?? response.status, null));
  const text = (response.output ?? []).flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
  if (!failure && !text.trim()) failure = new ReadError("bad_answer", "GPT 답이 비어 있습니다. 다시 읽어 주세요.");
  if (failure) { failure.usage = usage; throw failure; }
  return { message: { provider: "openai", response }, text, usage };
}
