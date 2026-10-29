// 따로 여는 점검 페이지(artifact)의 시작점.
// React, ReactDOM, JSXGraph 는 페이지에서 CDN 으로 먼저 불러 두고 여기서는 전역 값을 쓴다.
import { createRoot } from "react-dom/client";
import FigureTestView from "@/components/figure-test/FigureTestView";
import { loadFigureFonts } from "@/lib/figure/engine";

/* eslint-disable @typescript-eslint/no-explicit-any */
const JXG = (window as any).JXG;
const root = createRoot(document.getElementById("root")!);

loadFigureFonts().finally(() => {
  root.render(<FigureTestView JXG={JXG} canDownload={false} />);
});
