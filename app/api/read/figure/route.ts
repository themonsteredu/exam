// 2차 읽기: 그림 하나(잘라서 키운 사진) + 문제 글 → 그림 명령.
// 받는 것: { image: data URL 또는 base64, item: { no, stem, choices, bogi } } (stem 등은 시험지 JSON 조각 {t}/{m})
// 돌려주는 것: { figure, usage } 또는 { error }. figure.errors 가 비어 있지 않으면 그림 명령에 고칠 곳이 남은 것
import { readFigure } from "@/lib/ai/read-figure";
import { fail, failFrom, parseImage } from "@/lib/ai/http";

export const runtime = "nodejs";
export const maxDuration = 300;

const pieces = (v: unknown) => (Array.isArray(v) ? v.filter((p) => p && typeof p === "object") : []);

export async function POST(req: Request) {
  let body: { image?: unknown; item?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return fail(400, "보낸 내용을 읽지 못했습니다");
  }
  const image = parseImage(body.image);
  if ("error" in image) return fail(400, image.error);
  const item = body.item ?? {};
  try {
    const { figure, usage } = await readFigure(
      image,
      {
        no: typeof item.no === "number" || typeof item.no === "string" ? item.no : "?",
        stem: pieces(item.stem),
        choices: Array.isArray(item.choices) ? item.choices.map(pieces) : [],
        bogi: Array.isArray(item.bogi) ? item.bogi.map(pieces) : [],
      },
      { signal: req.signal },
    );
    return Response.json({ figure, usage });
  } catch (err) {
    return failFrom(err);
  }
}
