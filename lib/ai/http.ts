// AI 읽기 서버 주소(app/api/read/*)가 같이 쓰는 도우미: 받은 사진 확인, 오류 답.

import { ReadError } from "./claude";
import { imageSizeFromBytes, MAX_EDGE, MAX_PIXELS } from "./image-geometry";
import type { ImageInput } from "./read-page";

/** data:image/…;base64,… 또는 base64 글자 → AI 에게 보낼 사진. 크기가 맞지 않으면 까닭을 돌려준다 */
export function parseImage(value: unknown): ImageInput | { error: string } {
  if (typeof value !== "string" || !value) return { error: "사진이 없습니다" };
  const data = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(data, "base64"));
  } catch {
    return { error: "사진을 읽지 못했습니다" };
  }
  const info = imageSizeFromBytes(bytes);
  if (!info) return { error: "PNG, JPEG, WEBP, GIF 사진만 읽을 수 있습니다" };
  if (Math.max(info.width, info.height) > MAX_EDGE || info.width * info.height > MAX_PIXELS) {
    return { error: `사진이 너무 큽니다 (${info.width}×${info.height}). 화면에서 줄여 보내야 합니다` };
  }
  return { data, mediaType: info.type, width: info.width, height: info.height };
}

export function fail(status: number, message: string, detail?: string): Response {
  return Response.json({ error: message, ...(detail ? { detail } : {}) }, { status });
}

const STATUS: Record<ReadError["code"], number> = {
  no_key: 503,
  input: 400,
  refusal: 422,
  too_long: 422,
  bad_answer: 502,
  api: 502,
  timeout: 504,
};

export function failFrom(err: unknown): Response {
  if (err instanceof ReadError) {
    if (err.code === "api") console.error("AI 요청 실패", { code: err.code, message: err.message, detail: err.detail });
    return fail(STATUS[err.code], err.message, err.detail);
  }
  return fail(500, "AI 읽기 중 알 수 없는 오류가 났습니다", err instanceof Error ? err.message : String(err));
}
