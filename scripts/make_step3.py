"""3단계 확인용: 시험지 데이터 → 그림(PNG) 그리기 → 한글 파일.

    python3 scripts/make_step3.py

1) scripts/render-figures.mjs 로 그림 명령을 PNG 로 그린다 (화면 없는 브라우저).
2) PNG 와 한글 수식을 넣어 output/step3_exam_p1.hwpx 를 만든다.
3) 그림을 글 오른쪽에 두는 경우를 보는 파일 output/step3_figure_right.hwpx 도 만든다.
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))

from exam_hwpx.builder import build_exam  # noqa: E402

OUT = ROOT / "output"
OUT.mkdir(exist_ok=True)


def make(data_name: str, out_name: str) -> None:
    src = ROOT / "data" / data_name
    rendered = OUT / (pathlib.Path(data_name).stem + ".with_figures.json")
    subprocess.run(["node", str(ROOT / "scripts" / "render-figures.mjs"), str(src), str(rendered)], check=True)
    exam = json.loads(rendered.read_text(encoding="utf-8"))
    data, warnings = build_exam(exam)
    rendered.unlink()  # PNG 가 들어 있어 커서 남기지 않는다
    out = OUT / out_name
    out.write_bytes(data)
    print("저장:", out)
    for w in warnings:
        print("알림:", w)


make("exam_p1_manual.json", "step3_exam_p1.hwpx")
make("figure_right_demo.json", "step3_figure_right.hwpx")
