// 1차 읽기: 시험지 한 쪽 사진 → 머리 표, 안내 상자, 문항, 그림 위치.
// 서버 전용 (Claude 를 부른다).

import { callClaude, modelFor, ReadError, type Effort, type Usage } from "./claude";
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
  o: { page: number; total: number; before?: string; model?: string; effort?: Effort; apiKey?: string; signal?: AbortSignal },
): Promise<{ reading: PageReading; usage: Usage; raw: string }> {
  const { text, usage } = await callClaude({
    system: PAGE_SYSTEM,
    model: modelFor("page", o.model),
    apiKey: o.apiKey,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
          { type: "text", text: pageUserText({ width: image.width, height: image.height, page: o.page, total: o.total, before: o.before }) },
        ],
      },
    ],
    effort: o.effort ?? PAGE_EFFORT,
    maxTokens: 32000,
    jsonSchema: pageReadingJsonSchema(),
    signal: o.signal,
  });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new ReadError("bad_answer", "AI 의 답을 읽지 못했습니다. 다시 시도해 주세요.", text.slice(0, 500));
    err.usage = usage;
    throw err;
  }
  const parsed = PageReadingS.safeParse(json);
  if (!parsed.success) {
    const err = new ReadError("bad_answer", "AI 의 답이 정해진 모양과 다릅니다. 다시 시도해 주세요.", parsed.error.message.slice(0, 500));
    err.usage = usage;
    throw err;
  }
  return { reading: parsed.data, usage, raw: text };
}

/** 다음 쪽을 읽을 때 알려 줄 앞 쪽의 끝 (이어지는 부분의 번호를 맞추려고) */
export function continuationHint(sectionTitle: string | undefined, lastNo: number | undefined): string | undefined {
  if (lastNo === undefined) return undefined;
  const title = sectionTitle ? `"${sectionTitle}" 부분의 ` : "";
  return `앞 쪽은 ${title}${lastNo}번 문항에서 끝났습니다.`;
}
