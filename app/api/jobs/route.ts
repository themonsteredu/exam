import { getRun, start } from "workflow/api";
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
    if (state?.status === "running" || (!['rebuild', 'reread'].includes(body.mode) && doc.hwpx_path)) return Response.json({ docId: doc.id, runId: state?.runId });
    const device = await deviceOf(req);
    if (!device) return Response.json({ error: "화면을 새로고침해 주세요." }, { status: 400 });
    const page = await aiConfig(req, "page");
    const figure = await aiConfig(req, "figure");
    const mode = body.mode === "reread" ? "reread" : body.mode === "rebuild" ? "rebuild" : "create";
    if (mode !== "rebuild" && (!page.apiKey || page.keyBroken || !figure.apiKey || figure.keyBroken)) return Response.json({ error: "설정에서 API 키를 확인해 주세요." }, { status: 400 });
    if (mode !== "create" && !doc.exam_json) return Response.json({ error: "저장된 읽기 결과가 없습니다." }, { status: 400 });
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, 100).filter((t: any) => [t?.section, t?.index, t?.figureIndex].every(n => Number.isInteger(n) && n >= 0)).map((t: any) => ({ section: t.section, index: t.index, figureIndex: t.figureIndex, name: String(t.name || "그림").slice(0, 80), reasons: Array.isArray(t.reasons) ? t.reasons.slice(0, 10).map((r: unknown) => String(r).slice(0, 600)) : [] })) : [];
    if (mode === "reread" && !targets.length) return Response.json({ error: "다시 읽을 그림을 골라 주세요." }, { status: 400 });
    // 요청의 Host를 작업 주소로 믿지 않는다. 배포가 제공한 주소만 사용한다.
    const origin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : new URL(req.url).origin;
    if (state?.status === "completed" && mode !== "create") {
      // 결과 저장 직후 이전 실행이 반환 중이면 완료를 기다린 뒤 새 실행을 접수한다.
      await getRun(state.runId).returnValue.catch(() => undefined);
    }
    let runId: string;
    try {
      const run = await start(createExam, [{ docId: doc.id, device, models: { page: page.model, figure: figure.model }, origin, mode, targets }], {
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
