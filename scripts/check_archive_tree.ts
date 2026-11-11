import assert from "node:assert/strict";
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
const schoolConflict = exam("school-conflict", "금호중 2학년", "대자중학교_2학년.pdf");
const gradeConflict = exam("grade-conflict", "숭의중 2학년", "숭의중학교_1학년.pdf");
const unknown = exam("unknown", "제목 없는 시험지", "변환중_수학기초.pdf");
const noOriginal = exam("no-original", "숭의중 시험지", "숭의중.pdf", { original_files: [] });
const noOutput = exam("no-output", "숭의중 시험지", "숭의중.pdf", { hwpx_path: null });
const stopped = exam("stopped", "숭의중 시험지", "숭의중.pdf", { status: "reading" });
const failed = exam("failed", "숭의중 시험지", "숭의중.pdf", { status: "failed" });

assert.equal(isArchived(recent), true);
for (const doc of [noOriginal, noOutput, stopped, failed]) assert.equal(isArchived(doc), false);

const tree = groupArchivedDocuments([unknown, old, olderYear, noOriginal, gradeConflict, failed, schoolConflict, recent, noOutput, stopped]);
assert.deepEqual(tree.map(({ label, count }) => [label, count]), [["숭의중학교", 4], ["학교 미분류", 2]]);
assert.deepEqual(tree[0].groups.map((group) => [group.label, group.docs.map((doc) => doc.id)]), [
  ["2026학년도 1학년 2학기", ["recent", "old"]],
  ["2025학년도 3학년 2학기", ["older-year"]],
  ["학년·학기 미분류", ["grade-conflict"]],
]);
assert.deepEqual(tree[1].groups.map((group) => [group.label, group.docs.map((doc) => doc.id)]), [
  ["2학년", ["school-conflict"]],
  ["학년·학기 미분류", ["unknown"]],
]);
assert.deepEqual(groupArchivedDocuments([noOriginal, noOutput, stopped, failed]), []);

console.log("완료 파일·원본 확인, 학교 및 학년 분류, 충돌과 미분류, 정렬 검사 통과");
