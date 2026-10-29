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
  source_png?: string;
  source_png_size?: [number, number];
  [key: string]: unknown;
};

export type FigureRenderResult = {
  section: number;
  index: number;
  no: number | string;
  png?: string;
  size?: [number, number];
  error?: string;
  /** PNG 는 만들었지만 알려야 할 것 (글꼴을 못 불러옴 등) */
  warnings?: string[];
};

function figureWidthMm(fig: ExamFigure): number {
  // 한글 파일 만드는 쪽(builder.figure_width_mm)과 같게: 0 이나 빈 값이면 size_mm, 그것도 없으면 50
  return fig.width_mm || fig.size_mm?.[0] || 50;
}

/**
 * 그림이 있는 문항마다 PNG 를 만든다. 그리지 못한 그림은 error 에 까닭을 적는다.
 * 그림 명령이 없거나 모양이 틀린 그림도 error 로 돌려준다 (예전에 만든 PNG 가 남아 들어가지 않게).
 */
export async function renderExamFigures(JXG: any, exam: any, dpi = DEFAULT_FIGURE_DPI): Promise<FigureRenderResult[]> {
  await loadFigureFonts();
  const results: FigureRenderResult[] = [];
  const sections: any[] = Array.isArray(exam?.sections) ? exam.sections : [];
  for (let s = 0; s < sections.length; s++) {
    const items: any[] = Array.isArray(sections[s]?.items) ? sections[s].items : [];
    for (let i = 0; i < items.length; i++) {
      const fig: ExamFigure | undefined = items[i]?.figure;
      if (!fig) continue;
      const base = { section: s, index: i, no: items[i].no };
      if (!fig.commands) {
        if (fig.source_png) {
          results.push({ ...base, png: fig.source_png, size: fig.source_png_size });
        } else {
          results.push({ ...base, error: "그림 명령이 없습니다" });
        }
        continue;
      }
      if (!Array.isArray(fig.commands.elements)) {
        results.push({ ...base, error: "그림 명령에 그릴 것 목록(elements)이 없습니다" });
        continue;
      }
      try {
        const out = await renderFigurePng(JXG, fig.commands, {
          widthPx: pxForPrint(figureWidthMm(fig), dpi),
          minFontPx: pxForPrint(3.5, dpi),
          aspectRatio: fig.size_mm?.[1] ? figureWidthMm(fig) / fig.size_mm[1] : undefined,
          gliders: fig.gliders,
        });
        results.push({
          ...base,
          png: out.dataUrl.slice(out.dataUrl.indexOf(",") + 1),
          size: [out.width, out.height],
          ...(out.warnings.length ? { warnings: out.warnings } : {}),
        });
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
      delete fig.png_size;
      fig.render_error = r.error;
    }
    if (r.warnings?.length) fig.render_warnings = r.warnings;
    else delete fig.render_warnings;
    // 전송용 사본에는 같은 그림을 두 번 싣지 않는다. 원본 exam 은 보존한다.
    delete fig.source_png;
    delete fig.source_png_size;
  }
  return copy;
}
