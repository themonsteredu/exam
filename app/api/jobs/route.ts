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
    if (state?.status === "running" || (!['rebuild', 'reread', 'retry'].includes(body.mode) && doc.hwpx_path)) return Response.json({ docId: doc.id, runId: state?.runId });
    const device = await deviceOf(req);
    if (!device) return Response.json({ error: "화면을 새로고침해 주세요." }, { status: 400 });
    const page = await aiConfig(req, "page");
    const figure = await aiConfig(req, "figure");
    // 실패한 문서도 같은 원본으로 재접수한다. 읽기 결과가 있으면 AI 없이 한글만 다시 만든다.
    const mode = body.mode === "reread" ? "reread" : body.mode === "rebuild" || (body.mode === "retry" && doc.exam_json) ? "rebuild" : "create";
    if (mode !== "rebuild" && (!page.apiKey || page.keyBroken || !figure.apiKey || figure.keyBroken)) return Response.json({ error: "설정에서 API 키를 확인해 주세요." }, { status: 400 });
    if (mode !== "create" && !doc.exam_json) return Response.json({ error: "저장된 읽기 결과가 없습니다." }, { status: 400 });
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, 100).filter((t: any) => [t?.section, t?.index, t?.figureIndex].every(n => Number.isInteger(n) && n >= 0)).map((t: any) => ({ section: t.section, index: t.index, figureIndex: t.figureIndex, name: String(t.name || "그림").slice(0, 80), reasons: Array.isArray(t.reasons) ? t.reasons.slice(0, 10).map((r: unknown) => String(r).slice(0, 600)) : [] })) : [];
    if (mode === "reread" && !targets.length) return Response.json({ error: "다시 읽을 그림을 골라 주세요." }, { status: 400 });
    // 요청의 Host를 작업 주소로 믿지 않는다. 보호된 개별 배포는 자동화 자격이 있을 때만 사용한다.
    // 운영에서는 공개 운영 주소로 접근하되, 문서 API에는 별도로 앱의 세션 인증을 적용한다.
    const deploymentHost = process.env.VERCEL_ENV === "production" && !process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? (process.env.VERCEL_PROJECT_PRODUCTION_URL || "exam-maker-one.vercel.app") : process.env.VERCEL_URL;
    const origin = deploymentHost ? `https://${deploymentHost}` : new URL(req.url).origin;
    if (state) {
      // 성공·실패 저장 직후에도 이전 실행의 접수 잠금이 해제될 때까지 기다린다.
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
