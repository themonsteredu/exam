// 지금 서버가 내주는 프로그램 판 (next.config.mjs 의 NEXT_PUBLIC_APP_VERSION). 화면이 자기 판과 견준다 (lib/client/version.ts)
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ version: process.env.NEXT_PUBLIC_APP_VERSION || "" }, { headers: { "cache-control": "no-store" } });
}
