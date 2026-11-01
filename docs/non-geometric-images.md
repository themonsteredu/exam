# 도형 외 자료 (표·지도·통계 그래프·삽화·사진)

쪽 읽기는 그림 영역을 기하도형(diagram), 표(table), 지도(map), 통계 그래프(chart), 삽화(illustration), 사진(photo), 그 밖(other)으로 나눈다.

- 기하도형: 지금까지처럼 그림 명령(JSON) → JSXGraph(canvas) → PNG.
- 표·지도·통계 그래프·삽화·그 밖: 따로 읽어서(lib/ai/read-graphic.ts) 선·타원·글자·표 명령(lib/graphic/schema.ts)을 받고,
  화면에서 canvas 로 그려 PNG 로 넣는다(lib/graphic/render.ts). 임의 SVG·HTML·스크립트는 받지 않는다.
  명령 검사(좌표 범위, 색 형식, 꼭 들어갈 글자, 표의 행·열과 합친 칸)에 걸리면 한 번 고쳐 받고, 끝내 안 되면 빈 자리로 둔다.
- 사진: 다시 그릴 방법이 없어 AI 에게 보내지 않고, 한글 파일에는 크기만큼 "사진 자리" 빈 상자로 둔다.

원본 사진을 잘라 붙이지 않는다 (CLAUDE.md 규칙). 2026-11-01 GPT 판에 있던 "원본 사용" 선택, 원본 배치 출력, 원본 조각 보관은 모두 없앴다.

검사: `node scripts/run-ts.mjs scripts/check_graphics.ts` (명령 검사, 사진은 빈 자리, 읽기 실패는 빈 자리, 원본 조각 없음).
