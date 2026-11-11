"use client";

import { DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, downloadStored, patchJson, postJson, won, type FileRef } from "@/lib/client/api";
import { figureRereadUsd, makeExam, rereadFigures, resumeExam, stripPngs, type MakeResult, type Progress, type Recovery, type Step } from "@/lib/client/make-exam";
import { normalizeLegacyExam, reviewFigures, tidyExam, type FigureSuspect } from "@/lib/ai/assemble";
import { loadExamCheckpoint } from "@/lib/client/exam-storage";
import { pdfPaperMm, pdfTextDirection } from "@/lib/client/pages";
import { applyPaper, paperOf } from "@/lib/ai/assemble";
import { itemOrderRotations, uprightExam } from "@/lib/ai/orientation";

/** 그림 살피기 결과: 프로그램이 고친 그림과 다시 읽기를 권하는 그림 (시험지 데이터는 바꾸지 않는다) */
type FigureReview = { fixes: { name: string; changes: string[] }[]; suspects: FigureSuspect[] };

function figureReview(exam: any): FigureReview {
  const copy = tidyExam(normalizeLegacyExam(JSON.parse(JSON.stringify(exam ?? {}))));
  const suspects = reviewFigures(copy);
  const fixes: FigureReview["fixes"] = [];
  for (const s of copy.sections ?? []) {
    for (const it of s.items ?? []) {
      itemFigures(it).forEach((f: any, k: number) => {
        if (!Array.isArray(f.auto_fixes) || !f.auto_fixes.length) return;
        const name = it.label ? String(it.label).trim() : `${it.no}번`;
        fixes.push({ name: k ? `${name} (그림 ${k + 1})` : name, changes: f.auto_fixes });
      });
    }
  }
  return { fixes, suspects };
}

function FigureReviewNotes({ review }: { review: FigureReview | null }) {
  if (!review || (!review.fixes.length && !review.suspects.length)) return null;
  return (
    <div className="small">
      {review.fixes.length > 0 && (
        <>
          <p>프로그램이 원본 조건에 맞게 고친 그림 {review.fixes.length}개 (AI 요금 없음):</p>
          <ul>
            {review.fixes.map((f, i) => (
              <li key={i}>
                {f.name}: {f.changes.join(", ")}
              </li>
            ))}
          </ul>
        </>
      )}
      {review.suspects.length > 0 && (
        <>
          <p>원본과 다르게 그려졌거나 읽지 못한 것으로 보이는 그림 {review.suspects.length}개:</p>
          <ul>
            {review.suspects.map((t, i) => (
              <li key={i}>
                {t.name}: {t.reasons.join(", ")}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
import { isStale, STALE_MESSAGE } from "@/lib/client/version";
import { loadFigureFonts } from "@/lib/figure/engine";
import { piecesToHtml } from "@/lib/ai/latex-view";
import { itemFigures } from "@/lib/figure/item-figures";

/* eslint-disable @typescript-eslint/no-explicit-any */

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "원본 보관" },
  { key: "page", label: "쪽 읽기" },
  { key: "figure", label: "그림 읽기" },
  { key: "draw", label: "그림 그리기" },
  { key: "hwpx", label: "한글 파일" },
  { key: "save", label: "보관함 저장" },
];

type Ready = { keySaved: boolean; hwpxEndpoint: string; krwPerUsd: number; models: { page: string; figure: string }; cacheScope: string };

export default function MakePage() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [JXG, setJXG] = useState<any>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  /** 제목을 직접 고쳤는지 (안 고쳤으면 새 파일을 고를 때 그 파일 이름으로 바꾼다) */
  const [titleTyped, setTitleTyped] = useState(false);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<MakeResult | null>(null);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState("");
  const [busy, setBusy] = useState(false);
  /** 이 화면을 연 뒤 프로그램이 새 판으로 바뀌었는지 (바뀌었으면 새로 고치라고 알린다) */
  const [stale, setStale] = useState(false);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [resuming, setResuming] = useState(false);
  /** 그림 다시 읽기로 만드는 중이거나 만든 결과인지 (요금 문구가 다르다) */
  const [rereading, setRereading] = useState(0);
  const recoveryReview = useMemo(() => (recovery ? figureReview(recovery.exam) : null), [recovery]);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await api<any>("/api/settings");
        setReady({ keySaved: s.canRead ?? (!!s.apiKey?.saved && !s.apiKey?.broken), hwpxEndpoint: s.hwpxEndpoint, krwPerUsd: s.krwPerUsd, models: s.models, cacheScope: s.cacheScope ?? (s.apiKey?.savedAt ? s.apiKey.savedAt + ":" + s.apiKey.last4 : "") });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      await loadFigureFonts();
      const mod: any = await import("jsxgraph");
      setJXG(mod.default || mod.JXG || mod);
    })();
    // 창으로 돌아올 때마다 새 판이 나왔는지 본다 (배포 전에 열어 둔 창에서 예전 판으로 만들지 않게)
    const onVisible = () => {
      if (document.visibilityState === "visible") isStale().then((v) => v && setStale(true));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    const docId = new URLSearchParams(window.location.search).get("resume");
    if (!docId || !/^[0-9a-f-]{36}$/.test(docId)) return;
    const controller = new AbortController();
    (async () => {
      try {
        const { doc } = await api<{ doc: { title: string; exam_json?: any; cost_usd: number; original_files?: { path: string; type?: string; name?: string }[] } }>(`/api/documents/${docId}`, { signal: controller.signal });
        let exam = await loadExamCheckpoint(docId, doc.exam_json, controller.signal);
        // 원본 PDF 를 보고 예전 읽기 결과를 바로잡는다 (요금 없음):
        //  - 옆으로 누운 스캔을 누운 채로 읽은 결과면 쪽마다 방향을 문항 순서로 알아내 자리·크기를 바로 세운다 (2026-11-02 숭의중)
        //  - 용지를 적어 두기 전에 읽은 문서면 원본 PDF 크기를 보고 B4 원본이면 B4 로
        const pdf = doc.original_files?.find((f) => /pdf/i.test(f.type ?? "") || /\.pdf$/i.test(f.name ?? f.path));
        const pages: any[] = Array.isArray(exam?.source_pages) ? exam.source_pages : [];
        const maybeLying = pages.length > 0 && !pages.some((p) => p && "rotate" in p) && pages.some((p) => p?.width > p?.height);
        if (exam && pdf && (!exam.paper || maybeLying)) {
          try {
            const { url } = await postJson<{ url: string }>("/api/files/download-url", { path: pdf.path }, controller.signal);
            const bytes = await (await fetch(url, { signal: controller.signal })).arrayBuffer();
            if (maybeLying && (await pdfTextDirection(bytes.slice(0))) === "vertical") {
              const turns = itemOrderRotations(exam);
              if (turns.size) exam = uprightExam(exam, turns);
            }
            if (!exam.paper) exam = applyPaper(exam, paperOf(await pdfPaperMm(bytes.slice(0))));
          } catch {
            // 원본을 못 받으면 예전처럼 만든다
          }
        }
        const pageProblems = Array.isArray(doc.exam_json?.pageProblems) ? doc.exam_json.pageProblems.filter((v: unknown): v is string => typeof v === "string") : [];
        if (!controller.signal.aborted) {
          setTitle(doc.title);
          setRecovery({ docId, title: doc.title, exam, usd: doc.cost_usd || 0, pageProblems });
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => controller.abort();
  }, []);

  function choose(list: FileList | null) {
    if (!list || !list.length) return;
    const picked = [...list];
    setFiles(picked);
    setResult(null);
    setProgress(null);
    setResuming(false);
    setError("");
    setErrorDetail("");
    setRecovery(null);
    // 전에 고른 파일 이름이 제목으로 남아 다른 시험지에 붙지 않게 (2026-11-01 대자중이 금호중 제목으로 저장됨)
    if (!title || !titleTyped) setTitle(picked[0].name.replace(/\.[^.]+$/, ""));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    choose(e.dataTransfer.files);
  }

  /** 고른 그림만 AI 로 다시 읽고 다시 만든다 (요금을 먼저 알리고 묻는다) */
  function askReread(work: Recovery, targets: FigureSuspect[]) {
    if (!ready?.keySaved || !targets.length) return;
    const cost = figureRereadUsd(ready.models?.figure);
    const usual = won(targets.length * cost.usual, ready.krwPerUsd);
    const most = won(targets.length * cost.most, ready.krwPerUsd);
    const ok = window.confirm(
      `그림 ${targets.length}개를 AI 로 다시 읽고 한글 파일을 다시 만듭니다.\n` +
        `${targets.map((t) => `- ${t.name}`).join("\n")}\n\n` +
        `AI 요금은 보통 약 ${usual}, 많으면 약 ${most}입니다. 다시 읽을까요?`,
    );
    if (ok) start(work, targets);
  }

  async function start(savedWork?: Recovery, reread?: FigureSuspect[]) {
    if (abort.current || !JXG || !ready || (!savedWork && (!files.length || !ready.keySaved))) return;
    setBusy(true);
    setResuming(!!savedWork);
    setRereading(savedWork && reread?.length ? reread.length : 0);
    setProgress(null);
    setError("");
    setErrorDetail("");
    // 결과 화면에서 그림을 다시 읽다가 멈추거나 실패하면 앞의 결과를 되살린다
    const previous = result;
    setResult(null);
    const controller = new AbortController();
    abort.current = controller;
    let docId: string | null = savedWork?.docId ?? null;
    let currentCost = savedWork?.usd ?? 0;
    try {
      const common = {
        JXG,
        hwpxEndpoint: ready.hwpxEndpoint,
        onProgress: (value: Progress) => { currentCost = value.usd; setProgress(value); },
        signal: controller.signal,
        onRecoverable: setRecovery,
      };
      const originals = async (): Promise<FileRef[]> => {
        const { doc } = await api<{ doc: { original_files?: FileRef[] } }>(`/api/documents/${savedWork!.docId}`, { signal: controller.signal });
        return Array.isArray(doc.original_files) ? doc.original_files : [];
      };
      const out = savedWork && reread?.length
        ? await rereadFigures({ ...common, originals: await originals(), models: ready.models, cacheScope: ready.cacheScope }, savedWork, reread)
        : savedWork ? await resumeExam(common, savedWork) : await makeExam({
        ...common,
        files,
        // 모델은 설정 화면에서 이 기기에 저장한 것을 쓴다 (읽은 결과 재사용 기록도 모델별로 따로)
        models: ready.models,
        cacheScope: ready.cacheScope,
        title: title.trim() || "시험지",
        createDoc: async () => {
          docId = (await postJson<{ doc: { id: string } }>("/api/documents", { title })).doc.id;
          return docId;
        },
        confirmProblems: (message) => window.confirm(message),
      });
      setResult(out);
      setRecovery(null);
      try { await downloadStored(out.hwpxPath, out.fileName); }
      catch { setError("파일은 만들어졌지만 자동으로 내려받지 못했습니다. 아래의 다시 내려받기 버튼을 눌러 주세요."); }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = err instanceof ApiError ? err.detail ?? "" : "";
      setError(msg);
      setErrorDetail(detail);
      if (savedWork) {
        // 다 만든 문서를 다시 만들거나 그림을 다시 읽다가 멈추거나 실패해도 보관함의 문서는 그대로 둔다 ('실패'로 바꾸지 않는다).
        // 그림을 다시 읽느라 든 요금만 기록하고, 화면은 앞의 결과나 다시 만들기 칸으로 되돌린다
        if (docId && currentCost > (savedWork.usd ?? 0)) await patchJson(`/api/documents/${docId}`, { cost_usd: currentCost }).catch(() => undefined);
        if (previous) setResult(previous);
        else setRecovery(savedWork);
      } else if (docId) {
        await patchJson(`/api/documents/${docId}`, { status: "failed", cost_usd: currentCost, note: `${msg}${detail ? `\n${detail}` : ""}`.slice(0, 500) }).catch(() => undefined);
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  const stepIndex = progress ? STEPS.findIndex((s) => s.key === progress.step) : -1;
  const stopped = !busy && !!error && !result;
  const pct = result
    ? 100
    : progress
    ? Math.round(
        (100 * (progress.pagesDone + progress.figuresDone + (stepIndex >= 3 ? 1 : 0) + (result ? 1 : 0))) /
          Math.max(1, progress.pagesTotal + progress.figuresTotal + 2),
      )
    : 0;

  return (
    <main className="page" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <h1>시험지 만들기</h1>
        <p className="lead">시험지 PDF 나 사진을 올리면 AI 가 읽어서 학교 양식의 한글 파일로 만들어 줍니다. 원본과 만든 파일은 보관함에 저장됩니다.</p>
      </div>

      {(stale || error === STALE_MESSAGE) && (
        <p className="notice error" role="alert">
          {STALE_MESSAGE}{" "}
          <button type="button" onClick={() => window.location.reload()}>
            화면 새로 고치기
          </button>
        </p>
      )}

      {ready && !ready.keySaved && (
        <p className="notice error">
          이 기기에는 아직 AI 열쇠(API 키)가 없습니다. <a href="/settings">설정</a>에서 열쇠를 먼저 넣어 주세요.
        </p>
      )}

      <section className="card">
        <label className="field">
          시험지 제목
          <input type="text" value={title} onChange={(e) => { setTitle(e.target.value); setTitleTyped(true); }} placeholder="예: 2학년 2학기 중간고사" disabled={busy} />
        </label>
        <div
          className={`drop${over ? " over" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        >
          <input
            ref={input}
            type="file"
            accept="application/pdf,image/*"
            multiple
            onChange={(e) => choose(e.target.files)}
            disabled={busy}
          />
          <strong>PDF 나 사진을 여기에 끌어 놓거나 눌러서 고르세요</strong>
          <span className="muted small">사진은 여러 장을 한꺼번에 고를 수 있습니다. 고른 순서대로 1쪽, 2쪽이 됩니다.</span>
        </div>
        {files.length > 0 && (
          <ul className="files small">
            {files.map((f) => (
              <li key={f.name + f.size}>
                {f.name} <span className="muted">({(f.size / 1024 / 1024).toFixed(1)}MB)</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">
          읽는 AI 모델은 <a href="/settings">설정</a>에서 고릅니다. 같은 기기·모델로 이미 읽은 쪽과 그림은 다시 읽지 않고 그대로 써서 그만큼 요금이 들지 않습니다.
        </p>
        <div className="row">
          <button className="primary" type="button" onClick={() => start()} disabled={busy || !files.length || !JXG || !ready?.keySaved}>
            {busy ? "만드는 중" : "한글 파일 만들기"}
          </button>
          {busy && (
            <button type="button" onClick={() => abort.current?.abort()}>
              멈추기
            </button>
          )}
          {!JXG && <span className="muted small">그림 도구를 불러오는 중입니다.</span>}
        </div>
      </section>

      {recovery && !busy && !result && (
        <section className="card" aria-live="polite">
          <h2>읽은 결과로 다시 만들기</h2>
          <p>AI를 다시 부르지 않고 읽은 문항과 그림으로 한글 파일을 만듭니다.</p>
          <FigureReviewNotes review={recoveryReview} />
          <div className="row">
            <button className="primary" type="button" onClick={() => start(recovery)} disabled={!JXG || !ready}>
              읽은 결과로 한글 파일 만들기
            </button>
            {!!recoveryReview?.suspects.length && (
              <button type="button" onClick={() => askReread(recovery, recoveryReview.suspects)} disabled={!JXG || !ready?.keySaved}>
                그 그림 {recoveryReview.suspects.length}개만 AI로 다시 읽고 만들기
              </button>
            )}
          </div>
          {!!recoveryReview?.suspects.length && ready && !ready.keySaved && (
            <p className="muted small">그림 다시 읽기는 AI 열쇠를 넣은 기기에서 할 수 있습니다.</p>
          )}
        </section>
      )}

      {progress && (
        <section className="card" aria-live="polite">
          <h2>진행 상황</h2>
          {!!progress.reused && <p>이미 읽은 결과 {progress.reused}건 재사용 · 해당 부분 추가 AI 요금 0원</p>}
          <div className="bar" aria-hidden>
            <span style={{ width: `${pct}%` }} />
          </div>
          <ul className="progress-list">
            {STEPS.map((s, i) => (
              <li key={s.key} className={i < stepIndex || result ? "done" : i === stepIndex && !stopped ? "now" : ""}>
                <span className="state">{i < stepIndex || result ? "끝" : i === stepIndex ? stopped ? "중단" : "하는 중" : "기다림"}</span>
                <span>
                  {s.label}
                  {s.key === "page" && progress.pagesTotal > 0 && ` ${progress.pagesDone}/${progress.pagesTotal}쪽`}
                  {s.key === "figure" && progress.figuresTotal > 0 && ` ${progress.figuresDone}/${progress.figuresTotal}개`}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            {busy ? progress.message : result ? "다 됐습니다." : stopped ? "작업이 중단됐습니다." : ""} {resuming && !rereading ? "이전 읽기의 AI 요금" : "지금까지 AI 요금"}: 약 {won(progress.usd, ready?.krwPerUsd)}
          </p>
        </section>
      )}

      {error && error !== STALE_MESSAGE && (
        <div className="notice error" role="alert">
          <p>{error}</p>
          {error.includes("열쇠") && (
            <>
              {" "}
              <a href="/settings">설정으로 가기</a>
            </>
          )}
          {errorDetail && <details><summary>오류 상세</summary><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{errorDetail}</p></details>}
        </div>
      )}

      {result && (
        <ResultView
          result={result}
          rate={ready?.krwPerUsd}
          resumed={resuming}
          reread={rereading}
          canReread={!!JXG && !!ready?.keySaved && !busy}
          onReread={(targets) => askReread({ docId: result.docId, title: result.title, exam: stripPngs(result.exam), usd: result.usd, pageProblems: result.pageProblems }, targets)}
        />
      )}
    </main>
  );
}

function ResultView({ result, rate, resumed, reread, canReread, onReread }: { result: MakeResult; rate?: number; resumed: boolean; reread: number; canReread: boolean; onReread: (targets: FigureSuspect[]) => void }) {
  const items = (result.exam.sections ?? []).flatMap((s: any) => (s.items ?? []).map((it: any) => ({ ...it, _section: s.title })));
  const review = useMemo(() => figureReview(result.exam), [result]);
  return (
    <section className="card">
      <h2>다 만들었습니다</h2>
      <p>
        문항 {items.length}개를 옮겼습니다. 한글 파일을 만들었{result.saved ? "고 보관함에도 저장했" : ""}습니다.{" "}
        {reread && result.reread
          ? `그림 ${result.reread.asked}개 가운데 ${result.reread.replaced}개를 AI 로 다시 읽어 바꿨습니다. 이 시험지의 AI 요금은 지금까지 모두 약 ${won(result.usd, rate)}입니다.`
          : resumed
            ? `이전 읽기의 AI 요금은 약 ${won(result.usd, rate)}이며, 다시 만들기에 추가 AI 요금은 없습니다.`
            : `이번 AI 요금은 약 ${won(result.usd, rate)}입니다.`}
      </p>
      {!!result.reread?.failed.length && (
        <div className="notice error small" role="alert">
          <p>다시 읽지 못한 그림은 지난 그림을 그대로 두었습니다.</p>
          <ul>
            {result.reread.failed.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {result.saveProblem && (
        <p className="notice error" role="alert">
          {result.saveProblem}. {result.saved ? "" : "내려받은 한글 파일을 잘 보관해 주세요."}
        </p>
      )}
      {(result.unsure > 0 || result.failedFigures > 0) && (
        <p className="notice error">
          {result.unsure > 0 && `AI 가 확신이 낮다고 표시한 곳이 ${result.unsure}군데 있습니다. `}
          {result.failedFigures > 0 && `그리지 못한 그림이 ${result.failedFigures}개 있어 빈 자리로 넣었습니다. `}
          아래에서 붉은 테두리 문항을 원본과 견주어 확인해 주세요.
        </p>
      )}
      {result.warnings.length > 0 && (
        <details>
          <summary>한글 파일 알림 {result.warnings.length}개</summary>
          <ul className="small">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <FigureReviewNotes review={review} />
      <div className="row">
        <button className="primary" type="button" onClick={() => downloadStored(result.hwpxPath, result.fileName).catch(() => alert("한글 파일을 내려받지 못했습니다. 다시 시도해 주세요."))}>
          한글 파일 다시 내려받기
        </button>
        {review.suspects.length > 0 && (
          <button type="button" onClick={() => onReread(review.suspects)} disabled={!canReread}>
            그 그림 {review.suspects.length}개만 AI로 다시 읽고 다시 만들기
          </button>
        )}
      </div>
      {result.exam.unsure?.length > 0 && <p className="muted small">쪽 전체: {result.exam.unsure.join(" / ")}</p>}
      <div className="items">
        {items.map((it: any, i: number) => (
          <article key={i} className={`item-card${it.unsure?.length || itemFigures(it).some(f => f.render_error) ? " flag" : ""}`}>
            <div className="stem">
              <strong>{it.label ?? `${it.no}.`}</strong> <span dangerouslySetInnerHTML={{ __html: piecesToHtml(it.stem) }} />
              {it.points ? <span className="muted"> [{it.points}점]</span> : null}
            </div>
            {itemFigures(it).map((f, index) => <div key={index}>
              {f.png && <img className="figure" src={`data:image/png;base64,${f.png}`} alt={`${it.no}번 그림 ${index + 1}`} />}
              {f.render_error && <p className="notice error small">그림 {index + 1}을 그리지 못했습니다: {f.render_error}</p>}
              {Array.isArray(f.auto_fixes) && f.auto_fixes.length > 0 && <p className="muted small">프로그램이 고친 곳: {f.auto_fixes.join(", ")}</p>}
            </div>)}
            {it.bogi?.length > 0 && (
              <div className="small">
                &lt;보기&gt;{" "}
                {it.bogi.map((line: any, j: number) => (
                  <div key={j} dangerouslySetInnerHTML={{ __html: piecesToHtml(line) }} />
                ))}
              </div>
            )}
            {it.choices?.length > 0 && (
              <div className="choices">
                {it.choices.map((c: any, j: number) => (
                  <span key={j}>
                    {"①②③④⑤⑥⑦⑧"[j]} <span dangerouslySetInnerHTML={{ __html: piecesToHtml(c) }} />
                  </span>
                ))}
              </div>
            )}
            {it.unsure?.length > 0 && <p className="muted small">확인할 곳: {it.unsure.join(" / ")}</p>}
          </article>
        ))}
      </div>
    </section>
  );
}


