// 쪽 읽기(1차)에서 AI 가 돌려주는 답의 모양.
// 구조화 출력(답이 꼭 이 모양을 따르게 하는 기능)에 그대로 쓰므로 제한을 지킨다:
//   선택 항목(빠져도 되는 칸)은 모두 합쳐 24개까지, 둘 중 하나 모양(anyOf)은 16개까지.
//   그래서 빠져도 되는 칸이나 null 없이, 없으면 "" · 0 · [] · present:false 로 적게 한다.

import { z } from "zod";

/** 글 조각: kind "t" 는 글, "m" 은 수식(LaTeX) */
export const PieceS = z.strictObject({
  kind: z.enum(["t", "m"]),
  text: z.string(),
});

/** 사진 속 사각형 (보낸 사진의 픽셀, 왼쪽 위가 0,0) */
export const RegionS = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

export const FigureRegionS = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  place: z.enum(["below", "right"]),
  kind: z.enum(["diagram", "table", "map", "chart", "illustration", "photo", "other"]),
});

/** 원본에서 따로 배치할 글 상자. lines는 인쇄된 줄 단위이며 편집 가능한 글/수식이다. */
export const LayoutBlockS = z.strictObject({
  role: z.enum(["stem", "text", "box", "choice"]),
  region: RegionS,
  title: z.string(),
  choice_no: z.int(),
  lines: z.array(z.array(PieceS)),
});

export const ItemReadingS = z.strictObject({
  no: z.int(),
  no_text: z.string(),
  points: z.number(),
  column: z.int(),
  stem: z.array(PieceS),
  bogi: z.array(z.array(PieceS)),
  choices: z.array(z.array(PieceS)),
  figures: z.array(FigureRegionS),
  source: RegionS,
  unsure: z.array(z.string()),
  layout_blocks: z.array(LayoutBlockS).optional(),
});

export const PageReadingS = z.strictObject({
  header: z.strictObject({
    present: z.boolean(),
    title: z.string(),
    target_label: z.string(),
    target: z.string(),
    date: z.string(),
  }),
  boxes: z.array(
    z.strictObject({
      kind: z.enum(["notice", "score", "other"]),
      lines: z.array(z.strictObject({ text: z.string(), center: z.boolean() })),
    }),
  ),
  sections: z.array(z.strictObject({ title: z.string(), items: z.array(ItemReadingS) })),
  footer: z.strictObject({
    present: z.boolean(),
    right_top: z.string(),
    right_bottom: z.string(),
    notice: z.string(),
  }),
  page_end_note: z.string(),
  print_area: RegionS,
  unsure: z.array(z.string()),
  // 옛 읽기 결과도 열 수 있게 선택 칸. 새 변환은 원본의 머리말/안내/꼬리말 영역을 보존한다.
  page_artifacts: z.array(z.strictObject({ kind: z.enum(["header", "notice", "footer"]), region: RegionS })).optional(),
  page_rules: z.array(RegionS).optional(),
});

export type Piece = z.infer<typeof PieceS>;
export type Region = z.infer<typeof RegionS>;
export type FigureRegion = z.infer<typeof FigureRegionS>;
export type ItemReading = z.infer<typeof ItemReadingS>;
export type PageReading = z.infer<typeof PageReadingS>;

/** 구조화 출력이 받지 않는 제한 (정수 칸에 zod 가 붙이는 범위 등). 받은 답은 zod 로 다시 검사한다 */
const UNSUPPORTED = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength"]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k, strip(v)]));
}

/** 구조화 출력에 보낼 JSON 스키마 (zod 스키마에서 만든다) */
export function pageReadingJsonSchema(): Record<string, unknown> {
  return strip(z.toJSONSchema(PageReadingS, { target: "draft-2020-12", unrepresentable: "throw" })) as Record<string, unknown>;
}
