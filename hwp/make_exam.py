"""시험지 JSON으로 한글 파일을 만든다.

사용: python3 hwp/make_exam.py data/exam_p1.json output/exam_p1.hwpx
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from exam_hwpx import ExamBuilder, load_template  # noqa: E402


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    equations = "--equations" in sys.argv
    exam = json.loads(Path(src).read_text(encoding="utf-8"))
    builder = ExamBuilder(load_template(exam["template"]), equations=equations)
    builder.build(exam)
    result = builder.save(dst)
    print("저장:", dst)
    print("검사:", result["report"])
    if result["unconverted"]:
        print("글자로 넣은 수식:", result["unconverted"])


if __name__ == "__main__":
    main()
