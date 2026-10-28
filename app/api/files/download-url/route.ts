// 파일 내려받기 주소 (60초 동안만 열린다).
// 받는 것: { path, name? }
import { requireSession } from "@/lib/server/auth";
import { getStore, isAllowedPath, safeName } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "보낸 내용을 읽지 못했습니다." }, { status: 400 });
  }
  const filePath = String(body.path ?? "");
  if (!isAllowedPath(filePath)) return Response.json({ error: "파일을 찾지 못했습니다." }, { status: 404 });
  try {
    const url = await getStore().downloadUrl(filePath, typeof body.name === "string" ? safeName(body.name) : undefined);
    return Response.json({ url });
  } catch {
    return Response.json({ error: "내려받기 주소를 만들지 못했습니다." }, { status: 503 });
  }
}
