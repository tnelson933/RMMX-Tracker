import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Save, User, Mail, Calendar, PenLine, Trash2, MousePointer } from "lucide-react";

export type FieldType = "name" | "email" | "date" | "signature";

export interface WaiverField {
  id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const FIELD_META: Record<FieldType, { label: string; color: string; icon: React.ReactNode }> = {
  name:      { label: "Rider Name",   color: "#3b82f6", icon: <User size={12} /> },
  email:     { label: "Rider Email",  color: "#8b5cf6", icon: <Mail size={12} /> },
  date:      { label: "Date Signed",  color: "#10b981", icon: <Calendar size={12} /> },
  signature: { label: "Signature",    color: "#ef4444", icon: <PenLine size={12} /> },
};

const DEFAULT_SIZES: Record<FieldType, { w: number; h: number }> = {
  name:      { w: 0.26, h: 0.038 },
  email:     { w: 0.30, h: 0.038 },
  date:      { w: 0.18, h: 0.038 },
  signature: { w: 0.30, h: 0.065 },
};

interface PageDim { width: number; height: number }

interface Props {
  url: string;
  initialFields?: WaiverField[];
  onSave: (fields: WaiverField[]) => void;
  onCancel: () => void;
}

export function PdfFieldEditor({ url, initialFields = [], onSave, onCancel }: Props) {
  const [numPages, setNumPages]     = useState(0);
  const [loading, setLoading]       = useState(true);
  const [pdfError, setPdfError]     = useState<string | null>(null);
  const [fields, setFields]         = useState<WaiverField[]>(initialFields);
  const [dims, setDims]             = useState<(PageDim | null)[]>([]);
  const [tool, setTool]             = useState<FieldType | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const pdfRef     = useRef<any>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  const dragRef   = useRef<{ id: string; sx: number; sy: number; fx: number; fy: number } | null>(null);
  const resizeRef = useRef<{ id: string; sx: number; sy: number; sw: number; sh: number } | null>(null);
  const dimsRef   = useRef<(PageDim | null)[]>([]);

  useEffect(() => {
    let dead = false;
    setLoading(true); setPdfError(null); setNumPages(0); setDims([]);
    pdfRef.current = null; canvasRefs.current = []; dimsRef.current = [];
    (async () => {
      try {
        const lib: any = await import(/* @vite-ignore */ "pdfjs-dist");
        if (!lib.GlobalWorkerOptions.workerSrc)
          lib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${lib.version}/build/pdf.worker.min.mjs`;
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.arrayBuffer();
        if (dead) return;
        const doc = await lib.getDocument({ data }).promise;
        if (dead) return;
        pdfRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (e: any) {
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
      if (!dead) { dimsRef.current = newDims; setDims([...newDims]); }
    })();
    return () => { dead = true; };
  }, [numPages]);

  const handlePageClick = useCallback((e: React.MouseEvent<HTMLDivElement>, pageIdx: number) => {
    if (!tool) return;
    const d = dimsRef.current[pageIdx];
    if (!d) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    const { w, h } = DEFAULT_SIZES[tool];
    const fx = Math.max(0, Math.min(relX / d.width - w / 2, 1 - w));
    const fy = Math.max(0, Math.min(relY / d.height - h / 2, 1 - h));
    const nf: WaiverField = { id: crypto.randomUUID(), type: tool, page: pageIdx, x: fx, y: fy, width: w, height: h };
    setFields(prev => [...prev, nf]);
    setSelectedId(nf.id);
  }, [tool]);

  const startDrag = useCallback((e: React.MouseEvent, id: string, fx: number, fy: number) => {
    e.preventDefault(); e.stopPropagation();
    setSelectedId(id);
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, fx, fy };
  }, []);

  const startResize = useCallback((e: React.MouseEvent, id: string, sw: number, sh: number) => {
    e.preventDefault(); e.stopPropagation();
    resizeRef.current = { id, sx: e.clientX, sy: e.clientY, sw, sh };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const { id, sx, sy, fx, fy } = dragRef.current;
        setFields(prev => prev.map(f => {
          if (f.id !== id) return f;
          const d = dimsRef.current[f.page];
          if (!d) return f;
          const dx = (e.clientX - sx) / d.width;
          const dy = (e.clientY - sy) / d.height;
          return { ...f, x: Math.max(0, Math.min(fx + dx, 1 - f.width)), y: Math.max(0, Math.min(fy + dy, 1 - f.height)) };
        }));
      }
      if (resizeRef.current) {
        const { id, sx, sy, sw, sh } = resizeRef.current;
        setFields(prev => prev.map(f => {
          if (f.id !== id) return f;
          const d = dimsRef.current[f.page];
          if (!d) return f;
          const dw = (e.clientX - sx) / d.width;
          const dh = (e.clientY - sy) / d.height;
          return { ...f, width: Math.max(0.06, Math.min(sw + dw, 1 - f.x)), height: Math.max(0.025, Math.min(sh + dh, 1 - f.y)) };
        }));
      }
    };
    const onUp = () => { dragRef.current = null; resizeRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  return (
    <div className="flex flex-col h-full select-none" onMouseDown={() => setSelectedId(null)}>
      {/* ── Toolbar ── */}
      <div className="shrink-0 border-b bg-card px-4 py-3 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium mr-1">Add field:</span>
        {(Object.keys(FIELD_META) as FieldType[]).map(type => {
          const { label, color, icon } = FIELD_META[type];
          return (
            <button
              key={type}
              onClick={() => setTool(prev => prev === type ? null : type)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium transition-all"
              style={{
                borderColor: tool === type ? color : "#e5e7eb",
                backgroundColor: tool === type ? color + "18" : "white",
                color: tool === type ? color : "#374151",
              }}
            >
              {icon} {label}
            </button>
          );
        })}
        {tool && (
          <button
            onClick={() => setTool(null)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground ml-1"
          >
            <MousePointer size={12} /> Cancel placement
          </button>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={onCancel} className="h-8">Cancel</Button>
        <Button size="sm" onClick={() => onSave(fields)} className="h-8 font-heading uppercase tracking-wider gap-1.5">
          <Save size={13} /> Save Layout
        </Button>
      </div>

      {tool && (
        <div className="shrink-0 bg-blue-50 dark:bg-blue-950/30 border-b border-blue-200 dark:border-blue-800 px-4 py-2 text-xs text-blue-700 dark:text-blue-300 font-medium">
          Click anywhere on the PDF to place a <strong>{FIELD_META[tool].label}</strong> field. Click again to add more, or press Cancel placement when done.
        </div>
      )}

      {/* ── PDF area ── */}
      <div className="flex-1 overflow-y-auto bg-neutral-200 dark:bg-neutral-800 p-6">
        {loading && <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">Loading PDF…</div>}
        {pdfError && <div className="text-sm text-destructive text-center py-8">{pdfError}</div>}

        {!loading && !pdfError && (
          <div className="space-y-8">
            {Array.from({ length: numPages }, (_, i) => {
              const d = dims[i];
              const pf = fields.filter(f => f.page === i);
              return (
                <div key={i} className="mx-auto" style={{ width: d ? d.width : "auto" }}>
                  <p className="text-xs text-neutral-500 mb-1 text-center font-medium">Page {i + 1}</p>
                  <div
                    className="relative shadow-lg"
                    style={{ width: d ? d.width : "auto", height: d ? d.height : "auto", cursor: tool ? "crosshair" : "default" }}
                    onClick={(e) => handlePageClick(e, i)}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <canvas ref={el => { canvasRefs.current[i] = el; }} style={{ display: "block" }} />

                    {/* Field boxes */}
                    {d && pf.map(field => {
                      const { label, color } = FIELD_META[field.type as FieldType];
                      const isSelected = selectedId === field.id;
                      return (
                        <div
                          key={field.id}
                          style={{
                            position: "absolute",
                            left: field.x * d.width,
                            top: field.y * d.height,
                            width: field.width * d.width,
                            height: field.height * d.height,
                            border: `2px solid ${color}`,
                            outline: isSelected ? `2px solid ${color}` : "none",
                            outlineOffset: 2,
                            backgroundColor: color + "1a",
                            boxSizing: "border-box",
                            cursor: "move",
                          }}
                          onMouseDown={(e) => { e.stopPropagation(); startDrag(e, field.id, field.x, field.y); setSelectedId(field.id); }}
                          onClick={(e) => { e.stopPropagation(); setSelectedId(field.id); }}
                        >
                          {/* Label bar */}
                          <div style={{ position: "absolute", top: 0, left: 0, right: 0, backgroundColor: color, display: "flex", alignItems: "center", padding: "1px 4px", gap: 3, overflow: "hidden" }}>
                            <span style={{ color: "white", fontSize: 9, fontWeight: 700, fontFamily: "system-ui,sans-serif", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {label}
                            </span>
                            <button
                              style={{ color: "white", background: "none", border: "none", padding: "0 2px", cursor: "pointer", flexShrink: 0, lineHeight: 1, fontSize: 10 }}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); setFields(prev => prev.filter(f => f.id !== field.id)); if (selectedId === field.id) setSelectedId(null); }}
                            >
                              ✕
                            </button>
                          </div>

                          {/* Resize handle */}
                          <div
                            style={{ position: "absolute", bottom: 0, right: 0, width: 12, height: 12, backgroundColor: color, cursor: "se-resize" }}
                            onMouseDown={(e) => { e.stopPropagation(); startResize(e, field.id, field.width, field.height); }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Legend ── */}
      <div className="shrink-0 border-t bg-card px-4 py-2 flex items-center gap-4 flex-wrap">
        <span className="text-xs text-muted-foreground">Fields:</span>
        {fields.length === 0 ? (
          <span className="text-xs text-muted-foreground italic">No fields placed yet — select a type above and click the PDF</span>
        ) : (
          <>
            {(Object.keys(FIELD_META) as FieldType[]).map(type => {
              const count = fields.filter(f => f.type === type).length;
              if (!count) return null;
              const { label, color } = FIELD_META[type];
              return (
                <span key={type} className="flex items-center gap-1 text-xs" style={{ color }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: color, display: "inline-block" }} />
                  {count}× {label}
                </span>
              );
            })}
            <button
              onClick={() => { setFields([]); setSelectedId(null); }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive ml-auto"
            >
              <Trash2 size={11} /> Clear all
            </button>
          </>
        )}
      </div>
    </div>
  );
}
