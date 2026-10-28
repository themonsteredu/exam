"use client";

// 2단계 그림 엔진 확인 화면.
// Next.js 페이지(app/figure-test)와 따로 여는 점검 페이지(artifact) 양쪽에서 같은 코드를 쓴다.

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { EXAMPLES, type Example } from "@/lib/figure/examples";
import { FigureRenderer, pxForPrint, renderFigurePng } from "@/lib/figure/engine";
import { fitAffine, type Vec } from "@/lib/figure/geometry";

/* eslint-disable @typescript-eslint/no-explicit-any */
const MAX_BOARD_WIDTH = 520;
const PRINT_DPI = 360;

const SOURCES = [
  { file: "exam_p1.jpg", desc: "시험지 1쪽 (예시 A, B, C)" },
  { file: "cubes_problem4.png", desc: "쌓기나무 11개 문제 (예시 D)" },
  { file: "cubes_worksheet.png", desc: "쌓기나무 학습지 (예시 E)" },
  { file: "rect_p.jpg", desc: "직사각형과 점 P (예시 F)" },
];

const stem = (name: string) => name.toLowerCase().replace(/\.[^.]+$/, "");

type Props = {
  JXG: any;
  /** samples 폴더 사진 주소. 없으면 사용자가 사진을 직접 고른다 */
  sampleUrl?: (file: string) => string;
  /** PNG 를 파일로 내려받을 수 있는 곳인지 */
  canDownload?: boolean;
};

export default function FigureTestView({ JXG, sampleUrl, canDownload = false }: Props) {
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const [unmatched, setUnmatched] = useState<string[]>([]);

  const urlFor = (file: string): string | null => chosen[file] ?? (sampleUrl ? sampleUrl(file) : null);

  const choose = (file: string, f: File) => {
    setChosen((c) => ({ ...c, [file]: URL.createObjectURL(f) }));
  };

  const chooseMany = (files: FileList | null) => {
    if (!files) return;
    const missed: string[] = [];
    for (const f of Array.from(files)) {
      const hit = SOURCES.find((s) => stem(s.file) === stem(f.name));
      if (hit) choose(hit.file, f);
      else missed.push(f.name);
    }
    setUnmatched(missed);
  };

  const report = (file: string, ok: boolean) => setLoaded((l) => (l[file] === ok ? l : { ...l, [file]: ok }));

  return (
    <main className="page">
      <header className="page-head">
        <h1>시험지 그림 엔진</h1>
        <p className="lead">
          그림 명령으로 그린 예시 여섯 개입니다. 원본 사진을 반투명하게 겹쳐서 선과 점이 원본과 맞는지 확인할 수 있어요.
        </p>
        <ol className="steps">
          <li>
            {sampleUrl
              ? "samples 폴더에 있는 사진은 저절로 불러옵니다. 없는 사진은 아래에서 골라 주세요."
              : "아래 ‘원본 사진 고르기’에서 시험지 사진 네 장을 한 번에 골라 주세요. 파일 이름을 보고 알맞은 그림에 넣습니다."}
          </li>
          <li>그림마다 원본이 반투명하게 겹쳐 나옵니다. 선과 점이 원본과 맞는지 봐 주세요.</li>
          <li>많이 어긋나 있으면 &lsquo;기준점 다시 찍기&rsquo;를 누르고, 안내하는 점을 원본 사진에서 차례로 눌러 주세요.</li>
          <li>주황색 동그라미가 있는 점(예시 B의 E, 예시 F의 P)은 끌어서 옮겨 볼 수 있습니다.</li>
          <li>&lsquo;PNG 만들기&rsquo;를 누르면 한글 파일에 들어갈 그림을 실제 해상도로 만들어 보여 줍니다.</li>
        </ol>
      </header>

      <section className="ft-sources" aria-labelledby="sources-title">
        <h2 id="sources-title">원본 사진</h2>
        <div className="ft-row">
          <label className="btn" htmlFor="pick-all">
            원본 사진 고르기
            <input id="pick-all" className="sr-only" type="file" accept="image/*" multiple onChange={(e) => chooseMany(e.target.files)} />
          </label>
          <p className="ft-hint">여러 장을 한 번에 고를 수 있어요. 사진은 이 브라우저 안에서만 쓰이고 어디에도 올라가지 않습니다.</p>
        </div>
        <ul className="ft-source-list">
          {SOURCES.map((s) => (
            <li key={s.file} className="ft-source">
              <span className="ft-source-name">
                <span className="ft-file">{s.file}</span>
                <span className="ft-source-desc">{s.desc}</span>
              </span>
              <span className={`chip ${loaded[s.file] ? "ok" : ""}`}>{loaded[s.file] ? "불러옴" : "아직 없음"}</span>
            </li>
          ))}
        </ul>
        {unmatched.length > 0 && (
          <p className="ft-error">
            이름으로 짝을 찾지 못한 사진이 있습니다: {unmatched.join(", ")}. 해당 그림 칸의 &lsquo;이 그림의 원본 고르기&rsquo;로 직접 넣어 주세요.
          </p>
        )}
      </section>

      {!JXG && <p className="ft-boot">그림 도구를 불러오는 중입니다.</p>}
      {JXG &&
        EXAMPLES.map((ex) => (
          <FigureCard
            key={ex.key}
            JXG={JXG}
            ex={ex}
            imgUrl={urlFor(ex.image)}
            onChoose={(f) => choose(ex.image, f)}
            onImageState={(ok) => report(ex.image, ok)}
            canDownload={canDownload}
          />
        ))}
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
    /* 저장이 안 되는 브라우저: 이번 화면에서만 쓴다 */
  }
}

type CardProps = {
  JXG: any;
  ex: Example;
  imgUrl: string | null;
  onChoose: (f: File) => void;
  onImageState: (ok: boolean) => void;
  canDownload: boolean;
};

function FigureCard({ JXG, ex, imgUrl, onChoose, onImageState, canDownload }: CardProps) {
  const boxId = `board-${ex.key}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<FigureRenderer | null>(null);
  const [boardWidth, setBoardWidth] = useState<number | null>(null);
  const [natural, setNatural] = useState<[number, number] | null>(null);
  const [imgOk, setImgOk] = useState(false);
  const [overlay, setOverlay] = useState(true);
  const [opacity, setOpacity] = useState(0.45);
  const [onTop, setOnTop] = useState(true);
  const [matrix, setMatrix] = useState<number[] | null>(null);
  const [clicks, setClicks] = useState<Clicks | null>(null);
  const [picking, setPicking] = useState<[number, number][] | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [png, setPng] = useState<{ url: string; w: number; h: number } | null>(null);
  const [pngBusy, setPngBusy] = useState(false);
  const [pngError, setPngError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => setClicks(loadClicks(ex.key)), [ex.key]);

  // 칸 너비에 맞춰 그림 크기를 정한다
  useEffect(() => {
    const w = wrapRef.current?.clientWidth || MAX_BOARD_WIDTH;
    setBoardWidth(Math.max(260, Math.min(MAX_BOARD_WIDTH, w - 2)));
  }, []);

  // 사진이 바뀌면 크기를 다시 잰다
  useEffect(() => {
    setNatural(null);
    setImgOk(false);
  }, [imgUrl]);

  // 그림 그리기
  useEffect(() => {
    const el = document.getElementById(boxId);
    if (!el || !boardWidth) return;
    const r = new FigureRenderer(JXG, el, ex.spec, {
      widthPx: boardWidth,
      interactive: true,
      onChange: () => setTick((t) => t + 1),
    });
    rendererRef.current = r;
    setTick((t) => t + 1);
    return () => {
      r.destroy();
      rendererRef.current = null;
      el.innerHTML = "";
    };
  }, [JXG, ex, boxId, boardWidth]);

  // 겹쳐 보기 위치: 기준점끼리 짝지어 최소제곱 아핀 변환을 구한다
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !natural) return;
    const imgPts: Vec[] = [];
    const scrPts: Vec[] = [];
    ex.anchors.forEach((a, i) => {
      let px: [number, number];
      if (clicks && clicks.points[i]) {
        const [nw, nh] = clicks.natural;
        px = [(clicks.points[i][0] * natural[0]) / nw, (clicks.points[i][1] * natural[1]) / nh];
      } else {
        px = [(a.px[0] * natural[0]) / ex.imageSize[0], (a.px[1] * natural[1]) / ex.imageSize[1]];
      }
      const fp = r.pt(a.figure);
      if (!Number.isFinite(fp.x) || !Number.isFinite(fp.y)) return;
      imgPts.push({ x: px[0], y: px[1] });
      scrPts.push(r.toScreen(fp));
    });
    setMatrix(fitAffine(imgPts, scrPts));
  }, [natural, clicks, ex, tick]);

  const makePng = async () => {
    setPngBusy(true);
    setPngError(null);
    try {
      const out = await renderFigurePng(JXG, ex.spec, {
        widthPx: pxForPrint(ex.printWidthMm, PRINT_DPI),
        gliders: rendererRef.current?.gliderState(),
      });
      setPng({ url: out.dataUrl, w: out.width, h: out.height });
      if (canDownload) {
        const a = document.createElement("a");
        a.href = out.dataUrl;
        a.download = `figure-${ex.key}.png`;
        a.click();
      }
    } catch (err) {
      setPngError(`PNG를 만들지 못했습니다. (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      setPngBusy(false);
    }
  };

  const onPickClick = (e: ReactMouseEvent<HTMLImageElement>) => {
    if (!picking || !natural) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * natural[0];
    const y = ((e.clientY - rect.top) / rect.height) * natural[1];
    const next = [...picking, [x, y] as [number, number]];
    if (next.length >= ex.anchors.length) {
      const value: Clicks = { natural, points: next };
      setClicks(value);
      saveClicks(ex.key, value);
      setPicking(null);
    } else setPicking(next);
  };

  const heightPx = rendererRef.current?.heightPx ?? Math.round((boardWidth ?? MAX_BOARD_WIDTH) * 0.6);
  const width = boardWidth ?? MAX_BOARD_WIDTH;
  const pickTarget = picking ? ex.anchors[picking.length] : null;

  return (
    <section className="ft-card" aria-labelledby={`title-${ex.key}`}>
      <div className="ft-card-head">
        <div>
          <h2 id={`title-${ex.key}`}>{ex.title}</h2>
          <p className="ft-note">{ex.note}</p>
        </div>
        <div className="ft-card-tags">
          <span className="chip">시험지에서 가로 {ex.printWidthMm}mm</span>
          <span className={`chip ${imgOk ? "ok" : "warn"}`}>{imgOk ? "원본 있음" : "원본 없음"}</span>
        </div>
      </div>

      <div className="ft-body">
        <div className="ft-sheet-scroll" ref={wrapRef}>
          <div className="ft-sheet" style={{ width, height: heightPx }}>
            <div id={boxId} style={{ position: "absolute", left: 0, top: 0, zIndex: 2 }} />
            {overlay && matrix && imgOk && imgUrl && natural && (
              <img
                src={imgUrl}
                alt=""
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: natural[0],
                  height: natural[1],
                  transformOrigin: "0 0",
                  transform: `matrix(${matrix.join(",")})`,
                  opacity,
                  zIndex: onTop ? 3 : 1,
                  pointerEvents: "none",
                  mixBlendMode: onTop ? "multiply" : "normal",
                }}
              />
            )}
          </div>
          {imgUrl && (
            <img
              src={imgUrl}
              alt=""
              hidden
              onLoad={(e) => {
                setNatural([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight]);
                setImgOk(true);
                onImageState(true);
              }}
              onError={() => {
                setImgOk(false);
                onImageState(false);
              }}
            />
          )}
        </div>

        <div className="ft-controls">
          <div className="ft-group">
            <span className="ft-group-label">겹쳐 보기</span>
            <div className="ft-row">
              <label className="ft-check" htmlFor={`overlay-${ex.key}`}>
                <input id={`overlay-${ex.key}`} type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
                원본 겹쳐 보기
              </label>
              <label className="ft-check" htmlFor={`ontop-${ex.key}`}>
                <input id={`ontop-${ex.key}`} type="checkbox" checked={onTop} onChange={(e) => setOnTop(e.target.checked)} />
                원본을 그림 위에 올리기
              </label>
            </div>
            <div className="ft-range">
              <label htmlFor={`opacity-${ex.key}`}>원본 진하기</label>
              <input
                id={`opacity-${ex.key}`}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
              />
              <output htmlFor={`opacity-${ex.key}`}>{Math.round(opacity * 100)}%</output>
            </div>
          </div>

          <div className="ft-group">
            <span className="ft-group-label">원본 위치 맞추기</span>
            <div className="ft-row">
              <label className="btn" htmlFor={`file-${ex.key}`}>
                이 그림의 원본 고르기
                <input
                  id={`file-${ex.key}`}
                  className="sr-only"
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onChoose(f);
                  }}
                />
              </label>
              <button onClick={() => setPicking([])} disabled={!natural}>
                기준점 다시 찍기
              </button>
              {clicks && (
                <button
                  onClick={() => {
                    setClicks(null);
                    saveClicks(ex.key, null);
                  }}
                >
                  처음 기준점으로
                </button>
              )}
            </div>
            <p className="ft-hint">
              기준점: {ex.anchors.map((a) => a.name).join(", ")}
              {clicks ? " (직접 찍은 위치를 쓰는 중)" : ""}
            </p>
          </div>

          <div className="ft-group">
            <span className="ft-group-label">한글 파일에 들어갈 그림</span>
            <div className="ft-row">
              <button className="primary" onClick={makePng} disabled={pngBusy}>
                {pngBusy ? "만드는 중" : canDownload ? "PNG 만들고 저장" : "PNG 만들기"}
              </button>
              <button onClick={() => setShowJson((s) => !s)} aria-expanded={showJson}>
                {showJson ? "그림 명령 닫기" : "그림 명령 보기"}
              </button>
            </div>
            {pngError && <p className="ft-error">{pngError}</p>}
          </div>

          {showJson && <pre className="ft-json">{JSON.stringify(ex.spec, null, 2)}</pre>}
        </div>
      </div>

      {picking && natural && imgUrl && pickTarget && (
        <div className="ft-pick">
          <p className="ft-pick-title">
            <span>
              원본 사진에서 <span className="ft-pick-target">{pickTarget.name}</span> 위치를 눌러 주세요.
            </span>
            <span className="ft-pick-count">
              {picking.length + 1} / {ex.anchors.length}
            </span>
            <button onClick={() => setPicking(null)}>그만두기</button>
          </p>
          <div className="ft-pick-img">
            <img src={imgUrl} alt="원본 사진" onClick={onPickClick} />
            {picking.map(([x, y], i) => (
              <span key={i} className="ft-pick-dot" style={{ left: `${(x / natural[0]) * 100}%`, top: `${(y / natural[1]) * 100}%` }} />
            ))}
          </div>
        </div>
      )}

      {png && (
        <figure className="ft-png">
          <img src={png.url} alt={`${ex.title} PNG`} width={png.w} height={png.h} />
          <figcaption>
            {png.w} × {png.h} 픽셀 · 시험지에 가로 {ex.printWidthMm}mm로 넣으면 약 {Math.round((png.w / ex.printWidthMm) * 25.4)}dpi
          </figcaption>
        </figure>
      )}
    </section>
  );
}
