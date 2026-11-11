"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, downloadStored, patchJson, uploadFile, won, type FileRef } from "@/lib/client/api";
import { archiveDisplayTitle, groupArchivedDocuments, isArchived, type ArchiveClassPath, type ArchiveDocument } from "@/lib/client/archive-tree";
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
  const completedCount = groups.reduce((count, year) => count + year.count, 0);

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

  const row = (doc: ArchiveDocument, group?: ArchiveClassPath) => (
    <ArchiveRow key={doc.id} doc={doc} group={group} busy={busy === doc.id} locked={busy !== null}
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
              완료 <span>{completedCount}</span>
            </button>
            <button type="button" aria-pressed={view === "work"} onClick={() => setView("work")}>
              작업 기록 <span>{unfinished.length}</span>
            </button>
          </div>
          {view === "completed" && (groups.length ? (
            <section className="archive-tree" aria-label="년도·학기·학년별 완료 시험지">
              {groups.map((year, index) => (
                <details className="archive-year" key={year.key} open={index === 0}>
                  <summary>{year.label} <span className="archive-count">{year.count}건</span></summary>
                  <div className="archive-classes">
                    {year.terms.flatMap((term, i) => term.grades.map((grade, j) => (
                      <details className="archive-class" key={`${term.key}-${grade.key}`} open={i === 0 && j === 0}>
                        <summary><span>{term.label} <span className="archive-path-separator" aria-hidden="true">·</span> {grade.label}</span><span className="archive-count">{grade.count}건</span></summary>
                        <ul className="archive-documents">{grade.docs.map((doc) => row(doc, { year: year.key, term: term.key, grade: grade.key }))}</ul>
                      </details>
                    )))}
                  </div>
                </details>
              ))}
            </section>
          ) : <p className="muted">원본과 한글 파일을 함께 보관한 시험지가 여기에 표시됩니다.</p>)}
          {view === "work" && (unfinished.length ? (
            <ul className="archive-documents archive-work" aria-label="시험지 작업 기록">{unfinished.map((doc) => row(doc))}</ul>
          ) : <p className="muted">진행 중이거나 확인이 필요한 시험지가 없습니다.</p>)}
        </>
      )}
    </main>
  );
}

function ArchiveRow({ doc, group, busy, locked, onDownload, onRemove, onAttach }: {
  doc: ArchiveDocument;
  group?: ArchiveClassPath;
  busy: boolean;
  locked: boolean;
  onDownload: (path: string, name: string) => void;
  onRemove: (doc: ArchiveDocument) => void;
  onAttach: (doc: ArchiveDocument, files: File[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<"more" | "originals" | null>(null);
  const archived = isArchived(doc);
  const originals = doc.original_files;
  const displayTitle = archiveDisplayTitle(doc.title, group);
  const toggle = (next: "more" | "originals") => setPanel((current) => current === next ? null : next);

  return (
    <li className="archive-document" aria-busy={busy} onKeyDown={(event) => { if (event.key === "Escape") setPanel(null); }}>
      <div className="archive-document-info">
        <div className="archive-document-name">
          <strong title={doc.title}>{displayTitle}</strong>
          {!archived && <span className="archive-label">{documentStatus(doc)}</span>}
        </div>
        {doc.item_count > 0 && <span className="archive-document-meta">{doc.item_count}문항</span>}
      </div>
      <div className="archive-actions">
        {doc.hwpx_path && (
          <button type="button" className="archive-download" onClick={() => onDownload(doc.hwpx_path!, `${doc.title}.hwpx`)} aria-label={`${displayTitle} 한글 파일 내려받기`}>
            한글 파일
          </button>
        )}
        {originals.length === 1 && (
          <button type="button" title={originals[0].name} onClick={() => onDownload(originals[0].path, originals[0].name)} aria-label={`${displayTitle} 원본 파일 내려받기`}>
            원본
          </button>
        )}
        {originals.length > 1 && (
          <button type="button" aria-expanded={panel === "originals"} aria-controls={`archive-panel-${doc.id}`} onClick={() => toggle("originals")}>
            원본 {originals.length}개
          </button>
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
        <button type="button" className="archive-more" aria-label={`${displayTitle} 더보기`} aria-expanded={panel === "more"} aria-controls={`archive-panel-${doc.id}`} onClick={() => toggle("more")}>
          {panel === "more" ? "접기" : "더보기"}
        </button>
      </div>
      {!archived && doc.note && <p className="archive-document-note muted small">{doc.note}</p>}
      {panel && (
        <div className="archive-document-panel" id={`archive-panel-${doc.id}`}>
          {panel === "originals" ? (
            <ul className="archive-originals" aria-label={`${displayTitle} 원본 파일 목록`}>
              {originals.map((file) => (
                <li key={file.path}><button type="button" onClick={() => onDownload(file.path, file.name)}>{file.name}</button></li>
              ))}
            </ul>
          ) : (
            <>
              <dl className="archive-file-info">
                <dt>원래 이름</dt><dd>{doc.title}</dd>
                <dt>저장일</dt><dd>{when(doc.created_at)}</dd>
                {doc.cost_usd > 0 && <><dt>AI 요금</dt><dd>{won(doc.cost_usd)}</dd></>}
              </dl>
              {archived && doc.note && <p className="muted small">{doc.note}</p>}
              <div className="row archive-secondary-actions">
                {doc.item_count > 0 && <a href={`/?resume=${encodeURIComponent(doc.id)}`}>다시 만들기</a>}
                <button type="button" className="archive-remove" disabled={locked} onClick={() => onRemove(doc)} aria-label={`${doc.title} 지우기`}>지우기</button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}
