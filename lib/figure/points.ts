// 그림 명령의 점 위치 계산.
// 그림 엔진(engine.ts)과 서버의 그림 명령 검사(validate.ts)가 같이 쓴다. JSXGraph 없이 돈다.

import {
  Vec, v, add, sub, mul, dot, dist, unit, perp, fromAngle, rotate, mid,
  intersectLines, foot, intersectCircleLine, bisectorDir, Line,
} from "./geometry";
import type { LineSpec, PointRef, PointSpec, XY } from "./types";

type GliderSpec = Extract<PointSpec, { glider: unknown }>["glider"];

/** 선 위를 움직이는 자유점: 엔진이 JSXGraph glider 로 만든다 */
export type GliderPoint = {
  id: string;
  spec: GliderSpec;
  /** 거리를 재는 기준점 */
  from: () => Vec;
  /** 선 방향 (단위 벡터) */
  dir: () => Vec;
  /** 처음 위치: from 에서의 거리 (선분이면 선분 안으로 줄인 값) */
  startDist: () => number;
};

export type PointBookOptions = {
  /** 자유점 위치 (id → from 에서의 거리). 없으면 그림 명령의 dist */
  gliders?: Record<string, number>;
  /** 자유점의 지금 위치 (엔진이 보드를 만든 뒤 끌어서 옮긴 위치). 없으면 처음 위치 */
  gliderPosition?: (id: string) => Vec | undefined;
};

/** 점 이름 → 위치 계산. 위치는 쓸 때마다 다시 계산한다 (자유점을 옮기면 따라 움직이게) */
export class PointBook {
  readonly gliders: GliderPoint[] = [];
  private fns = new Map<string, () => Vec>();
  /** 지금 계산 중인 점 (서로를 거쳐 정해지는 점을 찾는 데 쓴다) */
  private visiting = new Set<string>();

  constructor(points: PointSpec[], private opts: PointBookOptions = {}) {
    for (const p of points) this.define(p);
  }

  pt(ref: PointRef): Vec {
    if (Array.isArray(ref)) return v(ref[0], ref[1]);
    const fn = this.fns.get(ref);
    if (!fn) throw new Error(`점 '${ref}' 이 없습니다`);
    if (this.visiting.has(ref)) throw new Error(`점 '${ref}' 의 위치가 자기 자신을 거쳐 정해집니다`);
    this.visiting.add(ref);
    try {
      return fn();
    } finally {
      this.visiting.delete(ref);
    }
  }

  has(id: string): boolean {
    return this.fns.has(id);
  }

  ids(): string[] {
    return [...this.fns.keys()];
  }

  lineOf(spec: LineSpec): Line {
    if ("bisector" in spec) {
      const [a, o, b] = spec.bisector.map((r) => this.pt(r));
      return { p: o, d: bisectorDir(a, o, b) };
    }
    if ("perpendicular" in spec) {
      const p = this.pt(spec.perpendicular.through);
      const [a, b] = spec.perpendicular.to.map((r) => this.pt(r));
      return { p, d: perp(sub(b, a)) };
    }
    const through = spec.through;
    if (through.length === 2) {
      const a = this.pt(through[0]);
      const b = this.pt(through[1] as PointRef);
      return { p: a, d: sub(b, a) };
    }
    const p = this.pt(through[0]);
    if ("angle" in spec) return { p, d: fromAngle(spec.angle) };
    if ("dirOf" in spec) {
      const [a, b] = spec.dirOf.map((r) => this.pt(r));
      return { p, d: rotate(sub(b, a), spec.turn ?? 0) };
    }
    throw new Error("직선을 알 수 없습니다");
  }

  private define(p: PointSpec) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const s: any = p;
    let fn: () => Vec;
    if (s.at) {
      const [x, y] = s.at as XY;
      fn = () => v(x, y);
    } else if (s.isoApex) {
      const { base, angle, side } = s.isoApex;
      fn = () => {
        const a = this.pt(base[0]);
        const b = this.pt(base[1]);
        const h = (dist(a, b) / 2) / Math.tan((angle / 2) * Math.PI / 180);
        const n = perp(unit(sub(b, a)));
        return add(mid(a, b), mul(n, side === "right" ? -h : h));
      };
    } else if (s.polar) {
      const { from, length, angle, dirOf, turn } = s.polar;
      fn = () => {
        const o = this.pt(from);
        let d: Vec;
        if (dirOf) {
          const [a, b] = dirOf.map((r: PointRef) => this.pt(r));
          d = rotate(unit(sub(b, a)), turn ?? 0);
        } else d = fromAngle(angle ?? 0);
        return add(o, mul(unit(d), length));
      };
    } else if (s.intersect) {
      const [l1, l2] = s.intersect;
      fn = () => intersectLines(this.lineOf(l1), this.lineOf(l2));
    } else if (s.circleLine) {
      const c = s.circleLine;
      fn = () => {
        const center = this.pt(c.center);
        const r = c.radius ?? dist(center, this.pt(c.through));
        const a = this.pt(c.line[0]);
        const b = this.pt(c.line[1]);
        const hits = intersectCircleLine(center, r, { p: a, d: sub(b, a) });
        if (hits.length === 0) return v(NaN, NaN);
        if (c.other) {
          const o = this.pt(c.other);
          return dist(hits[0], o) > dist(hits[1], o) ? hits[0] : hits[1];
        }
        if (c.near) {
          const o = this.pt(c.near);
          return dist(hits[0], o) < dist(hits[1], o) ? hits[0] : hits[1];
        }
        return hits[0];
      };
    } else if (s.foot) {
      const { from, to } = s.foot;
      fn = () => {
        const a = this.pt(to[0]);
        const b = this.pt(to[1]);
        return foot(this.pt(from), { p: a, d: sub(b, a) });
      };
    } else if (s.midpoint) {
      fn = () => mid(this.pt(s.midpoint[0]), this.pt(s.midpoint[1]));
    } else if (s.glider) {
      const g: GliderSpec = s.glider;
      const fromFn = () => this.pt(g.from);
      const dirFn = () => unit(sub(this.pt(g.line[1]), this.pt(g.line[0])));
      const wanted = this.opts.gliders?.[p.id] ?? g.dist;
      // 선분 위의 자유점은 처음 위치도 선분 안으로 줄인다 (JSXGraph 가 선분 끝에 붙이므로, 범위 계산도 같게)
      const startDist = () => {
        if (!g.segment) return wanted;
        const a = this.pt(g.line[0]);
        const t0 = dot(sub(fromFn(), a), dirFn()); // from 이 선분 시작점에서 떨어진 거리
        return Math.min(Math.max(wanted, -t0), dist(a, this.pt(g.line[1])) - t0);
      };
      // 엔진이 보드를 만들기 전(범위 계산)이나 서버 검사에서는 처음 위치를 쓴다
      fn = () => this.opts.gliderPosition?.(p.id) ?? add(fromFn(), mul(dirFn(), startDist()));
      this.gliders.push({ id: p.id, spec: g, from: fromFn, dir: dirFn, startDist });
    } else {
      throw new Error(`점 '${p.id}' 을 만드는 방법을 알 수 없습니다`);
    }
    this.fns.set(p.id, fn);
  }
}
