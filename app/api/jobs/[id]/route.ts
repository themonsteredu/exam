import { getRun } from "workflow/api";
import { requireSession } from "@/lib/server/auth";
import { DOC_ID, getStore } from "@/lib/server/store";
import { getJob, setJob } from "@/lib/server/exam-job";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(req: Request, { params }: Ctx) {
  const denied = await requireSession(req); if (denied) return denied;
  const { id } = await params;
  if (!DOC_ID.test(id)) return Response.json({ error: "문서를 찾지 못했습니다." }, { status: 404 });
  const doc = await getStore().getDoc(id);
  if (!doc) return Response.json({ error: "문서를 찾지 못했습니다." }, { status: 404 });
  let job = await getJob(id);
  if (job?.status === "running") {
    // 런타임 제한 등으로 워크플로 본문의 catch까지 도달하지 못한 실패도 표시한다.
    const status = await getRun(job.runId).status;
    if (status === "failed" || status === "cancelled") {
      job = { ...job, status, error: status === "cancelled" ? "제작을 취소했습니다." : "서버 작업이 중단됐습니다. 저장된 읽기 결과로 다시 만들 수 있습니다." };
      await setJob(id, job);
      await getStore().updateDoc(id, { status: doc.hwpx_path ? "done" : "failed", note: job.error });
    }
  }
  return Response.json({ job, doc }, { headers: { "cache-control": "no-store" } });
}
export async function DELETE(req: Request, { params }: Ctx) {
  const denied = await requireSession(req); if (denied) return denied;
  const { id } = await params;
  if (!DOC_ID.test(id)) return Response.json({ error: "문서를 찾지 못했습니다." }, { status: 404 });
  const job = await getJob(id);
  if (job?.status === "running") {
    await setJob(id, { ...job, status: "cancelled" });
    await getRun(job.runId).cancel();
    const doc = await getStore().getDoc(id);
    if (doc) await getStore().updateDoc(id, { status: doc.hwpx_path ? "done" : "failed", note: "제작을 취소했습니다." });
  }
  return Response.json({ ok: true });
}
