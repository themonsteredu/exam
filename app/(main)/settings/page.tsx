"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, postJson, won } from "@/lib/client/api";
import { examEstimate, type ModelInfo } from "@/lib/ai/models-info";
import { PROVIDER_NAMES, providerFor, type AiProvider } from "@/lib/ai/models";

type KeyInfo = { saved: false } | { saved: true; last4: string; savedAt: string; broken: boolean };
type MonthUsage = { month: string; calls: number; usd: number };
type Settings = {
  apiKey: KeyInfo;
  apiKeys: Record<AiProvider, KeyInfo>;
  models: { page: string; figure: string };
  modelOptions: ModelInfo[];
  usage: MonthUsage[];
  usageByProvider: Record<AiProvider, MonthUsage[]>;
  krwPerUsd: number;
};

const day = (iso: string) => iso ? new Date(iso).toLocaleDateString("ko-KR") : "";
const providers: AiProvider[] = ["anthropic", "openai"];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState("");
  const load = useCallback(async () => {
    try {
      setSettings(await api<Settings>("/api/settings"));
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <main className="page" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <h1>설정</h1>
        <p className="lead">이 브라우저에서 쓸 API 키와 AI 모델을 등록하고 사용 요금을 확인합니다.</p>
      </div>
      {loadError && <p className="notice error">{loadError}</p>}
      {settings && (
        <>
          <section className="card">
            <h2>AI API 키</h2>
            <p className="muted small">키는 이 브라우저에 연결해 서버에 암호화하여 보관합니다. AI 사용료는 각 키의 계정에 청구됩니다.</p>
            {providers.map((provider) => (
              <KeyForm key={provider} provider={provider} info={settings.apiKeys?.[provider] ?? { saved: false }} onChange={load} />
            ))}
          </section>
          <ModelCard settings={settings} onChange={load} />
          <UsageCard settings={settings} />
          <PasswordCard />
        </>
      )}
    </main>
  );
}

function KeyForm({ provider, info, onChange }: { provider: AiProvider; info: KeyInfo; onChange: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const name = PROVIDER_NAMES[provider];

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await postJson("/api/settings/api-key", { provider, key });
      setKey("");
      setMessage({ ok: true, text: `${name} 키를 확인하고 저장했습니다.` });
      onChange();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`이 브라우저에 등록된 ${name} API 키를 지울까요?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/settings/api-key?provider=${provider}`, { method: "DELETE" });
      setKey("");
      setMessage({ ok: true, text: `${name} 키를 지웠습니다.` });
      onChange();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="stack" style={{ paddingTop: 16, paddingBottom: 16, borderTop: "1px solid var(--line, #ddd)" }}>
      <h3 style={{ margin: 0 }}>{provider === "openai" ? "GPT (OpenAI)" : "Claude"}</h3>
      {info.saved && !info.broken && <p className="small">등록된 키 <strong>…{info.last4}</strong> · {day(info.savedAt)} 저장</p>}
      {info.saved && info.broken && <p className="notice error">등록된 키를 열지 못했습니다. 다시 등록해 주세요.</p>}
      <label className="field">
        {info.saved ? "새 API 키로 바꾸기" : `${name} API 키 등록`}
        <input type="password" autoComplete="off" aria-label={`${name} API 키`}
          placeholder={provider === "openai" ? "OpenAI에서 발급한 sk-… 키" : "Claude에서 발급한 sk-ant-api… 키"}
          value={key} onChange={(event) => setKey(event.target.value)} disabled={busy} />
      </label>
      {message && <p className={`notice${message.ok ? "" : " error"}`}>{message.text}</p>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !key.trim()}>{busy ? "확인하는 중" : `${name} 키 확인하고 저장`}</button>
        {info.saved && <button type="button" onClick={remove} disabled={busy}>{name} 키 지우기</button>}
      </div>
    </form>
  );
}

function ModelCard({ settings, onChange }: { settings: Settings; onChange: () => void }) {
  const [page, setPage] = useState(settings.models.page);
  const [figure, setFigure] = useState(settings.models.figure);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setPage(settings.models.page); setFigure(settings.models.figure); }, [settings.models.page, settings.models.figure]);
  const known = (id: string) => settings.modelOptions.some((model) => model.id === id);
  const estimate = known(page) && known(figure) ? examEstimate(page as ModelInfo["id"], figure as ModelInfo["id"]) : null;
  const selectedProviders = [...new Set([page, figure].map(providerFor))];
  const missingKeys = selectedProviders.filter((provider) => {
    const key = settings.apiKeys?.[provider];
    return !key?.saved || key.broken;
  });

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await postJson("/api/settings/models", { page, figure });
      setMessage({ ok: true, text: "AI 모델을 저장했습니다." });
      onChange();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const options = providers.map((provider) => (
    <optgroup key={provider} label={PROVIDER_NAMES[provider]}>
      {settings.modelOptions.filter((model) => providerFor(model.id) === provider).map((model) => (
        <option key={model.id} value={model.id}>{model.name} · 입력 ${model.price.input} / 출력 ${model.price.output}</option>
      ))}
    </optgroup>
  ));

  return (
    <section className="card">
      <h2>시험지를 읽을 AI</h2>
      <p className="muted small">글·수식과 도형에 사용할 모델을 각각 고릅니다. 모델별 정확도는 같은 시험지로 비교해 주세요. 표시 요금은 100만 토큰당 달러입니다.</p>
      <div className="stack">
        <label className="field">쪽 읽기 · 글과 수식<select value={page} onChange={(event) => setPage(event.target.value)} disabled={busy}>{options}</select></label>
        <label className="field">그림 읽기 · 도형과 도표<select value={figure} onChange={(event) => setFigure(event.target.value)} disabled={busy}>{options}</select></label>
      </div>
      {missingKeys.length > 0 && <p className="notice">{missingKeys.map((provider) => PROVIDER_NAMES[provider]).join(", ")} 키를 위에서 등록하면 선택한 모델로 읽을 수 있습니다.</p>}
      {estimate !== null && <p>25문항 시험지 한 부(약 7쪽, 그림 12개)의 예상 요금은 약 <strong>{won(estimate, settings.krwPerUsd)}</strong>입니다. 실제 사용량에 따라 달라집니다.</p>}
      {message && <p className={`notice${message.ok ? "" : " error"}`}>{message.text}</p>}
      <div className="row"><button className="primary" type="button" onClick={save} disabled={busy || (page === settings.models.page && figure === settings.models.figure)}>모델 저장</button></div>
    </section>
  );
}

function UsageCard({ settings }: { settings: Settings }) {
  const [provider, setProvider] = useState<AiProvider | "all">("all");
  const rows = provider === "all" ? settings.usage : settings.usageByProvider?.[provider] ?? [];
  const thisMonth = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).format(new Date());
  const now = rows.find((row) => row.month === thisMonth);
  return (
    <section className="card">
      <h2>AI 사용 요금</h2>
      <label className="field">확인할 AI
        <select value={provider} onChange={(event) => setProvider(event.target.value as AiProvider | "all")}>
          <option value="all">Claude + GPT</option><option value="anthropic">Claude</option><option value="openai">GPT</option>
        </select>
      </label>
      <p>이번 달 <strong>{won(now?.usd ?? 0, settings.krwPerUsd)}</strong> · {now?.calls ?? 0}회</p>
      {rows.length > 0 ? (
        <div className="table-wrap"><table className="list">
          <thead><tr><th>달</th><th className="num">사용 횟수</th><th className="num">요금</th><th className="num hide-sm">달러</th></tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={row.month}><td>{row.month.replace("-", "년 ")}월</td><td className="num">{row.calls.toLocaleString("ko-KR")}</td><td className="num">{won(row.usd, settings.krwPerUsd)}</td><td className="num hide-sm">${row.usd.toFixed(2)}</td></tr>
          ))}</tbody>
        </table></div>
      ) : <p className="muted">등록한 API 키의 사용 기록이 여기에 나옵니다.</p>}
      <p className="muted small">이 프로그램의 사용량을 1달러 {settings.krwPerUsd.toLocaleString("ko-KR")}원으로 환산한 값입니다. 같은 키를 등록한 기기의 사용량은 합산합니다. 실제 청구액은 각 회사의 API 사용량 화면에서 확인해 주세요.</p>
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
      setMsg({ ok: true, text: "비밀번호를 바꿨습니다. 다른 기기와 다른 사람은 새 비밀번호로 다시 들어가야 합니다." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>비밀번호 바꾸기</h2>
      <p className="muted small">
        비밀번호는 이 프로그램을 쓰는 모든 사람이 함께 씁니다. 바꾸면 모두 새 비밀번호로 다시 들어와야 합니다. 숫자 네 자리는 남이 짐작하기 쉬우니
        더 긴 비밀번호로 바꾸면 더 안전합니다.
      </p>
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
