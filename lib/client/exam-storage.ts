// 큰 시험지 데이터는 작은 조각으로 보관한다. AI를 다시 부르지 않고 출력만 재시도할 수 있다.
import { ApiError, patchJson, postJson, uploadFile } from "./api";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const EXAM_PART_BYTES = 4_000_000;
export const MAX_EXAM_PARTS = 24;
export type ExamCheckpoint = { kind: "exam-parts"; version: 1; bytes: number; parts: string[]; pageProblems?: string[] };

function validParts(docId: string, parts: unknown): parts is string[] {
  return Array.isArray(parts) && parts.length > 0 && parts.length <= MAX_EXAM_PARTS && new Set(parts).size === parts.length &&
    parts.every(p => typeof p === "string" && /^generated\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+\.bin$/.test(p) &&
      !p.includes("..") && p.split("/")[1] === docId);
}

/** 기존 문서에 전체 시험지가 직접 저장된 경우도 읽는다. */
export async function loadExamCheckpoint(docId: string, stored: unknown, signal?: AbortSignal): Promise<any> {
  if (!stored || typeof stored !== "object") throw new ApiError("저장된 읽기 결과가 없습니다.", 404);
  const record = stored as Record<string, unknown>;
  if (Array.isArray(record.sections)) return record;
  if (record.kind !== "exam-parts" || record.version !== 1 || !validParts(docId, record.parts)) {
    throw new ApiError("저장된 읽기 결과의 목록이 올바르지 않습니다.", 400);
  }
  const expected = record.bytes;
  if (typeof expected !== "number" || !Number.isInteger(expected) || expected <= 0 || expected > EXAM_PART_BYTES * MAX_EXAM_PARTS) {
    throw new ApiError("저장된 읽기 결과의 크기가 올바르지 않습니다.", 400);
  }
  const chunks: Blob[] = [];
  let received = 0;
  for (const path of record.parts) {
    const { url } = await postJson<{ url: string }>("/api/files/download-url", { path }, signal);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new ApiError("저장된 읽기 결과를 불러오지 못했습니다.", response.status);
    const chunk = await response.blob();
    if (chunk.size <= 0 || chunk.size > EXAM_PART_BYTES) throw new ApiError("저장된 읽기 결과의 조각 크기가 올바르지 않습니다.", 400);
    received += chunk.size;
    if (received > expected) throw new ApiError("저장된 읽기 결과의 크기가 맞지 않습니다.", 400);
    chunks.push(chunk);
  }
  if (received !== expected) throw new ApiError("저장된 읽기 결과가 일부 빠졌습니다.", 400);
  try {
    const exam = JSON.parse(await new Blob(chunks).text());
    if (!exam || typeof exam !== "object" || !Array.isArray(exam.sections)) throw new Error("sections missing");
    return exam;
  } catch {
    throw new ApiError("저장된 읽기 결과를 해독하지 못했습니다.", 400);
  }
}

/** 조각을 모두 올린 뒤에만 문서가 새 결과를 가리키게 한다. */
export async function saveExamCheckpoint(docId: string, exam: any, usd: number, signal?: AbortSignal, pageProblems: string[] = []): Promise<ExamCheckpoint> {
  const blob = new Blob([JSON.stringify(exam)], { type: "application/json" });
  if (!blob.size || blob.size > EXAM_PART_BYTES * MAX_EXAM_PARTS) {
    throw new ApiError("읽은 결과가 보관 가능한 크기를 넘었습니다. 이 화면을 닫지 말고 다시 시도해 주세요.", 413);
  }
  const parts: string[] = [];
  for (let pos = 0; pos < blob.size; pos += EXAM_PART_BYTES) {
    const chunk = blob.slice(pos, pos + EXAM_PART_BYTES, "application/octet-stream");
    const ref = await uploadFile(docId, "generated", chunk, "exam-part.bin", parts.length, signal);
    parts.push(ref.path);
  }
  const checkpoint: ExamCheckpoint = { kind: "exam-parts", version: 1, bytes: blob.size, parts, pageProblems: pageProblems.slice(0, 100) };
  const itemCount = (exam.sections ?? []).reduce((n: number, s: any) => n + (s.items?.length ?? 0), 0);
  await patchJson(`/api/documents/${docId}`, { exam_json: checkpoint, cost_usd: usd, item_count: itemCount });
  return checkpoint;
}
