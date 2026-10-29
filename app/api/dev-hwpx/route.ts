// 이 작업 환경에서 화면을 시험할 때만: 시험지 JSON(그림 PNG 포함) → 한글 파일. 배포에서는 Python 함수 api/hwpx.py 가 한다.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireSession } from "@/lib/server/auth";
import { DOC_ID, isAllowedPath, LOCAL_ROOT } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (process.env.EXAM_STORE !== "local") return new Response("없음", { status: 404 });
  const denied = await requireSession(req);
  if (denied) return denied;
  let input = Buffer.from(await req.arrayBuffer());
  let docId: string | undefined;
  try {
    const manifest = JSON.parse(input.toString("utf8"));
    if (manifest && typeof manifest === "object" && "input_paths" in manifest) {
      const parts = manifest.input_paths;
      if (!Array.isArray(parts) || parts.length < 1 || parts.length > 24 || new Set(parts).size !== parts.length) throw new Error("invalid parts");
      const buffers: Buffer[] = [];
      for (const p of parts) {
        if (typeof p !== "string" || !isAllowedPath(p) || !p.startsWith("generated/") || !p.endsWith(".bin")) throw new Error("invalid path");
        const id = p.split("/")[1];
        if (!DOC_ID.test(id) || (docId && docId !== id)) throw new Error("mixed documents");
        docId = id;
        const part = await readFile(path.join(LOCAL_ROOT, "files", p));
        if (!part.length || part.length > 4_000_000) throw new Error("invalid size");
        buffers.push(part);
      }
      input = Buffer.concat(buffers);
    }
  } catch {
    return Response.json({ error: "저장된 시험지 데이터를 읽지 못했습니다." }, { status: 400 });
  }
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
  if (docId) {
    const resultPath = `generated/${docId}/${randomUUID()}.hwpx`;
    const file = path.join(LOCAL_ROOT, "files", resultPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, result.out);
    return Response.json({ path: resultPath, warnings });
  }
  return new Response(new Uint8Array(result.out), {
    headers: {
      "content-type": "application/hwp+zip",
      "x-hwpx-warnings": encodeURIComponent(JSON.stringify(warnings)),
    },
  });
}
