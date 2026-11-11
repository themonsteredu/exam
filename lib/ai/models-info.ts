// Display estimates use 4K input + 8K output tokens per page and 9K input + 10K output per figure.
import { OPENAI_MODELS, OPENAI_PRICES, type ModelId } from "./models";

export type ModelInfo = {
  id: ModelId;
  name: string;
  note: string;
  price: { input: number; output: number };
  perPage: number;
  perFigure: number;
};

export const MODEL_INFO: ModelInfo[] = [
  { id: "claude-haiku-5-5", name: "Haiku 5.5", note: "저비용 모델입니다. 수식과 도형은 원본과 비교해 확인해 주세요.", price: { input: 0.1, output: 0.5 }, perPage: 0.005, perFigure: 0.005 },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: "복잡한 문항과 도형을 읽는 데 사용할 수 있습니다.", price: { input: 2, output: 10 }, perPage: 0.09, perFigure: 0.11 },
  { id: "claude-opus-5-5", name: "Opus 5.5", note: "복잡한 추론 작업을 위한 Claude 모델입니다.", price: { input: 4, output: 20 }, perPage: 0.19, perFigure: 0.22 },
  { id: "claude-opus-5", name: "Opus 5", note: "이전에 선택한 Opus 5도 사용할 수 있습니다.", price: { input: 5, output: 25 }, perPage: 0.24, perFigure: 0.28 },
  ...OPENAI_MODELS.map((id): ModelInfo => {
    const price = OPENAI_PRICES[id];
    const names = { "gpt-6.1-terra": "GPT-6.1 Terra", "gpt-6.1-sol": "GPT-6.1 Sol", "gpt-6-astra": "GPT-6 Astra" };
    const notes = {
      "gpt-6.1-terra": "시각 자료와 글을 다루는 GPT 모델입니다.",
      "gpt-6.1-sol": "복잡한 문항을 다루는 범용 GPT 모델입니다.",
      "gpt-6-astra": "복잡한 추론 작업을 위한 고성능 GPT 모델입니다.",
    };
    return {
      id, name: names[id], note: notes[id], price,
      perPage: (4_000 * price.input * 1.25 + 8_000 * price.output) / 1_000_000,
      perFigure: (9_000 * price.input * 1.25 + 10_000 * price.output) / 1_000_000,
    };
  }),
];

export const KRW_PER_USD = 1400;

export function examEstimate(page: ModelInfo["id"], figure: ModelInfo["id"], pages = 7, figures = 12): number {
  const p = MODEL_INFO.find((m) => m.id === page)?.perPage ?? 0;
  const f = MODEL_INFO.find((m) => m.id === figure)?.perFigure ?? 0;
  return p * pages + f * figures;
}
