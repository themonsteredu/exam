// 프로그램 전체를 비밀번호로 막는다. 여기서는 로그인 쿠키의 모양과 만료만 빠르게 본다 (화면을 로그인으로 돌려보내는 용도).
// 서명 열쇠는 저장 창구에 있어서 여기서는 서명을 보지 않는다. 자료를 주고받는 서버 주소는 모두 requireSession 으로
// 서명과 세션 판까지 확인한다 (화면 파일 자체에는 자료가 없다).
import { NextResponse, type NextRequest } from "next/server";
import { peekSessionToken, SESSION_COOKIE } from "@/lib/server/session";

/** 로그인 없이 열리는 곳 */
const OPEN = ["/login", "/api/auth/login", "/api/dev-files"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  if (peekSessionToken(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
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
