"use client";

import { DragEvent, useEffect, useRef, useState } from "react";
import { api, ApiError, downloadStored, patchJson, postJson, won } from "@/lib/client/api";
import { makeExam, resumeExam, type MakeResult, type Progress, type Recovery, type Step } from "@/lib/client/make-exam";
import { loadExamCheckpoint } from "@/lib/client/exam-storage";
import { isStale, STALE_MESSAGE } from "@/lib/client/version";
import { loadFigureFonts } from "@/lib/figure/engine";
import { piecesToHtml } from "@/lib/ai/latex-view";
import { FigureReview } from "@/components/app/FigureReview";

/* eslint-disable @typescript-eslint/no-explicit-any */

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "원본 보관" },
  { key: "page", label: "쪽 읽기" },
  { key: "figure", label: "그림 읽기" },
  { key: "draw", label: "그림 그리기" },
  { key: "review", label: "자료 비교" },
  { key: "hwpx", label: "한글 파일" },
  { key: "save", label: "보관함 저장" },
];

type Ready = { keySaved: boolean; hwpxEndpoint: string; krwPerUsd: number };

export default function MakePage() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [JXG, setJXG] = useState<any>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<MakeResult | null>(null);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState("");
  const [busy, setBusy] = useState(false);
  /** 이 화면을 연 뒤 프로그램이 새 판으로 바뀌었는지 (바뀌었으면 새로 고치라고 알린다) */
  const [stale, setStale] = useState(false);
  const [review, setReview] = useState<{ exam: any; finish: (exam: any) => void } | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [resuming, setResuming] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await api<any>("/api/settings");
        setReady({ keySaved: !!s.apiKey?.saved && !s.apiKey?.broken, hwpxEndpoint: s.hwpxEndpoint, krwPerUsd: s.krwPerUsd });
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
        const { doc } = await api<{ doc: { title: string; exam_json?: any; cost_usd: number } }>(`/api/documents/${docId}`, { signal: controller.signal });
        const exam = await loadExamCheckpoint(docId, doc.exam_json, controller.signal);
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
    if (!title) setTitle(picked[0].name.replace(/\.[^.]+$/, ""));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    choose(e.dataTransfer.files);
  }

  async function start(savedWork?: Recovery) {
    if (!JXG || !ready || (!savedWork && (!files.length || !ready.keySaved))) return;
    setBusy(true);
    setResuming(!!savedWork);
    setProgress(null);
    setError("");
    setErrorDetail("");
    setResult(null);
    const controller = new AbortController();
    abort.current = controller;
    let docId: string | null = savedWork?.docId ?? null;
    try {
      const common = {
        JXG,
        hwpxEndpoint: ready.hwpxEndpoint,
        onProgress: setProgress,
        signal: controller.signal,
        onRecoverable: setRecovery,
        reviewFigures: (exam: any, signal: AbortSignal): Promise<any> => new Promise((resolve, reject) => {
          const stop = () => { setReview(null); reject(new Error("자료 확인을 멈췄습니다")); };
          if (signal.aborted) return stop();
          signal.addEventListener("abort", stop, { once: true });
          setReview({ exam, finish: value => { signal.removeEventListener("abort", stop); setReview(null); resolve(value); } });
        }),
      };
      const out = savedWork ? await resumeExam(common, savedWork) : await makeExam({
        ...common,
        files,
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
      if (docId) await patchJson(`/api/documents/${docId}`, { status: "failed", note: `${msg}${detail ? `\n${detail}` : ""}`.slice(0, 500) }).catch(() => undefined);
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
        <p className="lead">시험지 PDF 나 사진을 올리면 원본의 용지와 문항 위치를 살려 편집 가능한 한글 파일로 만들어 줍니다. 원본과 만든 파일은 보관함에 저장됩니다.</p>
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
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 2학년 2학기 중간고사" disabled={busy} />
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
          <button className="primary" type="button" onClick={() => start(recovery)} disabled={!JXG || !ready}>
            읽은 결과로 한글 파일 만들기
          </button>
        </section>
      )}

      {progress && (
        <section className="card" aria-live="polite">
          <h2>진행 상황</h2>
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
            {busy ? progress.message : result ? "다 됐습니다." : stopped ? "작업이 중단됐습니다." : ""} {resuming ? "이전 읽기의 AI 요금" : "지금까지 AI 요금"}: 약 {won(progress.usd, ready?.krwPerUsd)}
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

      {review && <FigureReview exam={review.exam} onContinue={review.finish} />}

      {result && <ResultView result={result} rate={ready?.krwPerUsd} resumed={resuming} />}
    </main>
  );
}

function ResultView({ result, rate, resumed }: { result: MakeResult; rate?: number; resumed: boolean }) {
  const items = (result.exam.sections ?? []).flatMap((s: any) => (s.items ?? []).map((it: any) => ({ ...it, _section: s.title })));
  return (
    <section className="card">
      <h2>다 만들었습니다</h2>
      <p>
        문항 {items.length}개를 옮겼습니다. 한글 파일을 만들었{result.saved ? "고 보관함에도 저장했" : ""}습니다.{" "}
        {resumed ? `이전 읽기의 AI 요금은 약 ${won(result.usd, rate)}이며, 다시 만들기에 추가 AI 요금은 없습니다.` : `이번 AI 요금은 약 ${won(result.usd, rate)}입니다.`}
      </p>
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
      <div className="row">
        <button className="primary" type="button" onClick={() => downloadStored(result.hwpxPath, result.fileName).catch(() => alert("한글 파일을 내려받지 못했습니다. 다시 시도해 주세요."))}>
          한글 파일 다시 내려받기
        </button>
      </div>
      {result.exam.unsure?.length > 0 && <p className="muted small">쪽 전체: {result.exam.unsure.join(" / ")}</p>}
      <div className="items">
        {items.map((it: any, i: number) => (
          <article key={i} className={`item-card${it.unsure?.length || it.figure?.render_error ? " flag" : ""}`}>
            <div className="stem">
              <strong>{it.label ?? `${it.no}.`}</strong> <span dangerouslySetInnerHTML={{ __html: piecesToHtml(it.stem) }} />
              {it.points ? <span className="muted"> [{it.points}점]</span> : null}
            </div>
            {it.figure?.png && <img className="figure" src={`data:image/png;base64,${it.figure.png}`} alt={`${it.no}번 그림`} />}
            {it.figure?.render_error && <p className="notice error small">그림을 그리지 못했습니다: {it.figure.render_error}</p>}
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

