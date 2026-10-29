// 설정 화면에서 보여 줄 모델 설명과 어림 요금 (2026-10 공식 요금표 기준).
// 어림 요금은 쪽 하나(사진 1장, 지시문 약 3~4천 토큰, 답 약 8천 토큰)와 그림 하나(입력 약 9천, 답 약 1만 토큰)를 가정한 값.
// 실제 요금은 AI 가 생각하는 양에 따라 달라지므로, 정확한 값은 설정의 월별 기록을 본다.

export type ModelInfo = {
  id: "claude-haiku-5-5" | "claude-sonnet-5-5" | "claude-opus-5-5";
  name: string;
  note: string;
  /** 100만 토큰당 달러 */
  price: { input: number; output: number };
  /** 어림 요금 (달러) */
  perPage: number;
  perFigure: number;
};

export const MODEL_INFO: ModelInfo[] = [
  {
    id: "claude-haiku-5-5",
    name: "Haiku 5.5",
    note: "가장 쌉니다. 글 옮기기에는 쓸 만할 수 있지만 그림 읽기 품질은 시험해 봐야 합니다.",
    price: { input: 0.1, output: 0.5 },
    perPage: 0.005,
    perFigure: 0.005,
  },
  {
    id: "claude-sonnet-5-5",
    name: "Sonnet 5.5",
    note: "중간 값입니다. Opus 5.5 의 절반 요금입니다.",
    price: { input: 2, output: 10 },
    perPage: 0.09,
    perFigure: 0.11,
  },
  {
    id: "claude-opus-5-5",
    name: "Opus 5.5",
    note: "가장 정확합니다. 그림과 도표 읽기가 가장 낫습니다.",
    price: { input: 4, output: 20 },
    perPage: 0.19,
    perFigure: 0.22,
  },
];

/** 1달러를 원으로 (화면 표시용 어림값) */
export const KRW_PER_USD = 1400;

/** 25문항 시험지 한 부(약 7쪽, 그림 약 12개)의 어림 요금 */
export function examEstimate(page: ModelInfo["id"], figure: ModelInfo["id"], pages = 7, figures = 12): number {
  const p = MODEL_INFO.find((m) => m.id === page)?.perPage ?? 0;
  const f = MODEL_INFO.find((m) => m.id === figure)?.perFigure ?? 0;
  return p * pages + f * figures;
}
