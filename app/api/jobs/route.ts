import { start } from "workflow/api";
import { HookConflictError } from "workflow/errors";
import { createExam } from "@/lib/workflow/exam";
import { aiConfig, requireSession } from "@/lib/server/auth";
import { deviceOf } from "@/lib/server/device";
import { DOC_ID, getStore } from "@/lib/server/store";
import { getJob } from "@/lib/server/exam-job";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(req: Request) {
  const denied = await requireSession(req); if (denied) return denied;
  try {
    const body = await req.json();
    if (!DOC_ID.test(String(body.docId))) return Response.json({ error: "문서를 확인해 주세요." }, { status: 400 });
    const doc = await getStore().getDoc(body.docId);
    if (!doc?.original_files.length) return Response.json({ error: "원본 업로드를 먼저 마쳐 주세요." }, { status: 400 });
    const state = await getJob(doc.id);
    if (state?.status === "running" || (body.mode !== "rebuild" && doc.hwpx_path)) return Response.json({ docId: doc.id, runId: state?.runId });
    const device = await deviceOf(req);
    if (!device) return Response.json({ error: "화면을 새로고침해 주세요." }, { status: 400 });
    const page = await aiConfig(req, "page");
    const figure = await aiConfig(req, "figure");
    const mode = body.mode === "rebuild" ? "rebuild" : "create";
    if (mode === "create" && (!page.apiKey || page.keyBroken || !figure.apiKey || figure.keyBroken)) return Response.json({ error: "설정에서 API 키를 확인해 주세요." }, { status: 400 });
    if (mode === "rebuild" && !doc.exam_json) return Response.json({ error: "저장된 읽기 결과가 없습니다." }, { status: 400 });
    // 요청의 Host를 작업 주소로 믿지 않는다. 배포가 제공한 주소만 사용한다.
    const origin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : new URL(req.url).origin;
    let runId: string;
    try {
      const run = await start(createExam, [{ docId: doc.id, device, models: { page: page.model, figure: figure.model }, origin, mode }], {
        experimental_hook: { token: `exam:${doc.id}` },
      });
      runId = run.runId;
    } catch (err) {
      if (!HookConflictError.is(err) || !err.conflictingRunId) throw err;
      runId = err.conflictingRunId;
    }
    return Response.json({ docId: doc.id, runId }, { status: 202 });
  } catch {
    return Response.json({ error: "서버 접수를 확인하지 못했습니다. 같은 문서의 진행 상태를 확인해 주세요." }, { status: 503 });
  }
}
