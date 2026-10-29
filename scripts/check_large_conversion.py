"""로컬 시험 서버에서 6쪽·30개 그림의 대용량 JSON을 한 개 HWPX로 만든다. AI 호출 없음."""
from __future__ import annotations
import base64
import http.cookiejar
import io
import json
import random
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from xml.etree import ElementTree as ET
from PIL import Image

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3198"
host = urllib.parse.urlsplit(base).hostname
if host not in ("localhost", "127.0.0.1"):
    raise SystemExit("이 시험은 별도 로컬 시험 서버에서만 실행할 수 있습니다")
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(path, payload=None, method=None, headers=None):
    url = urllib.parse.urljoin(base, path)
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {"content-type": "application/json"})
    with opener.open(req, timeout=240) as response:
        body = response.read()
        return json.loads(body) if response.headers.get_content_type() == "application/json" else body


def synthetic_exam():
    pages = [{"page": p, "width": 1000, "height": 1417, "paper_mm": [210, 297]} for p in range(1, 7)]
    items = []
    rng = random.Random(456)
    for n in range(1, 31):
        page = (n - 1) // 5 + 1
        y = 40 + ((n - 1) % 5) * 260
        image = Image.frombytes("RGB", (500, 300), rng.randbytes(500 * 300 * 3))
        png = io.BytesIO()
        image.save(png, format="PNG")
        image64 = base64.b64encode(png.getvalue()).decode()
        box = {"page": page, "x": 100, "y": y + 45, "w": 650, "h": 170}
        items.append({
            "no": n, "source": {"page": page, "x": 30, "y": y, "w": 900, "h": 230},
            "layout_blocks": [{"role": "stem", "box": {"x": 30, "y": y, "w": 900, "h": 35}, "lines": [[{"t": f"시험 문항 {n}"}]]}],
            "figure": {"box": box, "png": image64, "png_size": [500, 300], "render_mode": "original"},
        })
    return {"layout_mode": "source", "source_pages": pages, "sections": [{"title": "", "items": items}]}


doc_id = None
try:
    assert request("/api/auth/login", {"password": "exam-local-test"})["ok"]
    doc_id = request("/api/documents", {"title": "대용량 자동 검증"})["doc"]["id"]
    raw = json.dumps(synthetic_exam(), ensure_ascii=False, separators=(",", ":")).encode()
    assert len(raw) > 4_500_000
    paths = []
    for start in range(0, len(raw), 4_000_000):
        chunk = raw[start:start + 4_000_000]
        signed = request("/api/files/upload-url", {"docId": doc_id, "kind": "generated", "name": "exam-part.bin", "type": "application/octet-stream", "size": len(chunk)})
        req = urllib.request.Request(urllib.parse.urljoin(base, signed["url"]), data=chunk, headers=signed["headers"], method="PUT")
        with opener.open(req, timeout=60) as response:
            assert response.status in (200, 201)
        paths.append(signed["path"])
    assert len(paths) > 1 and len(paths) == len(set(paths))
    checkpoint = {"kind": "exam-parts", "version": 1, "bytes": len(raw), "parts": paths}
    request(f"/api/documents/{doc_id}", {"exam_json": checkpoint, "cost_usd": 2.4, "item_count": 30}, "PATCH")
    saved = request(f"/api/documents/{doc_id}")["doc"]
    assert saved["exam_json"] == checkpoint and saved["item_count"] == 30
    result = request("/api/dev-hwpx", {"input_paths": paths})
    assert result["path"].startswith(f"generated/{doc_id}/") and result["path"].endswith(".hwpx")
    url = request("/api/files/download-url", {"path": result["path"]})["url"]
    with opener.open(urllib.parse.urljoin(base, url), timeout=60) as response:
        hwpx = response.read()
    assert len(hwpx) > 4_500_000
    with zipfile.ZipFile(io.BytesIO(hwpx)) as z:
        assert z.testzip() is None
        sections = [n for n in z.namelist() if n.startswith("Contents/section") and n.endswith(".xml")]
        assert len(sections) == 6
        namespace = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}
        roots = [ET.fromstring(z.read(name)) for name in sections]
        assert sum(len(root.findall(".//hp:pic", namespace)) for root in roots) == 30
        assert all(f"시험 문항 {n}" in "".join(root.itertext()) for root in roots for n in [roots.index(root) * 5 + 1])
    request(f"/api/documents/{doc_id}", {"hwpx_path": result["path"], "status": "done", "note": None}, "PATCH")
    assert request(f"/api/documents/{doc_id}")["doc"]["status"] == "done"
    print(json.dumps({"pages": 6, "figures": 30, "input_mb": round(len(raw) / 1e6, 2), "parts": len(paths), "hwpx_mb": round(len(hwpx) / 1e6, 2), "zip": "ok", "ai_calls": 0}, ensure_ascii=False))
finally:
    if doc_id:
        request(f"/api/documents/{doc_id}", method="DELETE")
