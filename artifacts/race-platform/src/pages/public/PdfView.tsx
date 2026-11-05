import { useEffect, useRef, useState } from "react";
import { loadPdfJs, PDF_JS_WORKER_URL } from "@/lib/pdfJs";

/**
 * A bare PDF page for the rider app's in-app viewer (/pdf-view?src=...).
 * Android's web view can't show PDFs itself, so the app shows this page
 * instead. Only RM Roost's own uploaded files can be shown.
 */
export const PDF_VIEW_SRC = /^\/api\/storage\/[A-Za-z0-9/_.-]+\.pdf$/;

export default function PdfView() {
  const src = new URLSearchParams(window.location.search).get("src") ?? "";
  const ok = PDF_VIEW_SRC.test(src) && !src.includes("..");
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(ok ? null : "This document can't be shown.");
  const docRef = useRef<any>(null);
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]);

  useEffect(() => {
    if (!ok) return;
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_URL;
        const res = await fetch(src);
        if (!res.ok) throw new Error(String(res.status));
        const doc = await pdfjs.getDocument({ data: await res.arrayBuffer() }).promise;
        if (cancelled) return;
        docRef.current = doc;
        setPages(doc.numPages);
      } catch {
        if (!cancelled) setError("Couldn't load the document. Check your connection and try again.");
      }
    })();
    return () => { cancelled = true; };
  }, [ok, src]);

  useEffect(() => {
    const doc = docRef.current;
    if (!doc || pages === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < pages && !cancelled; i++) {
        const canvas = canvases.current[i];
        if (!canvas) continue;
        const page = await doc.getPage(i + 1);
        // Sharp on high-density phone screens, sized to the page width.
        const scale = (window.devicePixelRatio || 2) * (window.innerWidth / page.getViewport({ scale: 1 }).width);
        const vp = page.getViewport({ scale });
        canvas.width = vp.width;
        canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
      }
    })();
    return () => { cancelled = true; };
  }, [pages]);

  return (
    <div style={{ background: "#ECECEC", minHeight: "100vh", padding: 8 }}>
      {error && <p style={{ textAlign: "center", padding: 32, color: "#5E5E5C", fontFamily: "Roboto, sans-serif" }}>{error}</p>}
      {!error && pages === 0 && <p style={{ textAlign: "center", padding: 32, color: "#5E5E5C", fontFamily: "Roboto, sans-serif" }}>Loading…</p>}
      {Array.from({ length: pages }, (_, i) => (
        <canvas
          key={i}
          ref={el => { canvases.current[i] = el; }}
          style={{ width: "100%", display: "block", background: "#fff", marginBottom: 8, boxShadow: "0 1px 3px rgba(0,0,0,.15)" }}
        />
      ))}
    </div>
  );
}
