// 1차 읽기: 시험지 한 쪽 사진 → 머리 표, 안내 상자, 문항, 그림 위치.
// 받는 것: { image: data URL 또는 base64 (긴 변 2576px, 370만 픽셀 이하), page, total, before? }
// 돌려주는 것: { reading, usage } 또는 { error }
import { readPage } from "@/lib/ai/read-page";
import { fail, failFrom, parseImage } from "@/lib/ai/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { image?: unknown; page?: unknown; total?: unknown; before?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, "보낸 내용을 읽지 못했습니다");
  }
  const image = parseImage(body.image);
  if ("error" in image) return fail(400, image.error);
  const page = Number.isInteger(body.page) && (body.page as number) > 0 ? (body.page as number) : 1;
  const total = Number.isInteger(body.total) && (body.total as number) >= page ? (body.total as number) : page;
  try {
    const { reading, usage } = await readPage(image, {
      page,
      total,
      before: typeof body.before === "string" ? body.before.slice(0, 300) : undefined,
      signal: req.signal,
    });
    return Response.json({ reading, usage });
  } catch (err) {
    return failFrom(err);
  }
}
