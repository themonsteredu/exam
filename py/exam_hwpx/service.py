"""한글 파일 만들기 서비스: 서버 함수(api/hwpx.py)와 개발용 주소(app/api/dev-hwpx)가 같이 쓴다.

- build_from_exam(exam) -> (hwpx 바이트, 알림 목록)
- verify_session(cookie 머리말, APP_SECRET) -> 로그인 쿠키가 맞는지 (lib/server/session.ts 와 같은 방식)
- 명령줄: python3 -m exam_hwpx.service < 시험지.json > 출력.hwpx  (알림은 stderr 에 JSON 한 줄)
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sys
import time

from .builder import build_exam

SESSION_COOKIE = "exam_session"


def build_from_exam(exam: dict) -> tuple[bytes, list[str]]:
    if not isinstance(exam, dict) or not isinstance(exam.get("sections", []), list):
        raise ValueError("시험지 데이터 모양이 맞지 않습니다")
    return build_exam(exam)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def verify_session(cookie_header: str | None, secret: str | None, now: float | None = None) -> bool:
    """쿠키 exam_session = v1.<만료 초>.<세션 판>.<HMAC-SHA256 서명> 의 서명과 만료를 본다."""
    if not cookie_header or not secret:
        return False
    token = None
    for part in cookie_header.split(";"):
        key, _, value = part.strip().partition("=")
        if key == SESSION_COOKIE:
            token = value
    if not token:
        return False
    parts = token.split(".")
    if len(parts) != 4 or parts[0] != "v1" or not parts[1].isdigit() or not parts[2].isdigit():
        return False
    body = ".".join(parts[:3])
    want = _b64url(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(want, parts[3]):
        return False
    return int(parts[1]) > (now if now is not None else time.time())


def main() -> None:
    exam = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    data, warnings = build_from_exam(exam)
    sys.stderr.write(json.dumps({"warnings": warnings}, ensure_ascii=False) + "\n")
    sys.stdout.buffer.write(data)


if __name__ == "__main__":
    main()
