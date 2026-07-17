import { useState, useEffect, useRef } from "react";
import type { WaiverField } from "./PdfFieldEditor";

const FIELD_COLORS: Record<string, string> = {
  name:      "#3b82f6",
  email:     "#8b5cf6",
  date:      "#10b981",
  signature: "#ef4444",
};

interface PageDim { width: number; height: number }

interface Props {
  url: string;
  fields: WaiverField[];
  signerName: string;
  signerEmail: string;
  signedAt: string;
  signerType?: "self" | "guardian";
  minorRiderName?: string;
  onScrolledToBottom?: () => void;
}

function getFieldValue(
  field: WaiverField,
  signerName: string,
  signerEmail: string,
  signedAt: string,
  signerType?: "self" | "guardian",
  minorRiderName?: string,
) {
  switch (field.type) {
    case "name":      return signerName;
    case "email":     return signerEmail;
    case "date":      return signedAt;
    case "signature":
      if (signerType === "guardian" && minorRiderName?.trim()) {
        return `${signerName} — parent/guardian of ${minorRiderName.trim()}`;
      }
      return signerName;
    default:          return "";
  }
}

function getPlaceholder(type: string) {
  switch (type) {
    case "name":      return "Full Name";
    case "email":     return "Email Address";
    case "date":      return "Date";
    case "signature": return "Signature";
    default:          return "";
  }
}

/**
 * Compute the largest font size (in px) that fits `text` inside `boxWidth`
 * with `padding` px of horizontal padding on each side.
 * Falls back to `minSize` if the text is very long.
 */
function fitFontSize(
  text: string,
  boxWidth: number,
  maxSize: number,
  minSize: number,
  fontStyle: string,  // e.g. "italic" or "normal"
  fontFamily: string,
): number {
  if (!text || boxWidth <= 0) return maxSize;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const available = boxWidth - 10; // 5 px padding each side
    ctx.font = `${fontStyle} ${maxSize}px ${fontFamily}`;
    const textWidth = ctx.measureText(text).width;
    if (textWidth <= available) return maxSize;
    const scaled = Math.floor(maxSize * (available / textWidth));
    return Math.max(minSize, scaled);
  } catch {
    return minSize;
  }
}

export function PdfSignedViewer({ url, fields, signerName, signerEmail, signedAt, signerType, minorRiderName, onScrolledToBottom }: Props) {
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading]   = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [dims, setDims]         = useState<(PageDim | null)[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const pdfRef       = useRef<any>(null);
  const canvasRefs   = useRef<(HTMLCanvasElement | null)[]>([]);
  const notifiedRef  = useRef(false);

  useEffect(() => {
    notifiedRef.current = false;
  }, [url]);

  useEffect(() => {
    let dead = false;
    setLoading(true); setPdfError(null); setNumPages(0); setDims([]);
    pdfRef.current = null; canvasRefs.current = [];
    (async () => {
      try {
        const lib: any = await import(/* @vite-ignore */ "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.mjs");
        if (!lib.GlobalWorkerOptions.workerSrc)
          lib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.worker.min.mjs";
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.arrayBuffer();
        if (dead) return;
        const doc = await lib.getDocument({ data }).promise;
        if (dead) return;
        pdfRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch {
        if (!dead) { setPdfError("Could not load PDF."); setLoading(false); }
      }
    })();
    return () => { dead = true; };
  }, [url]);

  useEffect(() => {
    if (!pdfRef.current || numPages === 0) return;
    let dead = false;
    const newDims: (PageDim | null)[] = Array(numPages).fill(null);
    (async () => {
      for (let i = 0; i < numPages; i++) {
        if (dead) break;
        const cv = canvasRefs.current[i];
        if (!cv) continue;
        try {
          const page = await pdfRef.current.getPage(i + 1);
          const vp = page.getViewport({ scale: 1.5 });
          cv.width = vp.width; cv.height = vp.height;
          await page.render({ canvasContext: cv.getContext("2d")!, viewport: vp }).promise;
          newDims[i] = { width: vp.width, height: vp.height };
        } catch {}
      }
      if (!dead) {
        setDims([...newDims]);
        if (onScrolledToBottom && !notifiedRef.current) {
          const el = containerRef.current;
          if (el && el.scrollHeight <= el.clientHeight + 40) {
            notifiedRef.current = true;
            onScrolledToBottom();
          }
        }
      }
    })();
    return () => { dead = true; };
  }, [numPages, onScrolledToBottom]);

  const handleScroll = () => {
    if (!onScrolledToBottom || notifiedRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop <= el.clientHeight + 40) {
      notifiedRef.current = true;
      onScrolledToBottom();
    }
  };

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-6 py-4 bg-muted/10" style={{ minHeight: 0 }}>
      {loading && (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          <span className="animate-pulse">Loading PDF…</span>
        </div>
      )}
      {pdfError && <div className="text-sm text-destructive text-center py-8">{pdfError}</div>}

      {!loading && !pdfError && (
        <div className="space-y-4">
          {Array.from({ length: numPages }, (_, i) => {
            const d = dims[i];
            const pageFields = fields.filter(f => f.page === i);
            return (
              <div key={i} className="mx-auto shadow-md" style={{ position: "relative", width: d ? d.width : "auto", display: "block" }}>
                <canvas ref={el => { canvasRefs.current[i] = el; }} style={{ display: "block" }} />

                {d && pageFields.map(field => {
                  const value = getFieldValue(field, signerName, signerEmail, signedAt, signerType, minorRiderName);
                  const isSignature = field.type === "signature";
                  const color = FIELD_COLORS[field.type] ?? "#6b7280";
                  const pxH = field.height * d.height;
                  const pxW = field.width * d.width;
                  const fontFamily = isSignature ? "'Georgia', 'Times New Roman', serif" : "system-ui, sans-serif";
                  const fontStyle  = isSignature ? "italic" : "normal";
                  const displayText = value || getPlaceholder(field.type);

                  const maxSize = isSignature
                    ? Math.max(13, Math.min(pxH * 0.6, 28))
                    : Math.max(10, Math.min(pxH * 0.55, 16));
                  const minSize = isSignature ? 8 : 7;
                  const fontSize = fitFontSize(displayText, pxW, maxSize, minSize, fontStyle, fontFamily);

                  return (
                    <div
                      key={field.id}
                      style={{
                        position: "absolute",
                        left: field.x * d.width,
                        top: field.y * d.height,
                        width: pxW,
                        height: pxH,
                        borderBottom: `2px solid ${color}`,
                        backgroundColor: value ? color + "12" : color + "08",
                        display: "flex",
                        alignItems: "center",
                        padding: "0 5px",
                        boxSizing: "border-box",
                        overflow: "hidden",
                      }}
                    >
                      <span
                        style={{
                          fontFamily,
                          fontStyle,
                          fontSize,
                          color: value ? (isSignature ? "#111" : "#222") : color + "60",
                          whiteSpace: "nowrap",
                          lineHeight: 1.2,
                        }}
                      >
                        {displayText}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
