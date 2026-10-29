// 이 작업 환경에서 화면을 시험할 때만 쓰는 파일 보관함 (EXAM_STORE=local). 배포에서는 404.
// 주소에 붙은 서명(token)으로만 열린다 (lib/server/store.ts 의 devFileToken).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkDevFileToken, isAllowedPath, LOCAL_ROOT } from "@/lib/server/store";

export const runtime = "nodejs";

function check(req: Request, mode: "put" | "get"): { file: string; url: URL } | Response {
  if (process.env.EXAM_STORE !== "local") return new Response("없음", { status: 404 });
  const url = new URL(req.url);
  const p = url.searchParams.get("path") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const token = url.searchParams.get("token") ?? "";
  if (!isAllowedPath(p) || !checkDevFileToken(p, mode, exp, token)) return new Response("주소가 맞지 않습니다", { status: 403 });
  return { file: path.join(LOCAL_ROOT, "files", p), url };
}

export async function PUT(req: Request) {
  const c = check(req, "put");
  if (c instanceof Response) return c;
  await mkdir(path.dirname(c.file), { recursive: true });
  await writeFile(c.file, Buffer.from(await req.arrayBuffer()));
  return Response.json({ ok: true });
}

export async function GET(req: Request) {
  const c = check(req, "get");
  if (c instanceof Response) return c;
  try {
    const data = await readFile(c.file);
    const name = c.url.searchParams.get("download");
    const headers: Record<string, string> = { "content-type": "application/octet-stream" };
    if (name) {
      // 영문 이름(대신 쓸 것)과 한글 이름을 함께 준다
      const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      headers["content-disposition"] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    }
    return new Response(new Uint8Array(data), { headers });
  } catch {
    return new Response("파일이 없습니다", { status: 404 });
  }
}
