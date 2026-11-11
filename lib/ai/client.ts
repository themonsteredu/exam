import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { assistantTurn as claudeTurn, callClaude, ReadError, type Usage } from "./claude";
import { providerFor } from "./models";
import { callOpenAI, type OpenAIResponse } from "./openai";

export type AITurn = BetaMessageParam | { provider: "openai"; response: OpenAIResponse };
export type AIMessage = { provider: "anthropic"; response: BetaMessage } | { provider: "openai"; response: OpenAIResponse };
export type AIRequest = Omit<Parameters<typeof callClaude>[0], "messages"> & { messages: AITurn[] };
export type AIResult = { message: AIMessage; text: string; usage: Usage };

export async function callAI(request: AIRequest): Promise<AIResult> {
  if (providerFor(request.model) === "openai") return callOpenAI(request);
  const messages = request.messages.map((turn) => {
    if ("provider" in turn) throw new ReadError("input", "AI 모델이 바뀌었습니다. 이 문항을 처음부터 다시 읽어 주세요.");
    return turn;
  });
  const result = await callClaude({ ...request, messages });
  return { ...result, message: { provider: "anthropic", response: result.message } };
}

export function assistantTurn(message: AIMessage): AITurn {
  return message.provider === "anthropic" ? claudeTurn(message.response) : message;
}
