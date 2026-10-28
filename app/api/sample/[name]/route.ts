import { readFile } from "node:fs/promises";
import path from "node:path";

const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

// samples 폴더의 사진을 겹쳐 보기 화면에 보내 준다
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const safe = path.basename(name);
  const type = TYPES[path.extname(safe).toLowerCase()];
  if (!type) return new Response("지원하지 않는 파일", { status: 400 });
  try {
    const data = await readFile(path.join(process.cwd(), "samples", safe));
    return new Response(new Uint8Array(data), { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
  } catch {
    return new Response("사진이 없습니다", { status: 404 });
  }
}
