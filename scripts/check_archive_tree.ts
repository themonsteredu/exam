import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { groupArchivedDocuments, isArchived, type ArchiveDocument } from "@/lib/client/archive-tree";

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
const tree = groupArchivedDocuments(input);
assert.deepEqual(tree.map(({ label, count }) => [label, count]), [["2026학년도", 7], ["2025학년도", 1], ["년도 미분류", 3]]);
const paths = tree.flatMap((year) => year.terms.flatMap((term) => term.grades.map((grade) => [
  year.label, term.label, grade.label, grade.docs.map((doc) => doc.id),
])));
assert.deepEqual(paths, [
  ["2026학년도", "1학기", "2학년", ["first-term"]],
  ["2026학년도", "2학기", "1학년", ["recent", "old"]],
  ["2026학년도", "2학기", "2학년", ["second-grade"]],
  ["2026학년도", "2학기", "6학년", ["upper-grade"]],
  ["2026학년도", "2학기", "학년 미분류", ["grade-conflict"]],
  ["2026학년도", "학기 미분류", "2학년", ["term-conflict"]],
  ["2025학년도", "2학기", "3학년", ["older-year"]],
  ["년도 미분류", "2학기", "2학년", ["year-conflict"]],
  ["년도 미분류", "학기 미분류", "2학년", ["school-conflict"]],
  ["년도 미분류", "학기 미분류", "학년 미분류", ["unknown"]],
]);
for (const year of tree) {
  assert.equal(year.count, year.terms.reduce((n, term) => n + term.count, 0));
  for (const term of year.terms) assert.equal(term.count, term.grades.reduce((n, grade) => n + grade.docs.length, 0));
}
const grouped = tree.flatMap((year) => year.terms.flatMap((term) => term.grades.flatMap((grade) => grade.docs)));
assert.equal(grouped.length, input.filter(isArchived).length);
assert.equal(new Set(grouped.map((doc) => doc.id)).size, grouped.length);
assert.equal(grouped.find((doc) => doc.id === recent.id), recent, "분류해도 원본과 한글 파일이 묶인 항목을 유지한다");
const normalized = groupArchivedDocuments([exam("normalized", "２０２４학년도 （ ３ ）학년 １학기", "scan.pdf")]);
assert.equal(normalized[0].label, "2024학년도");
assert.equal(normalized[0].terms[0].label, "1학기");
assert.equal(normalized[0].terms[0].grades[0].label, "3학년");
for (const [title, year, grade] of [
  ["TalkFile_2025 중1-2 기말 서석중 수학".normalize("NFD"), "2025학년도", "1학년"],
  ["2026 중3-2 중간 주월중", "2026학년도", "3학년"],
  ["2025년 3-2 기말 숭의중", "2025학년도", "3학년"],
  ["2024 중 1-2 중간 금호중", "2024학년도", "1학년"],
  ["26년 문성중 1-2 중간고사", "2026학년도", "1학년"],
]) {
  const [group] = groupArchivedDocuments([exam("filename", title, `${title}.pdf`)]);
  assert.equal(group.label, year);
  assert.equal(group.terms[0].label, "2학기");
  assert.equal(group.terms[0].grades[0].label, grade);
}
assert.equal(groupArchivedDocuments([exam("date-only", "시험지", "scan_2026-11-11.pdf")])[0].label, "년도 미분류",
  "저장 날짜나 스캔 파일의 날짜를 시험 학년도로 추측하지 않는다");
const [scanDate] = groupArchivedDocuments([exam("scan-date", "시험지", "scan_2026-1-2.pdf")]);
assert.equal(scanDate.terms[0].label, "학기 미분류");
assert.equal(scanDate.terms[0].grades[0].label, "학년 미분류");
assert.deepEqual(groupArchivedDocuments([noOriginal, noOutput, stopped, failed]), []);

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

console.log("완료 파일과 원본 묶기, 원본 추가와 내려받기, 년도·학기·학년 분류 및 정렬 검사 통과");
