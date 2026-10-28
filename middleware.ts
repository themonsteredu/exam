// 프로그램 전체를 비밀번호로 막는다. 로그인 쿠키의 서명과 만료만 빠르게 본다
// (비밀번호를 바꾼 뒤의 예전 쿠키는 서버 주소가 세션 판으로 한 번 더 걸러 낸다).
import { NextResponse, type NextRequest } from "next/server";
import { readSessionToken, SESSION_COOKIE } from "@/lib/server/session";

/** 로그인 없이 열리는 곳 */
const OPEN = ["/login", "/api/auth/login", "/api/dev-files"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  const session = await readSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // 글꼴, 빌드 파일, 아이콘은 막지 않는다
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/|pdf.worker).*)"],
};
