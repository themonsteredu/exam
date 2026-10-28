# 시험지 제작 프로그램 — 작업 규칙

전체 지시서: `docs/작업지시서.md` (기술 구성, 데이터 구조, 한글·그림에서 확인된 사항, 검증용 예시 A~F가 모두 들어 있음. 작업 전에 해당 부분을 꼭 다시 읽을 것)

## 진행 방식

- 사용자는 개발자가 아니다. 설명은 개발 용어 없이 쉬운 말로 한다. 꼭 필요한 용어는 한 줄로 풀어 쓴다.
- 단계는 하나씩만 진행한다. 단계가 끝나면 무엇을 만들었는지, 사용자가 직접 확인하는 방법을 쉬운 말로 알려 준다.
- 사용자가 "확인했다"고 말하기 전에는 다음 단계로 넘어가지 않는다.
- 요금이 드는 서비스, 저장 방식처럼 결정이 필요한 부분은 혼자 정하지 않는다. 선택지를 짧게 설명하고 묻는다.
- 테스트는 `samples/` 폴더의 사진으로 한다 (exam_p1.jpg, cubes_problem4.png, cubes_worksheet.png, rect_p.jpg).

## 꼭 지킬 규칙

### 그림
- 그림은 SVG로 그리지 않는다. 원본 사진을 잘라서 결과물에 붙이지도 않는다. 원본 사진은 확인 화면에서 비교할 때만 쓴다.
- 그림은 AI가 "그림 명령"(JSON)을 쓰고, JSXGraph(1.13.3)가 canvas 방식으로 그린 뒤 PNG로 저장해서 한글 파일에 넣는다.
- 문제 조건으로 정해지는 점(이등분선의 교점, 수선의 발, 원과 직선의 교점 등)은 좌표를 짐작하지 말고 그림 도구가 계산한다.
- 학생이 연필로 쓴 풀이, 채점 표시, 빨간 펜, 낙서는 넣지 않는다. 인쇄된 것만 옮긴다.

### 글과 수식
- 문제 글과 선택지는 한글에서 고칠 수 있는 진짜 글자로 넣는다.
- 수식(선분 기호, 각, 분수, 루트, 지수 등)은 한글 수식 개체로 넣는다. AI는 LaTeX로 읽고, 프로그램이 한글 수식 문법으로 바꾼다. 바꾸지 못한 수식은 글자로 넣고 확인 화면에 표시한다.
- 한국어 줄바꿈은 어절 단위로 한다. 방법: header.xml 의 breakNonLatinWord 를 모두 "BREAK_WORD" 로 둔다.
  (작업지시서 6번에는 KEEP_WORD 로 바꾸라고 되어 있지만, 한글에서는 이 값이 이름과 반대로 동작한다.
  KEEP_WORD 로 만든 파일은 사용자 한글에서 "구 / 하면", "컴퓨 / 터용"처럼 낱말 중간에서 끊겼다. python-hwpx 설명도 같다.)

### 화면
- 글꼴은 에스코어드림.
- 화면 문구는 자연스러운 말투로 쓰고, 이모지는 쓰지 않는다.
- API 키 같은 비밀값은 서버에만 두고 화면 코드에 넣지 않는다.

### 하지 말 것
- 결과물에 SVG 그림을 쓰거나 원본 사진을 잘라 붙이는 것
- 사용자 확인 없이 다음 단계로 넘어가는 것
- 개발 용어만으로 된 설명

## 기술 구성 (요약)
- 웹: Next.js + TypeScript, 배포는 Vercel
- 그림: jsxgraph 1.13.3, renderer 'canvas'
- 한글 파일: Python, python-hwpx==6.9.0 (Vercel Python 함수 먼저 시도)
- AI 읽기: Anthropic API. 모델은 환경변수 ANTHROPIC_MODEL (기본 claude-opus-5-5), 키는 ANTHROPIC_API_KEY
- 수식 미리보기: KaTeX
- 저장은 6단계에서 Supabase. 그 전까지는 저장 없이 한 번에 처리

## 단계
1. 한글 양식 틀 — exam_p1.jpg 양식(제목 상자, 응시대상·실시 일자 표, 안내 상자 2개, "선택형" 상자, 2단 본문과 세로 구분선, 꼬리말)을 따르는 생성기. 머리는 1단, 본문부터 2단. 1~3번은 직접 넣은 데이터, 그림 자리는 비움. 완료: 사용자가 한글에서 원본과 비교.
2. 그림 엔진 — 그림 명령 JSON을 JSXGraph(canvas)로 그려 300dpi 이상 PNG로 저장. 검증용 예시 A~F 테스트 페이지, 원본 반투명 겹쳐 보기. 완료: 사용자가 겹쳐 보기로 확인.
3. 합치기 — 1단계 파일에 2단계 PNG와 한글 수식을 넣는다. 그림은 원본처럼 글 아래나 오른쪽. 완료: 한글에서 1~3번이 그림·수식까지 들어가 있음.
4. AI 읽기 — 사진/PDF → Claude API → 시험지 JSON. 두 번 읽기(쪽 전체 → 그림별 잘라서 그림 명령). 인쇄 글씨와 연필 필기 구분, 확신 낮은 부분 표시. 완료: samples로 만든 JSON이 직접 넣은 내용과 거의 같음.
5. 확인·수정 화면 — 왼쪽 원본, 오른쪽 문항 목록. 글·선택지·수식(미리보기) 수정, 그림 미리보기·겹쳐 보기·자유점 끌기·명령 직접 수정, 문항별 "다시 읽기", 그림 모드(문제 조건대로 / 원본 모양대로), "한글 파일 만들기" 내려받기.
6. 양식 등록과 배포 — 새 시험지에서 양식(용지, 여백, 머리 표, 단 수, 구분선, 글꼴·크기, 꼬리말)을 뽑아 Supabase에 저장하고 골라 쓰기. Vercel 배포.

## 진행 상황
- 1단계: 완료 (사용자 확인함). py/exam_hwpx, scripts/make_step1.py → output/step1_exam_p1.hwpx
- 2단계: 완료 (사용자 확인함). 그림 엔진 lib/figure (types.ts 그림 명령 형식, engine.ts 그리기·PNG, geometry.ts 계산, examples.ts 예시 A~F, render-exam.ts 시험지 그림 일괄 PNG), 확인 화면 components/figure-test (Next 페이지 app/figure-test 와 점검 페이지가 같이 씀)
  - 점검 페이지(사용자가 바로 여는 주소): https://claude.ai/artifact/LvPQzVC3soDs8HtzVXUcGw
  - 다시 만들기: python3 scripts/subset-fonts.py <원본 글꼴 폴더> <부분 글꼴 폴더> → node scripts/build-figure-artifact.mjs <출력.html> <부분 글꼴 폴더>
- 3단계: 완료 (사용자 확인함). python3 scripts/make_step3.py → output/step3_exam_p1.hwpx (그림 아래 배치), output/step3_figure_right.hwpx (그림 오른쪽 배치 확인용)
  - 사용자 한글에서 확인된 사항 (바꾸지 말 것):
    - 그림: imgDim·imgClip = 픽셀 x 75, curSz = 0, PNG 에 pHYs 없음, 그림 이름 image1…, header 의 binDataList 없음, BinData·version.xml 은 압축하지 않음
      (python-hwpx 기본값으로는 이전 버전 한글에서 그림 자리만 생기고 그림이 안 보였다. scripts/make_picture_test.py 로 비교해서 찾음)
    - 문제 글: 왼쪽 여백 0 + 내어쓰기 5.5mm (번호가 선택지 번호와 같은 세로줄)
    - 같은 이름의 파일을 여러 번 보내면 사용자가 예전 파일을 열 수 있다. 보낼 때마다 파일 이름을 다르게 한다
  - python-hwpx 6.9.0 메모: doc.media.add_image 가 돌려주는 BinaryItem 의 id 는 item.id 가 아니라 item.item_id
- 4단계: 진행 중. AI 부르는 코드까지 다 만들었고, 사용자 API 키를 기다리는 중 (키 없이 할 수 있는 점검은 모두 통과)
  - 사용자에게 요금(쪽당 약 1,000~1,500원 예상, 시험 몇 번에 2~3만 원)과 키 넣는 법을 안내함. 요금 승인과 키 넣기는 사용자 몫
    - 키는 채팅에 붙여 넣게 하지 않는다. 환경 설정(세션 제목 줄의 환경 메뉴 → Edit → Network secrets 또는 환경변수)에 ANTHROPIC_API_KEY 로 넣고 새 세션을 연다
  - 흐름: 쪽 사진 → (1차) lib/ai/read-page.ts 쪽 읽기 (구조화 출력, effort medium) → 그림마다 원본에서 잘라 키워서 → (2차) lib/ai/read-figure.ts 그림 읽기 (effort high, 답을 lib/figure/validate.ts 로 검사해 틀리면 한 번 고쳐 받음) → lib/ai/assemble.ts 로 시험지 JSON
  - lib/ai: page-schema.ts (쪽 읽기 답 모양. 구조화 출력 제한: 선택 항목 24개·anyOf 16개, 그래서 빠지는 칸 없이 "" · 0 · [] 로), prompts.ts (지시문. 그림 예시는 samples 와 관계없는 연습용이어야 한다), claude.ts (스트리밍, fallbacks "default" + 베타 server-side-fallback-2026-07-01, 거절·한도·크레딧 오류를 쉬운 말로, 요금 계산), image-geometry.ts (보낼 크기: 긴 변 2576·370만 픽셀 이하, 그림 자르기 여백, 사진 머리에서 크기 읽기), compare.ts · figure-compare.ts (직접 넣은 것과 비교), latex-view.ts (보고서용 수식 보기), http.ts
  - lib/figure/points.ts: 점 위치 계산을 엔진에서 떼어 냄 (엔진이 만드는 PNG 가 바뀌기 전과 바이트까지 같음을 확인). lib/figure/validate.ts: 그림 명령 검사
  - 서버 주소: app/api/read/page, app/api/read/figure (5단계 화면이 쓸 것). 배포(6단계) 전에 남이 이 주소로 요금을 쓰지 못하게 막는 방법을 사용자에게 물어 정할 것
  - 한글 생성기 보완: 문항 label("[서술형 1]" 같은 번호), bogi(<보기> 상자), 문제 글 여러 문단({"t": "\n"}), break_before "page", 부분(section)의 break_before. 1~3단계 결과는 그대로임을 확인
  - 스크립트:
    - node scripts/check-ai.mjs : 요금 없는 점검 (답 모양 제한, 그림 명령 검사, 지시문 예시, 합치기 왕복, 사진 크기)
    - node scripts/read-samples.mjs [사진 이름] [--cached] : samples 를 AI 로 읽음 (요금 듦). 결과 output/ai/*.page.json · *.figures.json · *.exam.json, 요금 기록 output/ai/usage.json. --cached 는 저장해 둔 결과만 씀
    - node scripts/report-samples.mjs [--fonts=<부분 글꼴 폴더>] : output/ai/report.html 비교 보고서 (원본 · AI 그림 · 직접 만든 그림 나란히). 점검 페이지로 올릴 때는 --fonts 로 글꼴을 넣는다
      (글꼴: https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_six@1.2/S-CoreDream-{4Regular,5Medium,6Bold}.woff 와 public/fonts 의 Liberation Serif 를 한 폴더에 모아 python3 scripts/subset-fonts.py)
    - python3 scripts/make_hwpx.py <시험지.json> <출력.hwpx> : AI 결과로 한글 파일
  - 키가 생기면 할 일: check-ai → read-samples → report-samples → 보고서와 한글 파일(이름을 새로 붙여)을 사용자에게 보내고, 결과가 나쁜 곳은 지시문(prompts.ts)을 고쳐 다시 읽기 (--cached 로 요금 아끼기). 쓴 요금을 사용자에게 알린다
  - 사용자 결정(2026-10-28): 키는 이 작업 환경이 아니라 배포한 프로그램의 설정 화면에 넣는다. 그 키로 samples 를 읽어 품질이 괜찮은 가장 싼 모델을 고른다
    (배포한 프로그램의 /api/read/page·figure 에 model 을 바꿔 보내 시험. 요금은 설정의 월별 기록에 남는다)
- 설정·보관함·배포 (사용자 요청으로 6단계 일부를 먼저 함). 설계: docs/설계-설정-저장-배포.md
  - 사용자 결정: 저장은 기존 Supabase 프로젝트 aiapp(vypnobpmyadtcvxhtagn, 서울)에 exam_ 표와 exam-files 보관함을 따로. 비밀번호 3035 는 프로그램 전체. 월별 요금은 프로그램이 직접 기록
  - 화면: / (시험지 만들기), /archive (보관함), /settings (API 키·모델·월별 요금·비밀번호), /login
  - 배포: Vercel 팀 themonsteredu, 프로젝트 exam-maker (prj_JayN6FC5KzNlcDowvuG0lw1GJafo), 서버 지역 icn1(서울)
    - 주소: https://exam-maker-one.vercel.app (또는 exam-maker-themonsteredu.vercel.app). 보호를 "all" 로 바꿔 둠: 버셀에 로그인한 팀원만 열리고, 그다음 비밀번호 3035
      (팀 기본값 "사용자 도메인 말고 모두" 에서는 exam-maker-one.vercel.app 이 누구에게나 열렸다. 숫자 4자리 비밀번호만으로 공개하지 않으려고 바꿈.
      선생님들도 쓰게 하려면 사용자와 정해서 보호를 풀고 더 긴 비밀번호로)
    - 깃허브 기본 브랜치가 옛 claude/new-session-65lm7i 라서 Vercel 실서비스 브랜치도 그것이다. 그래서 Ignored Build Step
      ([ "$VERCEL_ENV" != "production" ] || [ "$VERCEL_GIT_COMMIT_REF" != "claude/lucid-sagan-4tgi0y" ]) 로 미리보기와 다른 브랜치는 빌드하지 않고,
      실서비스 배포는 Vercel MCP create_deployment (gitSource ref claude/lucid-sagan-4tgi0y, target production) 로 직접 한다 (push 만으로는 배포되지 않는다)
    - 팀 요금제는 무료(Hobby)로 보인다 (청구 내역 없음). Hobby 는 빌드를 한 번에 하나만 한다
    - 시험: 공유 링크(get_access_to_vercel_url) → node <scratchpad>/e2e/deployed-flow.mjs 로 로그인·보관·한글 파일·내려받기·지우기 확인
  - Vercel 환경변수에 비밀값이 없다. 저장 창구(supabase/functions/exam-gateway)는 Vercel OIDC 토큰(프로젝트 exam-maker, production·preview)만 받아들이고,
    로그인 쿠키 서명 열쇠와 API 키 암호화는 창구가 Supabase 서비스 열쇠로부터 만들어 한다. 미들웨어는 쿠키 모양·만료만, 서버 주소가 서명·세션 판까지 확인
    - 비밀값을 대화 기록에 찍지 않는다 (보안 검사가 막는다). 시험용 공유 비밀값(EXAM_GATEWAY_SECRET)은 이 작업 환경 scratchpad 파일에만 있다
  - Supabase 보관함은 한글 파일 이름을 받지 않는다 → 보관함 안 이름은 1.jpg·<시각>.hwpx, 한글 이름은 내려받기 주소의 download= 에 한 번만 인코딩해 붙인다
    (이 작업 환경 브라우저는 C 로캘이라 한글 이름이 download 로 보인다. LANG=C.UTF-8 로 띄우면 제대로 나온다)
  - 로그인 제한: DB 함수 exam_login_begin (15분 같은 곳 10번, 모두 50번, 24시간 200번). 동시에 보내도 건너뛰지 못함을 확인
