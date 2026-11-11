// 시험지 데이터에 든 그림 명령을 모두 PNG 로 그린다.
// 브라우저에서 돈다 (확인 화면과 scripts/render-figures.mjs 가 같이 쓴다).
// 결과 PNG 는 base64 글자로 figure.png 에 넣어서 한글 파일 만드는 쪽(Python)에 보낸다.
// 원본 사진을 잘라 붙이지 않는다: 그림 명령(commands)은 JSXGraph 로, 표·지도·삽화의 그리기 명령(graphic)은 canvas 로 그리고,
// 둘 다 없는 그림(사진, 읽지 못한 그림)은 PNG 없이 두어 한글 파일에 빈 자리로 들어가게 한다.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadFigureFonts, pxForPrint, renderFigurePng } from "./engine";
import { itemFigures } from "./item-figures";
import type { FigureSpec } from "./types";
import { checkFigureSpec } from "./validate";
import { renderGraphicPng } from "@/lib/graphic/render";
import type { GraphicSpec } from "@/lib/graphic/schema";

export const DEFAULT_FIGURE_DPI = 360;

export type ExamFigure = {
  commands?: FigureSpec;
  /** 표·지도·통계 그래프·삽화를 다시 그리는 명령 (lib/graphic) */
  graphic?: GraphicSpec;
  width_mm?: number;
  size_mm?: [number, number];
  /** 확인 화면에서 옮긴 자유점 위치 (점 이름 → 기준점에서의 거리) */
  gliders?: Record<string, number>;
  png?: string;
  png_size?: [number, number];
  /** 그림을 넣지 못할 때 빈 자리에 적을 말 (사진 자리, 그림 자리) */
  placeholder_note?: string;
  [key: string]: unknown;
};

export type FigureRenderResult = {
  section: number;
  index: number;
  /** 문항 안의 몇 번째 그림인지 (0 은 figure, 1 부터 extra_figures) */
  figureIndex: number;
  no: number | string;
  png?: string;
  size?: [number, number];
  error?: string;
  /** PNG 는 만들었지만 알려야 할 것 (글꼴을 못 불러옴 등) */
  warnings?: string[];
  /** 맞추기 전 그림 글자 인쇄 크기(mm)와 맞춘 배율 (점검용) */
  labelMm?: number;
  labelFit?: number;
  lineMm?: number;
  lineFit?: number;
};

function figureWidthMm(fig: ExamFigure): number {
  // 한글 파일 만드는 쪽(builder.figure_width_mm)과 같게: 0 이나 빈 값이면 size_mm, 그것도 없으면 50
  return fig.width_mm || fig.size_mm?.[0] || 50;
}

const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

/**
 * 문항의 그림마다 PNG 를 만든다. 그리지 못한 그림은 error 에 까닭을 적는다.
 * 그림 명령이 없거나 모양이 틀린 그림도 error 로 돌려준다 (예전에 만든 PNG 가 남아 들어가지 않게).
 * 다시 그리기 대상이 아닌 사진은 알림 없이 빈 자리로 둔다.
 */
export async function renderExamFigures(JXG: any, exam: any, dpi = DEFAULT_FIGURE_DPI): Promise<FigureRenderResult[]> {
  await loadFigureFonts();
  const results: FigureRenderResult[] = [];
  const sections: any[] = Array.isArray(exam?.sections) ? exam.sections : [];
  for (let s = 0; s < sections.length; s++) {
    const items: any[] = Array.isArray(sections[s]?.items) ? sections[s].items : [];
    for (let i = 0; i < items.length; i++) {
      const figures: ExamFigure[] = itemFigures(items[i]);
      for (let f = 0; f < figures.length; f++) {
        const fig = figures[f];
        const base = { section: s, index: i, figureIndex: f, no: items[i].no };
        if (fig.graphic) {
          try {
            const out = await renderGraphicPng(fig.graphic, pxForPrint(figureWidthMm(fig), dpi), figureWidthMm(fig));
            results.push({ ...base, png: base64Of(out.dataUrl), size: [out.width, out.height], ...(out.warnings.length ? { warnings: out.warnings } : {}) });
          } catch (err) {
            results.push({ ...base, error: err instanceof Error ? err.message : String(err) });
          }
          continue;
        }
        if (!fig.commands && (fig.asset_kind === "photo" || fig.placeholder_note === "사진 자리")) {
          results.push(base);
          continue;
        }
        if (!fig.commands) {
          results.push({ ...base, error: "그림을 읽지 못했습니다" });
          continue;
        }
        const checked = checkFigureSpec(fig.commands);
        if (!checked.spec) {
          results.push({ ...base, error: checked.errors.slice(0, 3).join(" / ") });
          continue;
        }
        try {
          const out = await renderFigurePng(JXG, checked.spec, {
            widthPx: pxForPrint(figureWidthMm(fig), dpi),
            gliders: fig.gliders,
            // 인쇄될 크기에 맞춰 그림 글자 크기를 고른다 (너무 크거나 작은 글자)
            printWidthMm: figureWidthMm(fig),
          });
          results.push({
            ...base,
            png: base64Of(out.dataUrl),
            size: [out.width, out.height],
            labelMm: out.labelMm,
            labelFit: out.labelFit,
            lineMm: out.lineMm,
            lineFit: out.lineFit,
            ...(out.warnings.length ? { warnings: out.warnings } : {}),
          });
        } catch (err) {
          results.push({ ...base, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  return results;
}

/** renderExamFigures 결과를 시험지 데이터에 붙인 사본을 돌려준다. */
export function attachFigurePngs(exam: any, results: FigureRenderResult[]): any {
  const copy = JSON.parse(JSON.stringify(exam));
  for (const r of results) {
    const fig = itemFigures(copy.sections?.[r.section]?.items?.[r.index])[r.figureIndex ?? 0];
    if (!fig) continue;
    // GPT 판이 남긴 원본 조각은 한글 파일로 보내지 않는다 (원본 사진을 잘라 붙이지 않는다)
    for (const key of ["source_png", "source_png_size", "original_png", "original_size", "render_mode", "photo_adjustment"]) delete fig[key];
    if (r.png) {
      fig.png = r.png;
      fig.png_size = r.size;
      delete fig.placeholder_note;
      delete fig.render_error;
    } else {
      delete fig.png;
      delete fig.png_size;
      if (r.error) {
        fig.render_error = r.error;
        fig.placeholder_note ??= "그림 자리";
      } else delete fig.render_error;
    }
    if (r.warnings?.length) fig.render_warnings = r.warnings;
    else delete fig.render_warnings;
  }
  return copy;
}
