"""Vercel Python 함수: 시험지 JSON(그림 PNG 포함) → 한글 파일(.hwpx).

POST /api/hwpx  (본문: 시험지 JSON, 로그인 쿠키 필요)
응답: hwpx 파일. 알림(글자로 대신 넣은 수식 등)은 머리말 x-hwpx-warnings (URL 인코딩한 JSON 목록)
"""
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "py"))

from exam_hwpx.service import build_from_exam, verify_session  # noqa: E402

MAX_BODY = 4_400_000  # Vercel 요청 본문 한도(4.5MB)보다 조금 작게


class handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802 (Vercel 이 부르는 이름)
        if not verify_session(self.headers.get("cookie"), os.environ.get("APP_SECRET")):
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
