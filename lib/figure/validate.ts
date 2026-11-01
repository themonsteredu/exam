// 그림 명령 검사: 모양(types.ts 와 같은지), 점 이름, 점 위치 계산까지 본다.
// AI 가 쓴 그림 명령을 받자마자 서버에서 검사하고, 틀린 곳을 AI 에게 돌려보내 고치게 한다.
// 확인 화면에서 그림 명령을 직접 고칠 때도 같은 검사를 쓴다. JSXGraph 없이 돈다.

import { z } from "zod";
import { PointBook } from "./points";
import type { ElementSpec, FigureSpec, PointRef } from "./types";

const num = z.number();
const XY = z.tuple([num, num]);
const PointRefS = z.union([z.string().min(1), XY], { error: "점은 이름(글자)이나 [x, y] 좌표여야 합니다" });
const Pair = z.tuple([PointRefS, PointRefS]);
const Triple = z.tuple([PointRefS, PointRefS, PointRefS]);
const DirS = z.union([z.enum(["N", "S", "E", "W", "NE", "NW", "SE", "SW"]), num], {
  error: "dir 는 N, S, E, W, NE, NW, SE, SW 가운데 하나나 각도(도, x축에서 시계 반대 방향)여야 합니다",
});
const color = z.string().min(1);

const stroke = { width: num.optional(), color: color.optional(), dash: z.boolean().optional() };

/** 직선을 정하는 방법 (어느 열쇠가 있는지로 고른다) */
function checkLine(value: unknown, path: string, errors: string[]) {
  const forms: [string, z.ZodType][] = [
    ["bisector", z.strictObject({ bisector: Triple })],
    ["perpendicular", z.strictObject({ perpendicular: z.strictObject({ through: PointRefS, to: Pair }) })],
    ["angle", z.strictObject({ through: z.tuple([PointRefS]), angle: num })],
    ["dirOf", z.strictObject({ through: z.tuple([PointRefS]), dirOf: Pair, turn: num.optional() })],
    ["through", z.strictObject({ through: Pair })],
  ];
  if (!isObject(value)) {
    errors.push(`${path}: 직선은 객체여야 합니다`);
    return;
  }
  const form = forms.find(([key]) => key in value) ?? forms[forms.length - 1];
  pushIssues(form[1].safeParse(value), path, errors);
}

const POINT_FORMS: Record<string, z.ZodType> = {
  at: XY,
  isoApex: z.strictObject({ base: Pair, angle: num, side: z.enum(["left", "right"]).optional() }),
  polar: z
    .strictObject({ from: PointRefS, length: num, angle: num.optional(), dirOf: Pair.optional(), turn: num.optional() })
    .refine((p) => p.angle !== undefined || p.dirOf !== undefined, "polar 에는 angle 이나 dirOf 가 있어야 합니다"),
  intersect: z.tuple([z.unknown(), z.unknown()]),
  circleLine: z
    .strictObject({
      center: PointRefS,
      radius: num.optional(),
      through: PointRefS.optional(),
      line: Pair,
      other: PointRefS.optional(),
      near: PointRefS.optional(),
    })
    .refine((c) => c.radius !== undefined || c.through !== undefined, "circleLine 에는 radius 나 through 가 있어야 합니다"),
  foot: z.strictObject({ from: PointRefS, to: Pair }),
  midpoint: Pair,
  glider: z.strictObject({ line: Pair, from: PointRefS, dist: num, segment: z.boolean().optional() }),
};

const ELEMENT_FORMS = {
  segment: z.strictObject({ type: z.literal("segment"), points: Pair, extendStart: num.optional(), extendEnd: num.optional(), ...stroke }),
  line: z.strictObject({ type: z.literal("line"), points: Pair, ray: z.boolean().optional(), ...stroke }),
  polygon: z.strictObject({ type: z.literal("polygon"), points: z.array(PointRefS).min(3), fill: color.optional(), border: z.boolean().optional(), ...stroke }),
  circle: z
    .strictObject({ type: z.literal("circle"), center: PointRefS, radius: num.optional(), through: PointRefS.optional(), fill: color.optional(), ...stroke })
    .refine((c) => c.radius !== undefined || c.through !== undefined, "circle 에는 radius 나 through 가 있어야 합니다"),
  arc: z.strictObject({ type: z.literal("arc"), center: PointRefS, from: PointRefS, to: PointRefS, radius: num.optional(), ...stroke }),
  angle: z.strictObject({
    type: z.literal("angle"),
    points: Triple,
    radius: num.optional(),
    count: z.int().min(1).max(4).optional(),
    symbol: z.enum(["dot", "cross"]).optional(),
    label: z.string().optional(),
    labelDist: num.optional(),
    labelSize: num.optional(),
    ...stroke,
  }),
  rightAngle: z.strictObject({ type: z.literal("rightAngle"), points: Triple, size: num.optional(), ...stroke }),
  ticks: z.strictObject({ type: z.literal("ticks"), points: Pair, count: z.int().min(1).max(4).optional(), size: num.optional(), ...stroke }),
  dimension: z.strictObject({
    type: z.literal("dimension"),
    points: Pair,
    bulge: num,
    shape: z.enum(["arc", "ellipse"]).optional(),
    label: z.string().optional(),
    italic: z.boolean().optional(),
    labelSize: num.optional(),
    gapStart: num.optional(),
    gapEnd: num.optional(),
    dotted: z.boolean().optional(),
    labelPlace: z.enum(["on", "outside"]).optional(),
    color: color.optional(),
    width: num.optional(),
  }),
  label: z.strictObject({
    type: z.literal("label"),
    at: PointRefS,
    text: z.string().min(1),
    dir: DirS.optional(),
    offset: num.optional(),
    size: num.optional(),
    italic: z.boolean().optional(),
    font: z.enum(["serif", "sans"]).optional(),
    color: color.optional(),
  }),
  dot: z.strictObject({ type: z.literal("dot"), at: PointRefS, size: num.optional(), color: color.optional() }),
  axes: z.strictObject({
    type: z.literal("axes"),
    x: z.tuple([num, num]),
    y: z.tuple([num, num]),
    ticks: num.optional(),
    tickLabels: z.boolean().optional(),
    origin: z.boolean().optional(),
  }),
  function: z.strictObject({ type: z.literal("function"), expr: z.string().min(1), domain: z.tuple([num, num]), ...stroke }),
  cubes: z.strictObject({
    type: z.literal("cubes"),
    heights: z.array(z.array(z.int().min(0).max(20))).min(1),
    mode: z.enum(["oblique", "iso"]),
    origin: XY.optional(),
    size: num.optional(),
    depth: num.optional(),
    colors: z
      .strictObject({ top: color.optional(), front: color.optional(), side: color.optional(), edge: color.optional() })
      .optional(),
  }),
  grid: z.strictObject({
    type: z.literal("grid"),
    at: XY,
    rows: z.int().min(1).max(30),
    cols: z.int().min(1).max(30),
    cell: num,
    dash: z.boolean().optional(),
    color: color.optional(),
  }),
  badge: z.strictObject({
    type: z.literal("badge"),
    at: XY,
    text: z.string().min(1),
    fill: color.optional(),
    stroke: color.optional(),
    radius: num.optional(),
    textColor: color.optional(),
  }),
  arrow: z.strictObject({ type: z.literal("arrow"), from: PointRefS, to: PointRefS, ...stroke }),
} satisfies Record<ElementSpec["type"], z.ZodType>;

const TOP = z.strictObject({
  base: num.positive(),
  bbox: z.tuple([num, num, num, num]).optional(),
  points: z.array(z.unknown()).optional(),
  elements: z.array(z.unknown()),
  style: z.strictObject({ lineScale: num.positive().optional(), labelScale: num.positive().optional() }).optional(),
});

/** 함수 식에 쓸 수 있는 이름 (JSXGraph 식 해석기 JessieCode 가 아는 것 가운데 그래프에 쓰는 것만) */
const FUNCTION_NAMES = new Set([
  "x", "PI", "EULER",
  "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
  "sqrt", "cbrt", "nthroot", "abs", "exp", "log", "ln", "log10", "log2", "pow",
  "floor", "ceil", "round", "trunc", "min", "max", "sign",
]);

/** 함수 식에 쓸 수 없는 이름·글자가 있으면 그 까닭들, 없으면 빈 목록 (엔진도 그리기 전에 다시 본다) */
export function functionExprProblems(expr: string): string[] {
  const problems: string[] = [];
  const bad = (expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((name) => !FUNCTION_NAMES.has(name));
  if (bad.length) problems.push(`함수 식에 쓸 수 없는 이름 ${[...new Set(bad)].join(", ")} (변수는 x 하나, 곱하기는 *, 거듭제곱은 ^)`);
  if (/[^A-Za-z0-9_+\-*/^().,\s]/.test(expr)) problems.push(`함수 식에 쓸 수 없는 글자가 있습니다 ('${expr}')`);
  if (expr.length > 200) problems.push("함수 식이 너무 깁니다 (200자까지)");
  return problems;
}

export type FigureCheck = {
  /** 고칠 것이 없으면 검사를 통과한 그림 명령 */
  spec?: FigureSpec;
  /** 그림을 그릴 수 없게 만드는 문제 */
  errors: string[];
  /** 그릴 수는 있지만 살펴볼 것 */
  warnings: string[];
};

/** 그림 명령을 검사한다. errors 가 비어 있을 때만 spec 을 돌려준다. */
export function checkFigureSpec(input: unknown): FigureCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const top = TOP.safeParse(input);
  if (!top.success) {
    pushIssues(top, "", errors);
    return { errors, warnings };
  }
  const points = top.data.points ?? [];
  const elements = top.data.elements;

  // 점: 만드는 방법이 꼭 하나
  const ids = new Set<string>();
  points.forEach((p, i) => {
    const path = `points[${i}]`;
    if (!isObject(p) || typeof p.id !== "string" || !p.id) {
      errors.push(`${path}: 점에는 이름(id)이 있어야 합니다`);
      return;
    }
    const where = `${path} (${p.id})`;
    if (ids.has(p.id)) errors.push(`${where}: 같은 이름의 점이 또 있습니다`);
    ids.add(p.id);
    const keys = Object.keys(p).filter((k) => k !== "id");
    const forms = keys.filter((k) => k in POINT_FORMS);
    const unknown = keys.filter((k) => !(k in POINT_FORMS));
    if (unknown.length) errors.push(`${where}: 모르는 항목 ${unknown.join(", ")} (점 만드는 방법: ${Object.keys(POINT_FORMS).join(", ")})`);
    if (forms.length !== 1) {
      errors.push(`${where}: 점을 만드는 방법을 하나만 써야 합니다 (${forms.length ? forms.join(", ") : "없음"})`);
      return;
    }
    const form = forms[0];
    pushIssues(POINT_FORMS[form].safeParse(p[form]), `${where}.${form}`, errors);
    if (form === "intersect" && Array.isArray(p.intersect)) {
      p.intersect.forEach((line: unknown, j: number) => checkLine(line, `${where}.intersect[${j}]`, errors));
    }
  });

  // 요소: 종류별 모양
  elements.forEach((el, i) => {
    const path = `elements[${i}]`;
    const type = isObject(el) ? el.type : undefined;
    const schema = typeof type === "string" ? (ELEMENT_FORMS as Record<string, z.ZodType>)[type] : undefined;
    if (!schema) {
      errors.push(`${path}: 모르는 요소 종류 ${JSON.stringify(type)} (쓸 수 있는 것: ${Object.keys(ELEMENT_FORMS).join(", ")})`);
      return;
    }
    pushIssues(schema.safeParse(el), `${path} (${type})`, errors);
  });
  if (errors.length) return { errors, warnings };

  const spec = input as FigureSpec;

  // 점 이름: 쓰인 이름이 모두 있는지
  for (const [path, ref] of allRefs(spec)) {
    if (typeof ref === "string" && !ids.has(ref)) errors.push(`${path}: 점 '${ref}' 이 points 에 없습니다`);
  }
  if (errors.length) return { errors, warnings };

  // 점 위치: 모두 계산되는지 (평행한 두 직선, 만나지 않는 원과 직선, 서로를 거쳐 정해지는 점 등)
  let book: PointBook;
  try {
    book = new PointBook(spec.points ?? []);
  } catch (err) {
    errors.push(message(err));
    return { errors, warnings };
  }
  for (const id of book.ids()) {
    try {
      const p = book.pt(id);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        errors.push(`점 '${id}' 의 위치를 계산할 수 없습니다 (평행한 두 직선의 교점, 만나지 않는 원과 직선 등)`);
      }
    } catch (err) {
      errors.push(message(err));
    }
  }
  if (errors.length) return { errors, warnings };

  // 요소별로 더 볼 것
  spec.elements.forEach((el, i) => {
    const path = `elements[${i}] (${el.type})`;
    const pts = (el as { points?: PointRef[] }).points?.map((r) => book.pt(r));
    const same = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;
    if (pts && (el.type === "segment" || el.type === "line" || el.type === "dimension" || el.type === "ticks") && same(pts[0], pts[1])) {
      errors.push(`${path}: 두 끝점이 같은 자리입니다`);
    }
    if (pts && (el.type === "angle" || el.type === "rightAngle") && (same(pts[0], pts[1]) || same(pts[1], pts[2]))) {
      errors.push(`${path}: 각의 꼭짓점이 다른 점과 같은 자리입니다`);
    }
    if (el.type === "function") {
      for (const problem of functionExprProblems(el.expr)) errors.push(`${path}: ${problem}`);
      if (!(el.domain[1] > el.domain[0])) errors.push(`${path}: domain 은 [작은 값, 큰 값] 이어야 합니다`);
    }
    if (el.type === "axes" && !(el.x[1] > el.x[0] && el.y[1] > el.y[0])) errors.push(`${path}: x, y 범위는 [작은 값, 큰 값] 이어야 합니다`);
    if (el.type === "label" && /[_^]/.test(el.text)) {
      warnings.push(`${path}: 글자 '${el.text}' 는 적힌 그대로 그려집니다 (첨자는 A₁, x² 처럼 써야 합니다)`);
    }
  });
  if (spec.bbox && !(spec.bbox[2] > spec.bbox[0] && spec.bbox[1] > spec.bbox[3])) {
    errors.push("bbox 는 [왼쪽, 위, 오른쪽, 아래] 이고 오른쪽 > 왼쪽, 위 > 아래 여야 합니다");
  }
  return errors.length ? { errors, warnings } : { spec, errors, warnings };
}

/** 그림 명령에 쓰인 점 (경로, 이름이나 좌표) */
function allRefs(spec: FigureSpec): [string, PointRef][] {
  const out: [string, PointRef][] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") out.push([path, value]);
    else if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number")) out.push([path, value as PointRef]);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (isObject(value)) for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
  };
  (spec.points ?? []).forEach((p, i) => {
    const { id, ...rest } = p as { id: string } & Record<string, unknown>;
    if ("at" in rest) return;
    for (const [k, v] of Object.entries(rest)) {
      if (k === "glider" || k === "isoApex" || k === "polar" || k === "circleLine" || k === "foot") {
        // 숫자·글자 설정(dist, angle, side 등)은 점이 아니다
        for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
          if (["base", "line", "to", "dirOf"].includes(kk)) walk(vv, `points[${i}] (${id}).${k}.${kk}`);
          else if (["from", "center", "through", "other", "near"].includes(kk)) walk(vv, `points[${i}] (${id}).${k}.${kk}`);
        }
      } else if (k === "midpoint") walk(v, `points[${i}] (${id}).midpoint`);
      else if (k === "intersect") {
        (v as Record<string, unknown>[]).forEach((line, j) => {
          for (const [kk, vv] of Object.entries(line)) {
            if (kk === "perpendicular") {
              const per = vv as Record<string, unknown>;
              walk(per.through, `points[${i}] (${id}).intersect[${j}].perpendicular.through`);
              walk(per.to, `points[${i}] (${id}).intersect[${j}].perpendicular.to`);
            } else if (kk !== "angle" && kk !== "turn") walk(vv, `points[${i}] (${id}).intersect[${j}].${kk}`);
          }
        });
      }
    }
  });
  spec.elements.forEach((el, i) => {
    const e = el as unknown as Record<string, unknown>;
    for (const key of ["points", "at", "center", "through", "from", "to"]) {
      if (e[key] === undefined) continue;
      // 격자·동그라미 라벨의 at 은 좌표만 쓴다 (모양 검사에서 이미 봄)
      if (key === "at" && (el.type === "grid" || el.type === "badge")) continue;
      walk(e[key], `elements[${i}] (${el.type}).${key}`);
    }
  });
  return out;
}

function pushIssues(result: { success: boolean; error?: z.ZodError }, path: string, errors: string[]) {
  if (result.success || !result.error) return;
  for (const issue of result.error.issues.slice(0, 6)) {
    const sub = issue.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("");
    errors.push(`${path}${sub || ""}: ${issue.message}`.replace(/^:\s*/, ""));
  }
}

function isObject(v: unknown): v is Record<string, any> /* eslint-disable-line @typescript-eslint/no-explicit-any */ {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
