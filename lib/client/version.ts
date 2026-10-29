// 이 화면을 연 뒤에 프로그램이 새 판으로 바뀌었는지 본다.
// 브라우저는 화면을 새로 고치기 전까지 처음 받은 판을 계속 쓴다. 그 상태로 시험지를 만들면 고친 내용이 빠진 채 AI 요금이 든다
// (2026-10-29: 스캔 PDF 를 고친 뒤에도 열어 둔 창에서 다시 만들어 같은 결과가 나왔다).
import { api, ApiError } from "./api";

export const STALE_MESSAGE = "프로그램이 새 판으로 바뀌었습니다. 화면을 새로 고친 뒤(F5 또는 새로 고침) 파일을 다시 골라 주세요.";

const MINE = process.env.NEXT_PUBLIC_APP_VERSION || "";

/** 서버의 판이 이 화면과 다르면 true. 판 표시가 없거나(이 작업 환경) 확인하지 못하면 false */
export async function isStale(): Promise<boolean> {
  if (!MINE) return false;
  try {
    const { version } = await api<{ version: string }>("/api/version");
    return !!version && version !== MINE;
  } catch {
    return false;
  }
}

/** 예전 판이면 멈춘다 (AI 요금이 들기 전에 부른다) */
export async function assertFresh(): Promise<void> {
  if (await isStale()) throw new ApiError(STALE_MESSAGE, 409);
}
