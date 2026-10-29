import { isHttps } from "@/lib/server/auth";
import { clearSessionCookie } from "@/lib/server/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "set-cookie": clearSessionCookie(isHttps(req)) },
  });
}
