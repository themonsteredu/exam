"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, postJson, won } from "@/lib/client/api";
import { examEstimate, type ModelInfo } from "@/lib/ai/models-info";

type Settings = {
  apiKey: { saved: false } | { saved: true; last4: string; savedAt: string; broken: boolean };
  models: { page: string; figure: string };
  modelOptions: ModelInfo[];
  usage: { month: string; calls: number; usd: number }[];
  krwPerUsd: number;
};

const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString("ko-KR") : "");

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      setS(await api<Settings>("/api/settings"));
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="page" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <h1>설정</h1>
        <p className="lead">AI 열쇠(API 키), 쓸 AI 모델, 달마다 쓴 AI 요금, 비밀번호를 여기서 정합니다.</p>
      </div>
      {loadError && <p className="notice error">{loadError}</p>}
      {s && (
        <>
          <KeyCard s={s} onChange={load} />
          <ModelCard s={s} onChange={load} />
          <UsageCard s={s} />
          <PasswordCard />
        </>
      )}
    </main>
  );
}

function KeyCard({ s, onChange }: { s: Settings; onChange: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await postJson("/api/settings/api-key", { key });
      setKey("");
      setMsg({ ok: true, text: "열쇠를 확인하고 저장했습니다." });
      onChange();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("저장된 API 키를 지울까요? 지우면 AI 읽기를 할 수 없습니다.")) return;
    setBusy(true);
    try {
      await api("/api/settings/api-key", { method: "DELETE" });
      setMsg({ ok: true, text: "열쇠를 지웠습니다." });
      onChange();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>AI 열쇠 (API 키)</h2>
      {s.apiKey.saved ? (
        s.apiKey.broken ? (
          <p className="notice error">저장된 열쇠를 열지 못했습니다. 열쇠를 다시 넣어 주세요.</p>
        ) : (
          <p>
            저장되어 있습니다: <strong>sk-ant-…{s.apiKey.last4}</strong> <span className="muted small">({day(s.apiKey.savedAt)} 저장)</span>
          </p>
        )
      ) : (
        <p className="notice">아직 열쇠가 없습니다. 열쇠를 넣어야 AI 가 시험지를 읽을 수 있습니다.</p>
      )}
      <p className="muted small">
        Claude 콘솔(platform.claude.com)의 API Keys 화면에서 만든 열쇠를 붙여 넣으세요. 저장하기 전에 맞는 열쇠인지 확인합니다(요금 없음).
        열쇠는 서버에 암호로 잠가 두고, 화면에는 끝 네 자리만 보입니다.
      </p>
      <label className="field">
        새 열쇠
        <input type="password" autoComplete="off" placeholder="sk-ant-로 시작하는 열쇠" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      {msg && <p className={`notice${msg.ok ? "" : " error"}`}>{msg.text}</p>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !key.trim()}>
          {busy ? "확인하는 중" : "확인하고 저장"}
        </button>
        {s.apiKey.saved && (
          <button type="button" onClick={remove} disabled={busy}>
            열쇠 지우기
          </button>
        )}
      </div>
    </form>
  );
}

function ModelCard({ s, onChange }: { s: Settings; onChange: () => void }) {
  const [page, setPage] = useState(s.models.page);
  const [figure, setFigure] = useState(s.models.figure);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const known = (id: string) => s.modelOptions.some((m) => m.id === id);
  const estimate = known(page) && known(figure) ? examEstimate(page as ModelInfo["id"], figure as ModelInfo["id"]) : null;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await postJson("/api/settings/models", { page, figure });
      setMsg({ ok: true, text: "저장했습니다." });
      onChange();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const options = s.modelOptions.map((m) => (
    <option key={m.id} value={m.id}>
      {m.name} (100만 토큰당 입력 ${m.price.input} · 출력 ${m.price.output})
    </option>
  ));

  return (
    <section className="card">
      <h2>AI 모델</h2>
      <p className="muted small">쪽 읽기(글·수식 옮기기)와 그림 읽기(그림을 그림 명령으로)에 쓸 모델을 따로 고를 수 있습니다. 비싼 모델일수록 정확합니다.</p>
      <div className="stack">
        <label className="field">
          쪽 읽기
          <select value={page} onChange={(e) => setPage(e.target.value)}>
            {options}
          </select>
        </label>
        <label className="field">
          그림 읽기
          <select value={figure} onChange={(e) => setFigure(e.target.value)}>
            {options}
          </select>
        </label>
      </div>
      <ul className="small muted" style={{ margin: 0, paddingLeft: "1.2em" }}>
        {s.modelOptions.map((m) => (
          <li key={m.id}>
            {m.name}: {m.note}
          </li>
        ))}
      </ul>
      {estimate !== null && (
        <p>
          이렇게 고르면 25문항 시험지 한 부(약 7쪽, 그림 12개)에 약 <strong>{won(estimate, s.krwPerUsd)}</strong> 정도 듭니다 (어림값).
        </p>
      )}
      {msg && <p className={`notice${msg.ok ? "" : " error"}`}>{msg.text}</p>}
      <div className="row">
        <button className="primary" type="button" onClick={save} disabled={busy || (page === s.models.page && figure === s.models.figure)}>
          저장
        </button>
      </div>
    </section>
  );
}

function UsageCard({ s }: { s: Settings }) {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const now = s.usage.find((u) => u.month === thisMonth);
  return (
    <section className="card">
      <h2>달마다 쓴 AI 요금</h2>
      <p>
        이번 달: <strong>{won(now?.usd ?? 0, s.krwPerUsd)}</strong> <span className="muted small">(AI 를 {now?.calls ?? 0}번 불렀습니다)</span>
      </p>
      {s.usage.length > 0 ? (
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th>달</th>
                <th className="num">부른 횟수</th>
                <th className="num">요금</th>
                <th className="num hide-sm">달러</th>
              </tr>
            </thead>
            <tbody>
              {s.usage.map((u) => (
                <tr key={u.month}>
                  <td>{u.month.replace("-", "년 ")}월</td>
                  <td className="num">{u.calls.toLocaleString("ko-KR")}</td>
                  <td className="num">{won(u.usd, s.krwPerUsd)}</td>
                  <td className="num hide-sm">${u.usd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">아직 기록이 없습니다.</p>
      )}
      <p className="muted small">
        이 프로그램이 AI 를 부를 때마다 적은 어림값입니다 (1달러 {s.krwPerUsd.toLocaleString("ko-KR")}원으로 계산). 실제 청구액은 Claude 콘솔의 Usage 화면에서 볼 수 있습니다.
      </p>
    </section>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (next !== again) {
      setMsg({ ok: false, text: "새 비밀번호 두 칸이 서로 다릅니다." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await postJson("/api/settings/password", { current, next });
      setCurrent("");
      setNext("");
      setAgain("");
      setMsg({ ok: true, text: "비밀번호를 바꿨습니다. 다른 기기에서는 새 비밀번호로 다시 들어가야 합니다." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>비밀번호 바꾸기</h2>
      <p className="muted small">숫자 네 자리는 남이 짐작하기 쉽습니다. 더 긴 비밀번호로 바꾸면 더 안전합니다.</p>
      <label className="field">
        지금 비밀번호
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field">
        새 비밀번호 (4자 이상)
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="field">
        새 비밀번호 한 번 더
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      {msg && <p className={`notice${msg.ok ? "" : " error"}`}>{msg.text}</p>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !current || next.length < 4}>
          바꾸기
        </button>
      </div>
    </form>
  );
}
