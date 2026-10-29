import { checkGraphic, type GraphicSpec } from "./schema";
import { FONT_SANS, loadFigureFonts } from "@/lib/figure/engine";

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
export function tableCells(t: GraphicSpec["tables"][number]) {
  const xs = [t.x], ys = [t.y], cw = sum(t.col_widths), rh = sum(t.row_heights);
  t.col_widths.forEach(w => xs.push(xs[xs.length - 1] + t.w * w / cw));
  t.row_heights.forEach(h => ys.push(ys[ys.length - 1] + t.h * h / rh));
  const occupied = new Set<string>();
  const cells = t.cells.map(c => {
    for (let r = c.row; r < c.row + c.row_span; r++) for (let col = c.col; col < c.col + c.col_span; col++) occupied.add(`${r}-${col}`);
    return { ...c, x: xs[c.col], y: ys[c.row], w: xs[c.col + c.col_span] - xs[c.col], h: ys[c.row + c.row_span] - ys[c.row] };
  });
  for (let r = 0; r < t.rows; r++) for (let col = 0; col < t.cols; col++) if (!occupied.has(`${r}-${col}`)) cells.push({ row: r, col, row_span: 1, col_span: 1, text: "", x: xs[col], y: ys[r], w: xs[col + 1] - xs[col], h: ys[r + 1] - ys[r] });
  return cells;
}

export async function renderGraphicPng(raw: GraphicSpec, widthPx: number, widthMm: number) {
  const check = checkGraphic(raw);
  if (!check.spec) throw new Error(check.errors.join(" / "));
  const s = check.spec;
  if (s.kind === "photo") throw new Error("사진은 원본 이미지를 사용합니다");
  await loadFigureFonts();
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(widthPx)); c.height = Math.max(1, Math.round(widthPx * s.height / s.width));
  if (c.width > 10000 || c.height > 10000 || c.width * c.height > 25000000) throw new Error("재작성 이미지가 너무 큽니다");
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(c.width / s.width, c.width / s.width);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const p of s.paths) {
    ctx.beginPath(); p.points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    if (p.closed) ctx.closePath();
    if (p.fill !== "none") { ctx.fillStyle = p.fill; ctx.fill(); }
    if (p.stroke !== "none") { ctx.strokeStyle = p.stroke; ctx.lineWidth = p.width; ctx.setLineDash(p.dash ? [p.width * 4, p.width * 3] : []); ctx.stroke(); }
  }
  ctx.setLineDash([]);
  for (const e of s.ellipses) {
    ctx.beginPath(); ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2);
    if (e.fill !== "none") { ctx.fillStyle = e.fill; ctx.fill(); }
    if (e.stroke !== "none") { ctx.strokeStyle = e.stroke; ctx.lineWidth = e.width; ctx.stroke(); }
  }
  const warnings: string[] = [];
  const text = (t: { x: number; y: number; w: number; h: number; text: string; size: number; align: string; direction?: string }) => {
    const lines = t.direction === "vertical" ? [...t.text.replace(/\n/g, "")] : t.text.split("\n");
    // 글자나 사물의 위치를 임의로 바꾸지 않는다. 공간이 부족하면 비교 화면에서 알린다.
    const minSize = s.width / widthMm * 25.4 / 72 * 8.5;
    let size = Math.max(t.size, minSize);
    ctx.font = `${size}px ${FONT_SANS}`;
    const widest = Math.max(1, ...lines.map(l => ctx.measureText(l).width));
    size = Math.min(size, t.w / widest * size, t.h / Math.max(1, lines.length) / 1.12);
    if (size < minSize * .95) warnings.push(`글자 '${t.text.slice(0, 25)}'의 자리가 좁습니다`);
    ctx.font = `${Math.max(1, size)}px ${FONT_SANS}`; ctx.fillStyle = "#000000";
    ctx.textAlign = t.direction === "vertical" ? "center" : t.align as CanvasTextAlign;
    ctx.textBaseline = "middle";
    const x = t.direction === "vertical" || t.align === "center" ? t.x + t.w / 2 : t.align === "right" ? t.x + t.w : t.x;
    const lineHeight = size * 1.12, top = t.y + (t.h - lineHeight * lines.length) / 2;
    lines.forEach((l, i) => ctx.fillText(l, x, top + lineHeight * (i + .5)));
  };
  for (const t of s.tables) for (const cell of tableCells(t)) {
    ctx.strokeStyle = "#000000"; ctx.lineWidth = Math.max(1, s.width / 700); ctx.strokeRect(cell.x, cell.y, cell.w, cell.h);
    const pad = Math.min(5, cell.w * .04);
    text({ ...cell, x: cell.x + pad, w: Math.max(1, cell.w - pad * 2), size: t.size, align: "center" });
  }
  s.texts.forEach(text);
  return { dataUrl: c.toDataURL("image/png"), width: c.width, height: c.height, warnings: [...new Set(warnings)] };
}

export async function renderOriginalPng(data: string, adjustment?: { brightness?: number; rotation?: number }) {
  const img = new Image();
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("원본 이미지를 열지 못했습니다")); img.src = data.startsWith("data:") ? data : `data:image/png;base64,${data}`; });
  const angle = Math.max(-5, Math.min(5, Number(adjustment?.rotation) || 0)) * Math.PI / 180;
  const brightness = Math.max(.7, Math.min(1.3, Number(adjustment?.brightness) || 1));
  const c = document.createElement("canvas");
  // 회전하면서 모서리를 잘라내지 않는다.
  c.width = Math.ceil(Math.abs(img.width * Math.cos(angle)) + Math.abs(img.height * Math.sin(angle)));
  c.height = Math.ceil(Math.abs(img.height * Math.cos(angle)) + Math.abs(img.width * Math.sin(angle)));
  if (c.width * c.height > 25000000) throw new Error("사진이 너무 큽니다");
  const ctx = c.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate(angle); ctx.drawImage(img, -img.width / 2, -img.height / 2);
  // filter 속성이 없는 태블릿 브라우저에서도 같은 보정 결과를 만든다.
  if (brightness !== 1) {
    const pixels = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < pixels.data.length; i += 4) for (let channel = 0; channel < 3; channel++) pixels.data[i + channel] = Math.min(255, Math.round(pixels.data[i + channel] * brightness));
    ctx.putImageData(pixels, 0, 0);
  }
  return { dataUrl: c.toDataURL("image/png"), width: c.width, height: c.height, warnings: [] as string[] };
}
