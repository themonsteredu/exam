// 옆으로 누운 쪽의 방향 묻기: 작은 쪽 사진(긴 변 1024px) → 바로 읽으려면 시계 방향으로 몇 도 돌려야 하는지 (0·90·180·270).
// 칸 다수결(lib/ai/orientation voteTextDirection)로 글자가 세로로 누운 쪽만 묻는다 (쪽당 1원 남짓). 서버 전용.
import { extractJson, modelFor, type Usage } from "./claude";
import { callAI } from "./client";
import type { ImageInput } from "./read-page";

export const ORIENT_SYSTEM = `너는 시험지 한 쪽을 스캔하거나 찍은 사진의 방향만 본다.
글자를 바로 읽으려면 사진을 시계 방향으로 몇 도 돌려야 하는지 0, 90, 180, 270 가운데 하나로 답한다.
- 0: 이미 바로 서 있음
- 90: 글자가 아래에서 위로 쓰여 있음 (사진 왼쪽이 시험지 위쪽)
- 270: 글자가 위에서 아래로 쓰여 있음 (사진 오른쪽이 시험지 위쪽)
- 180: 거꾸로 뒤집혀 있음
시험지 제목·문항 번호(1. 2. …)·선택지 번호(①②…)가 바로 읽히는 방향을 기준으로 한다. 손글씨는 보지 않는다.
답은 JSON 하나만: {"rotate": 90}`;

export async function readOrientation(
  image: ImageInput,
  o: { model?: string; apiKey?: string; signal?: AbortSignal; deadline?: number } = {},
): Promise<{ rotate: 0 | 90 | 180 | 270 | null; usage: Usage }> {
  const call = await callAI({
    system: ORIENT_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
          { type: "text", text: "이 쪽을 바로 읽으려면 시계 방향으로 몇 도 돌려야 합니까? JSON 으로만 답하세요." },
        ],
      },
    ],
    model: modelFor("page", o.model),
    effort: "low",
    maxTokens: 2000,
    apiKey: o.apiKey,
    signal: o.signal,
    deadline: o.deadline,
  });
  // 답을 읽지 못하면 null (화면은 돌리지 않고, 방향을 확인하지 못한 쪽으로 둔다)
  let rotate: 0 | 90 | 180 | 270 | null = null;
  try {
    const value = Number((extractJson(call.text) as { rotate?: unknown })?.rotate);
    if (value === 0 || value === 90 || value === 180 || value === 270) rotate = value;
  } catch {
    rotate = null;
  }
  return { rotate, usage: call.usage };
}
