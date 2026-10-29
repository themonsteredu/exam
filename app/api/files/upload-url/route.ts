// 파일 올리기 주소: 브라우저가 Supabase 보관함에 바로 올린다 (Vercel 을 거치지 않아 큰 PDF 도 된다).
// 보관함(exam-files)이 파일 하나에 50MB 까지 받으므로 그 안에서 자른다.
// 받는 것: { docId, kind: "original" | "generated", name, type, size, index? }
import { requireSession } from "@/lib/server/auth";
import { DOC_ID, fileExt, getStore } from "@/lib/server/store";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

const LIMIT = { original: 50 * 1024 * 1024, generated: 30 * 1024 * 1024 };

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "보낸 내용을 읽지 못했습니다." }, { status: 400 });
  }
  const docId = String(body.docId ?? "");
  const kind = body.kind === "generated" ? "generated" : body.kind === "original" ? "original" : null;
  const size = Number(body.size);
  if (!DOC_ID.test(docId) || !kind) return Response.json({ error: "잘못된 요청입니다." }, { status: 400 });
  if (!(size > 0) || size > LIMIT[kind]) {
    return Response.json({ error: `파일이 너무 큽니다 (최대 ${LIMIT[kind] / 1024 / 1024}MB).` }, { status: 413 });
  }
  // 보관함(Supabase) 안의 이름은 영문·숫자만 쓸 수 있다. 한글 원래 이름은 문서 기록에 두고 내려받을 때 붙인다.
  const filePath =
    kind === "original"
      ? `originals/${docId}/${Math.max(0, Math.floor(Number(body.index) || 0)) + 1}.${fileExt(String(body.name ?? ""))}`
      : `generated/${docId}/${randomUUID()}.${fileExt(String(body.name ?? ""), "hwpx")}`;
  const type = typeof body.type === "string" && body.type.length < 100 ? body.type : "application/octet-stream";
  try {
    const signed = await getStore().uploadUrl(filePath, type);
    return Response.json({ path: filePath, ...signed });
  } catch (err) {
    console.error("올리기 주소 실패", err);
    return Response.json({ error: "파일을 올릴 주소를 만들지 못했습니다." }, { status: 503 });
  }
}
