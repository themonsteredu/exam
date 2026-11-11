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

console.log("완료 파일과 원본 묶기, 원본 추가와 내려받기, 학교·학년 분류 및 정렬 검사 통과");
