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

export type ArchiveClassPath = { year: string; term: string; grade: string };
export const ARCHIVE_STEPS = ["year", "grade", "term", "exam"] as const;
export type ArchiveStep = typeof ARCHIVE_STEPS[number];
export type ArchiveSelection = Record<ArchiveStep, string>;
export const EMPTY_ARCHIVE_SELECTION: ArchiveSelection = { year: "", grade: "", term: "", exam: "" };
export type ArchiveItem = {
  doc: ArchiveDocument;
  path: ArchiveSelection;
  labels: ArchiveSelection;
  displayPath: ArchiveClassPath;
  schools: string[];
};

/** 목록용 이름만 정돈한다. 저장된 제목과 내려받는 파일명은 그대로 둔다. */
export function archiveDisplayTitle(title: string, group?: ArchiveClassPath): string {
  const original = title.normalize("NFKC");
  let name = original.replace(/^TalkFile[\s_-]*/i, "").replace(/_/g, " ").trim();
  if (group) {
    const { year, grade, term } = group;
    if (/^(19|20)\d{2}$/.test(year)) {
      const shortYear = year.startsWith("20") ? `|${year.slice(2)}(?:학년도|년)` : "";
      name = name.replace(new RegExp(`(^|[\\s(])(?:${year}(?:학년도|년)?${shortYear})(?=$|[\\s)])`, "g"), "$1");
    }
    if (/^[1-6]$/.test(grade) && /^[12]$/.test(term)) {
      name = name.replace(new RegExp(`(^|[\\s(])(?:초|중|고)?\\s*${grade}\\s*[-–]\\s*${term}(?=$|[\\s)])`, "g"), "$1");
    }
    if (/^[1-6]$/.test(grade)) {
      name = name.replace(new RegExp(`(?<!\\d)(?:\\(\\s*${grade}\\s*\\)|${grade})\\s*학년(?!도)`, "g"), " ");
    }
    if (/^[12]$/.test(term)) name = name.replace(new RegExp(`(?<!\\d)${term}\\s*학기`, "g"), " ");
  }
  name = name.replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").trim();
  const school = name.match(/(?:^|\s)([가-힣]{2,20}(?:초등학교|중학교|고등학교|초교|초|중|고))(?=\s|$)/u);
  if (school && !/(?:작업중|변환중|진행중|기초)$/.test(school[1])) {
    const rest = name.replace(school[0], " ").replace(/\s+/g, " ").trim();
    name = school[1] + (rest ? ` · ${rest}` : "");
  }
  return name || original;
}

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

const schoolPattern = /(?:^|[\s\d()[\]·.,_-])([가-힣]{2,20}(?:초등학교|중학교|고등학교|초교|초|중|고))(?=$|[\s\d()[\]·.,_-])/gu;
const schoolSearchKey = (value: string) => value.normalize("NFKC").replace(/초등학교|초교/g, "초").replace(/중학교/g, "중").replace(/고등학교/g, "고").replace(/\s/g, "").toLowerCase();

export function classifyArchiveDocument(doc: ArchiveDocument): ArchiveItem {
  const texts = [doc.title, ...doc.original_files.map(file => file.name)].map(value => value.normalize("NFKC").replace(/_/g, " "));
  const info = classInfo(texts);
  const schools = [...new Set(texts.flatMap(text => [...text.matchAll(schoolPattern)].map(match => match[1])))].filter(name => !/(?:작업중|변환중|진행중|기초)$/.test(name));
  const levels = new Set<string>();
  const levelNames: Record<string, string> = { elementary: "초등학교", middle: "중학교", high: "고등학교" };
  for (const [key, name, short] of [["elementary", "초등학교", "초"], ["middle", "중학교", "중"], ["high", "고등학교", "고"]]) {
    if (schools.some(school => school.endsWith(name) || school.endsWith(short) || key === "elementary" && school.endsWith("초교")) ||
      texts.some(text => new RegExp(`(?:^|[\\s(])(?:${name}|${short})\\s*[1-6](?:\\s*학년|\\s*[-–]|(?=$|\\s))`).test(text))) levels.add(key);
  }
  const level = levels.size === 1 ? [...levels][0] : "";
  const kinds = new Set<string>();
  for (const text of texts) {
    if (/중간/.test(text)) kinds.add("midterm");
    if (/기말/.test(text)) kinds.add("final");
    // 1차시 같은 수업 표기는 시험 구분으로 사용하지 않는다.
    for (const [, order] of text.matchAll(/(?<!\d)([12])\s*차(?!시)/g)) kinds.add(order === "1" ? "midterm" : "final");
  }
  const kind = kinds.size === 1 ? [...kinds][0] : UNCLASSIFIED;
  const key = (value?: number) => value ? String(value) : UNCLASSIFIED;
  return {
    doc, schools,
    path: { year: key(info.year), grade: info.grade ? `${level || "unknown"}:${info.grade}` : UNCLASSIFIED, term: key(info.term), exam: kind },
    labels: { year: info.year ? `${info.year}년` : "년도 미분류", grade: info.grade ? `${levelNames[level] || ""}${level ? " " : ""}${info.grade}학년` : "학년 미분류", term: info.term ? `${info.term}학기` : "학기 미분류", exam: kind === "midterm" ? "중간" : kind === "final" ? "기말" : "시험 미분류" },
    displayPath: { year: key(info.year), grade: key(info.grade), term: key(info.term) },
  };
}

export function archivedItems(docs: ArchiveDocument[]): ArchiveItem[] {
  return docs.filter(isArchived).sort(byNewest).map(classifyArchiveDocument);
}

export function archiveSchoolMatches(item: ArchiveItem, query: string): boolean {
  const key = schoolSearchKey(query);
  return !key || item.schools.some(school => schoolSearchKey(school).includes(key));
}

export function archiveOptions(items: ArchiveItem[], selection: ArchiveSelection, step: ArchiveStep) {
  const parents = ARCHIVE_STEPS.slice(0, ARCHIVE_STEPS.indexOf(step));
  const options = new Map<string, { key: string; label: string; count: number }>();
  for (const item of items) {
    if (!parents.every(parent => selection[parent] === item.path[parent])) continue;
    const key = item.path[step];
    const option = options.get(key) || { key, label: item.labels[step], count: 0 };
    option.count++; options.set(key, option);
  }
  const rank = (key: string) => key === UNCLASSIFIED ? Infinity : step === "year" ? -Number(key) : step === "exam" ? (key === "midterm" ? 0 : 1) : step === "grade" ? (["elementary", "middle", "high", "unknown"].indexOf(key.split(":")[0]) * 10 + Number(key.split(":")[1])) : Number(key);
  return [...options.values()].sort((a, b) => rank(a.key) - rank(b.key) || koreanOrder.compare(a.label, b.label));
}

export function selectArchiveStep(selection: ArchiveSelection, step: ArchiveStep, value: string): ArchiveSelection {
  return Object.fromEntries(ARCHIVE_STEPS.map((key, index) => [key, index < ARCHIVE_STEPS.indexOf(step) ? selection[key] : key === step ? value : ""])) as ArchiveSelection;
}

export function selectedArchiveItems(items: ArchiveItem[], selection: ArchiveSelection): ArchiveItem[] {
  return items.filter(item => ARCHIVE_STEPS.every(step => selection[step] && selection[step] === item.path[step]));
}
