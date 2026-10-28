"""시험지 JSON 한 개 → 그림(PNG) 그리기 → 한글 파일.

    python3 scripts/make_hwpx.py <시험지.json> <출력.hwpx>

4단계에서 AI 가 읽은 결과(output/ai/*.exam.json)를 한글 파일로 만들 때 쓴다.
그림은 scripts/render-figures.mjs 로 그린다 (화면 없는 브라우저. Playwright 와 Chromium 이 필요).
그리지 못한 그림이 있어도 한글 파일은 만든다. 그 그림은 빈 자리로 두고 까닭을 알려 준다.
"""
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))

from exam_hwpx.builder import build_exam  # noqa: E402


def make(src: pathlib.Path, out: pathlib.Path) -> list[str]:
    with tempfile.TemporaryDirectory() as tmp:
        rendered = pathlib.Path(tmp) / "with_figures.json"
        proc = subprocess.run(["node", str(ROOT / "scripts" / "render-figures.mjs"), str(src), str(rendered)])
        # 끝 코드 2: 그리지 못한 그림이 있음 (그 그림은 빈 자리로 들어간다)
        if proc.returncode not in (0, 2):
            raise SystemExit(f"그림을 그리지 못해 {out.name} 파일을 만들지 않았습니다 (위 안내를 확인해 주세요)")
        exam = json.loads(rendered.read_text(encoding="utf-8"))
    data, warnings = build_exam(exam)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return warnings


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("사용법: python3 scripts/make_hwpx.py <시험지.json> <출력.hwpx>")
    src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    for w in make(src, out):
        print("알림:", w)
    print("저장:", out)
