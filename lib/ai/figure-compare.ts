// 두 그림 명령 비교 (직접 만든 것 ↔ AI 가 쓴 것).
// 이름이 같은 점들의 위치를 회전·확대·이동으로 최대한 겹친 뒤 남는 차이를 잰다 (그림 크기에 대한 비율).
// 쌓기나무는 칸별 층수가 같은지 본다.

import { PointBook } from "@/lib/figure/points";
import type { FigureSpec } from "@/lib/figure/types";
import type { Vec } from "@/lib/figure/geometry";

export type PointsCompare = {
  common: string[];
  missing: string[];
  extra: string[];
  /** 남는 차이의 제곱평균 / 기준 그림 대각선 (0 이면 똑같은 모양) */
  rms: number;
  /** 점마다 남는 차이 / 기준 그림 대각선 */
  perPoint: Record<string, number>;
};

function points(spec: FigureSpec): Map<string, Vec> {
  const book = new PointBook(spec.points ?? []);
  const out = new Map<string, Vec>();
  for (const id of book.ids()) {
    try {
      const p = book.pt(id);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) out.set(id, p);
    } catch {
      /* 계산되지 않는 점은 빼고 비교 */
    }
  }
  return out;
}

/** 닮음 변환(뒤집기 없음)으로 got 을 ref 에 맞춘 뒤 남는 차이 */
export function comparePoints(ref: FigureSpec, got: FigureSpec): PointsCompare {
  const a = points(ref);
  const b = points(got);
  const common = [...a.keys()].filter((k) => b.has(k));
  const missing = [...a.keys()].filter((k) => !b.has(k));
  const extra = [...b.keys()].filter((k) => !a.has(k));
  const result: PointsCompare = { common, missing, extra, rms: NaN, perPoint: {} };
  if (common.length < 2) return result;
  const P = common.map((k) => b.get(k)!);
  const Q = common.map((k) => a.get(k)!);
  const mean = (xs: Vec[]) => ({ x: xs.reduce((s, p) => s + p.x, 0) / xs.length, y: xs.reduce((s, p) => s + p.y, 0) / xs.length });
  const mp = mean(P);
  const mq = mean(Q);
  // 복소수로 보면 q ≈ z·p + t 를 푸는 것과 같다 (z = 회전·확대)
  let num = { x: 0, y: 0 };
  let den = 0;
  P.forEach((p, i) => {
    const px = p.x - mp.x;
    const py = p.y - mp.y;
    const qx = Q[i].x - mq.x;
    const qy = Q[i].y - mq.y;
    num = { x: num.x + qx * px + qy * py, y: num.y + qy * px - qx * py };
    den += px * px + py * py;
  });
  const z = den > 0 ? { x: num.x / den, y: num.y / den } : { x: 1, y: 0 };
  const xs = Q.map((q) => q.x);
  const ys = Q.map((q) => q.y);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  let sum = 0;
  common.forEach((k, i) => {
    const px = P[i].x - mp.x;
    const py = P[i].y - mp.y;
    const fx = z.x * px - z.y * py + mq.x;
    const fy = z.y * px + z.x * py + mq.y;
    const d = Math.hypot(fx - Q[i].x, fy - Q[i].y) / diag;
    result.perPoint[k] = d;
    sum += d * d;
  });
  result.rms = Math.sqrt(sum / common.length);
  return result;
}

export type CubesCompare = { shapes: number; same: boolean[]; ref: number[][][]; got: number[][][] };

/** 쌓기나무: 모양마다 칸별 층수가 같은지 (모양 순서는 왼쪽 위부터 가까운 것끼리 짝짓는다) */
export function compareCubes(ref: FigureSpec, got: FigureSpec): CubesCompare {
  const cubes = (s: FigureSpec) =>
    s.elements
      .filter((e): e is Extract<FigureSpec["elements"][number], { type: "cubes" }> => e.type === "cubes")
      .map((e) => ({ heights: trim(e.heights), at: e.origin ?? [0, 0] }))
      .sort((p, q) => q.at[1] - p.at[1] || p.at[0] - q.at[0]);
  const r = cubes(ref);
  const g = cubes(got);
  const same = r.map((shape, i) => JSON.stringify(shape.heights) === JSON.stringify(g[i]?.heights));
  return { shapes: r.length, same, ref: r.map((x) => x.heights), got: g.map((x) => x.heights) };
}

/** 빈 줄·빈 칸(층수 0)을 가장자리에서 걷어 낸다 (같은 모양을 다르게 적은 것을 같게 보려고) */
function trim(h: number[][]): number[][] {
  let rows = h.map((r) => [...r]);
  while (rows.length && rows[rows.length - 1].every((x) => !x)) rows.pop();
  while (rows.length && rows[0].every((x) => !x)) rows.shift();
  const width = Math.max(0, ...rows.map((r) => r.length));
  rows = rows.map((r) => [...r, ...Array(width - r.length).fill(0)]);
  let left = 0;
  while (left < width && rows.every((r) => !r[left])) left++;
  let right = width;
  while (right > left && rows.every((r) => !r[right - 1])) right--;
  return rows.map((r) => r.slice(left, right));
}
