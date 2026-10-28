// 쪽 읽기·그림 읽기에 쓸 모델 고르기.
import { isModel } from "@/lib/ai/claude";
import { requireSession } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  let body: { page?: unknown; figure?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* 아래에서 처리 */
  }
  if (!isModel(body.page) || !isModel(body.figure)) {
    return Response.json({ error: "고를 수 없는 모델입니다." }, { status: 400 });
  }
  try {
    await getStore().setSetting("models", { page: body.page, figure: body.figure });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "저장하지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}
