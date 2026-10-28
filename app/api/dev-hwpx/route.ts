// 이 작업 환경에서 화면을 시험할 때만: 시험지 JSON(그림 PNG 포함) → 한글 파일. 배포에서는 Python 함수 api/hwpx.py 가 한다.
import { spawn } from "node:child_process";
import path from "node:path";
import { requireSession } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (process.env.EXAM_STORE !== "local") return new Response("없음", { status: 404 });
  const denied = await requireSession(req);
  if (denied) return denied;
  const input = Buffer.from(await req.arrayBuffer());
  const result = await new Promise<{ code: number; out: Buffer; err: string }>((resolve) => {
    const child = spawn("python3", ["-m", "exam_hwpx.service"], { cwd: path.join(process.cwd(), "py") });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? 1, out: Buffer.concat(out), err }));
    child.stdin.end(input);
  });
  if (result.code !== 0) {
    return Response.json({ error: "한글 파일을 만들지 못했습니다.", detail: result.err.slice(-2000) }, { status: 500 });
  }
  let warnings: string[] = [];
  try {
    warnings = JSON.parse(result.err.trim().split("\n").pop() || "{}").warnings ?? [];
  } catch {
    /* 알림 없음 */
  }
  return new Response(new Uint8Array(result.out), {
    headers: {
      "content-type": "application/hwp+zip",
      "x-hwpx-warnings": encodeURIComponent(JSON.stringify(warnings)),
    },
  });
}
