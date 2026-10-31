"use client";
import { useEffect, useRef, useState } from "react";
import { renderGraphicPng, renderOriginalPng } from "@/lib/graphic/render";
import { pxForPrint } from "@/lib/figure/engine";
import { itemFigures, setItemFigure } from "@/lib/figure/item-figures";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function FigureReview({ exam: initial, onContinue }: { exam: any; onContinue: (exam: any) => void }) {
  const [exam, setExam] = useState(initial);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const versions = useRef(new Map<string, number>());
  const current = useRef(initial), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const items = exam.sections.flatMap((s: any, section: number) => s.items.flatMap((it: any, index: number) => itemFigures(it).map((figure, figureIndex) => ({ it, figure, figureIndex, section, index })))).filter(({ figure }: any) => figure.original_png);
  async function change(section: number, index: number, figureIndex: number, patch: any) {
    const key = `${section}-${index}-${figureIndex}`, version = (versions.current.get(key) ?? 0) + 1;
    versions.current.set(key, version); setPending(p => p + 1); setError("");
    const fig = { ...itemFigures(current.current.sections[section].items[index])[figureIndex], ...patch };
    const update = (figure: any) => {
      const old = current.current, copy = { ...old, sections: [...old.sections] }, s = { ...old.sections[section], items: [...old.sections[section].items] };
      copy.sections[section] = s; s.items[index] = { ...s.items[index] };
      setItemFigure(s.items[index], figureIndex, figure);
      current.current = copy; if (alive.current) setExam(copy);
    };
    update(fig);
    try {
      const redraw = fig.render_mode === "redraw" && fig.graphic?.kind !== "photo";
      const out = redraw ? await renderGraphicPng(fig.graphic, pxForPrint(fig.width_mm || 80, 180), fig.width_mm || 80) : await renderOriginalPng(fig.original_png, fig.photo_adjustment);
      if (versions.current.get(key) !== version || !alive.current) return;
      update({ ...fig, png: out.dataUrl.split(",")[1], png_size: [out.width, out.height], render_warnings: out.warnings });
    } catch (e) { if (alive.current && versions.current.get(key) === version) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current) setPending(p => p - 1); }
  }
  return <section className="card" aria-labelledby="figure-review-title">
    <h2 id="figure-review-title">원본과 자료 비교</h2>
    <p>지명·숫자·단위·사물의 개수와 위치가 같은지 확인해 주세요. 재작성 결과가 다르면 해당 자료만 원본으로 사용할 수 있습니다.</p>
    {items.map(({ it, figure, figureIndex, section, index }: any) => {
      const f = figure, redraw = !!f.graphic && f.graphic.kind !== "photo";
      return <article className="graphic-review" key={`${section}-${index}-${figureIndex}`}>
        <h3>{it.label || `${it.no}번`} 자료 {figureIndex + 1}</h3>
        <div className="graphic-pair">
          <figure><figcaption>원본</figcaption><img src={`data:image/png;base64,${f.original_png}`} alt={`${it.no}번 원본 자료`} /></figure>
          <figure><figcaption>{f.render_mode === "redraw" ? "재작성" : "원본 사용"}</figcaption>{f.png && <img src={`data:image/png;base64,${f.png}`} alt={`${it.no}번 출력할 자료`} />}</figure>
        </div>
        <div className="row">
          {redraw && <button type="button" aria-pressed={f.render_mode === "redraw"} onClick={() => change(section, index, figureIndex, { render_mode: "redraw" })}>재작성 사용</button>}
          <button type="button" aria-pressed={f.render_mode === "original"} onClick={() => change(section, index, figureIndex, { render_mode: "original" })}>원본 사용</button>
        </div>
        {f.render_mode === "original" && <div className="row photo-controls">
          <label>밝기 {Math.round((f.photo_adjustment?.brightness ?? 1) * 100)}% <input type="range" min="0.7" max="1.3" step="0.05" value={f.photo_adjustment?.brightness ?? 1} onChange={e => change(section, index, figureIndex, { photo_adjustment: { brightness: Number(e.target.value), rotation: f.photo_adjustment?.rotation ?? 0 } })} /></label>
          <label>기울기 {f.photo_adjustment?.rotation ?? 0}° <input type="range" min="-5" max="5" step="0.5" value={f.photo_adjustment?.rotation ?? 0} onChange={e => change(section, index, figureIndex, { photo_adjustment: { brightness: f.photo_adjustment?.brightness ?? 1, rotation: Number(e.target.value) } })} /></label>
          <button type="button" onClick={() => change(section, index, figureIndex, { photo_adjustment: { brightness: 1, rotation: 0 } })}>보정 초기화</button>
        </div>}
        {it.unsure?.length > 0 && <p className="muted small">{it.unsure.join(" / ")}</p>}
        {f.render_warnings?.length > 0 && <p className="notice error">{f.render_warnings.join(" / ")}</p>}
      </article>;
    })}
    {error && <p className="notice error" role="alert">{error}</p>}
    <button className="primary" type="button" disabled={!!pending || !!error} onClick={() => onContinue(exam)}>{pending ? "자료를 그리는 중" : "확인한 자료로 한글 파일 만들기"}</button>
  </section>;
}

