import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ARCHIVE_STEPS, EMPTY_ARCHIVE_SELECTION, archiveDisplayTitle, archivedItems, archiveOptions, archiveSchoolMatches, classifyArchiveDocument, selectArchiveStep, selectedArchiveItems, isArchived, type ArchiveDocument } from "@/lib/client/archive-tree";

function exam(id: string, title: string, original: string, options: Partial<ArchiveDocument> = {}): ArchiveDocument {
  return {
    id,
    title,
    created_at: "2026-11-01T09:00:00Z",
    status: "done",
    original_files: [{ path: `originals/${id}/1.pdf`, name: original, size: 123, type: "application/pdf" }],
    hwpx_path: `generated/${id}/exam.hwpx`,
    cost_usd: 0,
    item_count: 10,
    note: null,
    ...options,
  };
}

const old = exam("old", "숭의중 1학년 2학기 중간고사", "숭의중학교_2026학년도_1학년_2학기.pdf");
const recent = exam("recent", "숭의중학교 1학년 2학기 기말고사", "숭의중_2026학년도_1학년_2학기.pdf", {
  created_at: "2026-11-11T10:00:00Z",
});
const olderYear = exam("older-year", "숭의중 2025학년도 3학년 2학기", "숭의중학교.pdf");
const firstTerm = exam("first-term", "금호중 2026학년도 2학년 1학기", "금호중.pdf");
const secondGrade = exam("second-grade", "2026학년도 ( 2 )학년 2학기", "시험지.pdf");
const upperGrade = exam("upper-grade", "2026학년도 6학년 2학기", "시험지.pdf");
const schoolConflict = exam("school-conflict", "금호중 2학년", "대자중학교_2학년.pdf");
const gradeConflict = exam("grade-conflict", "숭의중 2026학년도 2학년 2학기", "숭의중학교_1학년.pdf");
const termConflict = exam("term-conflict", "숭의중 2026학년도 2학년 2학기", "숭의중학교_1학기.pdf");
const yearConflict = exam("year-conflict", "숭의중 2026학년도 2학년 2학기", "숭의중학교_2025년.pdf");
const unknown = exam("unknown", "제목 없는 시험지", "변환중_수학기초.pdf");
const noOriginal = exam("no-original", "숭의중 시험지", "숭의중.pdf", { original_files: [] });
const noOutput = exam("no-output", "숭의중 시험지", "숭의중.pdf", { hwpx_path: null });
const stopped = exam("stopped", "숭의중 시험지", "숭의중.pdf", { status: "reading" });
const failed = exam("failed", "숭의중 시험지", "숭의중.pdf", { status: "failed" });

assert.equal(isArchived(recent), true);
for (const doc of [noOriginal, noOutput, stopped, failed]) assert.equal(isArchived(doc), false);

const input = [unknown, old, olderYear, noOriginal, gradeConflict, failed, schoolConflict, recent, noOutput, stopped,
  firstTerm, secondGrade, upperGrade, termConflict, yearConflict];
const items = archivedItems(input);
assert.equal(items.length, input.filter(isArchived).length);
assert.equal(new Set(items.map(item => item.doc.id)).size, items.length);
assert.equal(items.find(item => item.doc.id === recent.id)?.doc, recent, "원본과 한글 파일의 연결을 유지한다");
assert.deepEqual(archiveOptions(items, EMPTY_ARCHIVE_SELECTION, "year").map(({ label, count }) => [label, count]), [["2026년", 7], ["2025년", 1], ["년도 미분류", 3]]);
let selection = selectArchiveStep(EMPTY_ARCHIVE_SELECTION, "year", "2026");
assert.deepEqual(archiveOptions(items, selection, "grade").map(option => option.label), ["중학교 1학년", "중학교 2학년", "2학년", "6학년", "학년 미분류"]);
selection = selectArchiveStep(selection, "grade", "middle:1");
assert.deepEqual(archiveOptions(items, selection, "term").map(option => option.label), ["2학기"]);
selection = selectArchiveStep(selection, "term", "2");
assert.deepEqual(archiveOptions(items, selection, "exam").map(option => option.label), ["중간", "기말"]);
assert.deepEqual(selectedArchiveItems(items, selection), [], "시험 선택 전에는 문서를 펼치지 않는다");
selection = selectArchiveStep(selection, "exam", "final");
assert.deepEqual(selectedArchiveItems(items, selection).map(item => item.doc.id), [recent.id]);
assert.deepEqual(selectArchiveStep(selection, "year", "2025"), { year: "2025", grade: "", term: "", exam: "" }, "상위 분류를 바꾸면 하위 선택 초기화");
assert.deepEqual(selectArchiveStep(selection, "grade", "middle:2"), { year: "2026", grade: "middle:2", term: "", exam: "" });
assert.deepEqual(ARCHIVE_STEPS, ["year", "grade", "term", "exam"]);
assert.equal(classifyArchiveDocument(gradeConflict).labels.grade, "학년 미분류");
assert.equal(classifyArchiveDocument(termConflict).labels.term, "학기 미분류");
assert.equal(classifyArchiveDocument(yearConflict).labels.year, "년도 미분류");
const normalized = classifyArchiveDocument(exam("normalized", "２０２４학년도 （ ３ ）학년 １학기", "scan.pdf"));
assert.equal(normalized.labels.year, "2024년");
assert.equal(normalized.labels.term, "1학기");
assert.equal(normalized.labels.grade, "3학년");
for (const [title, year, grade] of [
  ["TalkFile_2025 중1-2 기말 서석중 수학".normalize("NFD"), "2025년", "중학교 1학년"],
  ["2026 중3-2 중간 주월중", "2026년", "중학교 3학년"],
  ["2025년 3-2 기말 숭의중", "2025년", "중학교 3학년"],
  ["2024 중 1-2 중간 금호중", "2024년", "중학교 1학년"],
  ["26년 문성중 1-2 중간고사", "2026년", "중학교 1학년"],
]) {
  const item = classifyArchiveDocument(exam("filename", title, `${title}.pdf`));
  assert.equal(item.labels.year, year);
  assert.equal(item.labels.term, "2학기");
  assert.equal(item.labels.grade, grade);
}
assert.equal(classifyArchiveDocument(exam("date-only", "시험지", "scan_2026-11-11.pdf")).labels.year, "년도 미분류",
  "저장 날짜나 스캔 파일의 날짜를 시험 학년도로 추측하지 않는다");
const scanDate = classifyArchiveDocument(exam("scan-date", "시험지", "scan_2026-1-2.pdf"));
assert.equal(scanDate.labels.term, "학기 미분류");
assert.equal(scanDate.labels.grade, "학년 미분류");
assert.equal(classifyArchiveDocument(exam("first", "2026 중1-2 1차 지필평가", "scan.pdf")).labels.exam, "중간");
assert.equal(classifyArchiveDocument(exam("second", "2026 중1-2 2차 정기시험", "scan.pdf")).labels.exam, "기말");
assert.equal(classifyArchiveDocument(exam("both", "중간 기말 모음", "scan.pdf")).labels.exam, "시험 미분류");
assert.equal(classifyArchiveDocument(exam("lesson", "1차시 활동", "scan.pdf")).labels.exam, "시험 미분류");
assert.equal(classifyArchiveDocument(exam("high", "2026 고1-2 기말 동아여고", "scan.pdf")).labels.grade, "고등학교 1학년");
assert.equal(archiveSchoolMatches(classifyArchiveDocument(recent), "숭 의 중"), true);
assert.equal(archiveSchoolMatches(classifyArchiveDocument(old), "숭의중학교"), true);
assert.equal(archiveSchoolMatches(classifyArchiveDocument(recent), "금호"), false);
assert.equal(archiveSchoolMatches(classifyArchiveDocument(unknown), "기초"), false);
assert.equal(archiveSchoolMatches(classifyArchiveDocument(exam("filename-school", "2026 중1-2 기말", "동성여중학교.pdf")), "동성여중"), true);
const displayGroup = { year: "2025", term: "2", grade: "1" };
assert.equal(archiveDisplayTitle("TalkFile_2025 중1-2 기말 서석중 수학".normalize("NFD"), displayGroup), "서석중 · 기말 수학");
assert.equal(archiveDisplayTitle("TalkFile_2025 중1-2 기말 동성여중", displayGroup), "동성여중 · 기말");
assert.equal(archiveDisplayTitle("26년 문성중 1-2 중간고사", { ...displayGroup, year: "2026" }), "문성중 · 중간고사");
assert.equal(archiveDisplayTitle("2025학년도 ( 1 )학년 2학기 금호중 1차 수학", displayGroup), "금호중 · 1차 수학");
assert.equal(archiveDisplayTitle("2024 중1-2 기말 서석중", displayGroup), "서석중 · 2024 기말", "분류와 다른 년도는 이름에 남긴다");
assert.equal(archiveDisplayTitle("2025학년도 1학년 2학기", displayGroup), "2025학년도 1학년 2학기", "이름이 비면 원래 제목을 표시한다");
assert.equal(archiveDisplayTitle("TalkFile_2025 중1-2 기말 서석중"), "서석중 · 2025 중1-2 기말", "작업 기록은 분류 정보를 생략하지 않는다");
assert.deepEqual(archivedItems([noOriginal, noOutput, stopped, failed]), []);

// 실제 파일 저장 경로와 보관함 API에서 원본을 추가하는 흐름을 확인한다.
const previousDirectory = process.cwd();
const scratch = await mkdtemp(path.join(tmpdir(), "exam-archive-check-"));
try {
  process.chdir(scratch);
  process.env.EXAM_STORE = "local";
  process.env.APP_SECRET = "exam-archive-test-secret-0123456789";
  const { getStore } = await import("@/lib/server/store");
  const { makeSessionToken } = await import("@/lib/server/session");
  const documents = await import("@/app/api/documents/[id]/route");
  const upload = await import("@/app/api/files/upload-url/route");
  const localFiles = await import("@/app/api/dev-files/route");
  const store = getStore();
  const doc = await store.createDoc("금호중학교 1학년 2학기");
  await store.updateDoc(doc.id, { hwpx_path: `generated/${doc.id}/exam.hwpx`, status: "done" });
  assert.equal(isArchived((await store.getDoc(doc.id))!), false);
  const { token } = await makeSessionToken(1, process.env.APP_SECRET);
  const request = (url: string, method: string, body: unknown) => new Request("http://localhost" + url, {
    method, headers: { cookie: "exam_session=" + token, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const sign = () => upload.POST(request("/api/files/upload-url", "POST", {
    docId: doc.id, kind: "original", name: "금호중학교.pdf", type: "application/pdf", size: 7,
  }));
  const signed = await sign();
  assert.equal(signed.status, 200);
  const first = await signed.json();
  const second = await (await sign()).json();
  assert.notEqual(first.path, second.path, "다시 올려도 이전 원본 경로를 덮어쓰지 않는다");
  const stored = await localFiles.PUT(new Request("http://localhost" + first.url, {
    method: "PUT", headers: first.headers, body: "fixture",
  }));
  assert.equal(stored.ok, true);
  const original = { path: first.path, name: "금호중학교.pdf", size: 7, type: "application/pdf" };
  const attach = () => documents.PATCH(request(`/api/documents/${doc.id}`, "PATCH", {
    attach_originals: [original],
  }), { params: Promise.resolve({ id: doc.id }) });
  assert.equal((await attach()).status, 200);
  const bundled = (await store.getDoc(doc.id))!;
  assert.equal(isArchived(bundled), true);
  assert.deepEqual(bundled.original_files, [original]);
  assert.equal(bundled.hwpx_path, `generated/${doc.id}/exam.hwpx`);
  const originalUrl = await store.downloadUrl(original.path);
  assert.equal(await (await localFiles.GET(new Request("http://localhost" + originalUrl))).text(), "fixture");
  assert.equal((await attach()).status, 409, "이미 연결된 원본을 바꾸지 않는다");
} finally {
  process.chdir(previousDirectory);
  await rm(scratch, { recursive: true, force: true });
}

console.log("원본·한글 보관, 년도→학년→학기→시험 선택, 학교명 검색·미분류 보존 검사 통과");
