"""대용량 입력 조립, 경로 검증과 보관함 주소 제한을 검사한다. 외부 호출 없음."""
from __future__ import annotations
import importlib.util
import io
import json
from pathlib import Path
import sys
import threading
import urllib.parse
import urllib.request
from http.server import HTTPServer
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))
from exam_hwpx.staging import PART_BYTES, output_path, read_exam_parts, validate_parts

doc = "11111111-1111-4111-8111-111111111111"
a, b = (f"generated/{doc}/{n}.bin" for n in (1, 2))
assert validate_parts([a, b]) == (doc, [a, b])
exam = {"sections": [{"items": [{"no": 1, "stem": [{"t": "한글"}]}]}], "note": "테스트"}
raw = json.dumps(exam, ensure_ascii=False).encode()
pos = raw.index("한글".encode()) + 1
assert read_exam_parts([a, b], {a: raw[:pos], b: raw[pos:]}.get) == exam
for bad in ([], [a, a], [a, f"generated/22222222-2222-4222-8222-222222222222/2.bin"],
            [f"generated/{doc}/../other.bin"], [f"originals/{doc}/1.bin"], [f"generated/{doc}/1.hwpx"]):
    try:
        validate_parts(bad)
        raise AssertionError(f"invalid path accepted: {bad}")
    except ValueError:
        pass
for bad_part in (b"", b"a" * (PART_BYTES + 1), b"not json"):
    try:
        read_exam_parts([a], lambda _: bad_part)
        raise AssertionError("invalid content accepted")
    except ValueError:
        pass
assert output_path(doc, b"HWPX").startswith(f"generated/{doc}/")
spec = importlib.util.spec_from_file_location("hwpx_api", ROOT / "api" / "hwpx.py")
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
host = "vypnobpmyadtcvxhtagn.supabase.co"
module.GATEWAY_URL = f"https://{host}/functions/v1/exam-gateway"
valid = f"https://{host}/storage/v1/object/sign/exam-files/{a}?token=test"
assert module._storage_url(valid, a) == valid
for bad in (valid.replace(host, "evil.example"), valid.replace("https:", "http:"),
            valid.replace("exam-files", "other"), valid.replace("?token=test", "?bad=test"),
            valid.replace(host, f"user@{host}"), valid.replace("?token=test", "?token=test#fragment")):
    try:
        module._storage_url(bad, a)
        raise AssertionError("unsafe signed URL accepted")
    except ValueError:
        pass
assert module._NoRedirect().redirect_request(None, None, 302, "", None, "https://evil.example") is None

# 실제 운영 handler를 실행하되 서명 URL과 파일 저장소만 메모리로 대체한다.
payload = json.dumps({"sections": [], "filler": "a" * (PART_BYTES + 500)}, ensure_ascii=False).encode()
objects = {a: payload[:PART_BYTES], b: payload[PART_BYTES:]}
operations = []
def gateway(action, body, oidc):
    path = body["path"]
    prefix = "upload/sign" if action == "files.uploadUrl" else "sign"
    url = f"https://{host}/storage/v1/object/{prefix}/exam-files/{path}?token=test"
    return {"url": url} if action == "files.uploadUrl" else url
class MemoryStorage:
    def open(self, request, timeout):
        u = urllib.parse.urlsplit(request.full_url)
        prefix = "/storage/v1/object/upload/sign/exam-files/" if request.method == "PUT" else "/storage/v1/object/sign/exam-files/"
        path = u.path[len(prefix):]
        operations.append((request.method, path))
        if request.method == "PUT":
            objects[path] = request.data
            body = b"{}"
        else:
            body = objects[path]
        response = io.BytesIO(body)
        response.status = 200
        return response
module._gateway = gateway
module._storage = MemoryStorage()
module.session_key = lambda oidc: "test-key"
module.session_version_of = lambda cookie, secret: 1
module.current_session_version = lambda oidc: 1
class QuietHandler(module.handler):
    def log_message(self, *args):
        pass
with HTTPServer(("127.0.0.1", 0), QuietHandler) as server:
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/api/hwpx"
        req = urllib.request.Request(url, data=json.dumps({"input_paths": [a, b]}).encode(), headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=20) as res:
            result = json.load(res)
        assert result["path"].startswith(f"generated/{doc}/") and result["path"].endswith(".hwpx")
        assert [m for m, _ in operations] == ["GET", "GET", "PUT"]
        assert zipfile.is_zipfile(io.BytesIO(objects[result["path"]]))
        assert len(json.dumps(result)) < 2000
    finally:
        server.shutdown()
        worker.join()
print("대용량 한글 입력: 조각 결합·경로와 URL 보호·운영 handler의 GET/PUT·작은 응답 검사 통과")
