"use client";

// 서버의 전용 브라우저가 기존 PDF·도형 엔진을 그대로 사용한다. 자료나 키는 이 페이지에 없다.
import { useEffect } from "react";
import { openSources, pageImage, orientationImage, textDirectionOf, rotateCanvas, figureImage } from "@/lib/client/pages";
import { attachFigurePngs, renderExamFigures } from "@/lib/figure/render-exam";

export default function RenderPage() {
  useEffect(() => {
    const canvas = async (url: string) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const c = document.createElement("canvas");
      c.width = bitmap.width; c.height = bitmap.height;
      c.getContext("2d")!.drawImage(bitmap, 0, 0); bitmap.close();
      return c;
    };
    (window as any).examRenderer = async (method: string, arg: any) => {
      if (method === "inspect" || method === "page") {
        const res = await fetch(arg.url);
        if (!res.ok) throw new Error("원본을 불러오지 못했습니다.");
        const sources = await openSources([new File([await res.blob()], arg.name, { type: arg.type })]);
        if (method === "inspect") return sources.map(s => ({ label: s.label, problem: s.problem }));
        const source = sources[arg.index];
        if (!source) throw new Error("원본 쪽을 찾지 못했습니다.");
        const c = await source.render();
        return { png: c.toDataURL("image/png"), paper: source.paperMm, direction: textDirectionOf(c), orientation: orientationImage(c) };
      }
      if (method === "prepare") {
        const c = rotateCanvas(await canvas(arg.url), arg.rotate || 0);
        const page = pageImage(c);
        return { png: c.toDataURL("image/png"), ...page, original: { width: c.width, height: c.height } };
      }
      if (method === "crop") {
        const c = await canvas(arg.url);
        return arg.regions.map((r: any) => figureImage(c, r, arg.scale));
      }
      if (method === "draw") {
        const mod: any = await import("jsxgraph");
        const rendered = await renderExamFigures(mod.default || mod.JXG || mod, arg.exam);
        return { exam: attachFigurePngs(arg.exam, rendered), rendered };
      }
      throw new Error("알 수 없는 그리기 작업입니다.");
    };
    return () => { delete (window as any).examRenderer; };
  }, []);
  return <main>시험지 그리기</main>;
}
