"""Vercel Python 함수: 시험지 JSON(그림 PNG 포함) → 한글 파일(.hwpx).

POST /api/hwpx  (본문: 시험지 JSON, 로그인 쿠키 필요)
응답: hwpx 파일. 알림(글자로 대신 넣은 수식 등)은 머리말 x-hwpx-warnings (URL 인코딩한 JSON 목록)

로그인 쿠키 서명 열쇠는 Supabase 저장 창구(exam-gateway)에서 받는다 (Vercel 에는 비밀값이 없다).
창구에는 Vercel 이 요청마다 주는 OIDC 토큰(머리말 x-vercel-oidc-token)으로 들어간다.
이 작업 환경에서 시험할 때는 EXAM_GATEWAY_SECRET(창구 공유 비밀값) 또는 APP_SECRET(열쇠 자체)을 쓴다.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "py"))

from exam_hwpx.service import build_from_exam, verify_session  # noqa: E402

MAX_BODY = 4_400_000  # Vercel 요청 본문 한도(4.5MB)보다 조금 작게
GATEWAY_URL = os.environ.get("EXAM_GATEWAY_URL") or "https://vypnobpmyadtcvxhtagn.supabase.co/functions/v1/exam-gateway"
_key_cache: dict = {}


def session_key(oidc_token: str | None) -> str | None:
    """로그인 쿠키 서명 열쇠. 함수가 살아 있는 동안 10분 캐시"""
    if os.environ.get("APP_SECRET"):
        return os.environ["APP_SECRET"]
    if _key_cache.get("value") and time.time() - _key_cache["at"] < 600:
        return _key_cache["value"]
    proof = {"x-exam-gateway": os.environ["EXAM_GATEWAY_SECRET"]} if os.environ.get("EXAM_GATEWAY_SECRET") else (
        {"x-exam-oidc": oidc_token} if oidc_token else None
    )
    if not proof:
        return None
    req = urllib.request.Request(
        GATEWAY_URL,
        data=json.dumps({"action": "session.key"}).encode(),
        headers={"content-type": "application/json", **proof},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        key = json.loads(res.read().decode("utf-8")).get("data", {}).get("key")
    if not key or len(key) < 32:
        return None
    _key_cache.update(value=key, at=time.time())
    return key


class handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802 (Vercel 이 부르는 이름)
        try:
            key = session_key(self.headers.get("x-vercel-oidc-token"))
        except Exception:  # noqa: BLE001 (창구에 닿지 못함)
            key = None
        if not key:
            return self._json(503, {"error": "저장소에 연결하지 못했습니다. 잠시 뒤 다시 해 주세요"})
        if not verify_session(self.headers.get("cookie"), key):
            return self._json(401, {"error": "로그인이 필요합니다"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "시험지 데이터가 너무 크거나 비었습니다"})
        try:
            exam = json.loads(self.rfile.read(length).decode("utf-8"))
            data, warnings = build_from_exam(exam)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 (까닭을 화면에 보여 준다)
            return self._json(500, {"error": "한글 파일을 만들지 못했습니다", "detail": str(exc)[:500]})
        self.send_response(200)
        self.send_header("content-type", "application/hwp+zip")
        self.send_header("content-length", str(len(data)))
        self.send_header("x-hwpx-warnings", urllib.parse.quote(json.dumps(warnings, ensure_ascii=False)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        return self._json(405, {"error": "POST 로 보내 주세요"})
