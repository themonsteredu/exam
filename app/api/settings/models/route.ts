// 이 기기에서 쪽 읽기·그림 읽기에 쓸 모델 고르기 (모델은 기기마다 따로).
import { isModel } from "@/lib/ai/claude";
import { requireSession } from "@/lib/server/auth";
import { deviceOf } from "@/lib/server/device";
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
  const device = await deviceOf(req);
  if (!device) return Response.json({ error: "이 기기를 알아보지 못했습니다. 화면을 새로 고친 뒤 다시 해 주세요." }, { status: 400 });
  try {
    await getStore().setModels(device, { page: body.page, figure: body.figure });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "저장하지 못했습니다. 잠시 뒤 다시 해 주세요." }, { status: 503 });
  }
}
