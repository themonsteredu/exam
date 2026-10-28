// 두 시험지 JSON 비교 (직접 넣은 것 ↔ AI 가 읽은 것).
// 4단계 완료 기준("samples 로 만든 JSON 이 직접 넣은 내용과 거의 같다")을 숫자로 보려고 쓴다.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 수식 글을 비교하기 좋게 고친다 (띄어쓰기, 같은 뜻의 다른 표기) */
export function normalizeLatex(s: string): string {
  return s
    .replace(/\\left|\\right/g, "")
    .replace(/\^\s*\\circ/g, "^{\\circ}")
    .replace(/°/g, "^{\\circ}")
    .replace(/\\le(?![a-z])/g, "\\leq")
    .replace(/\\ge(?![a-z])/g, "\\geq")
    .replace(/\\ne(?![a-z])/g, "\\neq")
    .replace(/\\(?:,|;|:|!| |quad|qquad)/g, "")
    .replace(/\^(\w)/g, "^{$1}")
    .replace(/_(\w)/g, "_{$1}")
    .replace(/\s+/g, "");
}

/** 글 조각 → 비교용 글 (수식은 $…$) */
export function piecesText(pieces: any[] | undefined): string {
  return (pieces ?? [])
    .map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p.m === "string") return `$${normalizeLatex(p.m)}$`;
      return String(p?.t ?? "");
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** 0~1 비슷한 정도 (글자 편집 거리) */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** 띄어쓰기를 뺀 내용 비교 */
const content = (s: string) => s.replace(/\s+/g, "");

export type FieldDiff = { field: string; expected: string; got: string; score: number };

export type ItemCompare = {
  no: number | string;
  found: boolean;
  /** 글·수식·선택지·보기 내용이 같은 정도 (띄어쓰기 제외) */
  textScore: number;
  /** 띄어쓰기까지 같은지 */
  spacingSame: boolean;
  pointsSame: boolean;
  figureSame: boolean;
  diffs: FieldDiff[];
};

export type ExamCompare = {
  summary: {
    items: number;
    found: number;
    textScore: number;
    pointsSame: number;
    figureSame: number;
    headerScore: number;
    boxesScore: number;
    footerScore: number;
  };
  items: ItemCompare[];
  header: FieldDiff[];
  extraItems: (number | string)[];
};

function field(name: string, expected: string, got: string, diffs: FieldDiff[]): number {
  const score = similarity(content(expected), content(got));
  if (score < 1 || expected !== got) diffs.push({ field: name, expected, got, score });
  return score;
}

function allItems(exam: any): any[] {
  return (exam?.sections ?? []).flatMap((s: any) => (s.items ?? []).map((it: any) => ({ ...it, _section: s.title ?? "" })));
}

export function compareExams(expected: any, got: any): ExamCompare {
  const want = allItems(expected);
  const have = allItems(got);
  const used = new Set<any>();
  const items: ItemCompare[] = want.map((w) => {
    const g = have.find((h) => !used.has(h) && h.no === w.no && h._section === w._section) ?? have.find((h) => !used.has(h) && h.no === w.no);
    if (!g) return { no: w.no, found: false, textScore: 0, spacingSame: false, pointsSame: false, figureSame: false, diffs: [] };
    used.add(g);
    const diffs: FieldDiff[] = [];
    const scores: number[] = [];
    scores.push(field("문제 글", piecesText(w.stem), piecesText(g.stem), diffs));
    const wc = w.choices ?? [];
    const gc = g.choices ?? [];
    for (let i = 0; i < Math.max(wc.length, gc.length); i++) {
      scores.push(field(`선택지 ${i + 1}`, piecesText(wc[i]), piecesText(gc[i]), diffs));
    }
    const wb = w.bogi ?? [];
    const gb = g.bogi ?? [];
    for (let i = 0; i < Math.max(wb.length, gb.length); i++) scores.push(field(`보기 ${i + 1}`, piecesText(wb[i]), piecesText(gb[i]), diffs));
    const textScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    // 내용은 같고 띄어쓰기만 다른 칸도 diffs 에 (score 1 로) 들어 있다
    const spacingSame = diffs.length === 0;
    const pointsSame = (w.points ?? null) === (g.points ?? null);
    if (!pointsSame) diffs.push({ field: "배점", expected: String(w.points ?? "없음"), got: String(g.points ?? "없음"), score: 0 });
    const figureSame = !!w.figure === !!g.figure && (!w.figure || w.figure.place === g.figure.place);
    if (!figureSame) diffs.push({ field: "그림", expected: w.figure ? `있음(${w.figure.place})` : "없음", got: g.figure ? `있음(${g.figure.place})` : "없음", score: 0 });
    return { no: w.no, found: true, textScore, spacingSame, pointsSame, figureSame, diffs };
  });
  const header: FieldDiff[] = [];
  const h1 = expected?.header ?? {};
  const h2 = got?.header ?? {};
  const headerScores = ["title", "target", "date"].map((k) => field(`머리 ${k}`, String(h1[k] ?? ""), String(h2[k] ?? ""), header));
  const lines = (exam: any) => (exam?.boxes ?? []).map((b: any) => (b.lines ?? []).map((l: any) => (typeof l === "string" ? l : l.text)).join("\n")).join("\n\n");
  const boxesScore = field("안내 상자", lines(expected), lines(got), header);
  const f1 = expected?.footer ?? {};
  const f2 = got?.footer ?? {};
  const footerScores = ["right_top", "right_bottom", "notice"].map((k) => field(`꼬리말 ${k}`, String(f1[k] ?? ""), String(f2[k] ?? ""), header));
  const found = items.filter((i) => i.found);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    summary: {
      items: want.length,
      found: found.length,
      textScore: avg(items.map((i) => i.textScore)),
      pointsSame: items.filter((i) => i.pointsSame).length,
      figureSame: items.filter((i) => i.figureSame).length,
      headerScore: avg(headerScores),
      boxesScore,
      footerScore: avg(footerScores),
    },
    items,
    header,
    extraItems: have.filter((h) => !used.has(h)).map((h) => h.no),
  };
}
