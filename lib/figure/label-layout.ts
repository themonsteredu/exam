/** 글자 크기와 선 위치를 함께 고려한다. 각도 이름은 이등분선 방향으로만 이동한다. */
export type LabelRect = { x: number; y: number; w: number; h: number };
export type StrokeSegment = { a: { x: number; y: number }; b: { x: number; y: number } };
export type PrintLabel = LabelRect & { direction?: { x: number; y: number }; strictDirection?: boolean };

export function rectOverlap(a: LabelRect, b: LabelRect): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
}

export function strokeHits(r: LabelRect, s: StrokeSegment): boolean {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  let lo = 0, hi = 1;
  for (const [p, q] of [[-dx, s.a.x - (r.x - r.w / 2)], [dx, r.x + r.w / 2 - s.a.x], [-dy, s.a.y - (r.y - r.h / 2)], [dy, r.y + r.h / 2 - s.a.y]]) {
    if (Math.abs(p) < 1e-10) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (lo > hi) return false;
  }
  return true;
}

export function arrangeLabels(labels: PrintLabel[], strokes: StrokeSegment[]) {
  const placed: LabelRect[] = [];
  let remaining = 0;
  const shifts = labels.map(label => {
    const candidates = [{ x: 0, y: 0 }];
    // 제자리 우선. 이동 범위를 글자 근처로 제한해 다른 각/점의 이름처럼 보이지 않게 한다.
    for (const radius of [.65, 1.15, 1.8, 2.5]) {
      if (label.direction) {
        candidates.push({ x: label.direction.x * label.h * radius, y: label.direction.y * label.h * radius });
        if (!label.strictDirection) for (const side of [-.6, .6]) candidates.push({
          x: (label.direction.x * radius - label.direction.y * side) * label.h,
          y: (label.direction.y * radius + label.direction.x * side) * label.h,
        });
      } else {
        for (let i = 0; i < 8; i++) candidates.push({ x: Math.cos(i * Math.PI / 4) * label.h * radius, y: Math.sin(i * Math.PI / 4) * label.h * radius });
      }
    }
    let best = candidates[0], bestScore = Infinity, bestHits = 0;
    for (const c of candidates) {
      const rect = { ...label, x: label.x + c.x, y: label.y + c.y };
      const hits = placed.filter(p => rectOverlap(rect, p)).length * 4 + strokes.filter(s => strokeHits(rect, s)).length;
      const score = hits * 100 + Math.hypot(c.x, c.y) / label.h;
      if (score < bestScore) { bestScore = score; best = c; bestHits = hits; }
    }
    if (bestHits) remaining++;
    placed.push({ ...label, x: label.x + best.x, y: label.y + best.y });
    return best;
  });
  return { shifts, remaining, placed };
}
