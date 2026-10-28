// scripts/render-figures.mjs 가 브라우저(Playwright) 안에서 부르는 시작점.
import { attachFigurePngs, renderExamFigures } from "@/lib/figure/render-exam";

/* eslint-disable @typescript-eslint/no-explicit-any */
(window as any).renderExam = async (exam: any, dpi?: number) => {
  const results = await renderExamFigures((window as any).JXG, exam, dpi);
  return { exam: attachFigurePngs(exam, results), results: results.map(({ png, ...rest }) => ({ ...rest, ok: !!png })) };
};
