// 보관함 문서 하나: 읽기 / 고치기(제목, 상태, 파일, 시험지 JSON, 요금) / 지우기(파일까지).
import { requireSession } from "@/lib/server/auth";
import { DOC_ID, getStore, isAllowedPath, type DocPatch, type FileRef } from "@/lib/server/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { id } = await params;
  if (!DOC_ID.test(id)) return Response.json({ error: "문서를 찾지 못했습니다." }, { status: 404 });
  try {
    const doc = await getStore().getDoc(id);
    return doc ? Response.json({ doc }) : Response.json({ error: "문서를 찾지 못했습니다." }, { status: 404 });
  } catch {
    return Response.json({ error: "문서를 읽지 못했습니다." }, { status: 503 });
  }
}

const STATUS = new Set(["reading", "done", "failed"]);

export async function PATCH(req: Request, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { id } = await params;
  if (!DOC_ID.test(id)) return Response.json({ error: "문서를 찾지 못했습니다." }, { status: 404 });
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "보낸 내용을 읽지 못했습니다." }, { status: 400 });
  }
  const patch: DocPatch = {};
  const ownPath = (p: unknown) => typeof p === "string" && isAllowedPath(p) && p.split("/")[1] === id;
  if (typeof body.title === "string") patch.title = body.title.trim().slice(0, 200) || "제목 없는 시험지";
  if (typeof body.status === "string" && STATUS.has(body.status)) patch.status = body.status as DocPatch["status"];
  if (typeof body.note === "string" || body.note === null) patch.note = body.note === null ? null : String(body.note).slice(0, 2000);
  if (typeof body.cost_usd === "number" && Number.isFinite(body.cost_usd) && body.cost_usd >= 0) patch.cost_usd = body.cost_usd;
  if (typeof body.item_count === "number" && Number.isInteger(body.item_count) && body.item_count >= 0) patch.item_count = body.item_count;
  if (body.hwpx_path === null || ownPath(body.hwpx_path)) patch.hwpx_path = (body.hwpx_path as string | null) ?? null;
  if (Array.isArray(body.original_files)) {
    const files = body.original_files.filter(
      (f): f is FileRef => !!f && typeof f === "object" && ownPath((f as FileRef).path) && typeof (f as FileRef).name === "string",
    );
    patch.original_files = files.map((f) => ({ path: f.path, name: f.name.slice(0, 200), size: Number(f.size) || 0, type: String(f.type || "") }));
  }
  if (body.exam_json !== undefined) {
    const text = JSON.stringify(body.exam_json);
    if (text.length > 3_000_000) return Response.json({ error: "시험지 데이터가 너무 큽니다." }, { status: 413 });
    patch.exam_json = body.exam_json;
  }
  try {
    return Response.json({ doc: await getStore().updateDoc(id, patch) });
  } catch {
    return Response.json({ error: "문서를 고치지 못했습니다." }, { status: 503 });
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { id } = await params;
  if (!DOC_ID.test(id)) return Response.json({ error: "문서를 찾지 못했습니다." }, { status: 404 });
  try {
    await getStore().deleteDoc(id);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "문서를 지우지 못했습니다." }, { status: 503 });
  }
}
