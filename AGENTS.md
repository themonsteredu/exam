# 다른 AI 도구(Codex 등)에게: 이 저장소의 작업 규칙

이 저장소의 규칙은 `CLAUDE.md` 에 있다. 작업 전에 반드시 `CLAUDE.md` 와 `docs/작업지시서.md` 를 읽고 그대로 따른다.
특히 아래는 사용자(학원 원장님)가 직접 확인하고 정한 것이라 바꾸지 않는다.

- 한글 파일은 확인받은 학교 양식 그대로 만든다: 머리 표는 1단, 본문은 2단(가운데 세로 구분선), 문제 글은 왼쪽 여백 0 + 내어쓰기 5.5mm.
  원본 쪽의 위치를 따라 글 상자를 하나하나 띄워 놓는 방식(2026-11-01 GPT 판의 "source layout")은 쓰지 않는다
  (쪽 수가 두 배가 되고, 낱말 중간에서 줄이 끊기고, 선택지가 빠졌다).
- 원본 사진을 잘라서 한글 파일에 붙이지 않는다 (머리말·안내·꼬리말·지도·사진 모두). 원본은 확인할 때만 쓴다.
  다시 그릴 수 없는 사진은 빈 자리로 둔다.
- 그림은 AI 가 쓴 그림 명령(JSON)을 JSXGraph 1.13.3(canvas)로 그려 PNG 로 넣는다. SVG 를 쓰지 않는다.
  점 이름 자동으로 옮기기, 글자 최소 크기 강제 같은 후처리는 넣지 않는다 (점 이름이 엉뚱한 곳으로 가서 그림을 못 쓰게 됐다).
- 문제 글·선택지는 한글에서 고칠 수 있는 진짜 글자, 수식은 한글 수식 개체. 줄바꿈은 breakNonLatinWord = BREAK_WORD.
- 요금이 드는 결정(모델 강제 변경 등)은 혼자 정하지 않는다. 모델은 설정 화면에서 기기마다 고른 것을 쓴다.
- 사용자는 개발자가 아니다. 설명은 쉬운 한국어로.

검사(요금 없음): `node scripts/check-ai.mjs`, `npx tsc --noEmit`, `node scripts/run-ts.mjs scripts/check_cost_layout.ts`,
`node scripts/run-ts.mjs scripts/check_graphics.ts`, `node scripts/run-ts.mjs scripts/check_ai_requests.ts`,
`node scripts/run-ts.mjs scripts/check_exam_storage.ts`, `python3 scripts/check_hwpx_text.py`, `python3 scripts/check_latex.py`,
`python3 scripts/check_staged_hwpx.py`.
