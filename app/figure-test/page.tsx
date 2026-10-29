"use client";

import { useEffect, useState } from "react";
import FigureTestView from "@/components/figure-test/FigureTestView";
import { loadFigureFonts } from "@/lib/figure/engine";
import "@/components/figure-test/figure-test.css";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function FigureTestPage() {
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

  return <FigureTestView JXG={JXG} sampleUrl={(file) => `/api/sample/${file}`} canDownload />;
}
