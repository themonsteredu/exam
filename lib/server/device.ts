// 기기(브라우저) 표시: 쿠키 exam_device 에 무작위 값(32바이트)을 둔다. 미들웨어가 처음 온 브라우저에 붙여 준다.
// AI 열쇠와 모델은 기기마다 따로 저장한다 (여러 사람이 같은 프로그램을 쓰되 AI 요금은 각자 자기 열쇠로).
// 저장 창구에는 쿠키 값이 아니라 그 SHA-256 만 보낸다 (저장소에 쿠키 값이 남지 않게).
// Web Crypto 만 써서 미들웨어(Edge)와 서버 주소(Node) 양쪽에서 돈다.
import { b64url, cookieValue } from "./session";

export const DEVICE_COOKIE = "exam_device";
/** 브라우저가 허락하는 가장 긴 쿠키 기간 (400일). 쓸 때마다 늘리지는 않는다 */
export const DEVICE_MAX_AGE = 400 * 24 * 3600;

export function isDeviceId(v: string | undefined | null): v is string {
  return !!v && /^[A-Za-z0-9_-]{43}$/.test(v);
}

export function newDeviceId(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 저장 창구에 보낼 기기 값: SHA-256 16진수 64자 */
export async function deviceTag(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`exam-device:${id}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 요청의 기기 표시 → 저장 창구에 보낼 값. 없거나 모양이 틀리면 null */
export async function deviceOf(req: Request): Promise<string | null> {
  const id = cookieValue(req, DEVICE_COOKIE);
  return isDeviceId(id) ? deviceTag(id) : null;
}
