"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, downloadStored, patchJson, postJson, uploadFile, won, type FileRef } from "@/lib/client/api";
import { ARCHIVE_STEPS, EMPTY_ARCHIVE_SELECTION, archivedItems, archiveOptions, archiveSchoolMatches, selectArchiveStep, selectedArchiveItems, archiveDisplayTitle, isArchived, type ArchiveClassPath, type ArchiveDocument, type ArchiveSelection, type ArchiveStep } from "@/lib/client/archive-tree";
import { precheckFiles } from "@/lib/client/pages";

const BATCH_SIZE = 100;
const savedAt = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Seoul" });
type ArchiveAction = "retry" | "delete" | "attach";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const stepLabels: Record<ArchiveStep, string> = { year: "년도", grade: "학년", term: "학기", exam: "시험" };
const stepPrompts: Record<ArchiveStep, string> = { year: "년도를 선택해 주세요.", grade: "학년을 선택해 주세요.", term: "학기를 선택해 주세요.", exam: "중간 또는 기말을 선택해 주세요." };

function documentStatus(doc: ArchiveDocument): string {
  if (isArchived(doc)) return "완료";
  if (doc.hwpx_path && !doc.original_files.length) return "원본 필요";
  if (doc.status === "failed") return "실패";
  if (doc.status === "done") return "한글 파일 필요";
  return doc.note?.includes("서버") || doc.note?.includes("읽고 있습니다") ? "서버 제작 중" : "작업 기록";
}

export default function ArchivePage() {
  const [docs, setDocs] = useState<ArchiveDocument[] | null>(null);
  const [view, setView] = useState<"completed" | "work">("completed");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<{ id: string; action: ArchiveAction } | null>(null);
  const [selection, setSelection] = useState<ArchiveSelection>({ ...EMPTY_ARCHIVE_SELECTION });
  const [query, setQuery] = useState("");

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

  const items = useMemo(() => archivedItems(docs ?? []), [docs]);
  const unfinished = useMemo(() => (docs ?? []).filter((doc) => !isArchived(doc)), [docs]);
  const searching = query.trim().length > 0;
  const selectedAll = ARCHIVE_STEPS.every(step => selection[step]);
  const visibleItems = useMemo(() => searching ? items.filter(item => archiveSchoolMatches(item, query)) : selectedArchiveItems(items, selection), [items, selection, query, searching]);
  const completedCount = items.length;

  async function retry(doc: ArchiveDocument) {
    setBusy({ id: doc.id, action: "retry" }); setError("");
    try {
      const { doc: saved } = await api<{ doc: ArchiveDocument & { exam_json?: unknown } }>(`/api/documents/${doc.id}`);
      if (!saved.exam_json && !confirm("저장된 원본으로 읽기를 다시 시도할까요? 이미 읽어 둔 결과는 재사용하며, 새로 읽는 부분에는 AI 요금이 발생할 수 있습니다.")) return;
      // 접수 응답이 유실돼도 같은 문서로 조회해 중복 생성하지 않는다.
      localStorage.setItem("exam-server-job", doc.id);
      localStorage.setItem("exam-server-mode", "retry");
      localStorage.setItem("exam-server-targets", "[]");
      await postJson("/api/jobs", { docId: doc.id, mode: "retry" });
      window.location.assign(`/?job=${encodeURIComponent(doc.id)}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally { setBusy(null); }
  }

  async function download(path: string, name: string) {
    setError("");
    try {
      await downloadStored(path, name);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(doc: ArchiveDocument) {
    const time = savedAt.format(new Date(doc.created_at));
    if (!confirm(`이 시험지를 삭제할까요?\n\n${doc.title}\n저장 시각: ${time}\n\n보관된 원본과 한글 파일도 함께 삭제됩니다.`)) return;
    setBusy({ id: doc.id, action: "delete" });
    setError("");
    setMessage("");
    try {
      await api(`/api/documents/${doc.id}`, { method: "DELETE" });
      setDocs((current) => current?.filter((saved) => saved.id !== doc.id) ?? null);
      setMessage("선택한 시험지를 삭제했습니다.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function attach(doc: ArchiveDocument, files: File[]) {
    if (!files.length) return;
    setBusy({ id: doc.id, action: "attach" });
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

  const row = (doc: ArchiveDocument, group?: ArchiveClassPath, context?: string) => (
    <ArchiveRow key={doc.id} doc={doc} group={group} pending={busy?.id === doc.id ? busy.action : undefined} locked={busy !== null}
      context={context} onDownload={download} onRemove={remove} onAttach={attach} onRetry={retry} />
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
          {view === "completed" && (items.length ? (
            <section className="archive-browser" aria-label="완료 시험지 찾기">
              <div className="archive-search">
                <label className="field" htmlFor="archive-school">학교명 검색
                  <input id="archive-school" type="search" placeholder="전체 보관함에서 학교명 검색" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" />
                </label>
                {searching && <button type="button" onClick={() => setQuery("")}>검색 지우기</button>}
              </div>
              {!searching && <div className="archive-filters" aria-label="년도, 학년, 학기, 시험 순서로 선택">
                {ARCHIVE_STEPS.map((step, index) => {
                  const enabled = index === 0 || Boolean(selection[ARCHIVE_STEPS[index - 1]]);
                  const options = archiveOptions(items, selection, step);
                  return <label className="field" key={step}><span><span className="archive-step-number">{index + 1}</span>{stepLabels[step]}</span>
                    <select aria-label={`${stepLabels[step]} 선택`} value={selection[step]} disabled={!enabled} onChange={event => setSelection(current => selectArchiveStep(current, step, event.target.value))}>
                      <option value="">{stepLabels[step]} 선택</option>
                      {options.map(option => <option key={option.key} value={option.key}>{option.label} ({option.count}건)</option>)}
                    </select>
                  </label>;
                })}
              </div>}
              {searching || selectedAll ? <div className="archive-results">
                <div className="archive-results-heading" role="status">
                  <h2>{searching ? "학교 검색 결과" : ARCHIVE_STEPS.map(step => visibleItems[0]?.labels[step] || archiveOptions(items, selection, step).find(option => option.key === selection[step])?.label).filter(Boolean).join(" · ")}</h2>
                  <span className="archive-count">{visibleItems.length}건</span>
                </div>
                {visibleItems.length ? <ul className="archive-documents">{visibleItems.map(item => row(item.doc, item.displayPath, searching ? ARCHIVE_STEPS.map(step => item.labels[step]).join(" · ") : undefined))}</ul>
                  : <p className="archive-empty muted">{searching ? "해당 학교의 시험지가 없습니다. 학교명 일부로도 검색할 수 있어요." : "이 분류에 보관된 시험지가 없습니다."}</p>}
              </div> : <p className="archive-empty muted" role="status">{stepPrompts[ARCHIVE_STEPS.find(step => !selection[step]) || "year"]}</p>}
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

function ArchiveRow({ doc, group, context, pending, locked, onDownload, onRemove, onAttach, onRetry }: {
  doc: ArchiveDocument;
  group?: ArchiveClassPath;
  context?: string;
  pending?: ArchiveAction;
  locked: boolean;
  onDownload: (path: string, name: string) => void;
  onRemove: (doc: ArchiveDocument) => void;
  onAttach: (doc: ArchiveDocument, files: File[]) => void;
  onRetry: (doc: ArchiveDocument) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<"more" | "originals" | null>(null);
  const archived = isArchived(doc);
  const originals = doc.original_files;
  const displayTitle = archiveDisplayTitle(doc.title, group);
  const time = savedAt.format(new Date(doc.created_at));
  const toggle = (next: "more" | "originals") => setPanel((current) => current === next ? null : next);

  return (
    <li className="archive-document" aria-busy={Boolean(pending)} onKeyDown={(event) => { if (event.key === "Escape") setPanel(null); }}>
      <div className="archive-document-info">
        <div className="archive-document-name">
          <strong title={doc.title}>{displayTitle}</strong>
          {!archived && <span className="archive-label">{documentStatus(doc)}</span>}
        </div>
        <div className="archive-document-meta">
          <time dateTime={doc.created_at}>저장 {time}</time>
          {doc.item_count > 0 && <span>{doc.item_count}문항</span>}
        </div>
        {context && <span className="archive-document-context">{context}</span>}
      </div>
      <div className="archive-actions">
        {doc.status === "failed" && originals.length > 0 && <button type="button" className="archive-download" disabled={locked} onClick={() => onRetry(doc)}>{pending === "retry" ? "접수 중" : "다시 시도"}</button>}
        {doc.status === "reading" && <a href={`/?job=${encodeURIComponent(doc.id)}`}>진행 확인</a>}
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
              {pending === "attach" ? "저장 중" : "원본 추가"}
            </button>
          </>
        )}
        <button type="button" className="archive-more" aria-label={`${displayTitle} 더보기`} aria-expanded={panel === "more"} aria-controls={`archive-panel-${doc.id}`} onClick={() => toggle("more")}>
          {panel === "more" ? "접기" : "더보기"}
        </button>
        <button type="button" className="archive-remove" disabled={locked} onClick={() => onRemove(doc)} aria-label={`${doc.title}, ${time} 저장 시험지 삭제`}>
          {pending === "delete" ? "삭제 중" : "삭제"}
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
                {doc.cost_usd > 0 && <><dt>AI 요금</dt><dd>{won(doc.cost_usd)}</dd></>}
              </dl>
              {archived && doc.note && <p className="muted small">{doc.note}</p>}
              {doc.item_count > 0 && <div className="row archive-secondary-actions">
                <a href={`/?resume=${encodeURIComponent(doc.id)}`}>다시 만들기</a>
              </div>}
            </>
          )}
        </div>
      )}
    </li>
  );
}
