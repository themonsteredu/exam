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

export type ArchiveClassGroup = {
  key: string;
  label: string;
  count: number;
  docs: ArchiveDocument[];
};

export type ArchiveSchoolGroup = {
  key: string;
  label: string;
  count: number;
  groups: ArchiveClassGroup[];
};

export function isArchived(doc: ArchiveDocument): boolean {
  return doc.status === "done" && Boolean(doc.hwpx_path) && doc.original_files.length > 0;
}

const UNCLASSIFIED = "unclassified";
const koreanOrder = new Intl.Collator("ko", { numeric: true });
const schoolEndings: Record<string, string> = {
  초: "초등학교",
  초교: "초등학교",
  중: "중학교",
  고: "고등학교",
};
const nonSchoolStems = /(?:기초|작업|제작|변환|출력|검토|진행|편집|풀이|확인|준비|중간|기말)$/;

function schoolNames(text: string): string[] {
  const names: string[] = [];
  const full = /(?:^|[^가-힣A-Za-z])((?:[가-힣]{2,14}대학교\s*)?[가-힣]{2,16})(초등학교|중학교|고등학교|초교)(?=$|[^가-힣A-Za-z])/gu;
  const short = /(?:^|[^가-힣A-Za-z])([가-힣]{2,12})(초|중|고)(?=$|[^가-힣A-Za-z])/gu;
  for (const [, stem, ending] of text.matchAll(full)) {
    names.push(stem.replace(/\s+/g, "") + (schoolEndings[ending] ?? ending));
  }
  for (const [, stem, ending] of text.matchAll(short)) {
    if (!nonSchoolStems.test(stem) && !(ending === "초" && stem.endsWith("기"))) {
      names.push(stem + schoolEndings[ending]);
    }
  }
  return names;
}

type ClassInfo = { year?: number; grade?: number; term?: number };

function classInfo(texts: string[]): ClassInfo | null {
  const years = new Set<number>();
  const grades = new Set<number>();
  const terms = new Set<number>();
  for (const text of texts) {
    for (const [, year] of text.matchAll(/(?:^|\D)((?:19|20)\d{2})\s*(?:학년도|년)/g)) years.add(Number(year));
    for (const [, grade] of text.matchAll(/(?:^|\D)([1-6])\s*학년(?!도)/g)) grades.add(Number(grade));
    for (const [, term] of text.matchAll(/(?:^|\D)([12])\s*학기/g)) terms.add(Number(term));
  }
  if ([years, grades, terms].some((values) => values.size > 1)) return null;
  return { year: [...years][0], grade: [...grades][0], term: [...terms][0] };
}

function compareClasses(a: ClassInfo, b: ClassInfo): number {
  return (b.year ?? 0) - (a.year ?? 0) || (a.grade ?? 99) - (b.grade ?? 99) || (a.term ?? 99) - (b.term ?? 99);
}

function byNewest(a: ArchiveDocument, b: ArchiveDocument): number {
  const time = (doc: ArchiveDocument) => Date.parse(doc.created_at) || 0;
  return time(b) - time(a) || koreanOrder.compare(a.title, b.title) || a.id.localeCompare(b.id);
}

export function groupArchivedDocuments(docs: ArchiveDocument[]): ArchiveSchoolGroup[] {
  type ClassBucket = ArchiveClassGroup & { info: ClassInfo };
  const schools = new Map<string, Map<string, ClassBucket>>();

  for (const doc of docs) {
    if (!isArchived(doc)) continue;
    const texts = [doc.title, ...doc.original_files.map((file) => file.name)].map((value) => value.normalize("NFKC"));
    const names = [...new Set(texts.flatMap(schoolNames))];
    const school = names.length === 1 ? names[0] : UNCLASSIFIED;
    const info = classInfo(texts) ?? {};
    const { year, grade, term } = info;
    const label = [year && `${year}학년도`, grade && `${grade}학년`, term && `${term}학기`].filter(Boolean).join(" ");
    const key = label || UNCLASSIFIED;
    let groups = schools.get(school);
    if (!groups) {
      groups = new Map();
      schools.set(school, groups);
    }
    let group = groups.get(key);
    if (!group) {
      group = { key, label: label || "학년·학기 미분류", info, count: 0, docs: [] };
      groups.set(key, group);
    }
    group.docs.push(doc);
    group.count += 1;
  }

  return [...schools.entries()]
    .sort(([a], [b]) => Number(a === UNCLASSIFIED) - Number(b === UNCLASSIFIED) || koreanOrder.compare(a, b))
    .map(([key, schoolGroups]) => {
      const groups = [...schoolGroups.values()]
        .sort((a, b) => compareClasses(a.info, b.info))
        .map(({ key, label, count, docs }) => ({ key, label, count, docs: docs.sort(byNewest) }));
      return { key, label: key === UNCLASSIFIED ? "학교 미분류" : key, count: groups.reduce((total, group) => total + group.count, 0), groups };
    });
}
