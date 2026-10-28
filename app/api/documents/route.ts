// 보관함 문서 목록 / 새 문서 만들기 (시험지 하나를 만들기 시작할 때).
import { requireSession } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  try {
    return Response.json({ docs: await getStore().listDocs(limit, offset) });
  } catch {
    return Response.json({ error: "보관함을 읽지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  let title = "";
  try {
    const body = await req.json();
    title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  } catch {
    /* 제목 없이 */
  }
  try {
    return Response.json({ doc: await getStore().createDoc(title || "제목 없는 시험지") });
  } catch {
    return Response.json({ error: "보관함에 새 문서를 만들지 못했습니다." }, { status: 503 });
  }
}
