// 시험지 데이터에 든 그림 명령을 모두 PNG 로 그린다.
// 브라우저에서 돈다 (확인 화면과 scripts/render-figures.mjs 가 같이 쓴다).
// 결과 PNG 는 base64 글자로 figure.png 에 넣어서 한글 파일 만드는 쪽(Python)에 보낸다.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadFigureFonts, pxForPrint, renderFigurePng } from "./engine";
import type { FigureSpec } from "./types";

export const DEFAULT_FIGURE_DPI = 360;

export type ExamFigure = {
  commands?: FigureSpec;
  width_mm?: number;
  size_mm?: [number, number];
  /** 확인 화면에서 옮긴 자유점 위치 (점 이름 → 기준점에서의 거리) */
  gliders?: Record<string, number>;
  png?: string;
  png_size?: [number, number];
  [key: string]: unknown;
};

export type FigureRenderResult = {
  section: number;
  index: number;
  no: number | string;
  png?: string;
  size?: [number, number];
  error?: string;
};

function figureWidthMm(fig: ExamFigure): number {
  return fig.width_mm ?? fig.size_mm?.[0] ?? 50;
}

/** 그림 명령이 있는 문항마다 PNG 를 만든다. 실패한 그림은 error 에 까닭을 적는다. */
export async function renderExamFigures(JXG: any, exam: any, dpi = DEFAULT_FIGURE_DPI): Promise<FigureRenderResult[]> {
  await loadFigureFonts();
  const results: FigureRenderResult[] = [];
  const sections: any[] = Array.isArray(exam?.sections) ? exam.sections : [];
  for (let s = 0; s < sections.length; s++) {
    const items: any[] = Array.isArray(sections[s]?.items) ? sections[s].items : [];
    for (let i = 0; i < items.length; i++) {
      const fig: ExamFigure | undefined = items[i]?.figure;
      if (!fig?.commands || !Array.isArray(fig.commands.elements)) continue;
      const base = { section: s, index: i, no: items[i].no };
      try {
        const out = await renderFigurePng(JXG, fig.commands, {
          widthPx: pxForPrint(figureWidthMm(fig), dpi),
          gliders: fig.gliders,
        });
        results.push({ ...base, png: out.dataUrl.slice(out.dataUrl.indexOf(",") + 1), size: [out.width, out.height] });
      } catch (err) {
        results.push({ ...base, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return results;
}

/** renderExamFigures 결과를 시험지 데이터에 붙인 사본을 돌려준다. */
export function attachFigurePngs(exam: any, results: FigureRenderResult[]): any {
  const copy = JSON.parse(JSON.stringify(exam));
  for (const r of results) {
    const fig = copy.sections?.[r.section]?.items?.[r.index]?.figure;
    if (!fig) continue;
    if (r.png) {
      fig.png = r.png;
      fig.png_size = r.size;
      delete fig.render_error;
    } else {
      delete fig.png;
      fig.render_error = r.error;
    }
  }
  return copy;
}
