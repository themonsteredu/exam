import { api, ApiError, patchJson, postJson, uploadFile } from "./api";
import { precheckFiles } from "./pages";
import { assertFresh } from "./version";
import { loadExamCheckpoint, saveExamCheckpoint } from "./exam-storage";
import type { FigureSuspect } from "@/lib/ai/assemble";
import type { MakeResult, Progress, Recovery } from "./make-exam";

export async function submitExam(o: { files: File[]; title: string; saved?: Recovery; targets?: FigureSuspect[]; onProgress: (p: Progress) => void; signal: AbortSignal; onQueued: (id: string) => void }) {
  await assertFresh();
  let id = o.saved?.docId;
  if (o.saved) await saveExamCheckpoint(o.saved.docId, o.saved.exam, o.saved.usd, o.signal, o.saved.pageProblems);
  if (!id) {
    await precheckFiles(o.files);
    o.onProgress({ step: "upload", message: "원본을 올리고 있습니다. 서버 접수 완료까지 창을 열어 주세요.", pagesDone: 0, pagesTotal: 0, figuresDone: 0, figuresTotal: 0, usd: 0 });
    id = (await postJson<{ doc: { id: string } }>("/api/documents", { title: o.title }, o.signal)).doc.id;
    const refs = [];
    for (let i = 0; i < o.files.length; i++) refs.push(await uploadFile(id, "original", o.files[i], o.files[i].name, i, o.signal));
    await patchJson(`/api/documents/${id}`, { original_files: refs });
  }
  // 업로드 이후에는 브라우저의 AbortSignal을 서버 작업에 연결하지 않는다.
  // 접수 응답이 유실돼도 같은 문서로 진행 상태를 되찾는다.
  localStorage.setItem("exam-server-job", id);
  const mode = o.targets?.length ? "reread" : o.saved ? "rebuild" : "create";
  localStorage.setItem("exam-server-mode", mode);
  localStorage.setItem("exam-server-targets", JSON.stringify(o.targets || []));
  try {
    await postJson("/api/jobs", { docId: id, mode, targets: o.targets });
  } catch (err) {
    // 응답 유실 가능성: 문서를 새로 만들지 않고 같은 접수를 조회·재시도한다.
    o.onQueued(id);
    throw err;
  }
  o.onQueued(id);
  return id;
}

export async function jobResult(doc: any, warnings: string[] = []): Promise<MakeResult> {
  const exam = await loadExamCheckpoint(doc.id, doc.exam_json);
  const figures = (exam.sections || []).flatMap((s: any) => s.items || []).flatMap((it: any) => [it.figure, ...(it.extra_figures || [])].filter(Boolean));
  return { docId: doc.id, title: doc.title, exam, hwpxPath: doc.hwpx_path, fileName: `${doc.title.replace(/[\\/:*?"<>|]/g, "_")}.hwpx`,
    warnings, usd: Number(doc.cost_usd) || 0, unsure: (exam.unsure || []).length + exam.sections.reduce((n: number, s: any) => n + s.items.reduce((k: number, it: any) => k + (it.unsure || []).length, 0), 0),
    failedFigures: figures.filter((f: any) => f.render_error).length, saved: true, pageProblems: doc.exam_json?.pageProblems || [] };
}
