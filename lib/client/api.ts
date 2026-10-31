// 화면에서 서버 주소를 부르는 도우미. 로그인이 풀렸으면 로그인 화면으로 보낸다.

export class ApiError extends Error {
  constructor(message: string, public status: number, public detail?: string, public usage?: { usd: number }) {
    super(message);
  }
}

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch (err) {
    if (init.signal?.aborted) throw new ApiError("멈췄습니다.", 0);
    throw new ApiError(`서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. (${err instanceof Error ? err.message : err})`, 0);
  }
  const text = await res.text();
  let body: { error?: string; detail?: string } & Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* JSON 이 아닌 답 */
  }
  if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth/")) {
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `/login?next=${next}`;
  }
  if (!res.ok) {
    const usage = body.usage as { usd?: unknown } | undefined;
    throw new ApiError(body.error || `서버 오류가 났습니다 (${res.status}).`, res.status, typeof body.detail === "string" ? body.detail : undefined,
      typeof usage?.usd === "number" && Number.isFinite(usage.usd) ? { usd: usage.usd } : undefined);
  }
  return body as T;
}

export function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return api<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
}

export function patchJson<T>(url: string, body: unknown): Promise<T> {
  return api<T>(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export type FileRef = { path: string; name: string; size: number; type: string };

/** 파일을 보관함에 올린다 (서버가 준 서명 주소로 Supabase 에 바로 올린다) */
export async function uploadFile(docId: string, kind: "original" | "generated", file: Blob, name: string, index = 0, signal?: AbortSignal): Promise<FileRef> {
  const type = file.type || "application/octet-stream";
  const signed = await postJson<{ path: string; url: string; headers: Record<string, string> }>(
    "/api/files/upload-url",
    { docId, kind, name, type, size: file.size, index },
    signal,
  );
  let res: Response;
  try {
    res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: file, signal });
  } catch {
    throw new ApiError("파일을 보관함에 올리지 못했습니다. 인터넷 연결을 확인해 주세요.", 0);
  }
  if (!res.ok) throw new ApiError(`파일을 보관함에 올리지 못했습니다 (${res.status}).`, res.status);
  return { path: signed.path, name, size: file.size, type };
}

/** 보관함 파일 내려받기 (60초짜리 주소를 받아 바로 연다) */
export async function downloadStored(path: string, name: string): Promise<void> {
  const { url } = await postJson<{ url: string }>("/api/files/download-url", { path, name });
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 브라우저에 있는 파일 내려받기 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const won = (usd: number, rate = 1400) => `${Math.round(usd * rate).toLocaleString("ko-KR")}원`;

