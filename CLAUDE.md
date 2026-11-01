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
    - 주소: https://exam-maker-one.vercel.app (누구나 열림, 그다음 비밀번호 3035). 보호는 all_except_custom_domains (2026-10-28 사용자 요청으로 "all" 에서 되돌림):
      exam-maker-one.vercel.app 만 공개, exam-maker-themonsteredu.vercel.app 과 배포마다 붙는 주소는 버셀 로그인이 필요하다 (시험은 공개 주소로)
    - 깃허브 기본 브랜치가 옛 claude/new-session-65lm7i 라서 Vercel 실서비스 브랜치도 그것이다. 그래서 Ignored Build Step
      ([ "$VERCEL_ENV" != "production" ] || [ "$VERCEL_GIT_COMMIT_REF" != "claude/lucid-sagan-4tgi0y" ]) 로 미리보기와 다른 브랜치는 빌드하지 않고,
      실서비스 배포는 Vercel MCP create_deployment (gitSource ref claude/lucid-sagan-4tgi0y, target production) 로 직접 한다 (push 만으로는 배포되지 않는다)
    - 팀 요금제는 무료(Hobby)로 보인다 (청구 내역 없음). Hobby 는 빌드를 한 번에 하나만 한다
    - 시험: node <scratchpad>/e2e/deployed-flow.mjs <출력 폴더> https://exam-maker-one.vercel.app/ (로그인·보관·한글 파일·내려받기·지우기),
      node <scratchpad>/e2e/deployed-devices.mjs https://exam-maker-one.vercel.app <출력 폴더> (기기별 열쇠·모델, 가짜 열쇠는 Anthropic 이 거절)
  - Vercel 환경변수에 비밀값이 없다. 저장 창구(supabase/functions/exam-gateway)는 Vercel OIDC 토큰(프로젝트 exam-maker, production·preview)만 받아들이고,
    로그인 쿠키 서명 열쇠와 API 키 암호화는 창구가 Supabase 서비스 열쇠로부터 만들어 한다. 미들웨어는 쿠키 모양·만료만, 서버 주소가 서명·세션 판까지 확인
    - 비밀값을 대화 기록에 찍지 않는다 (보안 검사가 막는다). 시험용 공유 비밀값(EXAM_GATEWAY_SECRET)은 이 작업 환경 scratchpad 파일에만 있다
  - Supabase 보관함은 한글 파일 이름을 받지 않는다 → 보관함 안 이름은 1.jpg·<시각>.hwpx, 한글 이름은 내려받기 주소의 download= 에 한 번만 인코딩해 붙인다
    (이 작업 환경 브라우저는 C 로캘이라 한글 이름이 download 로 보인다. LANG=C.UTF-8 로 띄우면 제대로 나온다)
  - 로그인 제한: DB 함수 exam_login_begin (15분 같은 곳 10번, 모두 50번, 24시간 200번). 동시에 보내도 건너뛰지 못함을 확인
    (모두 합친 제한은 남이 일부러 틀려 원장님을 막을 수 있다. 지금은 버셀 로그인 뒤에 있어 바깥 사람은 로그인 주소에 닿지 못한다)
  - 배포 전 점검(워크플로: 보안·흐름·Python, 각각 반박 검증)에서 고친 것: AI 그림 식 실행 막기, 로그인 뒤 이동 주소, Python 세션 판,
    사진 크기 한도(JPEG 로 낮춤), AI 읽기 시간 예산 280초, 파일 미리 확인(50MB·HEIC), 실패 때 남은 그림 읽기 멈춤, 원본·한글 파일 따로 보관,
    pdf.js legacy 판, 세션 판 낡은 기억, 한국 시간 달, 제목 상자 없는 시험지, 알림 머리말 크기, 한글 파일 요청 4.3MB(넘으면 300dpi)
  - 사용자 결정(2026-10-28, 배포 뒤): "점검 그만하고 올려". 다른 사람도 쓰게 한다 → 버셀 로그인 막음을 풀고(보호 all_except_custom_domains),
    AI 열쇠는 각자 설정에서 넣는다
    - 기기별 열쇠 (배포 완료 2026-10-28, 실서비스 dpl_7u5QKqvAQbPdsgJPKJKXu3cVNZRD, 커밋 10d9692, 창구 v5): 쿠키 exam_device(무작위, HttpOnly, 400일, 미들웨어가 붙임)
      → 그 SHA-256 으로 exam_devices 표에 열쇠(창구가 잠금)·모델. 요금은 열쇠별(key_tag) 기록·표시. 키 없는 기기의 AI 읽기는 바로 거절
      (서버 환경변수 키로 넘어가지 않음). 공개 주소에서 두 기기 분리·가짜 열쇠 거절·보관·한글 파일·지우기 모두 확인
    - 마이그레이션 20261029_exam_devices.sql 은 지우는 문장(drop) 없이 새 함수 exam_usage_monthly_by_key 를 더하기만 한다
      (drop 이 있던 판은 apply_migration 이 사용자 허락 창을 띄웠고 두 번 모두 답이 없어 시간 초과. 더하기만 하는 판은 창 없이 적용됨)
    - 구독: 사용자는 Max (아이폰 앱으로 구독한 것으로 보임). 웹 프로그램은 구독 로그인으로 못 돌린다 (code.claude.com/docs/en/legal-and-compliance).
      대신 Max 에 든 매달 API 크레딧(5x 100달러, 20x 200달러, 달마다 사라짐, 7일 뒤부터)을 claude.ai 웹 설정 → 결제 → API credits 에서 콘솔 조직에 연결하고,
      그 조직의 키를 설정에 넣으면 이 프로그램이 크레딧으로 돈다 (platform.claude.com/docs/en/about-claude/api-credits-for-subscribers).
      크레딧은 계정 주인만 쓸 수 있다 (anthropic.com/legal/credit-terms) → 다른 선생님은 각자 키.
      다른 길(claude.ai 안에서 여는 페이지의 sample 기능: 보는 사람 구독으로 돌지만 사진을 약 1.2MP 로 줄이고 바깥 연결이 막혀 한글 파일 만들기를 브라우저로 옮겨야 함)은
      크레딧으로 충분하면 만들 필요 없음
  - 첫 실제 시험(2026-10-29, 문성중 1-2 중간 4쪽 23문항, Opus, 1.15달러): 글이 거의 비고 그림도 부정확. 원인: 캐논 복사기 스캔 PDF 는
    흐린 배경 JPEG(150ppi) 위에 인쇄 글자가 CCITT 흑백 층(300ppi)으로 따로 있는데, pdf.js 6.4 가 wasmUrl 없이 해독기를 못 띄워 그 층을 말없이 건너뜀
    → AI 가 흐린 배경만 받음. 고침: public/pdfjs 에 wasm·cmaps·standard_fonts·iccs (scripts/copy-pdfjs-assets.mjs, 판은 check-ai 가 확인),
    getDocument 에 wasmUrl·cMapUrl·standardFontDataUrl·iccUrl. 미리 확인: 같은 쪽을 보통·엄격(stopAtErrors)으로 그리기 명령 수를 세어 엄격 쪽이 적으면
    "빠짐" (pdf.js 6.4 는 엄격이어도 오류를 내지 않고 명령을 비운다) → AI 요금 전에 "그래도 만들까요?" 확인, 결과 알림에도 남김.
    미들웨어는 /pdfjs/ 를 막지 않는다. 사용자 PDF 로 실제 화면에서 확인 (글자 또렷, 해독기를 막으면 확인 창이 뜨고 AI 요청 0번)
  - 두 번째 실제 시험(00:30 UTC, 배포 2분 뒤)도 같은 결과: 배포 전에 열어 둔 창(예전 판 화면 코드)으로 만듦 (4번 그림의 x 가 예전 글꼴, 15 도 기울어 있어 확인).
    고침: next.config 의 NEXT_PUBLIC_APP_VERSION(VERCEL_DEPLOYMENT_ID) 과 /api/version 을 견줘, 예전 판이면 AI 요금 전에 멈추고 "화면 새로 고치기" 알림
    (lib/client/version.ts, 만들기 화면은 창으로 돌아올 때도 확인). 배포한 뒤에는 사용자에게 꼭 새로 고치라고 말할 것
  - 2026-10-29 배포 dpl_35vk5pLmN4DJTiN9r6JyAVeXu5Yi (커밋 81b8296: 스캔 PDF 고침 + 기울인 글자 글꼴 + 판 확인). 실제 사이트에서 새 화면은 통과, 예전 판 흉내는 AI 요청 0번으로 멈춤
  - 사용자 요청 "배포머지": 깃허브 기본 줄기 claude/new-session-65lm7i 는 뿌리가 다른 예전 1단계 시험판 커밋 하나였다 (hwp/ 등, py/exam_hwpx 가 대신함).
    합치기 커밋 98960ab (부모: 기본 줄기 8ac96d9 + 작업 줄기 81b8296, 내용은 작업 줄기 그대로)를 두 줄기에 올려 지금은 두 줄기가 같다.
    앞으로 작업 줄기에 올린 것은 기본 줄기에도 그대로(빨리 감기로) 올린다. 기본 줄기에 올려도 Ignored Build Step 때문에 Vercel 이 다시 빌드하지 않는다
- GPT(Codex)로 이어서 한 작업 되돌리기 (2026-11-01, 사용자 결정 "2단 본문으로 되돌리기"):
  - 사용자가 GPT 로 PR #8~#11 (88c7ccb..595e84f) 을 올렸는데 결과가 나빴다: 원본 배치 따라 하기(source layout, 글 상자 160개를 쪽 위치에 띄움)로
    쪽 수 두 배·낱말 중간 줄바꿈·선택지 빠짐, 원본 조각(머리말·꼬리말·지도·사진) 붙이기, 점 이름 자동 옮기기로 그림 망가짐,
    그림 하나 못 읽으면 한글 파일 만들기 전체 멈춤, 절약 모드가 설정 모델 대신 Sonnet 강제, SDK 다시 보내기 끔, 지시문 모순으로 조건 상자가 문제 글에서 빠짐
  - 되돌림: 2단 본문만 (builder 의 source 갈래, source_layout.py·layout_safety.py·graphic.py 삭제), 원본 조각 경로 모두 삭제(FigureReview·sourceFigureImage·renderOriginalPng),
    그림 엔진은 88c7ccb 판(label-layout.ts 삭제), 쪽 읽기는 구조화 출력 + PageReadingS (layout_blocks·page_artifacts·page_rules 없음), SDK maxRetries 3(마감 있으면 1/0),
    모델은 설정 화면 값, 읽기 기억 판 two-column-v2
  - 살림: 큰 시험지 4MB 조각 보관(exam-storage.ts, api/hwpx.py input_paths, staging.py), 요금 없이 다시 만들기(보관함 "다시 만들기", 완료 문서도),
    읽기 기억(read-cache.ts), 그림 여러 개(extra_figures), 표·지도·통계 그래프·삽화는 graphic 명령 → canvas PNG(사진은 "사진 자리" 빈 상자),
    굵게·밑줄, 배점 중복 막기(괄호 (4점)·[총 6점]도), \triangle·\parallel, 오류 상세(apiErrorDetail), 실패한 읽기 요금 기록, allowFallback 기본 끔
  - 새로 넣음: 그림 읽기가 잠깐 실패(인터넷·500·503·504·AI 서버 바쁨)하면 4초·15초 뒤 두 번 더 시도, 그래도 안 되면 그 그림만 "그림 자리" 빈 상자로 두고 파일은 만든다.
    선택지가 모두 그림이면(빈 선택지 수 = 그림 수, 또는 선택지 없이 묻는 문장 + 그림 4~5개) ①~⑤ 를 붙여 테두리 없는 2열 표로(builder picture_choices·build_choice_figures).
    GPT 판 읽기 결과는 다시 만들 때 normalizeLegacyExam 으로 바꾼다(그림 크기 다시 계산, layout_blocks 에만 있던 조건 상자는 cond_box, <보기>는 bogi)
  - AGENTS.md: Codex 등 다른 도구도 이 규칙을 따르게 함. CI(.github/workflows/exam-regression.yml)는 요금 없는 검사만
  - 배포 2026-11-01 dpl_F1qLCZhXUxYyf6uJbLMXKyjEj4LN (커밋 f410b67, 두 줄기 같음). push 로 생긴 자동 빌드는 Ignored Build Step 이 둘 다 취소했고 실서비스는 MCP create_deployment 로 올림.
    실제 사이트에서 시험용 문서로 '다시 만들기' 확인(12초, 2단·24문항·그림 20·조건 상자, 문서 지움): scratchpad/e2e/live-resume.mjs <출력 폴더> <exam.json>
  - 확인: 저장해 둔 읽기 결과 3개(금호중 10-30·10-31, 조대부중 11-01)로 요금 없이 다시 만들어 구조 확인 (2단, 문항·선택지·수식 모두, 그림 선택지 표, 빈 자리, 조건 상자).
    1·3단계 결과는 그림 PNG 까지 같음(기울인 x 글꼴과 GPT 의 \triangle 표기만 다름)
- 대자중 시험지 보완 (2026-11-01, 사용자 "맘에 안 들어, 너가 봐봐"): 사용자가 GPT 판으로 읽은 대자중(문서 62beb9f2, 제목은 금호중으로 잘못 붙음)을
  내 판의 '다시 만들기'로 받은 파일. 원본과 비교해 고친 것 (커밋 a8f197d, 배포 dpl_8ELXBeneyYbvRDGfoRvVbuKx6xXc):
  - 선택지 배치를 원본대로: 쪽 읽기 ItemReadingS.choice_layout(column/row/grid), GPT 판은 layout_blocks 의 choice 자리로 추정.
    builder choice_columns: row 면 5→3→2 개, grid 면 3→2 개를 단 너비에 들어가는지 재서(piece_width_mm, estimate_text_width·measure_equation) 테두리 없는 표로. 모르면 한 줄에 하나(3단계 모양)
  - 그림 수 = 선택지 수(4개 이상)면 그림 선택지 칸(번호·그림·선택지 글). 선택지 표(칸에 ①~⑤)와 선·글자 없는 표 자료는 한글 표(build_native_table)
  - 응시대상 값이 없으면 머리를 굵은 상자 하나(제목 줄 + 날짜 줄)로 (build_simple_header). exam_p1 처럼 응시대상이 있으면 예전 그대로
  - add_rich_text 가 __**글**__ 처럼 겹친 표시도 푼다. 배점은 마지막 문단 끝(3단계 자리)으로 되돌림
  - tidyExam: 앞뒤 번호 사이 혼자 어긋난 번호(14→5→16) 고침 (만들기·다시 만들기 모두)
  - 안내 상자: 쪽 읽기 boxes 에 before(다음 문항 no_text) 추가 → 머리 아래는 exam.boxes, 쪽 중간은 그 문항 boxes_before, 끝은 boxes_after.
    GPT 판은 둘째 쪽부터의 notice text_blocks(저작권 안내 등)를 boxes_after 로. 읽기 기억 판 two-column-v3-boxes
  - 이 문서의 원래 GPT 판 읽기 결과는 보관함에 남아 있다(generated/62beb9f2…/926cd242….bin). 지금 문서의 exam_json 은 04:39 다시 만들기로 바뀐 판(선택지 자리 정보 없음)이라
    보관함에서 다시 만들기를 하면 선택지가 한 줄에 하나씩 나온다. 보낸 파일(대자중_원본처럼_고침_1101.hwpx)은 원래 읽기 결과로 만든 것
  - 남은 것: 서술형4 b·l 글자 겹침(AI 가 정한 자리). 서술형 유의사항 상자는 AI 가 읽어 두었고(GPT 판 source_pages[].boxes) 이제 살린다
- 대자중 두 번째 의견 (사용자 한글 화면 사진: "그래프 문자 분수 이상, 수식과 글자 겹침, 문제 배열 이상, 여백이 왜 나와"):
  - 수식 겹침: python-hwpx 측정기가 한글보다 좁게 잰다 ("2:3=x:6을" 의 6과 을, "0.5x-1.7의" 의 7과 의가 겹침). 화면 사진에서 잰 값으로 builder.py 가 시작할 때
    hwpx.equation.measure 의 _DIGIT 0.51, _PUNCT 0.26, _OPERATOR_SPACE 0.27, 기울인 x 0.58, ':' 를 관계 기호(0.35+양옆)로 바꿔 잰다 (넓으면 빈칸, 좁으면 겹침)
  - 빈 공간: 양식의 item_gap_pt 40(풀이 공간) → 12. 원본의 단·쪽 나눔(break_before)을 만들지 않고 tidyExam 이 예전 결과의 것도 지운다 → 문항이 2단에 이어서 흐른다
  - 그림 글자: label 글자에 = < > 나 간단한 분수(15/x)가 있으면 engine.mathLabel 로 그린다 (영문 기울임·숫자 바로·연산자 둘레 띄움·분수는 위아래로 쌓고 가로줄,
    조각마다 기준선 맞춤). 예시 A~F 와 3단계 그림에는 이런 글자가 없어 그림이 바뀌지 않는다
  - 1·3단계 결과물(output/*.hwpx)은 이 두 가지(문항 사이 간격, 수식 상자 너비) 때문에 다시 만들면 달라진다. 저장소의 파일은 그대로 둠
- 대자중 세 번째 의견 ("캡처한 곳은 고쳐졌는데 다른 겹침 남음, 문제가 단·쪽에서 잘림 → 원본과 동일하게, 그림과 각도 숫자 비율이 안 맞는 것 하나"):
  - 단·쪽 나눔: 원본 자리에서 다시 나눈다 (assemble 의 break_before 되살림, tidyExam 은 지우지 않음). 문항 사이 간격은 12pt 그대로.
    builder.build_item 이 한 문항의 문단을 '다음 문단과 함께(keepWithNext)'·'문단 보호(keepLines)'로 묶어 단·쪽 사이에서 잘리지 않게 하고, 부분 제목도 다음 문항과 붙인다
  - 수식 겹침 더: 따옴표 안 기호(△ ⊥ ∥ ≡ ① …)를 0.95em 으로 잼(측정기는 0.4), 목록에 없는 관계 기호 0.72, 상자 여유 = 너비×3% + 글자 크기×0.35.
    \triangle 은 3단계에서 확인받은 한글 수식 기호 TRIANGLE 로 되돌림 (GPT 판 {rm "△" it} 는 좁게 재져 "(SAS합동)" 등과 겹침)
  - 원본 비교 워크플로(7 에이전트, 쪽 5 + 그림 2) 결과로 더: 원본에서 두 단에 걸친 문항(12번: 영역이 쪽 가운데를 넘음, spansIntoNextColumn)은
    split_ok 로 묶지 않고, 그 다음 문항의 단 나눔은 지운다 (통째로 옮기면 다음 단 나눔이 빈 단을 만듦). GPT 판 source_pages[].boxes(둘째 쪽부터)를
    새 부분 첫 문항 앞(boxes_before) 또는 그 쪽 마지막 문항 뒤로. 소문항 (1)·(2) 가 있으면 그림을 그 앞에. 세로 글자의 띄어쓰기는 빈 줄로 만들지 않음.
    그림 선 굵기 최소 LINE_MIN_MM 0.2mm(lineFit), 글자 최소 3.0mm. 원문자(㉠…)는 그대로 읽게 지시문 보강. 15번 "5." 는 원본 인쇄 오류(1 이 비어 있음)
  - 사용자 "아직도 한 단에 한 문제 넣고 아래 여백 비우고 다음 줄 가는 게 많음": 원인은 우리 글(11pt, 줄 간격 180%)이 원본보다 길어 단이 넘치고,
    원본 자리의 단·쪽 나눔이 그 뒤에 빈 단을 만듦 (python-hwpx 쪽 어림 hwpx.layout.pages.estimate_pages: 대자중 5쪽 → 8쪽).
    고침: builder.build_exam 이 만든 뒤 쪽을 어림해서(estimated_pages, 글 옆에 띄운 그림은 어림기가 못 다뤄 빼고 잼) 원본 쪽 수(source_pages)보다 많으면
    FIT_STEPS 대로 줄 간격 → 글자 크기(10.5→10→9.5pt) → 문항 사이 → 그림 크기(0.9→0.8)를 줄여 다시 만든다. 끝까지 넘치면 단 나눔, 그다음 쪽 나눔을 풀어 빈 단이 안 생기게.
    대자중은 2단계(10.5pt, 160%/145%)에서 원본과 같은 배열(1쪽 1·2|3·4·5 … 5쪽 서술형3·4|서술형5). 금호중·조대부중은 맞춤 없이 원본 쪽 수 안.
    점검: python3 <exam-work>/regen/where.py <파일.hwpx> (문항마다 몇 쪽 몇 단, 단마다 마지막 줄 위치)
  - 사용자 화면 사진 "∠c 의, ∠a , 처럼 수식 뒤 조사 띄어쓰기 / 그림 옆 줄 낱말 사이 / 서술형4 선이 짧고 비좁음 / 문제는 왼쪽 정렬":
    화면에서 잰 실제 너비 ≈ 보정한 측정값이라 덧붙인 여유가 원인 → EQ_PAD_EM 0.08, 비율 0. (이 때의 너비 값은 아래 '하나하나 찾아줘야' 항목에서 다시 맞춤)
    수식 바로 뒤 글의 "띄어쓰기+조사(을 를 의 이 가 은 는 와 과 에 로 일 인 이다 라 …)" 는 붙인다(_PARTICLE_AFTER_EQ).
    문제 글·<보기>·안내 상자는 왼쪽 정렬(양쪽 정렬이면 수식 줄·그림 옆 줄에서 낱말 사이가 벌어짐).
    그림 지시문 6번: 직선은 교점 너머로 충분히 길게, 직선 이름은 선 끝 바깥, 각 글자는 각 안 빈 곳 (읽기 기억 판 two-column-v5-lines).
    보낸 대자중 파일(고침7)의 서술형4 그림은 직선 끝점·글자 자리를 손으로 고쳤다 (그림 notes 에 적어 둠)
  - 사용자 "아직도 이런 겹침(MN의), 하나하나 찾아줘야 고칠거야?" → 수식 너비를 사진 세 장(6·7·9.png)으로 다시 맞춤 (scripts/check_eq_width.py, CI 에 넣음):
    - 한글(윈도)은 파일의 수식 상자 너비를 그대로 쓰고 수식을 상자 왼쪽에 붙여 그린다 (넘치면 오른쪽으로만 넘침).
    - 예전 보정은 사진의 글자 크기(px/em)를 잘못 잡아(9.png 를 21px 로, 실제 26px) 값이 틀렸다. 이번에는 사진마다 1em 을
      함초롬바탕 한글 간격(0.9676em, hwpx.form_fit char_advance)과 '상자 끝 = 바로 뒤 글자 시작'으로 따로 재서 맞춤 (6.png 25.94, 7.png 23.77, 9.png 26.03px)
    - 결과: python-hwpx 기본값이 대부분 맞았다. 바꾼 것: 숫자 0.5, 소수점 0.25, 연산자 양옆 0.2, ':' 는 관계 기호(0.27+양옆), 분수 양쪽 0.14,
      기울인 c 0.44, ° (circ) 기호 하나 0.5, %·?·*·@ 넓게, '~' 0.4, 따옴표 안 기호(□△①㉠ 0.95, ⊥∽≡ 0.75),
      바로 세운 영문은 Times 너비(M 0.889 등, 측정기는 대문자 모두 0.67 → "MN의" 겹침),
      angle·triangle 등은 측정기의 연산 기호 목록(OPERATORS)에도 있어 양옆 빈칸까지 재던 것을 기호 하나(_SYMBOL 1.05)로 ("∠a ," 빈칸의 원인)
    - 여유 EQ_PAD_EM 0.06 + 1%. 잰 수식 15개가 모두 뒤 글자와 0.04~0.19em 떨어짐
    - 조사 규칙 보강(점검 워크플로 결과): 수식 뒤 " ," 의 빈칸 지움, 조사 목록 늘림(이므로·만큼·처럼 …), "이 때·이 식" 의 지시어 '이' 는 그대로,
      글로 읽은 숫자 뒤("30% 일 때")도 붙임(_PARTICLE_AFTER_NUMBER)
  - 그림 글자 크기: 인쇄 크기를 알면(render-exam 이 printWidthMm 를 줌) 글자 크기(em)를 LABEL_MM [3.0, 4.3] mm 안으로 맞춘다 (FigureRenderer.labelFit,
    커지면 가장자리 여백 다시 계산). 서술형4 5.5mm → x0.78. 3단계 그림은 3.7~4.5mm 라 거의 그대로(4.53 → x0.95). render-figures 가 맞추기 전 크기를 찍어 준다
  - 비교 검사(워크플로) 결과로 더 고친 것: 테두리 없는 ※ 안내 줄(boxes.framed=false → 상자 없이 줄만), 긴 선택지의 둘째 줄을 번호 뒤 글자에 맞춤(내어쓰기 = "①  " 너비),
    한 줄 꼬리말(notice 가 40자 이하·저작권 문구 아님·right_top 없음 → 왼쪽 notice · 가운데 쪽/전체 · 오른쪽 학교), 새 파일을 고르면 직접 고치지 않은 제목은 새 파일 이름으로
  - 남은 일: 세 모델 비교 → 가장 싼 쓸 만한 조합을 기본값으로. 열쇠가 기기마다 따로라서 read-samples --via 로는 원장님 열쇠를 쓸 수 없다
    → 프로그램 화면 안에 '모델 비교' 기능을 만들어 원장님 기기에서 돌리고, 결과는 보관함(DB)에서 읽어 판단할 것.
    그림 속 기울인 글자: 코드 완료(아직 배포 안 함, 사용자에게 전후 비교 그림 보냄). public/fonts/ExamMathItalic.woff2 = Latin Modern Math 1.959 의 수학 기울임 글자만
      보통 글자 자리(A-Z, a-z, α-ω)에 옮긴 글꼴 (scripts/make-math-italic-font.py, GUST 사용 허락에 따라 이름 바꿈, README·license 같이 둠).
      엔진(lib/figure/engine.ts textFont): 명조 기울인 글자는 'Exam Math Italic' 다음 Liberation Serif (숫자는 세움, italic 은 걸지 않음).
      기울인 글자가 없는 그림은 PNG 가 바이트까지 같음을 확인. 예전 조사: 한글 수식 글꼴 x 와 0.987, Liberation Serif Italic 은 0.089,
    보관함에서 '한글 파일 다시 만들기'(exam_json 은 이미 보관됨), 보관함을 사람마다 나눌지 사용자에게 물을 것
