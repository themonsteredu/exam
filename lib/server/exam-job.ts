import { randomUUID } from "node:crypto";
import { getStore, type FileRef } from "./store";
import type { Progress } from "@/lib/client/make-exam";

export type JobInput = { docId: string; device: string; models: { page: string; figure: string }; origin: string; mode: "create" | "rebuild" };
export type JobState = { runId: string; status: "running" | "completed" | "failed" | "cancelled"; progress: Progress; error?: string; warnings?: string[] };
export const jobKey = (id: string) => `exam_job_${id}`;
export async function getJob(id: string): Promise<JobState | null> {
  return (await getStore().getSettings([jobKey(id)]))[jobKey(id)] as JobState || null;
}
export async function setJob(id: string, state: JobState) {
  await getStore().setSetting(jobKey(id), state);
}
export function fileUrl(url: string, origin: string) { return new URL(url, origin).href; }
export async function download(path: string, origin: string): Promise<Buffer> {
  const res = await fetch(fileUrl(await getStore().downloadUrl(path), origin), { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error("보관한 자료를 불러오지 못했습니다.");
  return Buffer.from(await res.arrayBuffer());
}
export async function upload(docId: string, bytes: Buffer, origin: string, ext = "json"): Promise<string> {
  const path = `generated/${docId}/${randomUUID()}.${ext}`;
  const signed = await getStore().uploadUrl(path, "application/octet-stream");
  const res = await fetch(fileUrl(signed.url, origin), { method: "PUT", headers: signed.headers, body: new Uint8Array(bytes), signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error("작업 자료를 보관하지 못했습니다.");
  return path;
}
export const readJson = async (path: string, origin: string) => JSON.parse((await download(path, origin)).toString("utf8"));
export const writeJson = (job: JobInput, value: unknown) => upload(job.docId, Buffer.from(JSON.stringify(value)), job.origin);
export async function checkpoint(job: JobInput, exam: any, usd: number, pageProblems: string[] = []) {
  const bytes = Buffer.from(JSON.stringify(exam));
  if (!bytes.length || bytes.length > 96_000_000) throw new Error("시험지 자료가 보관 가능한 크기를 넘었습니다.");
  const parts: string[] = [];
  for (let pos = 0; pos < bytes.length; pos += 4_000_000) parts.push(await upload(job.docId, bytes.subarray(pos, pos + 4_000_000), job.origin, "bin"));
  const record = { kind: "exam-parts", version: 1, bytes: bytes.length, parts, pageProblems };
  await getStore().updateDoc(job.docId, { exam_json: record, cost_usd: usd, item_count: exam.sections.reduce((n: number, s: any) => n + s.items.length, 0) });
  return record;
}
export async function loadCheckpoint(job: JobInput, stored: any) {
  if (Array.isArray(stored?.sections)) return stored;
  if (stored?.kind !== "exam-parts" || !Array.isArray(stored.parts) || stored.parts.length > 24 ||
      stored.parts.some((p: unknown) => typeof p !== "string" || !p.startsWith(`generated/${job.docId}/`) || !p.endsWith(".bin"))) throw new Error("읽기 결과를 찾지 못했습니다.");
  const bytes = Buffer.concat(await Promise.all(stored.parts.map((p: string) => download(p, job.origin))));
  if (bytes.length !== stored.bytes) throw new Error("읽기 결과가 일부 빠졌습니다.");
  return JSON.parse(bytes.toString("utf8"));
}
export async function originalInput(ref: FileRef, origin: string) {
  return { ...ref, url: fileUrl(await getStore().downloadUrl(ref.path), origin) };
}
