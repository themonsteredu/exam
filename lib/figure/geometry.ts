// 그림 엔진에서 쓰는 작은 기하 계산 모음.
// 문제 조건으로 정해지는 점(교점, 수선의 발, 이등분선 등)은 모두 여기서 계산한다.

export type Vec = { x: number; y: number };

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => v(a.x + b.x, a.y + b.y);
export const sub = (a: Vec, b: Vec): Vec => v(a.x - b.x, a.y - b.y);
export const mul = (a: Vec, k: number): Vec => v(a.x * k, a.y * k);
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => len(sub(a, b));
export const unit = (a: Vec): Vec => {
  const l = len(a);
  return l === 0 ? v(0, 0) : v(a.x / l, a.y / l);
};
export const perp = (a: Vec): Vec => v(-a.y, a.x); // 왼쪽으로 90도
export const rad = (deg: number): number => (deg * Math.PI) / 180;
export const deg = (r: number): number => (r * 180) / Math.PI;
export const fromAngle = (degrees: number): Vec => v(Math.cos(rad(degrees)), Math.sin(rad(degrees)));
export const angleOf = (a: Vec): number => deg(Math.atan2(a.y, a.x));
export const rotate = (a: Vec, degrees: number): Vec => {
  const c = Math.cos(rad(degrees));
  const s = Math.sin(rad(degrees));
  return v(a.x * c - a.y * s, a.x * s + a.y * c);
};
export const lerp = (a: Vec, b: Vec, t: number): Vec => v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
export const mid = (a: Vec, b: Vec): Vec => lerp(a, b, 0.5);

/** 점 p 를 지나고 방향이 d 인 직선 */
export type Line = { p: Vec; d: Vec };

export function intersectLines(l1: Line, l2: Line): Vec {
  const den = cross(l1.d, l2.d);
  if (Math.abs(den) < 1e-12) return v(NaN, NaN);
  const t = cross(sub(l2.p, l1.p), l2.d) / den;
  return add(l1.p, mul(l1.d, t));
}

/** 수선의 발 */
export function foot(p: Vec, l: Line): Vec {
  const d = unit(l.d);
  return add(l.p, mul(d, dot(sub(p, l.p), d)));
}

/** 원과 직선이 만나는 점들 */
export function intersectCircleLine(center: Vec, r: number, l: Line): Vec[] {
  const d = unit(l.d);
  const f = sub(l.p, center);
  const b = dot(f, d);
  const c = dot(f, f) - r * r;
  const disc = b * b - c;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [add(l.p, mul(d, -b - s)), add(l.p, mul(d, -b + s))];
}

/** 꼭짓점 vtx 에서 두 방향(vtx→a, vtx→b) 사이 각의 이등분선 방향 */
export function bisectorDir(a: Vec, vtx: Vec, b: Vec): Vec {
  const u1 = unit(sub(a, vtx));
  const u2 = unit(sub(b, vtx));
  const s = add(u1, u2);
  // 두 방향이 정반대면(평각) 수직 방향
  return len(s) < 1e-12 ? perp(u1) : unit(s);
}

/** 각 a-vtx-b 의 크기(도, 0~180) */
export function angleAt(a: Vec, vtx: Vec, b: Vec): number {
  const u1 = sub(a, vtx);
  const u2 = sub(b, vtx);
  return deg(Math.acos(Math.max(-1, Math.min(1, dot(u1, u2) / (len(u1) * len(u2))))));
}

/**
 * 각을 그릴 때 쓰는 시작각과 끝각(도). 항상 180도보다 작은 안쪽 각을
 * 시계 반대 방향으로 돌도록 돌려준다.
 */
export function interiorSweep(a: Vec, vtx: Vec, b: Vec): { start: number; end: number } {
  let s = angleOf(sub(a, vtx));
  let e = angleOf(sub(b, vtx));
  let sweep = e - s;
  while (sweep < 0) sweep += 360;
  if (sweep > 180) {
    [s, e] = [e, s];
    sweep = 360 - sweep;
  }
  return { start: s, end: s + sweep };
}

/** 최소제곱 아핀 변환: src[i] → dst[i]. [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f) */
export function fitAffine(src: Vec[], dst: Vec[]): number[] | null {
  const n = Math.min(src.length, dst.length);
  if (n < 2) return null;
  if (n === 2) {
    // 두 점이면 닮음 변환(회전·확대·이동)
    const s = sub(src[1], src[0]);
    const t = sub(dst[1], dst[0]);
    const k = len(t) / len(s);
    const ang = Math.atan2(t.y, t.x) - Math.atan2(s.y, s.x);
    const a = k * Math.cos(ang);
    const b = k * Math.sin(ang);
    const e = dst[0].x - (a * src[0].x - b * src[0].y);
    const f = dst[0].y - (b * src[0].x + a * src[0].y);
    return [a, b, -b, a, e, f];
  }
  // 정규방정식 (3x3) 을 x, y 따로 푼다
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bx = [0, 0, 0];
  const by = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const row = [src[i].x, src[i].y, 1];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) M[r][c] += row[r] * row[c];
      bx[r] += row[r] * dst[i].x;
      by[r] += row[r] * dst[i].y;
    }
  }
  const sx = solve3(M, bx);
  const sy = solve3(M, by);
  if (!sx || !sy) return null;
  return [sx[0], sy[0], sx[1], sy[1], sx[2], sy[2]];
}

function solve3(M: number[][], b: number[]): number[] | null {
  const A = M.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-12) return null;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const k = A[r][i] / A[i][i];
      for (let c = i; c < 4; c++) A[r][c] -= k * A[i][c];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}
