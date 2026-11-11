import type { FileRef } from "./api";

export type ArchiveDocument = {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
  status: "reading" | "done" | "failed";
  original_files: FileRef[];
  hwpx_path: string | null;
  cost_usd: number;
  item_count: number;
  note: string | null;
};

export type ArchiveGradeGroup = {
  key: string;
  label: string;
  count: number;
  docs: ArchiveDocument[];
};

export type ArchiveTermGroup = {
  key: string;
  label: string;
  count: number;
  grades: ArchiveGradeGroup[];
};

export type ArchiveYearGroup = {
  key: string;
  label: string;
  count: number;
  terms: ArchiveTermGroup[];
};

export function isArchived(doc: ArchiveDocument): boolean {
  return doc.status === "done" && Boolean(doc.hwpx_path) && doc.original_files.length > 0;
}

const UNCLASSIFIED = "unclassified";
const koreanOrder = new Intl.Collator("ko", { numeric: true });
type ClassInfo = { year?: number; grade?: number; term?: number };

function classInfo(texts: string[]): ClassInfo {
  const years = new Set<number>();
  const grades = new Set<number>();
  const terms = new Set<number>();
  for (const raw of texts) {
    const text = raw
      .replace(/\(\s*([1-6])\s*\)\s*(학년|학기)/g, "$1$2")
      // 스캔 날짜를 시험 학년도나 '학년-학기'로 읽지 않는다.
      .replace(/(?<!\d)(?:19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}(?!\d)/g, " ");
    for (const [, year] of text.matchAll(/(?:^|\D)((?:19|20)\d{2})(?!\d)/g)) years.add(Number(year));
    // 보관된 '26년 문성중 1-2' 같은 최근 시험지 파일명 표기.
    for (const [, year] of text.matchAll(/(?:^|\D)([0-4]\d)\s*(?:학년도|년)/g)) years.add(2000 + Number(year));
    for (const [, grade] of text.matchAll(/(?:^|\D)([1-6])\s*학년(?!도)/g)) grades.add(Number(grade));
    for (const [, term] of text.matchAll(/(?:^|\D)([12])\s*학기/g)) terms.add(Number(term));
    for (const [, grade, term] of text.matchAll(/(?:^|[^\d])([1-6])\s*[-–]\s*([12])(?=$|[^\d])/g)) {
      grades.add(Number(grade));
      terms.add(Number(term));
    }
  }
  // 한 항목이 모호하더라도 나머지 확인된 분류는 유지한다.
  const unique = (values: Set<number>) => values.size === 1 ? [...values][0] : undefined;
  return { year: unique(years), grade: unique(grades), term: unique(terms) };
}

function byNewest(a: ArchiveDocument, b: ArchiveDocument): number {
  const time = (doc: ArchiveDocument) => Date.parse(doc.created_at) || 0;
  return time(b) - time(a) || koreanOrder.compare(a.title, b.title) || a.id.localeCompare(b.id);
}

export function groupArchivedDocuments(docs: ArchiveDocument[]): ArchiveYearGroup[] {
  const years = new Map<number, Map<number, Map<number, ArchiveDocument[]>>>();

  for (const doc of docs) {
    if (!isArchived(doc)) continue;
    const texts = [doc.title, ...doc.original_files.map((file) => file.name)].map((value) => value.normalize("NFKC"));
    const { year = 0, term = 0, grade = 0 } = classInfo(texts);
    if (!years.has(year)) years.set(year, new Map());
    const terms = years.get(year)!;
    if (!terms.has(term)) terms.set(term, new Map());
    const grades = terms.get(term)!;
    if (!grades.has(grade)) grades.set(grade, []);
    grades.get(grade)!.push(doc);
  }

  const key = (value: number) => value ? String(value) : UNCLASSIFIED;
  const ascending = (a: number, b: number) => (a || Infinity) - (b || Infinity);
  const count = (groups: { count: number }[]) => groups.reduce((total, group) => total + group.count, 0);
  return [...years.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, termBuckets]) => {
      const terms = [...termBuckets.entries()]
        .sort(([a], [b]) => ascending(a, b))
        .map(([term, gradeBuckets]) => {
          const grades = [...gradeBuckets.entries()]
            .sort(([a], [b]) => ascending(a, b))
            .map(([grade, docs]) => ({
              key: key(grade), label: grade ? `${grade}학년` : "학년 미분류",
              count: docs.length, docs: docs.sort(byNewest),
            }));
          return { key: key(term), label: term ? `${term}학기` : "학기 미분류", count: count(grades), grades };
        });
      return { key: key(year), label: year ? `${year}학년도` : "년도 미분류", count: count(terms), terms };
    });
}
