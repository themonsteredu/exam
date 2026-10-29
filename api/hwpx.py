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

from exam_hwpx.service import build_from_exam, session_version_of  # noqa: E402
from exam_hwpx.staging import PART_BYTES, output_path, read_exam_parts, validate_parts  # noqa: E402

MAX_BODY = 4_400_000  # Vercel 요청 본문 한도(4.5MB)보다 조금 작게
MAX_WARNINGS_HEADER = 6000  # 알림 머리말 크기 상한 (머리말 크기 한도를 넘지 않게)


def warnings_header(warnings: list[str]) -> str:
    """알림을 머리말에 담는다. 많으면 앞의 것만 줄여서 담고 나머지는 개수만 (머리말이 너무 커지지 않게)"""
    shown = [w if len(w) <= 150 else w[:147] + "..." for w in warnings[:20]]
    while True:
        rest = len(warnings) - len(shown)
        items = shown + ([f"외 {rest}개"] if rest else [])
        value = urllib.parse.quote(json.dumps(items, ensure_ascii=False))
        if len(value) <= MAX_WARNINGS_HEADER or not shown:
            return value
        shown = shown[:-1]
GATEWAY_URL = os.environ.get("EXAM_GATEWAY_URL") or "https://vypnobpmyadtcvxhtagn.supabase.co/functions/v1/exam-gateway"
# 이 작업 환경 시험(EXAM_STORE=local)에서만 APP_SECRET 을 서명 열쇠로 쓴다 (Next 의 LocalStore 와 같은 조건)
LOCAL_TEST = os.environ.get("EXAM_STORE") == "local" and bool(os.environ.get("APP_SECRET"))
_cache: dict = {}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_storage = urllib.request.build_opener(_NoRedirect())


def _storage_url(url: str, file_path: str, upload: bool = False) -> str:
    """창구가 서명한 이 프로젝트 보관함 주소만 허용한다 (외부 주소·리디렉션 차단)."""
    parsed = urllib.parse.urlsplit(url)
    host = urllib.parse.urlsplit(GATEWAY_URL).hostname
    prefix = "/storage/v1/object/upload/sign/exam-files/" if upload else "/storage/v1/object/sign/exam-files/"
    if (parsed.scheme != "https" or parsed.hostname != host or parsed.port not in (None, 443)
            or parsed.username or parsed.password or parsed.fragment or parsed.path != prefix + file_path
            or not urllib.parse.parse_qs(parsed.query).get("token")):
        raise ValueError("보관함 주소가 올바르지 않습니다")
    return url


def _read_part(file_path: str, oidc_token: str | None) -> bytes:
    signed = _gateway("files.downloadUrl", {"path": file_path}, oidc_token)
    url = _storage_url(signed, file_path)
    with _storage.open(urllib.request.Request(url, method="GET"), timeout=30) as response:
        return response.read(PART_BYTES + 1)


def _save_output(file_path: str, data: bytes, oidc_token: str | None) -> None:
    signed = _gateway("files.uploadUrl", {"path": file_path, "contentType": "application/hwp+zip"}, oidc_token)
    url = _storage_url(signed["url"], file_path, upload=True)
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/hwp+zip", "x-upsert": "true"}, method="PUT")
    with _storage.open(req, timeout=60) as response:
        if response.status not in (200, 201):
            raise ValueError("완성된 한글 파일을 보관하지 못했습니다")


def _gateway(action: str, payload: dict, oidc_token: str | None):
    """저장 창구를 부른다 (Vercel OIDC 토큰으로 들어감. 이 작업 환경 시험은 공유 비밀값)"""
    if os.environ.get("EXAM_GATEWAY_SECRET"):
        proof = {"x-exam-gateway": os.environ["EXAM_GATEWAY_SECRET"]}
    elif oidc_token:
        proof = {"x-exam-oidc": oidc_token}
    else:
        raise RuntimeError("저장 창구에 들어갈 증명이 없습니다")
    req = urllib.request.Request(
        GATEWAY_URL,
        data=json.dumps({"action": action, **payload}).encode(),
        headers={"content-type": "application/json", **proof},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode("utf-8")).get("data")


def _cached(name: str, seconds: int, make):
    hit = _cache.get(name)
    if hit and time.time() - hit[1] < seconds:
        return hit[0]
    value = make()
    _cache[name] = (value, time.time())
    return value


def session_key(oidc_token: str | None) -> str:
    """로그인 쿠키 서명 열쇠. 함수가 살아 있는 동안 10분 캐시"""
    if LOCAL_TEST:
        return os.environ["APP_SECRET"]
    key = _cached("key", 600, lambda: (_gateway("session.key", {}, oidc_token) or {}).get("key"))
    if not key or len(key) < 32:
        _cache.pop("key", None)
        raise RuntimeError("쿠키 서명 열쇠를 받지 못했습니다")
    return key


def current_session_version(oidc_token: str | None, fresh: bool = False) -> int:
    """지금 세션 판 (비밀번호를 바꾸면 오른다). 60초 캐시 (Next 서버 주소와 같게)"""
    if LOCAL_TEST:
        return int(os.environ.get("EXAM_SESSION_VERSION", "1"))
    if fresh:
        _cache.pop("version", None)
    data = _cached("version", 60, lambda: _gateway("settings.get", {"keys": ["session_version"]}, oidc_token) or {})
    try:
        return int(data.get("session_version") or 1)
    except (TypeError, ValueError):
        return 1


class handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802 (Vercel 이 부르는 이름)
        oidc = self.headers.get("x-vercel-oidc-token")
        try:
            version = session_version_of(self.headers.get("cookie"), session_key(oidc))
            current = current_session_version(oidc) if version is not None else None
            if version is not None and version > current:
                # 다른 곳에서 비밀번호를 막 바꿨으면 기억(60초)이 낡았을 수 있다 → 새로 읽어 본다
                current = current_session_version(oidc, fresh=True)
        except Exception:  # noqa: BLE001 (창구에 닿지 못함)
            return self._json(503, {"error": "저장소에 연결하지 못했습니다. 잠시 뒤 다시 해 주세요"})
        if version is None:
            return self._json(401, {"error": "로그인이 필요합니다"})
        if version != current:
            return self._json(401, {"error": "비밀번호가 바뀌어 다시 로그인해야 합니다"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "시험지 데이터가 너무 크거나 비었습니다"})
        try:
            exam = json.loads(self.rfile.read(length).decode("utf-8"))
            if isinstance(exam, dict) and "input_paths" in exam:
                doc_id, parts = validate_parts(exam["input_paths"])
                exam = read_exam_parts(parts, lambda part: _read_part(part, oidc))
                data, warnings = build_from_exam(exam)
                path = output_path(doc_id, data)
                _save_output(path, data, oidc)
                shown = warnings[:50]
                if len(warnings) > len(shown):
                    shown.append(f"외 {len(warnings) - len(shown)}개")
                return self._json(200, {"path": path, "warnings": shown})
            data, warnings = build_from_exam(exam)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except Exception:  # 서명 주소가 오류에 섞일 수 있으므로 내부 상세는 노출하지 않는다.
            return self._json(500, {"error": "한글 파일을 만들거나 보관하지 못했습니다. 읽은 결과로 다시 시도해 주세요."})
        self.send_response(200)
        self.send_header("content-type", "application/hwp+zip")
        self.send_header("content-length", str(len(data)))
        self.send_header("x-hwpx-warnings", warnings_header(warnings))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        return self._json(405, {"error": "POST 로 보내 주세요"})
