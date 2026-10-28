// 그림 명령(JSON) → JSXGraph(canvas) 그림.
// 브라우저에서만 돈다. JXG 는 `import("jsxgraph")` 로 불러서 넘긴다.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Vec, v, add, sub, mul, dist, unit, perp, fromAngle, angleOf, mid, bisectorDir, interiorSweep } from "./geometry";
import { PointBook } from "./points";
import type { ElementSpec, FigureSpec, PointRef, Dir } from "./types";

export const FONT_SERIF = "'Liberation Serif', 'Times New Roman', serif";
export const FONT_SANS = "'S-Core Dream', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";

type JXGType = any;

// 층(layer): 숫자가 클수록 위
const LAYER = { fill: 1, cubes: 2, dimension: 3, line: 5, mark: 6, dot: 7, text: 9, handle: 10 };

let patched = false;

/** 캔버스 글자: Arial 고정을 풀고, 실제 글자 높이로 정확히 가운데 맞춘다. */
export function patchCanvasText(JXG: JXGType) {
  if (patched) return;
  patched = true;
  JXG.CanvasRenderer.prototype.drawInternalText = function (el: any) {
    const fs = el.evalVisProp("fontsize");
    const ctx = this.context as CanvasRenderingContext2D;
    ctx.save();
    if (this._setColor(el, "stroke", "fill") && !isNaN(el.coords.scrCoords[1] + el.coords.scrCoords[2])) {
      const f = el.figFont || { family: FONT_SANS, italic: false, weight: 400 };
      ctx.font = `${f.italic ? "italic " : ""}${f.weight || 400} ${fs > 0 ? fs : 0}px ${f.family}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const m = ctx.measureText(el.plaintext);
      const dy = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
      ctx.fillText(el.plaintext, el.coords.scrCoords[1], el.coords.scrCoords[2] + dy);
    }
    ctx.restore();
    return null;
  };
}

/** 글꼴을 기다리는 가장 긴 시간(ms). 넘으면 있는 글꼴로 그리고, 그 글꼴을 쓴 그림마다 알림을 붙인다 */
const FONT_TIMEOUT_MS = 15000;
let fontsLoading: Promise<void> | null = null;

/**
 * 그림 글꼴(점 이름 Liberation Serif, 한글 에스코어드림)을 불러 둔다.
 * 내려받기가 실패하거나 멈춰도 FONT_TIMEOUT_MS 뒤에는 넘어간다. 한 페이지에서 한 번만 기다린다.
 * 빠진 글꼴은 그림마다 FigureRenderer.fontWarnings() 로 알린다.
 */
export function loadFigureFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  if (!fontsLoading) {
    const loads = Promise.all(
      [`20px 'Liberation Serif'`, `italic 20px 'Liberation Serif'`, `400 20px 'S-Core Dream'`, `500 20px 'S-Core Dream'`]
        .map((font) => document.fonts.load(font).catch(() => undefined)),
    );
    fontsLoading = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FONT_TIMEOUT_MS);
      loads.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return fontsLoading;
}

/** 요소가 쓰는 점(이름이나 좌표)을 모두 모은다 */
function refsOf(el: ElementSpec): PointRef[] {
  const s: any = el;
  const out: PointRef[] = Array.isArray(s.points) ? [...s.points] : [];
  for (const key of ["at", "center", "through", "from", "to"]) {
    if (s[key] !== undefined) out.push(s[key]);
  }
  return out;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measureTextPx(text: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 10;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

const DIRS: Record<string, number> = { E: 0, NE: 45, N: 90, NW: 135, W: 180, SW: 225, S: 270, SE: 315 };
const dirVec = (d: Dir): Vec => fromAngle(typeof d === "number" ? d : DIRS[d] ?? 90);

export type RenderOptions = {
  /** 보드 가로 크기(px, 화면 기준) */
  widthPx: number;
  /** 자유점을 끌 수 있게 할지 */
  interactive?: boolean;
  /** 자유점 위치 (id → from 에서의 거리) */
  gliders?: Record<string, number>;
  /** 자유점을 옮길 때마다 부르는 함수 */
  onChange?: () => void;
};

export class FigureRenderer {
  JXG: JXGType;
  spec: FigureSpec;
  board: any;
  container: HTMLElement;
  bbox: [number, number, number, number];
  pxPerUnit: number;
  heightPx: number;
  /** 다 그리지 못한 까닭 (없는 점, 계산되지 않는 점, 모르는 요소 등). 비어 있지 않으면 PNG 를 만들지 않는다 */
  issues: string[] = [];
  /** 점 위치 계산 (자유점은 보드를 만든 뒤 JSXGraph glider 위치를 따른다) */
  private book: PointBook;
  private gliderEls = new Map<string, { el: any; from: () => Vec; dir: () => Vec }>();
  private opts: RenderOptions;
  /** 그릴 요소 (쓰는 점을 확인한 것만) */
  private elements: ElementSpec[];
  /** 함수 요소마다 미리 계산한 점 (범위 계산용) */
  private fnSamples = new Map<ElementSpec, Vec[]>();
  /** 이 그림에 쓴 글꼴 → 그 글꼴로 쓴 글자 */
  private fontsUsed = new Map<string, string>();

  constructor(JXG: JXGType, container: HTMLElement, spec: FigureSpec, opts: RenderOptions) {
    this.JXG = JXG;
    this.spec = spec;
    this.container = container;
    this.opts = opts;
    patchCanvasText(JXG);

    // 점 계산 준비 (자유점은 보드를 만들기 전까지 처음 위치로)
    this.book = new PointBook(spec.points || [], {
      gliders: opts.gliders,
      gliderPosition: (id) => {
        const ge = this.gliderEls.get(id);
        return ge ? v(ge.el.X(), ge.el.Y()) : undefined;
      },
    });
    // 없는 점이나 계산되지 않는 점(만나지 않는 원과 직선 등)을 쓰는 요소는 그리지 않고 issues 에 적는다
    this.elements = spec.elements.filter((el) => this.usable(el));

    this.bbox = spec.bbox || this.autoBBox();
    if (!(this.bbox[2] > this.bbox[0] && this.bbox[1] > this.bbox[3])) {
      this.addIssue("그림의 보이는 범위(bbox)를 정할 수 없습니다");
      this.bbox = [-1, 1, 1, -1];
    }
    const [l, t, r, b] = this.bbox;
    this.pxPerUnit = opts.widthPx / (r - l);
    this.heightPx = Math.round((t - b) * this.pxPerUnit);
    container.style.width = `${opts.widthPx}px`;
    container.style.height = `${this.heightPx}px`;

    this.board = JXG.JSXGraph.initBoard(container, {
      renderer: "canvas",
      boundingbox: this.bbox,
      keepAspectRatio: true,
      axis: false,
      grid: false,
      showNavigation: false,
      showCopyright: false,
      showInfobox: false,
      pan: { enabled: false },
      zoom: { enabled: false, wheel: false },
      resize: { enabled: false },
    });
    this.board.suspendUpdate();
    this.setupDashes();
    this.createGliders();
    for (const el of this.elements) this.drawElement(el);
    this.board.unsuspendUpdate();
    if (opts.onChange) this.board.on("update", opts.onChange);
  }

  destroy() {
    try {
      this.JXG.JSXGraph.freeBoard(this.board);
    } catch {
      /* 이미 지워짐 */
    }
  }

  // ---------------------------------------------------------------- 크기 기준
  get base() {
    return this.spec.base;
  }
  /** 본선 굵기 (px) */
  get lineWidthPx() {
    return 0.01 * this.base * (this.spec.style?.lineScale ?? 1) * this.pxPerUnit;
  }
  /** 점 이름 글자 크기 (그림 단위) */
  get labelUnits() {
    return 0.15 * this.base * (this.spec.style?.labelScale ?? 1);
  }
  get labelPx() {
    return this.labelUnits * this.pxPerUnit;
  }

  private setupDashes() {
    const w = this.lineWidthPx;
    const dims = w * 0.5;
    // dash 번호: 1 보조 점선, 2 길이 표시 짧은 점선, 3 동그란 점선, 4 격자 점선
    this.board.renderer.dashArray = [
      [w * 4, w * 3],
      [dims * 7, dims * 5],
      [0, w * 0.9 * 2.4],
      [w * 2.2, w * 2.2],
      [20, 10, 10, 10],
      [20, 5, 10, 5],
      [0, 5],
    ];
  }

  // ---------------------------------------------------------------- 점
  pt(ref: PointRef): Vec {
    return this.book.pt(ref);
  }

  /** 지금 점 좌표 (자유점을 옮긴 뒤 값 포함) */
  pointValue(id: string): Vec {
    return this.pt(id);
  }

  pointIds(): string[] {
    return this.book.ids();
  }

  private createGliders() {
    for (const { id, spec: g, from: fromFn, dir: dirFn, startDist } of this.book.gliders) {
      const a = () => this.pt(g.line[0]);
      const b = () => this.pt(g.line[1]);
      const line = this.board.create(
        g.segment ? "segment" : "line",
        [() => [a().x, a().y], () => [b().x, b().y]],
        { visible: false, fixed: true },
      );
      const start = add(fromFn(), mul(dirFn(), startDist()));
      const interactive = !!this.opts.interactive;
      const el = this.board.create("glider", [start.x, start.y, line], {
        name: "",
        withLabel: false,
        size: Math.max(4, this.lineWidthPx * 3),
        face: "o",
        fillColor: "#F28C28",
        strokeColor: "#F28C28",
        fillOpacity: 0.35,
        strokeOpacity: 0.8,
        visible: interactive,
        fixed: !interactive,
        highlight: interactive,
        layer: LAYER.handle,
        showInfobox: false,
      });
      this.gliderEls.set(id, { el, from: fromFn, dir: dirFn });
    }
  }

  /** 자유점 위치를 from 에서의 거리로 돌려준다 (PNG 다시 그릴 때 사용) */
  gliderState(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, g] of this.gliderEls) {
      const p = v(g.el.X(), g.el.Y());
      const d = sub(p, g.from());
      out[id] = d.x * g.dir().x + d.y * g.dir().y;
    }
    return out;
  }

  // ---------------------------------------------------------------- 확인
  private addIssue(message: string) {
    if (!this.issues.includes(message)) this.issues.push(message);
  }

  /** 요소가 쓰는 점이 모두 있고 계산되는지 본다. 함수 요소는 식도 미리 계산해 본다. */
  private usable(el: ElementSpec): boolean {
    for (const ref of refsOf(el)) {
      let p: Vec;
      try {
        p = this.pt(ref);
      } catch (err) {
        this.addIssue(err instanceof Error ? err.message : String(err));
        return false;
      }
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        const name = typeof ref === "string" ? `'${ref}'` : JSON.stringify(ref);
        this.addIssue(`점 ${name} 의 위치를 계산할 수 없습니다 (만나지 않는 원과 직선, 평행한 두 직선 등)`);
        return false;
      }
    }
    if (el.type === "function") {
      const pts = this.sampleFunction(el);
      if (!pts) return false;
      this.fnSamples.set(el, pts);
    }
    return true;
  }

  /**
   * 함수 식을 JSXGraph 의 식 해석기(JessieCode)로 읽어 정의역을 40 칸으로 나눠 계산한다.
   * 식은 페이지 JavaScript 로 실행하지 않는다. 그리는 보드가 아직 없으므로 그리지 않는 보드(renderer "no")를 잠깐 쓴다.
   */
  private sampleFunction(el: Extract<ElementSpec, { type: "function" }>): Vec[] | null {
    const parser = this.JXG.JSXGraph.initBoard(document.createElement("div"), {
      renderer: "no", boundingbox: [-1, 1, 1, -1], showNavigation: false, showCopyright: false,
    });
    try {
      let f: (x: number) => unknown;
      try {
        f = parser.jc.snippet(el.expr, true, "x", false);
      } catch {
        this.addIssue(`함수 식 '${el.expr}' 을 읽을 수 없습니다`);
        return null;
      }
      const out: Vec[] = [];
      for (let i = 0; i <= 40; i++) {
        const x = el.domain[0] + ((el.domain[1] - el.domain[0]) * i) / 40;
        let y = NaN;
        try {
          y = Number(f(x));
        } catch {
          /* 이 x 에서는 계산되지 않는다 */
        }
        if (Number.isFinite(y)) out.push(v(x, y));
      }
      if (out.length === 0) {
        this.addIssue(`함수 식 '${el.expr}' 의 값을 계산할 수 없습니다`);
        return null;
      }
      return out;
    } finally {
      this.JXG.JSXGraph.freeBoard(parser);
    }
  }

  // ---------------------------------------------------------------- 범위
  private autoBBox(): [number, number, number, number] {
    const pts: Vec[] = [];
    for (const id of this.book.ids()) {
      try {
        pts.push(this.pt(id));
      } catch {
        /* 다른 점이 없어 계산되지 않는 점. 이 점을 쓰는 요소는 issues 에 이미 적혀 있다 */
      }
    }
    for (const el of this.elements) pts.push(...refsOf(el).map((r) => this.pt(r)), ...this.extentOf(el));
    const good = pts.filter((p) => isFinite(p.x) && isFinite(p.y));
    if (good.length === 0) {
      this.addIssue("그릴 점이나 선이 하나도 없습니다");
      return [-1, 1, 1, -1];
    }
    const xs = good.map((p) => p.x);
    const ys = good.map((p) => p.y);
    const pad = this.labelUnits * 0.6;
    return [Math.min(...xs) - pad, Math.max(...ys) + pad, Math.max(...xs) + pad, Math.min(...ys) - pad];
  }

  private extentOf(el: ElementSpec): Vec[] {
    const L = this.labelUnits;
    const box = (c: Vec, w: number, h: number) => [v(c.x - w, c.y - h), v(c.x + w, c.y + h)];
    switch (el.type) {
      case "label": {
        const at = this.pt(el.at);
        const size = L * (el.size ?? 1);
        const c = el.dir ? add(at, mul(dirVec(el.dir), size * (el.offset ?? 0.75))) : at;
        return box(c, size * 0.3 * Math.max(1, el.text.length), size * 0.5);
      }
      case "dimension": {
        const [a, b] = el.points.map((r) => this.pt(r));
        const n = perp(unit(sub(b, a)));
        const apex = add(mid(a, b), mul(n, el.bulge * dist(a, b)));
        const size = L * (el.labelSize ?? 0.85);
        const w = el.label ? (measureTextPx(el.label, `400 100px ${FONT_SERIF}`) / 100) * size : 0;
        const out = el.labelPlace === "outside" ? mul(n, (Math.sign(el.bulge) || 1) * (w / 2 * Math.abs(n.x) + size * 0.6 * Math.abs(n.y) + size * 0.2)) : v(0, 0);
        return [a, b, ...box(add(apex, out), w / 2 + size * 0.2, size * 0.6)];
      }
      case "cubes":
        return this.cubeFaces(el).flatMap((f) => f.pts);
      case "grid":
        return [v(el.at[0], el.at[1]), v(el.at[0] + el.cols * el.cell, el.at[1] - el.rows * el.cell)];
      case "badge": {
        const r = el.radius ?? L * 0.75;
        return box(v(el.at[0], el.at[1]), r, r);
      }
      case "axes":
        return [v(el.x[0], el.y[0]), v(el.x[1] + L * 0.6, el.y[1] + L * 0.6)];
      case "circle": {
        const c = this.pt(el.center);
        const r = el.radius ?? dist(c, this.pt(el.through!));
        return box(c, r, r);
      }
      case "segment": {
        const [a, b] = el.points.map((r) => this.pt(r));
        const d = unit(sub(b, a));
        return [sub(a, mul(d, el.extendStart ?? 0)), add(b, mul(d, el.extendEnd ?? 0))];
      }
      case "arrow":
        return [this.pt(el.from), this.pt(el.to)];
      case "function":
        return this.fnSamples.get(el) ?? [];
      case "arc":
        return this.arcPath(el);
      case "angle": {
        const [a, o, b] = el.points.map((p) => this.pt(p));
        const r = el.radius ?? this.base * 0.07;
        const { start, end } = interiorSweep(a, o, b);
        const out = this.arcPoints(o, r + ((el.count ?? 1) - 1) * r * 0.22, start, end, 12);
        if (el.label) {
          const size = L * (el.labelSize ?? 0.8);
          const c = add(o, mul(bisectorDir(a, o, b), el.labelDist ?? r * 1.9));
          out.push(...box(c, size * 0.3 * Math.max(1, el.label.length), size * 0.5));
        }
        return out;
      }
      case "rightAngle": {
        const [a, o, b] = el.points.map((p) => this.pt(p));
        const s = el.size ?? this.base * 0.045;
        return [add(add(o, mul(unit(sub(a, o)), s)), mul(unit(sub(b, o)), s))];
      }
      case "ticks": {
        const [a, b] = el.points.map((p) => this.pt(p));
        const s = el.size ?? this.base * 0.035;
        return box(mid(a, b), s, s);
      }
      case "dot": {
        const r = (el.size ?? 1) * this.base * 0.012;
        return box(this.pt(el.at), r, r);
      }
      default:
        return [];
    }
  }

  // ---------------------------------------------------------------- 그리기 도우미
  private curve(
    data: () => Vec[],
    attrs: Record<string, any>,
  ) {
    const c = this.board.create("curve", [[0], [0]], {
      strokeColor: "#000000",
      strokeWidth: this.lineWidthPx,
      fillColor: "none",
      highlight: false,
      fixed: true,
      lineCap: "round",
      ...attrs,
    });
    c.updateDataArray = function () {
      const pts = data();
      this.dataX = pts.map((p) => p.x);
      this.dataY = pts.map((p) => p.y);
    };
    return c;
  }

  private text(at: () => Vec, text: string, opts: { sizePx: number; family: string; italic?: boolean; weight?: number; color?: string }) {
    const t = this.board.create("text", [() => at().x, () => at().y, text], {
      display: "internal",
      // 적힌 글자 그대로 그린다 (A_1, x^2 를 <sub>/<sup> 태그로 바꾸지 않고, <value> 같은 것도 계산하지 않는다)
      parse: false,
      anchorX: "middle",
      anchorY: "middle",
      fontSize: opts.sizePx,
      strokeColor: opts.color || "#000000",
      highlight: false,
      fixed: true,
      layer: LAYER.text,
    });
    t.figFont = { family: opts.family, italic: !!opts.italic, weight: opts.weight || 400 };
    const font = `${opts.italic ? "italic " : ""}${opts.weight || 400} 20px ${opts.family}`;
    this.fontsUsed.set(font, (this.fontsUsed.get(font) ?? "") + text);
    return t;
  }

  /** 이 그림에 쓴 글꼴 가운데 불러오지 못한 것이 있으면 알림 문장으로 돌려준다 */
  fontWarnings(): string[] {
    if (typeof document === "undefined" || !document.fonts) return [];
    const missing = new Set<string>();
    for (const [font, sample] of this.fontsUsed) {
      if (!document.fonts.check(font, sample)) missing.add(font.includes("S-Core Dream") ? "에스코어드림" : "Liberation Serif");
    }
    return [...missing].map((name) => `글꼴(${name})을 불러오지 못해 다른 글꼴로 그렸습니다`);
  }

  private strokeAttrs(s: { width?: number; color?: string; dash?: boolean }, layer = LAYER.line) {
    return {
      strokeWidth: this.lineWidthPx * (s.width ?? 1),
      strokeColor: s.color || "#000000",
      dash: s.dash ? 1 : 0,
      layer,
    };
  }

  private arcPoints(c: Vec, r: number, startDeg: number, endDeg: number, n = 48): Vec[] {
    const out: Vec[] = [];
    for (let i = 0; i <= n; i++) out.push(add(c, mul(fromAngle(startDeg + ((endDeg - startDeg) * i) / n), r)));
    return out;
  }

  /** 호: center 를 중심으로 from 에서 to 까지 시계 반대 방향 */
  private arcPath(el: Extract<ElementSpec, { type: "arc" }>): Vec[] {
    const c = this.pt(el.center);
    const f = this.pt(el.from);
    const t = this.pt(el.to);
    const r = el.radius ?? dist(c, f);
    const s = angleOf(sub(f, c));
    let e = angleOf(sub(t, c));
    while (e < s) e += 360;
    return this.arcPoints(c, r, s, e, 90);
  }

  // ---------------------------------------------------------------- 요소
  private drawElement(el: ElementSpec) {
    const L = this.labelUnits;
    switch (el.type) {
      case "segment": {
        this.curve(() => {
          const a = this.pt(el.points[0]);
          const b = this.pt(el.points[1]);
          const d = unit(sub(b, a));
          return [sub(a, mul(d, el.extendStart ?? 0)), add(b, mul(d, el.extendEnd ?? 0))];
        }, this.strokeAttrs(el));
        return;
      }
      case "line": {
        const a = () => this.pt(el.points[0]);
        const b = () => this.pt(el.points[1]);
        this.board.create("line", [() => [a().x, a().y], () => [b().x, b().y]], {
          ...this.strokeAttrs(el),
          straightFirst: !el.ray,
          straightLast: true,
          highlight: false,
          fixed: true,
        });
        return;
      }
      case "polygon": {
        const pts = () => {
          const p = el.points.map((r) => this.pt(r));
          return [...p, p[0]];
        };
        this.curve(pts, {
          ...this.strokeAttrs(el, LAYER.fill),
          fillColor: el.fill || "none",
          fillOpacity: 1,
          strokeWidth: el.border === false ? 0 : this.lineWidthPx * (el.width ?? 1),
          strokeOpacity: el.border === false ? 0 : 1,
        });
        return;
      }
      case "circle": {
        this.curve(() => {
          const c = this.pt(el.center);
          const r = el.radius ?? dist(c, this.pt(el.through!));
          return this.arcPoints(c, r, 0, 360, 120);
        }, { ...this.strokeAttrs(el), fillColor: el.fill || "none", fillOpacity: 1 });
        return;
      }
      case "arc": {
        this.curve(() => this.arcPath(el), this.strokeAttrs(el));
        return;
      }
      case "angle": {
        const r = el.radius ?? this.base * 0.07;
        const count = el.count ?? 1;
        const markWidth = (el.width ?? 0.8);
        for (let k = 0; k < count; k++) {
          const rk = r + k * r * 0.22;
          this.curve(() => {
            const [a, o, b] = el.points.map((p) => this.pt(p));
            const { start, end } = interiorSweep(a, o, b);
            return this.arcPoints(o, rk, start, end, 40);
          }, { ...this.strokeAttrs({ ...el, width: markWidth }, LAYER.mark) });
        }
        if (el.symbol) {
          const at = () => {
            const [a, o, b] = el.points.map((p) => this.pt(p));
            return add(o, mul(bisectorDir(a, o, b), r * 0.62));
          };
          const s = r * 0.16;
          if (el.symbol === "dot") {
            this.curve(() => this.arcPoints(at(), s * 0.75, 0, 360, 20), {
              strokeWidth: 0, fillColor: el.color || "#000", fillOpacity: 1, layer: LAYER.mark,
            });
          } else {
            for (const ang of [45, 135]) {
              this.curve(() => {
                const c = at();
                const d = mul(fromAngle(ang), s * 1.3);
                return [sub(c, d), add(c, d)];
              }, this.strokeAttrs({ width: 0.7, color: el.color }, LAYER.mark));
            }
          }
        }
        if (el.label) {
          const dl = el.labelDist ?? r * 1.9;
          this.text(() => {
            const [a, o, b] = el.points.map((p) => this.pt(p));
            return add(o, mul(bisectorDir(a, o, b), dl));
          }, el.label, { sizePx: this.labelPx * (el.labelSize ?? 0.8), family: FONT_SERIF });
        }
        return;
      }
      case "rightAngle": {
        const s = el.size ?? this.base * 0.045;
        this.curve(() => {
          const [a, o, b] = el.points.map((p) => this.pt(p));
          const u1 = mul(unit(sub(a, o)), s);
          const u2 = mul(unit(sub(b, o)), s);
          return [add(o, u1), add(add(o, u1), u2), add(o, u2)];
        }, { ...this.strokeAttrs({ ...el, width: el.width ?? 0.8 }, LAYER.mark), lineCap: "butt" });
        return;
      }
      case "ticks": {
        const n = el.count ?? 1;
        const size = el.size ?? this.base * 0.035;
        for (let k = 0; k < n; k++) {
          this.curve(() => {
            const [a, b] = el.points.map((p) => this.pt(p));
            const d = unit(sub(b, a));
            const nrm = perp(d);
            const c = add(mid(a, b), mul(d, (k - (n - 1) / 2) * size * 0.55));
            return [add(c, mul(nrm, size)), sub(c, mul(nrm, size))];
          }, this.strokeAttrs({ ...el, width: el.width ?? 0.8 }, LAYER.mark));
        }
        return;
      }
      case "dimension":
        this.drawDimension(el);
        return;
      case "label": {
        const size = L * (el.size ?? 1);
        const serif = (el.font ?? "serif") === "serif";
        this.text(() => {
          const at = this.pt(el.at);
          return el.dir ? add(at, mul(dirVec(el.dir), size * (el.offset ?? 0.75))) : at;
        }, el.text, {
          sizePx: size * this.pxPerUnit,
          family: serif ? FONT_SERIF : FONT_SANS,
          italic: el.italic,
          color: el.color,
          weight: serif ? 400 : 500,
        });
        return;
      }
      case "dot": {
        const r = (el.size ?? 1) * this.base * 0.012;
        this.curve(() => this.arcPoints(this.pt(el.at), r, 0, 360, 24), {
          strokeWidth: 0, fillColor: el.color || "#000", fillOpacity: 1, layer: LAYER.dot,
        });
        return;
      }
      case "axes":
        this.drawAxes(el);
        return;
      case "function": {
        const f = this.board.jc.snippet(el.expr, true, "x", false);
        this.board.create("functiongraph", [f, el.domain[0], el.domain[1]], {
          ...this.strokeAttrs(el), highlight: false, fixed: true,
        });
        return;
      }
      case "cubes":
        this.drawCubes(el);
        return;
      case "grid": {
        const [x0, y0] = el.at;
        const color = el.color || "#4A7BD0";
        const attrs = { strokeWidth: this.lineWidthPx * 0.7, strokeColor: color, dash: el.dash === false ? 0 : 4, layer: LAYER.line, lineCap: "butt" };
        for (let i = 0; i <= el.rows; i++) {
          const y = y0 - i * el.cell;
          this.curve(() => [v(x0, y), v(x0 + el.cols * el.cell, y)], attrs);
        }
        for (let j = 0; j <= el.cols; j++) {
          const x = x0 + j * el.cell;
          this.curve(() => [v(x, y0), v(x, y0 - el.rows * el.cell)], attrs);
        }
        return;
      }
      case "badge": {
        const r = el.radius ?? L * 0.75;
        const c = v(el.at[0], el.at[1]);
        this.curve(() => this.arcPoints(c, r, 0, 360, 60), {
          strokeColor: el.stroke || "#888888",
          strokeWidth: this.lineWidthPx * 0.8,
          fillColor: el.fill || "#FFFFFF",
          fillOpacity: 1,
          layer: LAYER.mark,
        });
        this.text(() => c, el.text, { sizePx: r * 1.05 * this.pxPerUnit, family: FONT_SANS, weight: 500, color: el.textColor || "#222222" });
        return;
      }
      case "arrow": {
        const a = () => this.pt(el.from);
        const b = () => this.pt(el.to);
        this.curve(() => [a(), b()], this.strokeAttrs({ ...el, width: el.width ?? 0.8 }, LAYER.mark));
        const head = this.base * 0.03;
        this.curve(() => {
          const d = unit(sub(b(), a()));
          const n = perp(d);
          const tip = b();
          const back = sub(tip, mul(d, head * 1.6));
          return [add(back, mul(n, head * 0.6)), tip, sub(back, mul(n, head * 0.6)), add(back, mul(n, head * 0.6))];
        }, { strokeWidth: 0, fillColor: el.color || "#000", fillOpacity: 1, layer: LAYER.mark });
        return;
      }
      default:
        this.addIssue(`'${(el as { type?: unknown }).type}' 는 그림 엔진이 모르는 요소입니다`);
    }
  }

  private drawDimension(el: Extract<ElementSpec, { type: "dimension" }>) {
    const L = this.labelUnits;
    const labelSize = L * (el.labelSize ?? 0.85);
    const labelFont = `${el.italic ? "italic " : ""}400 ${labelSize * this.pxPerUnit}px ${FONT_SERIF}`;
    const labelW = el.label ? measureTextPx(el.label, labelFont) / this.pxPerUnit : 0;
    const outside = el.labelPlace === "outside";
    const labelHalf = el.label && !outside ? labelW / 2 + labelSize * 0.35 : 0;

    const path = (): Vec[] => {
      const a = this.pt(el.points[0]);
      const b = this.pt(el.points[1]);
      const L2 = dist(a, b);
      const u = unit(sub(b, a));
      const n = perp(u);
      const h = el.bulge * L2;
      const m = mid(a, b);
      const out: Vec[] = [];
      const N = 160;
      if (el.shape === "ellipse") {
        for (let i = 0; i <= N; i++) {
          const t = (Math.PI * i) / N;
          out.push(add(add(m, mul(u, -(L2 / 2) * Math.cos(t))), mul(n, h * Math.sin(t))));
        }
        return out;
      }
      if (Math.abs(h) < 1e-9) return [a, b];
      const R = (L2 * L2) / 4 / (2 * Math.abs(h)) + Math.abs(h) / 2;
      const c = add(m, mul(n, h - Math.sign(h) * R));
      const sa = angleOf(sub(a, c));
      const sb = angleOf(sub(b, c));
      const apex = add(m, mul(n, h));
      const sx = angleOf(sub(apex, c));
      const norm = (x: number) => ((x % 360) + 360) % 360;
      let sweep = norm(sb - sa);
      if (norm(sx - sa) > sweep) sweep -= 360;
      for (let i = 0; i <= N; i++) out.push(add(c, mul(fromAngle(sa + (sweep * i) / N), R)));
      return out;
    };

    this.curve(() => {
      const pts = path();
      // 길이를 따라 재서 빈칸(글자 자리, 점 이름 자리)을 비운다
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
      const total = cum[cum.length - 1];
      const gaps: [number, number][] = [];
      if (el.label) gaps.push([total / 2 - labelHalf, total / 2 + labelHalf]);
      if (el.gapStart) gaps.push([-1, el.gapStart]);
      if (el.gapEnd) gaps.push([total - el.gapEnd, total + 1]);
      const out: Vec[] = [];
      let wasIn = false;
      for (let i = 0; i < pts.length; i++) {
        const inGap = gaps.some(([g0, g1]) => cum[i] > g0 && cum[i] < g1);
        if (inGap) {
          if (!wasIn) out.push(v(NaN, NaN));
          wasIn = true;
          continue;
        }
        wasIn = false;
        out.push(pts[i]);
      }
      return out;
    }, {
      strokeColor: el.color || "#000000",
      strokeWidth: this.lineWidthPx * (el.width ?? (el.dotted ? 0.9 : 0.5)),
      dash: el.dotted ? 3 : 2,
      lineCap: "round",
      layer: LAYER.dimension,
    });

    if (el.label) {
      this.text(() => {
        const pts = path();
        const apex = pts[Math.floor(pts.length / 2)];
        if (!outside) return apex;
        // 호 바깥쪽으로, 글자 상자가 호에 닿지 않을 만큼 민다
        const a = this.pt(el.points[0]);
        const b = this.pt(el.points[1]);
        const n = mul(perp(unit(sub(b, a))), Math.sign(el.bulge) || 1);
        const push = (labelW / 2) * Math.abs(n.x) + (labelSize * 0.38) * Math.abs(n.y) + labelSize * 0.2;
        return add(apex, mul(n, push));
      }, el.label, { sizePx: labelSize * this.pxPerUnit, family: FONT_SERIF, italic: el.italic, color: "#000000" });
    }
  }

  private drawAxes(el: Extract<ElementSpec, { type: "axes" }>) {
    const L = this.labelUnits;
    const head = this.base * 0.025;
    const arrow = (a: Vec, b: Vec) => {
      this.curve(() => [a, b], this.strokeAttrs({ width: 0.8 }));
      const d = unit(sub(b, a));
      const n = perp(d);
      const back = sub(b, mul(d, head * 1.8));
      this.curve(() => [add(back, mul(n, head * 0.7)), b, sub(back, mul(n, head * 0.7)), add(back, mul(n, head * 0.7))], {
        strokeWidth: 0, fillColor: "#000", fillOpacity: 1, layer: LAYER.line,
      });
    };
    arrow(v(el.x[0], 0), v(el.x[1], 0));
    arrow(v(0, el.y[0]), v(0, el.y[1]));
    const lab = (at: Vec, text: string, italic: boolean, size = 0.85) =>
      this.text(() => at, text, { sizePx: L * size * this.pxPerUnit, family: FONT_SERIF, italic });
    lab(v(el.x[1] + L * 0.1, -L * 0.55), "x", true);
    lab(v(L * 0.5, el.y[1] + L * 0.05), "y", true);
    if (el.origin !== false) lab(v(-L * 0.45, -L * 0.5), "O", true);
    if (el.ticks) {
      const t = el.ticks;
      const tl = this.base * 0.012;
      for (let x = Math.ceil(el.x[0] / t) * t; x < el.x[1] - t * 0.3; x += t) {
        if (Math.abs(x) < 1e-9) continue;
        this.curve(() => [v(x, -tl), v(x, tl)], this.strokeAttrs({ width: 0.7 }));
        if (el.tickLabels) lab(v(x, -L * 0.55), String(Math.round(x * 100) / 100), false, 0.65);
      }
      for (let y = Math.ceil(el.y[0] / t) * t; y < el.y[1] - t * 0.3; y += t) {
        if (Math.abs(y) < 1e-9) continue;
        this.curve(() => [v(-tl, y), v(tl, y)], this.strokeAttrs({ width: 0.7 }));
        if (el.tickLabels) lab(v(-L * 0.5, y), String(Math.round(y * 100) / 100), false, 0.65);
      }
    }
  }

  // ---------------------------------------------------------------- 쌓기나무
  cubeFaces(el: Extract<ElementSpec, { type: "cubes" }>): { pts: Vec[]; color: string }[] {
    const s = el.size ?? 1;
    const [ox, oy] = el.origin ?? [0, 0];
    const colors = { top: "#EAD6AE", front: "#DFC69A", side: "#C9AC82", ...el.colors };
    // 화면 위 방향: c(왼→오른쪽), r(앞→뒤), z(위)
    const ec = el.mode === "iso" ? v(Math.cos(Math.PI / 6), -0.5) : v(1, 0);
    const er = el.mode === "iso" ? v(Math.cos(Math.PI / 6), 0.5) : v(el.depth ?? 0.45, el.depth ?? 0.45);
    const ez = v(0, 1);
    const P = (c: number, r: number, z: number) => v(ox + (ec.x * c + er.x * r + ez.x * z) * s, oy + (ec.y * c + er.y * r + ez.y * z) * s);
    const cubes: { c: number; r: number; z: number }[] = [];
    el.heights.forEach((row, r) => row.forEach((h, c) => {
      for (let z = 0; z < h; z++) cubes.push({ c, r, z });
    }));
    // 뒤에 있는 것부터: 깊이 = c - r + z (보는 사람 쪽이 +c, -r, +z)
    cubes.sort((a, b) => (a.c - a.r + a.z) - (b.c - b.r + b.z) || (b.r - a.r) || (a.c - b.c) || (a.z - b.z));
    const faces: { pts: Vec[]; color: string }[] = [];
    for (const { c, r, z } of cubes) {
      faces.push({ pts: [P(c, r, z), P(c + 1, r, z), P(c + 1, r, z + 1), P(c, r, z + 1)], color: colors.front }); // 앞면 (r 쪽)
      faces.push({ pts: [P(c + 1, r, z), P(c + 1, r + 1, z), P(c + 1, r + 1, z + 1), P(c + 1, r, z + 1)], color: colors.side }); // 옆면 (+c 쪽)
      faces.push({ pts: [P(c, r, z + 1), P(c + 1, r, z + 1), P(c + 1, r + 1, z + 1), P(c, r + 1, z + 1)], color: colors.top }); // 윗면
    }
    return faces;
  }

  private drawCubes(el: Extract<ElementSpec, { type: "cubes" }>) {
    const edge = el.colors?.edge || "#4B3E31";
    for (const f of this.cubeFaces(el)) {
      this.curve(() => [...f.pts, f.pts[0]], {
        fillColor: f.color,
        fillOpacity: 1,
        strokeColor: edge,
        strokeWidth: this.lineWidthPx * 0.8,
        lineJoin: "round",
        layer: LAYER.cubes,
      });
    }
  }

  // ---------------------------------------------------------------- 좌표 변환
  /** 그림 좌표 → 보드 안 화면 좌표(px) */
  toScreen(p: Vec): Vec {
    const [l, t] = this.bbox;
    return v((p.x - l) * this.pxPerUnit, (t - p.y) * this.pxPerUnit);
  }
}

/**
 * 보이지 않는 곳에 큰 보드를 따로 그려 흰 바탕 PNG 로 만든다.
 * 다 그리지 못하는 그림(없는 점, 계산되지 않는 점, 모르는 요소 등)은 까닭을 담아 오류를 낸다.
 * warnings: PNG 는 만들었지만 알려야 할 것 (글꼴을 못 불러와 다른 글꼴로 그림 등)
 */
export async function renderFigurePng(
  JXG: JXGType,
  spec: FigureSpec,
  opts: { widthPx: number; gliders?: Record<string, number> },
): Promise<{ dataUrl: string; width: number; height: number; warnings: string[] }> {
  if (!(opts.widthPx > 0)) throw new Error("그림의 가로 크기(width_mm)가 올바르지 않습니다");
  await loadFigureFonts();
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-100000px;top:0;";
  const box = document.createElement("div");
  box.id = `figpng-${Math.random().toString(36).slice(2)}`;
  holder.appendChild(box);
  document.body.appendChild(holder);
  let r: FigureRenderer | null = null;
  try {
    r = new FigureRenderer(JXG, box, spec, { widthPx: opts.widthPx, gliders: opts.gliders });
    if (r.issues.length) throw new Error(`그림을 다 그리지 못했습니다: ${r.issues.join(" / ")}`);
    r.board.fullUpdate();
    const src: HTMLCanvasElement = r.board.renderer.canvasRoot;
    // 캔버스는 화면 배율만큼 크게 그려지므로, 원하는 픽셀 수로 맞춰 흰 바탕에 합친다
    const out = document.createElement("canvas");
    out.width = opts.widthPx;
    out.height = Math.round((opts.widthPx * src.height) / src.width);
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, out.width, out.height);
    const dataUrl = out.toDataURL("image/png");
    return { dataUrl, width: out.width, height: out.height, warnings: r.fontWarnings() };
  } finally {
    r?.destroy();
    holder.remove();
  }
}

/** 실제 크기(mm)와 해상도(dpi)로 필요한 가로 픽셀 수 */
export function pxForPrint(widthMm: number, dpi = 360): number {
  return Math.round((widthMm / 25.4) * dpi);
}
