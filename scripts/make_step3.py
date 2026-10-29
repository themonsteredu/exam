"""3단계 확인용: 시험지 데이터 → 그림(PNG) 그리기 → 한글 파일.

    python3 scripts/make_step3.py

1) scripts/render-figures.mjs 로 그림 명령을 PNG 로 그린다 (화면 없는 브라우저. Playwright 와 Chromium 이 필요).
2) PNG 와 한글 수식을 넣어 output/step3_exam_p1.hwpx 를 만든다.
3) 그림을 글 오른쪽에 두는 경우를 보는 파일 output/step3_figure_right.hwpx 도 만든다.
그리지 못한 그림이 있어도 한글 파일은 만든다. 그 그림은 빈 자리로 두고, 까닭은 그림 그리기 단계에서 보여 준다.
"""
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))

from exam_hwpx.builder import build_exam  # noqa: E402

OUT = ROOT / "output"
OUT.mkdir(exist_ok=True)


def make(data_name: str, out_name: str) -> None:
    src = ROOT / "data" / data_name
    # PNG 가 들어 있어 큰 중간 파일은 임시 폴더에 두고, 끝나면(실패해도) 지운다
    with tempfile.TemporaryDirectory() as tmp:
        rendered = pathlib.Path(tmp) / (pathlib.Path(data_name).stem + ".with_figures.json")
        proc = subprocess.run(["node", str(ROOT / "scripts" / "render-figures.mjs"), str(src), str(rendered)])
        # 끝 코드 2: 그리지 못한 그림이 있음. 그 그림에는 render_error 가 적혀 있고 한글 파일에는 빈 자리로 들어간다
        if proc.returncode not in (0, 2):
            raise SystemExit(f"그림을 그리지 못해 {out_name} 파일을 만들지 않았습니다 (위 안내를 확인해 주세요)")
        exam = json.loads(rendered.read_text(encoding="utf-8"))
    data, warnings = build_exam(exam)
    out = OUT / out_name
    out.write_bytes(data)
    print("저장:", out)
    for w in warnings:
        print("알림:", w)


make("exam_p1_manual.json", "step3_exam_p1.hwpx")
make("figure_right_demo.json", "step3_figure_right.hwpx")
