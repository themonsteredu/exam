"use client";

import { useEffect, useRef, useState } from "react";
import { EXAMPLES, type Example } from "@/lib/figure/examples";
import { FigureRenderer, loadFigureFonts, pxForPrint, renderFigurePng } from "@/lib/figure/engine";
import { fitAffine, type Vec } from "@/lib/figure/geometry";

/* eslint-disable @typescript-eslint/no-explicit-any */
const BOARD_WIDTH = 520;
const PRINT_DPI = 360;

function useJXG() {
  const [JXG, setJXG] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      await loadFigureFonts();
      const mod: any = await import("jsxgraph");
      if (alive) setJXG(mod.default || mod.JXG || mod);
    })();
    return () => {
      alive = false;
    };
  }, []);
  return JXG;
}

export default function FigureTestPage() {
  const JXG = useJXG();
  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 16px 80px" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 6px" }}>그림 엔진 확인</h1>
      <p style={{ color: "var(--muted)", margin: "0 0 24px", maxWidth: 760 }}>
        그림 명령으로 그린 그림과 원본 사진을 겹쳐서 비교하는 화면입니다. 겹쳐 보기를 켜면 원본이 반투명하게 깔립니다.
        위치가 어긋나 보이면 &lsquo;기준점 다시 찍기&rsquo;로 원본 사진 속 점을 눌러 맞춰 주세요.
      </p>
      {!JXG && <p>그림 도구를 불러오는 중입니다.</p>}
      {JXG && EXAMPLES.map((ex) => <FigureCard key={ex.key} JXG={JXG} ex={ex} />)}
    </main>
  );
}

type Clicks = { natural: [number, number]; points: [number, number][] };

function loadClicks(key: string): Clicks | null {
  try {
    const raw = localStorage.getItem(`anchors-${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveClicks(key: string, value: Clicks | null) {
  try {
    if (value) localStorage.setItem(`anchors-${key}`, JSON.stringify(value));
    else localStorage.removeItem(`anchors-${key}`);
  } catch {
    /* 저장이 안 되는 브라우저 */
  }
}

function FigureCard({ JXG, ex }: { JXG: any; ex: Example }) {
  const boxId = `board-${ex.key}`;
  const rendererRef = useRef<FigureRenderer | null>(null);
  const [imgUrl, setImgUrl] = useState(`/api/sample/${ex.image}`);
  const [natural, setNatural] = useState<[number, number] | null>(null);
  const [imgMissing, setImgMissing] = useState(false);
  const [overlay, setOverlay] = useState(true);
  const [opacity, setOpacity] = useState(0.45);
  const [onTop, setOnTop] = useState(true);
  const [matrix, setMatrix] = useState<number[] | null>(null);
  const [clicks, setClicks] = useState<Clicks | null>(null);
  const [picking, setPicking] = useState<[number, number][] | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [png, setPng] = useState<{ url: string; w: number; h: number } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => setClicks(loadClicks(ex.key)), [ex.key]);

  // 그림 그리기
  useEffect(() => {
    const el = document.getElementById(boxId);
    if (!el) return;
    const r = new FigureRenderer(JXG, el, ex.spec, { widthPx: BOARD_WIDTH, interactive: true, onChange: () => setTick((t) => t + 1) });
    rendererRef.current = r;
    setTick((t) => t + 1);
    return () => {
      r.destroy();
      rendererRef.current = null;
    };
  }, [JXG, ex, boxId]);

  // 겹쳐 보기 위치 계산 (최소제곱 아핀 변환)
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !natural) return;
    const imgPts: Vec[] = [];
    const scrPts: Vec[] = [];
    ex.anchors.forEach((a, i) => {
      let px: [number, number] | undefined;
      if (clicks && clicks.points[i]) {
        const [nw, nh] = clicks.natural;
        px = [(clicks.points[i][0] * natural[0]) / nw, (clicks.points[i][1] * natural[1]) / nh];
      } else {
        px = [(a.px[0] * natural[0]) / ex.imageSize[0], (a.px[1] * natural[1]) / ex.imageSize[1]];
      }
      const fp = r.pt(a.figure);
      if (!isFinite(fp.x)) return;
      imgPts.push({ x: px[0], y: px[1] });
      scrPts.push(r.toScreen(fp));
    });
    setMatrix(fitAffine(imgPts, scrPts));
  }, [natural, clicks, ex, tick]);

  const downloadPng = async () => {
    const r = rendererRef.current;
    const out = await renderFigurePng(JXG, ex.spec, {
      widthPx: pxForPrint(ex.printWidthMm, PRINT_DPI),
      gliders: r?.gliderState(),
    });
    setPng({ url: out.dataUrl, w: out.width, h: out.height });
    const a = document.createElement("a");
    a.href = out.dataUrl;
    a.download = `figure-${ex.key}.png`;
    a.click();
  };

  const startPicking = () => setPicking([]);
  const onPickClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!picking || !natural) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * natural[0];
    const y = ((e.clientY - rect.top) / rect.height) * natural[1];
    const next = [...picking, [x, y] as [number, number]];
    if (next.length >= ex.anchors.length) {
      const value = { natural, points: next };
      setClicks(value);
      saveClicks(ex.key, value);
      setPicking(null);
    } else setPicking(next);
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    setImgUrl(URL.createObjectURL(f));
    setImgMissing(false);
    setNatural(null);
  };

  const r = rendererRef.current;
  const heightPx = r?.heightPx ?? 300;

  return (
    <section
      style={{
        background: "var(--panel)",
        border: "1px solid var(--line)",
        borderRadius: 10,
        padding: 20,
        marginBottom: 22,
      }}
    >
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 4px" }}>{ex.title}</h2>
      <p style={{ color: "var(--muted)", margin: "0 0 14px", fontSize: 14 }}>{ex.note}</p>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ position: "relative", width: BOARD_WIDTH, height: heightPx, overflow: "hidden", border: "1px solid var(--line)", background: "#fff" }}>
          <div id={boxId} style={{ position: "absolute", left: 0, top: 0, zIndex: 2 }} />
          {overlay && matrix && !imgMissing && (
            <img
              src={imgUrl}
              alt=""
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: natural?.[0],
                height: natural?.[1],
                maxWidth: "none",
                transformOrigin: "0 0",
                transform: `matrix(${matrix.join(",")})`,
                opacity,
                zIndex: onTop ? 3 : 1,
                pointerEvents: "none",
                mixBlendMode: onTop ? "multiply" : "normal",
              }}
            />
          )}
          {/* 크기를 알아내기 위한 숨은 사진 */}
          <img
            src={imgUrl}
            alt=""
            style={{ display: "none" }}
            onLoad={(e) => setNatural([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
            onError={() => setImgMissing(true)}
          />
        </div>

        <div style={{ flex: "1 1 300px", minWidth: 280, fontSize: 14 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <button onClick={() => setOverlay((o) => !o)}>{overlay ? "겹쳐 보기 끄기" : "겹쳐 보기 켜기"}</button>
            <button onClick={() => setOnTop((o) => !o)}>{onTop ? "원본을 그림 아래로" : "원본을 그림 위로"}</button>
            <button className="primary" onClick={downloadPng}>PNG로 저장</button>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            원본 진하기
            <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
            {Math.round(opacity * 100)}%
          </label>
          {imgMissing && (
            <p style={{ color: "#a0442c" }}>
              samples 폴더에 {ex.image} 가 아직 없습니다. 아래에서 사진을 직접 골라도 됩니다.
            </p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <label style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 12px", cursor: "pointer", background: "#fff" }}>
              다른 사진 고르기
              <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <button onClick={startPicking} disabled={!natural}>기준점 다시 찍기</button>
            {clicks && (
              <button onClick={() => { setClicks(null); saveClicks(ex.key, null); }}>처음 기준점으로</button>
            )}
          </div>
          <p style={{ color: "var(--muted)", margin: "0 0 8px" }}>
            기준점: {ex.anchors.map((a) => a.name).join(", ")}
            {clicks ? " (직접 찍은 위치 사용 중)" : ""}
          </p>
          {png && (
            <p style={{ color: "var(--muted)", margin: "0 0 8px" }}>
              저장한 PNG: {png.w} × {png.h} 픽셀 (시험지에서 가로 {ex.printWidthMm}mm 일 때 약 {Math.round((png.w / ex.printWidthMm) * 25.4)}dpi)
            </p>
          )}
          <button onClick={() => setShowJson((s) => !s)}>{showJson ? "그림 명령 닫기" : "그림 명령 보기"}</button>
          {showJson && (
            <pre style={{ maxHeight: 320, overflow: "auto", background: "#f3f1ec", padding: 10, fontSize: 12, borderRadius: 6 }}>
              {JSON.stringify(ex.spec, null, 2)}
            </pre>
          )}
        </div>
      </div>

      {picking && natural && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontWeight: 500, margin: "0 0 8px" }}>
            원본 사진에서 <span style={{ color: "var(--accent)" }}>{ex.anchors[picking.length].name}</span> 을(를) 눌러 주세요. ({picking.length + 1} / {ex.anchors.length})
            <button style={{ marginLeft: 12 }} onClick={() => setPicking(null)}>그만두기</button>
          </p>
          <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
            <img src={imgUrl} alt="원본" onClick={onPickClick} style={{ maxWidth: "100%", cursor: "crosshair", display: "block" }} />
            {picking.map(([x, y], i) => (
              <span
                key={i}
                style={{
                  position: "absolute",
                  left: `${(x / natural[0]) * 100}%`,
                  top: `${(y / natural[1]) * 100}%`,
                  width: 10,
                  height: 10,
                  marginLeft: -5,
                  marginTop: -5,
                  borderRadius: "50%",
                  background: "#e0533a",
                  pointerEvents: "none",
                }}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
