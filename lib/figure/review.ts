// 그림 명령 살피기와 뻔한 실수 고치기 (AI 없이, 요금 없음).
// 그림 읽기 검사(validate.ts, read-figure.ts)와 시험지 합치기·다시 만들기(assemble.ts)가 같이 쓴다.
//
// 2026-11-01 호남삼육중에서 나온 실수가 바탕이다:
//  - 2번: C 를 지나는 직선의 방향각 78° 를 사잇각 102° 로 써서 ∠BAC 가 35° 가 아니라 59° 로 그려졌다.
//    35° 글자는 angle 요소의 label 이 아니라 따로 둔 글자(label 요소)라 예전 검사가 보지 못했다.
//  - 서답형 2: 3x°, 2x° 의 x 를 풀어(18) 그려 그림이 원본보다 크게 눕고 길어졌다 (점 E 가 원본 자리에서 크게 벗어남).

import { add, angleAt, fromAngle, mul, v, type Vec } from "./geometry";
import { PointBook } from "./points";
import type { FigureSpec, LabelSpec, PointRef } from "./types";

/** 각 글자와 그린 각이 이만큼(도) 넘게 다르면 틀린 것으로 본다 */
export const DEGREE_TOLERANCE = 2;
/** 따로 둔 각 글자를 각 표시와 짝지을 때, 꼭짓점까지 거리가 그림 기준 길이(base)의 이 비율 안이어야 한다 */
const FREE_LABEL_REACH = 0.6;
/** 원본 기준점과 견줘 한 점이 그림 크기의 이 비율보다 많이 어긋나면 모양이 원본과 다르다고 본다 (보관된 그림 93개로 정함) */
export const SHAPE_DEVIATION_LIMIT = 0.3;

const DIRS: Record<string, number> = { E: 0, NE: 45, N: 90, NW: 135, W: 180, SW: 225, S: 270, SE: 315 };

/** 각 글자가 숫자 도(35°, 37.5°)면 그 값. 문자(x, 3x°)나 0·180 이상이면 undefined */
export function degreeLabel(label: string): number | undefined {
  const m = label.replace(/\s+/g, "").match(/^(\d{1,3}(?:\.\d+)?)(?:°|º|˚|\^\\circ)$/);
  if (!m) return undefined;
  const value = Number(m[1]);
  return value > 0 && value < 180 ? value : undefined;
}

export type DegreeMismatch = {
  /** elements 안 자리 (각 표시 또는 따로 둔 글자) */
  where: string;
  label: string;
  want: number;
  got: number;
  /** 각 표시의 세 점 (앞점, 꼭짓점, 뒷점) */
  points: [PointRef, PointRef, PointRef];
  /** 따로 둔 글자(label 요소)를 가까운 각 표시와 짝지은 것인지 */
  free: boolean;
};

function refName(ref: PointRef): string {
  return typeof ref === "string" ? ref : `(${ref[0]}, ${ref[1]})`;
}

/** 따로 둔 글자의 가운데 자리 (엔진과 같은 계산: 점에서 dir 쪽으로 글자 크기 × offset) */
function labelCenter(el: LabelSpec, book: PointBook, spec: FigureSpec): Vec {
  const at = book.pt(el.at);
  if (el.dir === undefined) return at;
  const size = spec.base * 0.15 * (spec.style?.labelScale ?? 1) * (el.size ?? 1);
  const ang = typeof el.dir === "number" ? el.dir : DIRS[el.dir] ?? 90;
  return add(at, mul(fromAngle(ang), size * (el.offset ?? 0.75)));
}

/**
 * 숫자로 적힌 각(35°)과 그린 각이 다른 곳을 찾는다.
 * - angle 요소의 label
 * - 따로 둔 글자(label 요소): 글자에서 가장 가까운 이름 있는 점이 글자 없는 각 표시 하나의 꼭짓점이고, 그 거리가 base × 0.6 안이면 그 각과 견준다
 * 점 위치를 계산하지 못하면 빈 목록 (그 문제는 다른 검사가 알린다).
 */
export function degreeMismatches(spec: FigureSpec, book?: PointBook): DegreeMismatch[] {
  const out: DegreeMismatch[] = [];
  try {
    book ??= new PointBook(spec.points ?? []);
    const angles = spec.elements
      .map((el, i) => ({ el, i }))
      .filter((x): x is { el: Extract<FigureSpec["elements"][number], { type: "angle" }>; i: number } => x.el?.type === "angle");
    const measure = (pts: PointRef[]) => {
      const [a, o, b] = pts.map((p) => book!.pt(p));
      return angleAt(a, o, b);
    };
    for (const { el, i } of angles) {
      const want = typeof el.label === "string" ? degreeLabel(el.label) : undefined;
      if (want === undefined) continue;
      const got = measure(el.points);
      if (Math.abs(got - want) > DEGREE_TOLERANCE) out.push({ where: `elements[${i}]`, label: el.label!, want, got, points: el.points, free: false });
    }
    // 따로 둔 숫자 각 글자
    const bare = angles.filter(({ el }) => !el.label);
    if (!bare.length) return out;
    const named = book.ids().map((id) => ({ id, p: book!.pt(id) })).filter(({ p }) => Number.isFinite(p.x) && Number.isFinite(p.y));
    spec.elements.forEach((el, i) => {
      if (el?.type !== "label" || (el.font ?? "serif") !== "serif") return;
      const want = degreeLabel(el.text);
      if (want === undefined) return;
      const c = labelCenter(el, book!, spec);
      let nearest: { id: string; d: number } | undefined;
      for (const { id, p } of named) {
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (!nearest || d < nearest.d) nearest = { id, d };
      }
      if (!nearest || nearest.d > spec.base * FREE_LABEL_REACH) return;
      const at = bare.filter(({ el: a }) => a.points[1] === nearest!.id);
      if (at.length !== 1) return; // 그 꼭짓점에 글자 없는 각 표시가 없거나 여럿이면 짝짓지 않는다
      const got = measure(at[0].el.points);
      if (Math.abs(got - want) > DEGREE_TOLERANCE) out.push({ where: `elements[${i}]`, label: el.text, want, got, points: at[0].el.points, free: true });
    });
  } catch {
    return out;
  }
  return out;
}

/** 검사 오류 문장 (그림 읽기에서 AI 에게 돌려보낸다) */
export function degreeMismatchText(m: DegreeMismatch): string {
  const angle = m.points.map(refName).join("");
  const tail = "그 각을 정하는 점을 다시 계산하세요 (intersect 의 angle 은 x축에서 잰 방향각입니다. 사잇각과 헷갈리지 않았는지, turn 의 방향(+ 는 시계 반대)이 맞는지)";
  return m.free
    ? `${m.where}: 각 글자 ${m.label} 가 꼭짓점 ${refName(m.points[1])} 의 각 표시 옆에 있는데 그린 각 ${angle} 는 ${m.got.toFixed(1)}° 입니다. 숫자로 적힌 각은 그 각의 angle 요소 label 로 넣고, ${tail}`
    : `${m.where}: 각 표시가 ${m.label} 인데 그린 각 ${angle} 는 ${m.got.toFixed(1)}° 입니다. ${tail}`;
}

/** 확인할 곳에 적을 짧은 문장 */
export function degreeMismatchNote(m: DegreeMismatch): string {
  return `각 글자 ${m.label} 와 그린 각 ${m.points.map(refName).join("")}(${Math.round(m.got)}°)이 다릅니다`;
}

type Edit = { describe: string; apply: (spec: FigureSpec) => void };

const norm = (deg: number) => {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return Math.round(d * 1000) / 1000;
};

/** 방향각·도는 각을 헷갈린 실수를 고쳐 볼 후보: 점 정의 속 각 숫자를 하나씩 뒤집어 본다 */
function candidateEdits(spec: FigureSpec): Edit[] {
  const edits: Edit[] = [];
  (spec.points ?? []).forEach((p: any, i) => {
    const id = p?.id ?? `points[${i}]`;
    if (Array.isArray(p?.intersect)) {
      p.intersect.forEach((line: any, j: number) => {
        if (!line || typeof line !== "object") return;
        const through = Array.isArray(line.through) ? refName(line.through[0]) : "";
        if (typeof line.angle === "number") {
          // 직선은 θ 와 θ+180 이 같은 직선이고, 180−θ 와 −θ 도 같은 직선이다 → 뒤집은 것 하나
          const to = norm(180 - line.angle);
          if (to !== norm(line.angle)) {
            edits.push({ describe: `점 ${id}: ${through} 를 지나는 직선의 방향 ${line.angle}° → ${to}°`, apply: (s: any) => { s.points[i].intersect[j].angle = to; } });
          }
        }
        if (typeof line.turn === "number" && line.turn !== 0) {
          edits.push({ describe: `점 ${id}: ${through} 를 지나는 직선의 도는 각 ${line.turn}° → ${-line.turn}°`, apply: (s: any) => { s.points[i].intersect[j].turn = -line.turn; } });
        }
      });
    }
    const polar = p?.polar;
    if (polar && typeof polar === "object") {
      const from = refName(polar.from);
      if (typeof polar.angle === "number") {
        for (const to of new Set([norm(180 - polar.angle), norm(-polar.angle), norm(polar.angle + 180)])) {
          if (to === norm(polar.angle)) continue;
          edits.push({ describe: `점 ${id}: ${from} 에서의 방향 ${polar.angle}° → ${to}°`, apply: (s: any) => { s.points[i].polar.angle = to; } });
        }
      }
      if (typeof polar.turn === "number" && polar.turn !== 0) {
        edits.push({ describe: `점 ${id}: ${from} 에서 도는 각 ${polar.turn}° → ${-polar.turn}°`, apply: (s: any) => { s.points[i].polar.turn = -polar.turn; } });
      }
    }
    const iso = p?.isoApex;
    if (iso && typeof iso.angle === "number") {
      // 꼭지각과 밑각을 헷갈린 실수
      for (const to of new Set([180 - 2 * iso.angle, (180 - iso.angle) / 2])) {
        if (!(to > 0 && to < 180) || to === iso.angle) continue;
        edits.push({ describe: `점 ${id}: 꼭지각 ${iso.angle}° → ${Math.round(to * 100) / 100}°`, apply: (s: any) => { s.points[i].isoApex.angle = to; } });
      }
    }
  });
  return edits;
}

function computable(spec: FigureSpec): PointBook | undefined {
  try {
    const book = new PointBook(spec.points ?? []);
    for (const id of book.ids()) {
      const p = book.pt(id);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return undefined;
    }
    return book;
  } catch {
    return undefined;
  }
}

export type DegreeRepair = { spec: FigureSpec; changes: string[] };

/**
 * 숫자 각 글자와 그린 각이 다르면, 점 정의 속 각 숫자를 뒤집어(방향각 ↔ 사잇각, 도는 방향, 꼭지각 ↔ 밑각) 모든 각 글자가 맞게 되는 것을 찾는다.
 * 하나만 바꿔서 안 되면 둘을 바꿔 본다. 고칠 길이 여럿이면 원본 기준점(anchors)과 더 닮은 것을, 기준점이 없으면 덜 바꾼 것을 고른다.
 * 고치지 못하면 undefined. 그림 명령은 바꾸지 않고 고친 사본을 돌려준다.
 */
export function repairDegrees(spec: FigureSpec, anchors?: Anchor[]): DegreeRepair | undefined {
  const before = degreeMismatches(spec);
  if (!before.length) return undefined;
  const edits = candidateEdits(spec);
  const tryEdits = (chosen: Edit[]): FigureSpec | undefined => {
    const copy: FigureSpec = JSON.parse(JSON.stringify(spec));
    for (const e of chosen) e.apply(copy);
    const book = computable(copy);
    if (!book || degreeMismatches(copy, book).length) return undefined;
    return copy;
  };
  const found: { spec: FigureSpec; edits: Edit[] }[] = [];
  for (const e of edits) {
    const s = tryEdits([e]);
    if (s) found.push({ spec: s, edits: [e] });
  }
  if (!found.length && edits.length <= 40) {
    for (let a = 0; a < edits.length; a++) {
      for (let b = a + 1; b < edits.length; b++) {
        const s = tryEdits([edits[a], edits[b]]);
        if (s) found.push({ spec: s, edits: [edits[a], edits[b]] });
      }
    }
  }
  if (!found.length) return undefined;
  // 고를 길이 여럿이면: 원본 기준점과 더 닮은 것 → AI 가 그린 자리에서 점이 덜 옮겨지는 것 → 덜 바꾼 것
  // (각 글자만 보면 뒤집힌 그림(삼각형이 밑변 아래로)도 맞을 수 있다. AI 가 그린 모양은 대개 원본과 비슷하므로 덜 옮긴 쪽이 원래 뜻에 가깝다)
  const original = computable(spec);
  const moved = (f: { spec: FigureSpec }) => {
    const book = computable(f.spec);
    if (!book || !original) return Infinity;
    let sum = 0;
    for (const id of original.ids()) {
      const a = original.pt(id), b = book.pt(id);
      sum += Math.hypot(a.x - b.x, a.y - b.y);
    }
    return sum / Math.max(1e-9, spec.base);
  };
  const scored = found.map((f) => ({
    ...f,
    shape: anchors?.length ? Math.round((shapeDeviation(f.spec, anchors)?.worst ?? 0) * 20) / 20 : 0,
    moved: moved(f),
  }));
  scored.sort((x, y) => x.shape - y.shape || x.moved - y.moved || x.edits.length - y.edits.length);
  const best = scored[0];
  return { spec: best.spec, changes: best.edits.map((e) => e.describe) };
}

/** 원본 사진 속 점 자리 (픽셀, 왼쪽 위가 0,0) */
export type Anchor = { at: PointRef; px: [number, number] };

export type ShapeDeviation = {
  /** 가장 많이 어긋난 점과 그 정도 (원본 기준점이 퍼진 크기에 대한 비율) */
  worst: number;
  worstPoint: string;
  /** 점마다 어긋난 정도 */
  points: { id: string; ratio: number }[];
};

/**
 * 그린 점 자리와 원본 사진 속 점 자리(AI 가 적어 준 기준점)를 닮은꼴로 맞춰 보고(돌리기·키우기·옮기기),
 * 점마다 어긋난 거리를 원본 기준점이 퍼진 크기(가장 먼 두 점 사이)에 대한 비율로 잰다.
 * 점 하나를 뺀 나머지로 맞춘 뒤 그 점이 어디로 가는지 본다 (멀리 떨어진 점 하나가 맞춤을 끌어당겨 어긋남을 숨기지 않게.
 * 2026-11-01 삼육중 서답형 2: 모두로 맞추면 멀리 그린 E 가 맞춤을 끌어당겨 E 는 4% 로 보였다).
 * 이름 있는 기준점이 3개 미만이면 undefined.
 */
export function shapeDeviation(spec: FigureSpec, anchors: Anchor[], book?: PointBook): ShapeDeviation | undefined {
  let pairs: { id: string; p: Vec; q: Vec }[];
  try {
    book ??= new PointBook(spec.points ?? []);
    const seen = new Set<string>();
    pairs = [];
    for (const a of anchors) {
      if (typeof a.at !== "string" || seen.has(a.at) || !book.has(a.at)) continue;
      const p = book.pt(a.at);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      seen.add(a.at);
      pairs.push({ id: a.at, p, q: v(a.px[0], -a.px[1]) }); // 사진은 아래로 갈수록 y 가 커진다 → 뒤집어 그림 좌표와 같은 방향으로
    }
  } catch {
    return undefined;
  }
  if (pairs.length < 3) return undefined;
  let spread = 0;
  for (const x of pairs) for (const y of pairs) spread = Math.max(spread, Math.hypot(x.q.x - y.q.x, x.q.y - y.q.y));
  if (!(spread > 0)) return undefined;

  // 복소수로 본 닮은꼴 맞춤: w ≈ a·z (z, w 는 무게중심을 뺀 좌표)
  const fit = (use: typeof pairs) => {
    const n = use.length;
    const p0 = use.reduce((s, x) => add(s, mul(x.p, 1 / n)), v(0, 0));
    const q0 = use.reduce((s, x) => add(s, mul(x.q, 1 / n)), v(0, 0));
    let re = 0, im = 0, zz = 0;
    for (const x of use) {
      const zx = x.p.x - p0.x, zy = x.p.y - p0.y, wx = x.q.x - q0.x, wy = x.q.y - q0.y;
      re += zx * wx + zy * wy; // conj(z)·w 의 실수부
      im += zx * wy - zy * wx; // 허수부
      zz += zx * zx + zy * zy;
    }
    if (!(zz > 1e-12)) return undefined;
    const ar = re / zz, ai = im / zz;
    return (p: Vec) => {
      const zx = p.x - p0.x, zy = p.y - p0.y;
      return v(q0.x + ar * zx - ai * zy, q0.y + ai * zx + ar * zy);
    };
  };
  const points: { id: string; ratio: number }[] = [];
  for (const x of pairs) {
    const map = fit(pairs.filter((y) => y !== x));
    if (!map) continue;
    const m = map(x.p);
    points.push({ id: x.id, ratio: Math.hypot(m.x - x.q.x, m.y - x.q.y) / spread });
  }
  if (!points.length) return undefined;
  const worst = points.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  return { worst: worst.ratio, worstPoint: worst.id, points };
}

/** 확인할 곳에 적을 짧은 문장 */
export function shapeDeviationNote(d: ShapeDeviation): string {
  return `점 ${d.worstPoint} 가 원본 자리와 많이 다릅니다 (그림 크기의 ${Math.round(d.worst * 100)}%)`;
}

/** 원본과 모양이 많이 다를 때 알리는 문장 */
export function shapeDeviationText(d: ShapeDeviation): string {
  return `점 ${d.worstPoint} 가 원본 사진 속 자리와 많이 다릅니다 (그림 크기의 ${Math.round(d.worst * 100)}%). 문자로 적힌 값(3x° 등)을 풀어서 그리지 않았는지, 원본 모양대로 그릴 부분을 조건으로 정하지 않았는지 확인하고 원본처럼 고치세요. 숫자로 주어진 조건 때문에 어쩔 수 없으면 그대로 두고 notes 에 까닭을 적으세요.`;
}
