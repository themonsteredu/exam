"use client";

import { useCallback, useEffect, useState } from "react";
import { api, downloadStored, won, type FileRef } from "@/lib/client/api";

type Doc = {
  id: string;
  created_at: string;
  title: string;
  status: "reading" | "done" | "failed";
  original_files: FileRef[];
  hwpx_path: string | null;
  cost_usd: number;
  item_count: number;
  note: string | null;
};

const when = (iso: string) => new Date(iso).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
const STATUS: Record<Doc["status"], string> = { reading: "만드는 중이거나 멈춤", done: "완성", failed: "실패" };

export default function ArchivePage() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setDocs((await api<{ docs: Doc[] }>("/api/documents?limit=100")).docs);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function download(path: string, name: string) {
    try {
      await downloadStored(path, name);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(doc: Doc) {
    if (!confirm(`'${doc.title}' 을 지울까요? 원본 파일과 한글 파일도 함께 지워집니다.`)) return;
    try {
      await api(`/api/documents/${doc.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="page" style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <h1>보관함</h1>
        <p className="lead">올린 원본 파일과 만든 한글 시험지를 여기서 다시 내려받을 수 있습니다.</p>
      </div>
      {error && <p className="notice error">{error}</p>}
      {docs && docs.length === 0 && <p className="muted">아직 만든 시험지가 없습니다.</p>}
      {docs && docs.length > 0 && (
        <section className="card">
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th>제목</th>
                  <th className="hide-sm">만든 때</th>
                  <th className="num hide-sm">문항</th>
                  <th className="num hide-sm">AI 요금</th>
                  <th>파일</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div>{d.title}</div>
                      {d.status !== "done" && <span className={`chip${d.status === "failed" ? " warn" : ""}`}>{STATUS[d.status]}</span>}
                      {d.note && <div className="muted small">{d.note}</div>}
                    </td>
                    <td className="hide-sm">{when(d.created_at)}</td>
                    <td className="num hide-sm">{d.item_count || ""}</td>
                    <td className="num hide-sm">{d.cost_usd ? won(d.cost_usd) : ""}</td>
                    <td>
                      <div className="row">
                        {d.hwpx_path && (
                          <button type="button" className="primary" onClick={() => download(d.hwpx_path!, `${d.title}.hwpx`)}>
                            한글 파일
                          </button>
                        )}
                        {d.original_files.map((f, i) => (
                          <button key={f.path} type="button" onClick={() => download(f.path, f.name)}>
                            원본{d.original_files.length > 1 ? ` ${i + 1}` : ""}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td>
                      <button type="button" onClick={() => remove(d)} aria-label={`${d.title} 지우기`}>
                        지우기
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
