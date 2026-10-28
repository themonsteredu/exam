"use client";

import { FormEvent, Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import "../app.css";

/** 로그인 뒤 돌아갈 곳. 이 사이트 안의 주소만 허락한다 ("/\\다른사이트" 처럼 다른 사이트로 보내는 주소는 처음 화면으로) */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "로그인하지 못했습니다.");
        return;
      }
      window.location.href = safeNext(params.get("next"));
    } catch {
      setError("서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card login-card" onSubmit={submit}>
      <h2>시험지 만들기</h2>
      <p className="muted small">비밀번호를 넣어 주세요. 이 기기에서는 한 달 동안 다시 묻지 않습니다.</p>
      <label className="field">
        비밀번호
        <input
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          required
        />
      </label>
      {error && <p className="notice error">{error}</p>}
      <button className="primary" type="submit" disabled={busy || !password}>
        {busy ? "확인하는 중" : "들어가기"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="login-wrap">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
