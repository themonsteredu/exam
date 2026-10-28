// 로그인 쿠키: "v1.<만료 초>.<세션 판>.<서명>". 서명은 HMAC-SHA256(APP_SECRET).
// Web Crypto 만 써서 미들웨어(Edge)와 서버 주소(Node) 양쪽에서 돈다.
// 비밀번호를 바꾸면 세션 판(session_version)을 올려 예전 쿠키를 모두 무효로 한다 (판 확인은 서버 주소에서).

export const SESSION_COOKIE = "exam_session";
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

/** 쿠키 서명·API 키 암호화에 쓰는 서버 비밀값. 배포에서는 꼭 있어야 한다 */
export function appSecret(): string {
  const s = process.env.APP_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production" && process.env.EXAM_STORE !== "local") {
    throw new Error("APP_SECRET 환경변수가 없거나 너무 짧습니다 (32자 이상)");
  }
  return "dev-only-secret-not-for-production-use-0123456789";
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** 길이가 같을 때 글자를 모두 견준다 (서명 비교에 걸리는 시간으로 답을 짐작하지 못하게) */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeSessionToken(version: number, now = Date.now()): Promise<{ token: string; maxAge: number }> {
  const maxAge = SESSION_DAYS * 24 * 3600;
  const exp = Math.floor(now / 1000) + maxAge;
  const body = `v1.${exp}.${version}`;
  return { token: `${body}.${await sign(appSecret(), body)}`, maxAge };
}

/** 서명과 만료가 맞으면 세션 판을 돌려준다. 아니면 null */
export async function readSessionToken(token: string | undefined | null, now = Date.now()): Promise<{ version: number; exp: number } | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, expText, versionText, sig] = parts;
  if (!/^\d+$/.test(expText) || !/^\d+$/.test(versionText)) return null;
  const expected = await sign(appSecret(), `v1.${expText}.${versionText}`);
  if (!sameString(sig, expected)) return null;
  const exp = Number(expText);
  if (exp * 1000 <= now) return null;
  return { version: Number(versionText), exp };
}

/** 응답에 붙일 Set-Cookie 값 */
export function sessionCookie(token: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
