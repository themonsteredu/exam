// 비도형 자료의 안전한 재작성 명령. 임의 SVG/HTML/코드 실행을 허용하지 않는다.
import { z } from "zod";

const n = z.number().finite();
const positive = n.positive();
const color = z.string().regex(/^(#[0-9a-fA-F]{6}|none)$/);
const box = { x: n.nonnegative(), y: n.nonnegative(), w: positive, h: positive };
const point = z.tuple([n, n]);
export const GraphicS = z.strictObject({
  kind: z.enum(["map", "table", "chart", "illustration", "photo"]),
  width: positive.max(4000), height: positive.max(4000),
  paths: z.array(z.strictObject({ points: z.array(point).min(2).max(500), closed: z.boolean(), stroke: color, fill: color, width: positive.max(80), dash: z.boolean() })).max(500),
  ellipses: z.array(z.strictObject({ cx: n, cy: n, rx: positive, ry: positive, stroke: color, fill: color, width: positive.max(80) })).max(300),
  texts: z.array(z.strictObject({ ...box, text: z.string().max(2000), size: positive.max(200), align: z.enum(["left", "center", "right"]), direction: z.enum(["horizontal", "vertical"]) })).max(400),
  tables: z.array(z.strictObject({
    ...box, rows: z.int().min(1).max(30), cols: z.int().min(1).max(30),
    col_widths: z.array(positive).min(1).max(30), row_heights: z.array(positive).min(1).max(30), size: positive.max(200),
    cells: z.array(z.strictObject({ row: z.int().nonnegative(), col: z.int().nonnegative(), row_span: z.int().min(1), col_span: z.int().min(1), text: z.string().max(2000) })).max(900),
  })).max(15),
  critical_labels: z.array(z.string().min(1).max(200)).max(200),
});
export type GraphicSpec = z.infer<typeof GraphicS>;
export type GraphicKind = GraphicSpec["kind"];

export function checkGraphic(raw: unknown) {
  const parsed = GraphicS.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.slice(0, 8).map(i => `${i.path.join(".")}: ${i.message}`), warnings: [] as string[], spec: undefined };
  const s = parsed.data, errors: string[] = [], warnings: string[] = [];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x <= s.width && y <= s.height;
  const inBox = (b: { x: number; y: number; w: number; h: number }) => inside(b.x, b.y) && inside(b.x + b.w, b.y + b.h);
  if (s.paths.reduce((v, p) => v + p.points.length, 0) > 10000) errors.push("선의 꼭짓점이 너무 많습니다");
  if (s.paths.some(p => p.points.some(([x, y]) => !inside(x, y)))) errors.push("선이 그림 영역 밖에 있습니다");
  if (s.ellipses.some(e => !inside(e.cx - e.rx, e.cy - e.ry) || !inside(e.cx + e.rx, e.cy + e.ry))) errors.push("타원이 그림 영역 밖에 있습니다");
  if (s.texts.some(t => !inBox(t))) errors.push("글자가 그림 영역 밖에 있습니다");
  for (const t of s.tables) {
    if (!inBox(t) || t.col_widths.length !== t.cols || t.row_heights.length !== t.rows) { errors.push("표의 영역 또는 행·열 크기가 맞지 않습니다"); continue; }
    const used = new Set<string>();
    for (const c of t.cells) {
      if (c.row + c.row_span > t.rows || c.col + c.col_span > t.cols) { errors.push("표의 병합 칸이 표 밖으로 나갔습니다"); continue; }
      for (let r = c.row; r < c.row + c.row_span; r++) for (let col = c.col; col < c.col + c.col_span; col++) {
        const key = `${r}-${col}`;
        if (used.has(key)) errors.push("표의 병합 칸이 겹칩니다");
        used.add(key);
      }
    }
  }
  const labels = [...s.texts.map(t => t.text), ...s.tables.flatMap(t => t.cells.map(c => c.text))].map(t => t.replace(/\s/g, ""));
  for (const key of s.critical_labels) {
    const word = key.replace(/\s/g, "");
    if (!labels.some(t => word.length < 3 ? t === word : t.includes(word))) errors.push(`필수 표기 누락: ${key}`);
  }
  if (s.kind !== "photo" && !s.paths.length && !s.ellipses.length && !s.texts.length && !s.tables.length) errors.push("재작성할 내용이 비어 있습니다");
  if (s.kind === "table" && !s.tables.length) errors.push("표는 편집 가능한 표 명령으로 작성해야 합니다");
  if (s.kind === "photo" && (s.paths.length || s.ellipses.length || s.texts.length || s.tables.length)) errors.push("사진을 임의 도형으로 대체할 수 없습니다");
  return { spec: errors.length ? undefined : s, errors: [...new Set(errors)].slice(0, 12), warnings };
}
