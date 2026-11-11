// 1차 읽기: 시험지 한 쪽 사진 → 머리 표, 안내 상자, 문항, 그림 위치.
// 서버 전용 (설정에서 고른 AI를 부른다).

import { callAI, assistantTurn, type AITurn } from "./client";
import { addUsage, extractJson, modelFor, ReadError, type Effort, type Usage } from "./claude";
import { PageReadingS, pageReadingJsonSchema, type PageReading } from "./page-schema";
import { PAGE_SYSTEM, pageUserText } from "./prompts";

export type ImageInput = {
  /** base64 글자 (data: 머리말 없이) */
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  width: number;
  height: number;
};

export const PAGE_EFFORT: Effort = "medium";

export async function readPage(
  image: ImageInput,
  o: { page: number; total: number; before?: string; model?: string; effort?: Effort; apiKey?: string; signal?: AbortSignal; deadline?: number },
): Promise<{ reading: PageReading; usage: Usage; raw: string }> {
  const messages: AITurn[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        { type: "text", text: pageUserText({ width: image.width, height: image.height, page: o.page, total: o.total, before: o.before }) },
      ],
    },
  ];
  const model = modelFor("page", o.model);
  const jsonSchema = pageReadingJsonSchema();
  let usage: Usage | undefined;
  let issue = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let call;
    try {
      call = await callAI({
        system: PAGE_SYSTEM,
        model,
        apiKey: o.apiKey,
        messages,
        effort: o.effort ?? PAGE_EFFORT,
        maxTokens: 32000,
        // 구조화 출력: 답이 꼭 정해진 모양이 되게 한다 (API 가 이 모양을 받지 못하면 callAI 가 지시문 방식으로 한 번 다시 묻는다)
        jsonSchema,
        signal: o.signal,
        deadline: o.deadline,
      });
    } catch (err) {
      if (err instanceof ReadError && usage) err.usage = err.usage ? addUsage(usage, err.usage) : usage;
      throw err;
    }
    usage = addUsage(usage, call.usage);
    try {
      const parsed = PageReadingS.safeParse(extractJson(call.text));
      if (parsed.success) return { reading: parsed.data, usage, raw: call.text };
      issue = parsed.error.message.slice(0, 2000);
    } catch (err) {
      issue = err instanceof Error ? err.message : String(err);
    }
    if (attempt === 2 || o.signal?.aborted || (o.deadline && o.deadline - Date.now() < 120_000)) break;
    messages.push(assistantTurn(call.message), {
      role: "user",
      content: `답을 검사하니 다음 오류가 있습니다. 같은 사진의 인쇄 내용으로 전체 JSON 을 한 번 더 보내 주세요. 문항·선택지를 빠뜨리지 말고 정해진 모양을 지켜 주세요. 설명이나 코드 블록 없이 JSON 하나만 답합니다.\n${issue.slice(0, 2000)}`,
    });
  }
  const err = new ReadError("bad_answer", "AI 의 답이 정해진 모양과 달라 문항을 확인하지 못했습니다. 다시 시도해 주세요.", issue.slice(0, 500));
  err.usage = usage;
  throw err;
}

/** 다음 쪽을 읽을 때 알려 줄 앞 쪽의 끝 (이어지는 부분의 번호를 맞추려고) */
export function continuationHint(sectionTitle: string | undefined, lastNo: number | undefined): string | undefined {
  if (lastNo === undefined) return undefined;
  const title = sectionTitle ? `"${sectionTitle}" 부분의 ` : "";
  return `앞 쪽은 ${title}${lastNo}번 문항에서 끝났습니다.`;
}
