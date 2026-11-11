"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, downloadStored, patchJson, uploadFile, won, type FileRef } from "@/lib/client/api";
import { groupArchivedDocuments, isArchived, type ArchiveDocument } from "@/lib/client/archive-tree";
import { precheckFiles } from "@/lib/client/pages";

const BATCH_SIZE = 100;
const when = (iso: string) => new Date(iso).toLocaleDateString("ko-KR", { dateStyle: "medium" });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function documentStatus(doc: ArchiveDocument): string {
  if (isArchived(doc)) return "완료";
  if (doc.hwpx_path && !doc.original_files.length) return "원본 필요";
  if (doc.status === "failed") return "실패";
  if (doc.status === "done") return "한글 파일 필요";
  return "작업 중·멈춤";
}

export default function ArchivePage() {
  const [docs, setDocs] = useState<ArchiveDocument[] | null>(null);
  const [view, setView] = useState<"completed" | "work">("completed");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const byId = new Map<string, ArchiveDocument>();
      try {
        for (let offset = 0; ; offset += BATCH_SIZE) {
          const page = await api<{ docs: ArchiveDocument[] }>(
            `/api/documents?limit=${BATCH_SIZE}&offset=${offset}`, { signal: controller.signal },
          );
          for (const doc of page.docs) byId.set(doc.id, doc);
          if (page.docs.length < BATCH_SIZE) break;
        }
        if (!controller.signal.aborted) setDocs([...byId.values()]);
      } catch (err) {
        if (!controller.signal.aborted) setError(errorMessage(err));
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  const groups = useMemo(() => groupArchivedDocuments(docs ?? []), [docs]);
  const unfinished = useMemo(() => (docs ?? []).filter((doc) => !isArchived(doc)), [docs]);
  const completedCount = groups.reduce((count, school) => count + school.count, 0);

  async function download(path: string, name: string) {
    setError("");
    try {
      await downloadStored(path, name);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(doc: ArchiveDocument) {
    if (!confirm(`'${doc.title}'을 지울까요? 원본과 한글 파일도 함께 지워집니다.`)) return;
    setBusy(doc.id);
    setError("");
    setMessage("");
    try {
      await api(`/api/documents/${doc.id}`, { method: "DELETE" });
      setDocs((current) => current?.filter((saved) => saved.id !== doc.id) ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function attach(doc: ArchiveDocument, files: File[]) {
    if (!files.length) return;
    setBusy(doc.id);
    setError("");
    setMessage("");
    try {
      await precheckFiles(files);
      const url = `/api/documents/${doc.id}`;
      const refs: FileRef[] = [];
      for (const file of files) {
        refs.push(await uploadFile(doc.id, "original", file, file.name));
      }
      const { doc: updated } = await patchJson<{ doc: ArchiveDocument }>(url, {
        attach_originals: refs,
      });
      setDocs((current) => current?.map((saved) => saved.id === doc.id ? updated : saved) ?? null);
      if (isArchived(updated)) {
        setMessage(`‘${updated.title}’의 원본과 한글 파일을 함께 보관했습니다.`);
        setView("completed");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const row = (doc: ArchiveDocument) => (
    <ArchiveRow key={doc.id} doc={doc} busy={busy === doc.id} locked={busy !== null}
      onDownload={download} onRemove={remove} onAttach={attach} />
  );

  return (
    <main className="page archive-page">
      <div className="page-head">
        <h1>시험지 보관함</h1>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {message && <p className="notice" role="status">{message}</p>}
      {docs === null && !error && <p className="muted" role="status">보관함을 불러오는 중입니다.</p>}
      {docs !== null && (
        <>
          <div className="archive-views" role="group" aria-label="보관함 보기">
            <button type="button" aria-pressed={view === "completed"} onClick={() => setView("completed")}>
              완료 보관함 <span>{completedCount}</span>
            </button>
            <button type="button" aria-pressed={view === "work"} onClick={() => setView("work")}>
              작업 기록 <span>{unfinished.length}</span>
            </button>
          </div>
          {view === "completed" && (groups.length ? (
            <section className="archive-tree" aria-label="학교별 완료 시험지">
              {groups.map((school, index) => (
                <details className="archive-school" key={school.key} open={index === 0}>
                  <summary>{school.label} <span className="archive-count">{school.count}건</span></summary>
                  <div className="archive-terms">
                    {school.groups.map((term, i) => (
                      <details key={term.key} open={i === 0}>
                        <summary>{term.label} <span className="archive-count">{term.count}건</span></summary>
                        <ul className="archive-documents">{term.docs.map(row)}</ul>
                      </details>
                    ))}
                  </div>
                </details>
              ))}
            </section>
          ) : <p className="muted">원본과 한글 파일을 함께 보관한 시험지가 여기에 표시됩니다.</p>)}
          {view === "work" && (unfinished.length ? (
            <ul className="archive-documents archive-work" aria-label="시험지 작업 기록">{unfinished.map(row)}</ul>
          ) : <p className="muted">진행 중이거나 확인이 필요한 시험지가 없습니다.</p>)}
        </>
      )}
    </main>
  );
}

function ArchiveRow({ doc, busy, locked, onDownload, onRemove, onAttach }: {
  doc: ArchiveDocument;
  busy: boolean;
  locked: boolean;
  onDownload: (path: string, name: string) => void;
  onRemove: (doc: ArchiveDocument) => void;
  onAttach: (doc: ArchiveDocument, files: File[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const archived = isArchived(doc);
  const originals = doc.original_files;

  return (
    <li className="archive-document" aria-busy={busy}>
      <div className="archive-document-name">
        <strong>{doc.title}</strong>
        <span className={`archive-label${archived ? " complete" : ""}`}>{documentStatus(doc)}</span>
      </div>
      <div className="muted small archive-document-meta">
        {when(doc.created_at)}
        {doc.item_count > 0 && ` · ${doc.item_count}문항`}
        {doc.cost_usd > 0 && ` · AI 요금 ${won(doc.cost_usd)}`}
      </div>
      {doc.note && <p className="muted small">{doc.note}</p>}
      <div className="row archive-actions">
        {doc.hwpx_path && (
          <button type="button" className="primary" onClick={() => onDownload(doc.hwpx_path!, `${doc.title}.hwpx`)}>
            한글 파일
          </button>
        )}
        {originals.length === 1 && (
          <button type="button" title={originals[0].name} onClick={() => onDownload(originals[0].path, originals[0].name)}>
            원본 파일
          </button>
        )}
        {originals.length > 1 && (
          <details className="archive-originals">
            <summary>원본 {originals.length}개</summary>
            <ul>
              {originals.map((file) => (
                <li key={file.path}><button type="button" onClick={() => onDownload(file.path, file.name)}>{file.name}</button></li>
              ))}
            </ul>
          </details>
        )}
        {doc.hwpx_path && originals.length === 0 && (
          <>
            <input ref={fileInput} type="file" accept=".pdf,application/pdf,image/*" multiple hidden
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                onAttach(doc, files);
              }} />
            <button type="button" disabled={locked} onClick={() => fileInput.current?.click()}>
              {busy ? "저장 중" : "원본 추가"}
            </button>
          </>
        )}
        {doc.item_count > 0 && <a href={`/?resume=${encodeURIComponent(doc.id)}`}>다시 만들기</a>}
        <button type="button" className="archive-remove" disabled={locked} onClick={() => onRemove(doc)} aria-label={`${doc.title} 지우기`}>
          지우기
        </button>
      </div>
    </li>
  );
}
