// 프로그램 전체를 비밀번호로 막는다. 여기서는 로그인 쿠키의 모양과 만료만 빠르게 본다 (화면을 로그인으로 돌려보내는 용도).
// 서명 열쇠는 저장 창구에 있어서 여기서는 서명을 보지 않는다. 자료를 주고받는 서버 주소는 모두 requireSession 으로
// 서명과 세션 판까지 확인한다 (화면 파일 자체에는 자료가 없다).
// 처음 온 브라우저에는 기기 표시 쿠키(exam_device)를 붙인다 (AI 열쇠와 모델을 기기마다 따로 저장하려고. lib/server/device.ts).
import { NextResponse, type NextRequest } from "next/server";
import { DEVICE_COOKIE, DEVICE_MAX_AGE, isDeviceId, newDeviceId } from "@/lib/server/device";
import { isHttps, peekSessionToken, SESSION_COOKIE } from "@/lib/server/session";

/** 로그인 없이 열리는 곳 */
const OPEN = ["/login", "/api/auth/login", "/api/dev-files"];

export function middleware(req: NextRequest) {
  const fresh = isDeviceId(req.cookies.get(DEVICE_COOKIE)?.value) ? null : newDeviceId();
  const res = decide(req, fresh);
  if (fresh) {
    res.cookies.set(DEVICE_COOKIE, fresh, { httpOnly: true, sameSite: "lax", secure: isHttps(req), path: "/", maxAge: DEVICE_MAX_AGE });
  }
  return res;
}

function decide(req: NextRequest, fresh: string | null): NextResponse {
  const { pathname } = req.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return pass(req, fresh);
  if (peekSessionToken(req.cookies.get(SESSION_COOKIE)?.value)) return pass(req, fresh);
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

/** 그대로 넘긴다. 기기 표시를 새로 만들었으면 이번 요청에도 넣어 준다 (서버 주소가 바로 쓸 수 있게) */
function pass(req: NextRequest, fresh: string | null): NextResponse {
  if (!fresh) return NextResponse.next();
  const others = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${DEVICE_COOKIE}=`));
  const headers = new Headers(req.headers);
  headers.set("cookie", [...others, `${DEVICE_COOKIE}=${fresh}`].join("; "));
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // 글꼴, 빌드 파일, 아이콘, PDF 보조 파일은 막지 않는다
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/|pdfjs/|pdf.worker).*)"],
};
