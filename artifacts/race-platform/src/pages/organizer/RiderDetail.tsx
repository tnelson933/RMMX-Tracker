import { useState } from "react";
import { StateSelect } from "@/components/ui/StateSelect";
import { useRoute, Link } from "wouter";
import { useGetRider, useUpdateRider, useAssignRfid, useListDiscountCodes, getGetRiderQueryKey, getListRidersQueryKey, getListDiscountCodesQueryKey, useGetRiderDiscountCode, getGetRiderDiscountCodeQueryKey } from "@workspace/api-client-react";
import type { DiscountCode as DiscountCodeType, RiderDetail as RiderDetailType } from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/zodResolver";
import { z } from "zod";
import { loadPdfJs, PDF_JS_WORKER_URL } from "@/lib/pdfJs";
import { useToast } from "@/hooks/use-toast";
import { User, Tag, History, ChevronLeft, Save, Activity, Bike, Star, MapPin, Ticket, Copy, Check, Trash2, Plus, Loader2, FileText, ShieldCheck, ChevronDown, Download, ExternalLink, Radio, Printer } from "lucide-react";
import { format } from "date-fns";
import { useGetMe } from "@workspace/api-client-react";
import { PdfSignedViewer } from "@/components/PdfSignedViewer";
import { OfficialResultsBadge } from "@/components/OfficialResultsBadge";
import { useAuth } from "@/contexts/AuthContext";

// ── Types ────────────────────────────────────────────────────────────────────

interface WaiverAck {
  id: number;
  eventId: number;
  eventName: string;
  eventDate: string;
  waiverAcknowledgedAt: string;
  waiverSnapshot: string | null;
  /** The acknowledgement PDF the rider accepted, or null when it was typed text. */
  pdfUrl?: string | null;
}

interface WaiverField {
  id: string;
  type: "name" | "email" | "date" | "signature";
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PdfWaiverSignature {
  id: number;
  eventId: number;
  eventName: string;
  eventDate: string;
  signerName: string;
  signerEmail: string;
  signedAt: string;
  waiverSnapshot: string;
  /** The signed PDF, or null when the waiver was typed text (in waiverSnapshot). */
  pdfUrl?: string | null;
  fieldLayout: WaiverField[] | null;
  signerType: "self" | "guardian";
  minorRiderName: string | null;
  waiverContentHash: string;
  signerIp?: string | null;
  signerUserAgent?: string | null;
}

/** The PDF behind a stored snapshot ("[PDF waiver] url", or an older bare url). */
function snapshotPdf(snapshot: string | null | undefined): string | null {
  const s = (snapshot ?? "").trim();
  if (s.startsWith("[PDF waiver] ")) return s.slice("[PDF waiver] ".length).trim();
  return /^(https?:\/\/|\/api\/storage\/)\S+$/.test(s) ? s : null;
}

// ── Signed copy (download / print) ───────────────────────────────────────────

interface SignedCopy {
  title: string;
  pdfUrl: string | null;
  text: string | null;
  /** Fill the PDF's name/email/date/signature boxes with these values. */
  stamp?: { fields: WaiverField[]; name: string; email: string; date: string; signature: string };
  /** The signature record printed on the last page. */
  record: Array<[string, string]>;
}

/** The form as signed (the PDF with its filled-in boxes, or the text), then a signature record page. */
async function buildSignedCopy(copy: SignedCopy) {
  const { jsPDF } = await import("jspdf");
  let pdf: InstanceType<typeof jsPDF> | null = null;

  if (copy.pdfUrl) {
    const pdfjs = await loadPdfJs();
    if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_URL;
    const file = await fetch(copy.pdfUrl, { credentials: "include" });
    if (!file.ok) throw new Error(`The form's PDF couldn't be loaded (${file.status}).`);
    const pdfDoc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport }).promise;

      for (const field of (copy.stamp?.fields ?? []).filter(f => f.page === pageNum)) {
        const x = field.x * viewport.width;
        const y = field.y * viewport.height;
        const w = field.width * viewport.width;
        const h = field.height * viewport.height;
        ctx.fillStyle = "rgba(219, 234, 254, 0.55)";
        ctx.fillRect(x, y, w, h);
        const fontSize = Math.max(10, Math.min(h * 0.55, 24));
        ctx.font = field.type === "signature" ? `italic ${fontSize}px Georgia, serif` : `${fontSize}px Arial, sans-serif`;
        ctx.fillStyle = field.type === "signature" ? "#1d4ed8" : "#1e293b";
        ctx.textBaseline = "middle";
        const s = copy.stamp!;
        const value = field.type === "name" ? s.name : field.type === "email" ? s.email : field.type === "date" ? s.date : s.signature;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 4, y, w - 8, h);
        ctx.clip();
        ctx.fillText(value, x + 6, y + h / 2);
        ctx.restore();
      }

      const pdfW = viewport.width / 2;
      const pdfH = viewport.height / 2;
      const orientation = pdfW > pdfH ? "landscape" : "portrait";
      if (!pdf) pdf = new jsPDF({ orientation, unit: "pt", format: [pdfW, pdfH] });
      else pdf.addPage([pdfW, pdfH], orientation);
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, pdfW, pdfH);
    }
  }

  // Typed text forms, on letter pages.
  const margin = 54;
  const writeLines = (doc: InstanceType<typeof jsPDF>, lines: string[], startY: number, lineHeight: number) => {
    let y = startY;
    const bottom = doc.internal.pageSize.getHeight() - margin;
    for (const line of lines) {
      if (y > bottom) { doc.addPage("letter", "portrait"); y = margin; }
      doc.text(line, margin, y);
      y += lineHeight;
    }
    return y;
  };
  if (!copy.pdfUrl && copy.text) {
    pdf = new jsPDF({ unit: "pt", format: "letter" });
    const width = pdf.internal.pageSize.getWidth() - margin * 2;
    pdf.setFont("helvetica", "bold").setFontSize(15);
    pdf.text(copy.title, margin, margin);
    pdf.setFont("helvetica", "normal").setFontSize(10.5);
    writeLines(pdf, pdf.splitTextToSize(copy.text, width), margin + 28, 14);
  }

  // Signature record.
  if (!pdf) pdf = new jsPDF({ unit: "pt", format: "letter" });
  else pdf.addPage("letter", "portrait");
  const width = pdf.internal.pageSize.getWidth() - margin * 2;
  pdf.setFont("helvetica", "bold").setFontSize(15);
  pdf.text("Signature record", margin, margin);
  pdf.setFont("helvetica", "normal").setFontSize(10);
  pdf.text(copy.title, margin, margin + 18);
  let y = margin + 48;
  for (const [label, value] of copy.record) {
    pdf.setFont("helvetica", "bold").setFontSize(10);
    y = writeLines(pdf, [label], y, 13);
    pdf.setFont("helvetica", "normal").setFontSize(10);
    y = writeLines(pdf, pdf.splitTextToSize(value || "—", width), y, 13) + 8;
  }
  pdf.setFontSize(8.5).setTextColor(120);
  writeLines(pdf, pdf.splitTextToSize(`Kept by RM Roost. Printed ${format(new Date(), "MMMM d, yyyy 'at' h:mm a")}.`, width), y + 6, 11);
  pdf.setTextColor(0);
  return pdf;
}

function fileName(...parts: string[]) {
  return `${parts.join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`;
}

function signatureCopy(sig: PdfWaiverSignature): SignedCopy {
  const pdfUrl = sig.pdfUrl !== undefined ? sig.pdfUrl : snapshotPdf(sig.waiverSnapshot);
  const guardianOf = sig.signerType === "guardian" && sig.minorRiderName ? sig.minorRiderName : null;
  return {
    title: `Liability waiver: ${sig.eventName}`,
    pdfUrl,
    text: pdfUrl ? null : sig.waiverSnapshot,
    stamp: {
      fields: sig.fieldLayout ?? [],
      name: sig.signerName,
      email: sig.signerEmail,
      date: format(new Date(sig.signedAt), "MM/dd/yyyy"),
      signature: guardianOf ? `${sig.signerName} — parent/guardian of ${guardianOf}` : sig.signerName,
    },
    record: [
      ["Event", `${sig.eventName} (${sig.eventDate.substring(0, 10)})`],
      ["Signed by", guardianOf ? `${sig.signerName}, parent/guardian of ${guardianOf}` : sig.signerName],
      ["Email", sig.signerEmail],
      ["Signed", format(new Date(sig.signedAt), "MMMM d, yyyy 'at' h:mm:ss a")],
      ["Signature", "Typed name, with consent to sign electronically"],
      ["IP address", sig.signerIp ?? ""],
      ["Device", sig.signerUserAgent ?? ""],
      ["Document fingerprint (SHA-256)", sig.waiverContentHash],
    ],
  };
}

function acknowledgementCopy(ack: WaiverAck, riderName: string): SignedCopy {
  const pdfUrl = ack.pdfUrl !== undefined ? ack.pdfUrl : snapshotPdf(ack.waiverSnapshot);
  return {
    title: `Rider acknowledgement: ${ack.eventName}`,
    pdfUrl,
    text: pdfUrl ? null : ack.waiverSnapshot,
    record: [
      ["Event", `${ack.eventName} (${ack.eventDate.substring(0, 10)})`],
      ["Rider", riderName],
      ["Accepted", format(new Date(ack.waiverAcknowledgedAt), "MMMM d, yyyy 'at' h:mm:ss a")],
      ["How", "Checked the acknowledgement box when registering"],
    ],
  };
}

async function downloadCopy(copy: SignedCopy, name: string) {
  (await buildSignedCopy(copy)).save(name);
}

/**
 * Opens the print dialog for the signed copy, from a hidden frame on this page (no
 * pop-up to block); if the browser can't print it there, the copy opens in a new tab.
 */
async function printCopy(copy: SignedCopy) {
  const pdf = await buildSignedCopy(copy);
  const url = String(pdf.output("bloburl"));
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, "_blank");
    }
    setTimeout(() => frame.remove(), 60_000);
  };
  frame.src = url;
  document.body.appendChild(frame);
}

// ── WaiverAcknowledgmentsCard ─────────────────────────────────────────────────

function WaiverAcknowledgmentsCard({ riderId, clubId, riderName }: { riderId: number; clubId: number; riderName: string }) {
  const { toast } = useToast();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [viewingSig, setViewingSig] = useState<PdfWaiverSignature | null>(null);
  const [viewingAckPdf, setViewingAckPdf] = useState<WaiverAck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    try { await task(); }
    catch (err) { console.error("signed copy", err); toast({ title: "Couldn't open the signed copy", description: "The form's file may have been removed. Try again, or check Team → Forms.", variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const { data: acks, isLoading: acksLoading, isError: acksFailed, refetch: refetchAcks } = useQuery<WaiverAck[]>({
    queryKey: ["waiver-acknowledgments", clubId, riderId],
    queryFn: async () => {
      const res = await fetch(`/api/clubs/${clubId}/riders/${riderId}/waiver-acknowledgments`, { credentials: "include" });
      if (!res.ok) throw new Error("Couldn't fetch waiver acknowledgments");
      return res.json();
    },
  });

  const { data: pdfSigs, isLoading: sigsLoading, isError: sigsFailed, refetch: refetchSigs } = useQuery<PdfWaiverSignature[]>({
    queryKey: ["liability-waiver-signatures", clubId, riderId],
    queryFn: async () => {
      const res = await fetch(`/api/clubs/${clubId}/riders/${riderId}/liability-waiver-signatures`, { credentials: "include" });
      if (!res.ok) throw new Error("Couldn't fetch signed waivers");
      return res.json();
    },
  });

  const shownAcks = (acks ?? []).filter(a => a.waiverSnapshot);
  const isLoading = acksLoading || sigsLoading;
  const loadFailed = (acksFailed || sigsFailed) && !isLoading;
  const isEmpty = !pdfSigs?.length && !shownAcks.length && !isLoading && !loadFailed;
  const viewingSigPdf = viewingSig ? (viewingSig.pdfUrl !== undefined ? viewingSig.pdfUrl : snapshotPdf(viewingSig.waiverSnapshot)) : null;

  const actions = (key: string, onView: () => void, copy: () => SignedCopy, name: string) => (
    <div className="flex items-center gap-1 shrink-0">
      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onView}>
        <ExternalLink size={11} className="mr-1" />
        View
      </Button>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" title="Print" aria-label="Print"
        disabled={busy === `print-${key}`} onClick={() => run(`print-${key}`, () => printCopy(copy()))}>
        {busy === `print-${key}` ? <Loader2 size={11} className="animate-spin" /> : <Printer size={11} />}
      </Button>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" title="Download PDF" aria-label="Download PDF"
        disabled={busy === `dl-${key}`} onClick={() => run(`dl-${key}`, () => downloadCopy(copy(), name))}>
        {busy === `dl-${key}` ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
      </Button>
    </div>
  );

  return (
    <>
      <Card>
        <CardHeader className="border-b pb-4">
          <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
            <ShieldCheck className="text-primary" size={20} />
            Waiver History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={18} className="animate-spin text-muted-foreground" />
            </div>
          ) : loadFailed ? (
            <div className="p-6 space-y-3 text-center">
              <p className="text-sm text-destructive">Couldn&apos;t load this rider&apos;s waiver history.</p>
              <Button
                variant="outline"
                size="sm"
                className="font-heading uppercase"
                onClick={() => { if (acksFailed) refetchAcks(); if (sigsFailed) refetchSigs(); }}
              >
                Try Again
              </Button>
            </div>
          ) : isEmpty ? (
            <div className="p-6 text-center text-muted-foreground text-sm">No signed waivers or acknowledgements on record.</div>
          ) : (
            <div className="divide-y">

              {/* Signed liability waivers */}
              {pdfSigs?.map(sig => (
                <div key={`pdf-${sig.id}`} className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold truncate">{sig.eventName}</p>
                        <Badge variant="outline" className="text-xs py-0 h-5 border-green-400 text-green-700 bg-green-50">
                          Liability waiver · signed
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <ShieldCheck size={11} className="inline text-green-600 mr-1" />
                        Signed by <strong>{sig.signerName}</strong>
                        {sig.signerType === "guardian" && sig.minorRiderName && (
                          <span className="ml-1 text-amber-700 dark:text-amber-400">(parent/guardian of {sig.minorRiderName})</span>
                        )}
                        {" · "}{format(new Date(sig.signedAt), "MMM d, yyyy 'at' h:mm a")}
                      </p>
                    </div>
                    {actions(`sig-${sig.id}`, () => setViewingSig(sig), () => signatureCopy(sig), fileName("waiver", sig.signerName, sig.eventName))}
                  </div>
                </div>
              ))}

              {/* Rider acknowledgements */}
              {shownAcks.map(ack => {
                const ackPdf = ack.pdfUrl !== undefined ? ack.pdfUrl : snapshotPdf(ack.waiverSnapshot);
                return (
                  <div key={`ack-${ack.id}`} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold truncate">{ack.eventName}</p>
                          <Badge variant="outline" className="text-xs py-0 h-5">Acknowledgement · accepted</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                          <ShieldCheck size={11} className="text-green-600 shrink-0" />
                          Accepted {format(new Date(ack.waiverAcknowledgedAt), "MMM d, yyyy 'at' h:mm a")}
                        </p>
                      </div>
                      {actions(
                        `ack-${ack.id}`,
                        () => ackPdf ? setViewingAckPdf(ack) : setExpandedId(expandedId === ack.id ? null : ack.id),
                        () => acknowledgementCopy(ack, riderName),
                        fileName("acknowledgement", riderName, ack.eventName),
                      )}
                    </div>
                    {!ackPdf && expandedId === ack.id && ack.waiverSnapshot && (
                      <div className="mt-3 rounded-md bg-muted/50 border px-3 py-3 max-h-64 overflow-y-auto">
                        <pre className="whitespace-pre-wrap font-sans text-xs text-muted-foreground leading-relaxed">
                          {ack.waiverSnapshot}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}

            </div>
          )}
        </CardContent>
      </Card>

      {/* Signed waiver viewer */}
      <Dialog open={!!viewingSig} onOpenChange={(open) => { if (!open) setViewingSig(null); }}>
        <DialogContent className="max-w-[92vw] w-[92vw] h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-5 py-3 border-b flex-row items-center justify-between space-y-0 gap-3 pr-12">
            <div className="min-w-0">
              <DialogTitle className="font-heading uppercase tracking-wider text-base">
                Signed Waiver — {viewingSig?.eventName}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                Signed by <strong>{viewingSig?.signerName}</strong>
                {viewingSig?.signerType === "guardian" && viewingSig?.minorRiderName && (
                  <span className="ml-1 text-amber-700 dark:text-amber-400">(parent/guardian of {viewingSig.minorRiderName})</span>
                )}
                {" "}({viewingSig?.signerEmail}) on{" "}
                {viewingSig ? format(new Date(viewingSig.signedAt), "MMMM d, yyyy 'at' h:mm a") : ""}
              </DialogDescription>
            </div>
            {viewingSig && (
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" disabled={busy === "print-view"}
                  onClick={() => run("print-view", () => printCopy(signatureCopy(viewingSig)))}>
                  {busy === "print-view" ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Printer size={14} className="mr-1.5" />}
                  Print
                </Button>
                <Button variant="outline" size="sm" disabled={busy === "dl-view"}
                  onClick={() => run("dl-view", () => downloadCopy(signatureCopy(viewingSig), fileName("waiver", viewingSig.signerName, viewingSig.eventName)))}>
                  {busy === "dl-view" ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Download size={14} className="mr-1.5" />}
                  Download PDF
                </Button>
              </div>
            )}
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            {viewingSig && (viewingSigPdf ? (
              <PdfSignedViewer
                url={viewingSigPdf}
                fields={viewingSig.fieldLayout ?? []}
                signerName={viewingSig.signerName}
                signerEmail={viewingSig.signerEmail}
                signedAt={format(new Date(viewingSig.signedAt), "MM/dd/yyyy")}
                signerType={viewingSig.signerType}
                minorRiderName={viewingSig.minorRiderName ?? undefined}
              />
            ) : (
              <div className="h-full overflow-y-auto p-6">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{viewingSig.waiverSnapshot}</pre>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Acknowledgement PDF viewer */}
      <Dialog open={!!viewingAckPdf} onOpenChange={(open) => { if (!open) setViewingAckPdf(null); }}>
        <DialogContent className="max-w-[92vw] w-[92vw] h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-5 py-3 border-b flex-row items-center justify-between space-y-0 gap-3 pr-12">
            <div className="min-w-0">
              <DialogTitle className="font-heading uppercase tracking-wider text-base">
                Rider Acknowledgement — {viewingAckPdf?.eventName}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                Accepted by <strong>{riderName}</strong> on{" "}
                {viewingAckPdf ? format(new Date(viewingAckPdf.waiverAcknowledgedAt), "MMMM d, yyyy 'at' h:mm a") : ""}
              </DialogDescription>
            </div>
            {viewingAckPdf && (
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" disabled={busy === "print-ackview"}
                  onClick={() => run("print-ackview", () => printCopy(acknowledgementCopy(viewingAckPdf, riderName)))}>
                  {busy === "print-ackview" ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Printer size={14} className="mr-1.5" />}
                  Print
                </Button>
                <Button variant="outline" size="sm" disabled={busy === "dl-ackview"}
                  onClick={() => run("dl-ackview", () => downloadCopy(acknowledgementCopy(viewingAckPdf, riderName), fileName("acknowledgement", riderName, viewingAckPdf.eventName)))}>
                  {busy === "dl-ackview" ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Download size={14} className="mr-1.5" />}
                  Download PDF
                </Button>
              </div>
            )}
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            {viewingAckPdf && (
              <PdfSignedViewer
                url={(viewingAckPdf.pdfUrl !== undefined ? viewingAckPdf.pdfUrl : snapshotPdf(viewingAckPdf.waiverSnapshot)) ?? ""}
                fields={[]}
                signerName={riderName}
                signerEmail=""
                signedAt={format(new Date(viewingAckPdf.waiverAcknowledgedAt), "MM/dd/yyyy")}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

const updateRiderSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  bibNumber: z.string().optional(),
  dateOfBirth: z.string().optional(),
  emergencyContact: z.string().optional(),
  emergencyPhone: z.string().optional(),
  streetAddress: z.string().optional(),
  city: z.string().optional(),
  homeState: z.string().optional(),
  zip: z.string().optional(),
  bikeManufacturer: z.string().optional(),
  bikeModel: z.string().optional(),
  bikeYear: z.string().optional(),
  sponsors: z.string().optional(),
  amaNumber: z.string().optional(),
  mylapsTransponderId: z.string().optional(),
});

type RiderRecentResultView = NonNullable<RiderDetailType["recentResults"]>[number];

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 22 -> "22nd". */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1">{label}</div>
      <div className="font-medium">{value || <span className="text-muted-foreground/50">—</span>}</div>
    </div>
  );
}

interface DiscountCodeLegacy {
  id: number;
  code: string;
  amount: number;
  maxUses: number;
  usesCount: number;
  riderId: number;
  riderName?: string;
  createdAt: string;
}

function DiscountCodeCard({ riderId, clubId }: { riderId: number; clubId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const codeQueryKey = getGetRiderDiscountCodeQueryKey(clubId, riderId);
  const {
    data: codeData,
    isLoading: loading,
    isError: codeLoadFailed,
    error: codeLoadError,
    refetch: refetchCode,
  } = useGetRiderDiscountCode(clubId, riderId, {
    query: { queryKey: codeQueryKey, retry: false },
  });
  // The endpoint returns JSON null when no code is assigned. The RM Roost
  // local server returns an array of the rider's active codes instead, so
  // show the first one.
  const code: DiscountCodeLegacy | null = Array.isArray(codeData)
    ? ((codeData as DiscountCodeLegacy[])[0] ?? null)
    : (codeData ?? null);
  const setCode = (next: DiscountCodeLegacy | null) => {
    queryClient.setQueryData(codeQueryKey, next as DiscountCodeLegacy);
    // The rider's assigned-codes list (useListDiscountCodes) shows the same code.
    queryClient.invalidateQueries({ queryKey: getListDiscountCodesQueryKey() });
  };
  const [copied, setCopied] = useState(false);
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [generateAmount, setGenerateAmount] = useState("");
  const [generating, setGenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleGenerate = async () => {
    const amount = parseFloat(generateAmount);
    if (!amount || amount <= 0) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/clubs/${clubId}/riders/${riderId}/discount-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ amount }),
      });
      if (res.ok) {
        const data = await res.json();
        setCode(data);
        setShowGenerateDialog(false);
        setGenerateAmount("");
        toast({ title: "Discount code generated", description: `Code: ${data.code}` });
      } else {
        const err = await res.json().catch(() => ({}));
        toast({ title: "Couldn't generate code", description: err.error, variant: "destructive" });
      }
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/clubs/${clubId}/riders/${riderId}/discount-code`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setCode(null);
        toast({ title: "Discount code removed" });
      } else {
        const err = await res.json().catch(() => ({}));
        toast({ title: "Couldn't delete code", description: err.error, variant: "destructive" });
      }
    } finally {
      setDeleting(false);
    }
  };

  const handleCopy = () => {
    if (!code) return;
    navigator.clipboard.writeText(code.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: "Code copied to clipboard" });
  };

  const isUsed = code ? code.usesCount >= code.maxUses : false;

  return (
    <>
      <Card className={code && !isUsed ? "border-primary/30" : ""}>
        <CardHeader className="border-b pb-4">
          <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
            <Ticket className="text-primary" size={20} />
            Discount Code
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : codeLoadFailed ? (
            <div className="space-y-3 text-center py-2">
              <p className="text-sm text-destructive">
                Couldn&apos;t load this rider&apos;s discount code.
              </p>
              {codeLoadError instanceof Error && (
                <p className="text-xs text-muted-foreground">{codeLoadError.message}</p>
              )}
              <Button variant="outline" size="sm" className="font-heading uppercase" onClick={() => refetchCode()}>
                Try Again
              </Button>
            </div>
          ) : code && !isUsed ? (
            <div className="space-y-4">
              <div className="flex items-center justify-center p-5 bg-primary/5 rounded-lg border border-primary/20">
                <div className="text-center">
                  <div className="text-xs font-bold text-primary uppercase tracking-widest mb-2">Active Code</div>
                  <div className="font-mono text-2xl font-bold tracking-widest text-primary">{code.code}</div>
                  <div className="text-sm text-muted-foreground mt-1">${code.amount.toFixed(2)} discount</div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1 font-heading uppercase" onClick={handleCopy}>
                  {copied ? <><Check size={14} className="mr-2" /> Copied</> : <><Copy size={14} className="mr-2" /> Copy Code</>}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={handleDelete}
                  disabled={deleting}
                  title="Revoke code"
                >
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground text-center">
                Rider enters this code at event registration for ${code.amount.toFixed(2)} off.
              </p>
            </div>
          ) : code && isUsed ? (
            <div className="space-y-4">
              <div className="flex items-center justify-center p-5 bg-muted rounded-lg border">
                <div className="text-center">
                  <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">Code Used</div>
                  <div className="font-mono text-xl font-bold text-muted-foreground line-through tracking-widest">{code.code}</div>
                  <div className="text-sm text-muted-foreground mt-1">${code.amount.toFixed(2)} — already redeemed</div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full font-heading uppercase"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Trash2 size={14} className="mr-2" />}
                Clear Used Code
              </Button>
              <Button
                size="sm"
                className="w-full font-heading uppercase"
                onClick={() => setShowGenerateDialog(true)}
              >
                <Plus size={14} className="mr-2" /> Generate New Code
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-center p-5 bg-muted/50 rounded-lg border border-dashed">
                <div className="text-center">
                  <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1">No Code Assigned</div>
                  <div className="text-sm text-muted-foreground">Generate a personalized discount code for this rider</div>
                </div>
              </div>
              <Button
                size="sm"
                className="w-full font-heading uppercase"
                onClick={() => setShowGenerateDialog(true)}
              >
                <Plus size={14} className="mr-2" /> Generate Code
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading uppercase">Generate Discount Code</DialogTitle>
            <DialogDescription>
              This code will be locked to this rider. They'll need to enter their exact name and email when using it at registration.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-bold uppercase tracking-wider block mb-2">Discount Amount ($)</label>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              placeholder="45.00"
              value={generateAmount}
              onChange={e => setGenerateAmount(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>Cancel</Button>
            <Button
              onClick={handleGenerate}
              disabled={generating || !generateAmount || parseFloat(generateAmount) <= 0}
              className="font-heading uppercase"
            >
              {generating ? <><Loader2 size={14} className="mr-2 animate-spin" /> Generating...</> : "Generate Code"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "No expiry";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isExpired(code: DiscountCodeType): boolean {
  return !!code.expiresAt && new Date() > new Date(code.expiresAt);
}

function RiderAssignedCodesSection({ riderId }: { riderId: number }) {
  const { toast } = useToast();
  const { data: codes = [], isLoading } = useListDiscountCodes(
    { riderId },
    { query: {} as any }
  );
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const handleCopy = (code: DiscountCodeType) => {
    navigator.clipboard.writeText(code.code);
    setCopiedId(code.id);
    setTimeout(() => setCopiedId(null), 2000);
    toast({ title: "Code copied!" });
  };

  const getStatusBadge = (code: DiscountCodeType) => {
    if (!code.isActive) return <Badge variant="destructive" className="text-xs">Inactive</Badge>;
    if (isExpired(code)) return <Badge variant="destructive" className="text-xs">Expired</Badge>;
    if (code.usesCount >= code.maxUses) return <Badge variant="secondary" className="text-xs">Used</Badge>;
    return <Badge variant="default" className="text-xs bg-green-600">Active</Badge>;
  };

  return (
    <Card>
      <CardHeader className="border-b pb-4">
        <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
          <Tag className="text-primary" size={20} />
          Discount Codes
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={18} className="animate-spin text-muted-foreground" />
          </div>
        ) : (codes as DiscountCodeType[]).length === 0 ? (
          <div className="p-6 text-center text-muted-foreground">
            <Tag size={24} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">No discount codes assigned.</p>
          </div>
        ) : (
          <div className="divide-y">
            {(codes as DiscountCodeType[]).map(code => (
              <div key={code.id} className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold tracking-wider text-sm">{code.code}</span>
                    <button
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => handleCopy(code)}
                      title="Copy code"
                    >
                      {copiedId === code.id ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                    <span className="font-medium text-foreground">
                      {code.discountType === "percentage"
                        ? `${Number(code.amount).toFixed(0)}% off`
                        : `$${Number(code.amount).toFixed(2)} off`}
                    </span>
                    <span>·</span>
                    <span>Expires: {formatDate(code.expiresAt)}</span>
                    <span>·</span>
                    <span>{code.usesCount}/{code.maxUses >= 999999 ? "∞" : code.maxUses} uses</span>
                  </div>
                </div>
                <div className="shrink-0">{getStatusBadge(code)}</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function RiderDetail() {
  const [match, params] = useRoute("/riders/:riderId");
  const riderId = parseInt(params?.riderId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: rider, isLoading, isError: riderLoadFailed, error: riderLoadError, refetch: refetchRider } = useGetRider(riderId, { query: { enabled: !!riderId, retry: false } as any });
  const { data: me } = useGetMe({ query: {} as any });

  const updateMutation = useUpdateRider();
  const assignRfidMutation = useAssignRfid();

  const [isEditing, setIsEditing] = useState(false);
  const [emailExpanded, setEmailExpanded] = useState(false);
  const [rfidInput, setRfidInput] = useState("");
  const [activeTransponderInput, setActiveTransponderInput] = useState("");

  const r = rider as any;
  const clubId = (me as any)?.clubId;
  const { hasPermission } = useAuth();
  const canManageDiscountCodes = hasPermission("discount_codes");

  const form = useForm<z.infer<typeof updateRiderSchema>>({
    resolver: zodResolver(updateRiderSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      bibNumber: "",
      dateOfBirth: "",
      emergencyContact: "",
      emergencyPhone: "",
      streetAddress: "",
      city: "",
      homeState: "",
      zip: "",
      bikeManufacturer: "",
      bikeModel: "",
      bikeYear: "",
      sponsors: "",
      amaNumber: "",
      mylapsTransponderId: "",
    },
  });

  // Fill the form from the latest rider data each time editing opens (and on
  // Cancel), so a transponder/RFID assigned since the page loaded isn't reverted on Save.
  const resetFormFromRider = () => {
    if (!rider) return;
    form.reset({
      firstName: rider.firstName,
      lastName: rider.lastName,
      email: rider.email || "",
      phone: rider.phone || "",
      bibNumber: rider.bibNumber || "",
      dateOfBirth: rider.dateOfBirth || "",
      emergencyContact: rider.emergencyContact || "",
      emergencyPhone: rider.emergencyPhone || "",
      streetAddress: r.streetAddress || "",
      city: r.city || "",
      homeState: r.homeState || "",
      zip: r.zip || "",
      bikeManufacturer: r.bikeManufacturer || "",
      bikeModel: (r as any).bikeModel || "",
      bikeYear: (r as any).bikeYear || "",
      sponsors: r.sponsors || "",
      amaNumber: r.amaNumber || "",
      mylapsTransponderId: r.mylapsTransponderId || "",
    });
  };

  const startEditing = () => {
    resetFormFromRider();
    setIsEditing(true);
  };

  const cancelEditing = () => {
    resetFormFromRider();
    setIsEditing(false);
  };

  const invalidateRider = () => {
    queryClient.invalidateQueries({ queryKey: getGetRiderQueryKey(riderId) });
    queryClient.invalidateQueries({ queryKey: getListRidersQueryKey() });
  };

  const onSubmit = (data: z.infer<typeof updateRiderSchema>) => {
    updateMutation.mutate(
      { riderId, data },
      {
        onSuccess: () => {
          invalidateRider();
          setIsEditing(false);
          toast({ title: "Rider profile updated" });
        },
        onError: (err) => {
          toast({ title: "Update failed", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleAssignRfid = () => {
    if (!rfidInput) return;
    assignRfidMutation.mutate(
      { data: { riderId, rfidNumber: rfidInput } },
      {
        onSuccess: () => {
          invalidateRider();
          setRfidInput("");
          toast({ title: "RFID assigned successfully" });
        },
        onError: (err) => {
          toast({ title: "Assignment failed", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleAssignActiveTransponder = () => {
    const value = activeTransponderInput.trim();
    if (!value) return;
    updateMutation.mutate(
      { riderId, data: { mylapsTransponderId: value } },
      {
        onSuccess: () => {
          invalidateRider();
          setActiveTransponderInput("");
          toast({ title: "Active transponder assigned successfully" });
        },
        onError: (err) => {
          toast({ title: "Assignment failed", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  if (isLoading) return <div className="p-8">Loading rider...</div>;
  if (riderLoadFailed) {
    const status = (riderLoadError as { status?: number } | null)?.status;
    if (status !== 404) {
      return (
        <div className="p-8 space-y-3">
          <p className="text-destructive font-medium">
            {status === 403
              ? "You don't have access to this rider."
              : "Couldn't load this rider. Check your connection and try again."}
          </p>
          {status !== 403 && (
            <Button variant="outline" size="sm" className="font-heading uppercase" onClick={() => refetchRider()}>
              Try Again
            </Button>
          )}
          <div>
            <Link href="/riders" className="text-sm text-muted-foreground hover:text-foreground underline">Back to riders</Link>
          </div>
        </div>
      );
    }
  }
  if (!rider) return <div className="p-8">Rider not found</div>;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <Link href="/riders" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground font-medium uppercase tracking-wider mb-2">
        <ChevronLeft size={16} className="mr-1" /> Back to Database
      </Link>

      <div className="flex items-center gap-4 mb-8">
        <div className="w-16 h-16 bg-sidebar rounded-lg flex items-center justify-center text-sidebar-foreground">
          <User size={32} />
        </div>
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight">
            {rider.firstName} {rider.lastName}
          </h1>
          <div className="flex items-center gap-3 text-muted-foreground mt-1 flex-wrap">
            {rider.bibNumber && (
              <span className="font-mono bg-muted px-2 py-0.5 rounded text-sm font-bold border">Bib: {rider.bibNumber}</span>
            )}
            {(r.city || r.homeState) && (
              <span className="flex items-center gap-1 text-sm"><MapPin size={13} /> {[r.city, r.homeState].filter(Boolean).join(", ")}</span>
            )}
            {r.bikeManufacturer && (
              <span className="flex items-center gap-1 text-sm"><Bike size={13} /> {r.bikeManufacturer}</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">

          {/* Personal Information */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
              <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
                <User className="text-primary" size={20} /> Personal Information
              </CardTitle>
              {!isEditing && (
                <Button variant="outline" size="sm" onClick={startEditing}>Edit Profile</Button>
              )}
            </CardHeader>
            <CardContent className="p-6">
              {isEditing ? (
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                    {/* Name */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <FormField control={form.control} name="firstName" render={({ field }) => (
                        <FormItem><FormLabel>First Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={form.control} name="lastName" render={({ field }) => (
                        <FormItem><FormLabel>Last Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>

                    {/* Contact */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <FormField control={form.control} name="email" render={({ field }) => (
                        <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={form.control} name="phone" render={({ field }) => (
                        <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>

                    {/* Address */}
                    <FormField control={form.control} name="streetAddress" render={({ field }) => (
                      <FormItem><FormLabel>Street Address</FormLabel><FormControl><Input placeholder="123 Dirt Track Rd" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <FormField control={form.control} name="city" render={({ field }) => (
                        <FormItem><FormLabel>City</FormLabel><FormControl><Input placeholder="Tucson" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={form.control} name="homeState" render={({ field }) => (
                        <FormItem><FormLabel>State</FormLabel><FormControl><StateSelect value={field.value} onChange={field.onChange} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={form.control} name="zip" render={({ field }) => (
                        <FormItem><FormLabel>ZIP</FormLabel><FormControl><Input placeholder="85701" maxLength={10} {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>

                    {/* Basics */}
                    <FormField control={form.control} name="dateOfBirth" render={({ field }) => (
                      <FormItem><FormLabel>Date of Birth</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />

                    {/* Racing info */}
                    <div className="border-t pt-4 mt-2">
                      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Racing Info</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <FormField control={form.control} name="bikeManufacturer" render={({ field }) => (
                          <FormItem><FormLabel>Bike Manufacturer</FormLabel><FormControl><Input placeholder="Honda, KTM, Yamaha…" {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name="bibNumber" render={({ field }) => (
                          <FormItem><FormLabel>Default Bib #</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                        <FormField control={form.control} name="bikeModel" render={({ field }) => (
                          <FormItem><FormLabel>Bike Model</FormLabel><FormControl><Input placeholder="450 SX-F, CRF450R…" {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name="bikeYear" render={({ field }) => (
                          <FormItem><FormLabel>Bike Year</FormLabel><FormControl><Input placeholder="2024" maxLength={4} {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                        <FormField control={form.control} name="amaNumber" render={({ field }) => (
                          <FormItem><FormLabel>AMA #</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name="mylapsTransponderId" render={({ field }) => (
                          <FormItem><FormLabel>RM TrackR Transponder #</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>
                      <div className="mt-4">
                        <FormField control={form.control} name="sponsors" render={({ field }) => (
                          <FormItem><FormLabel>Sponsors</FormLabel><FormControl><Input placeholder="Fox Racing, Alpinestars, FMF…" {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>
                    </div>

                    {/* Emergency */}
                    <div className="border-t pt-4 mt-2">
                      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Emergency Contact</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <FormField control={form.control} name="emergencyContact" render={({ field }) => (
                          <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name="emergencyPhone" render={({ field }) => (
                          <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>
                    </div>

                    <div className="pt-4 flex justify-end gap-2">
                      <Button variant="ghost" type="button" onClick={cancelEditing}>Cancel</Button>
                      <Button type="submit" disabled={updateMutation.isPending} className="font-heading uppercase">
                        <Save size={16} className="mr-2" /> Save Profile
                      </Button>
                    </div>
                  </form>
                </Form>
              ) : (
                <div className="space-y-6">
                  {/* Contact */}
                  <div className="grid grid-cols-2 gap-y-5">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1 flex items-center gap-1">
                        EMAIL
                        {rider.email && (
                          <button
                            onClick={() => setEmailExpanded(e => !e)}
                            className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-muted-foreground/40 text-muted-foreground/60 hover:text-foreground hover:border-foreground transition-colors text-[10px] leading-none"
                            title={emailExpanded ? "Collapse" : "Show full email"}
                          >
                            {emailExpanded ? "−" : "+"}
                          </button>
                        )}
                      </div>
                      {rider.email ? (
                        emailExpanded ? (
                          <div className="font-medium break-all">{rider.email}</div>
                        ) : (
                          <div className="font-medium truncate pr-2">{rider.email}</div>
                        )
                      ) : (
                        <div className="font-medium"><span className="text-muted-foreground/50">—</span></div>
                      )}
                    </div>
                    <InfoRow label="Phone" value={rider.phone} />
                    <InfoRow label="Date of Birth" value={rider.dateOfBirth} />
                  </div>
                  <div className="border-t pt-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Address</p>
                    <div className="grid grid-cols-2 gap-y-5">
                      <InfoRow label="Street Address" value={r.streetAddress} />
                      <InfoRow label="ZIP" value={r.zip} />
                      <InfoRow label="City" value={r.city} />
                      <InfoRow label="State" value={r.homeState} />
                    </div>
                  </div>

                  {/* Racing */}
                  <div className="border-t pt-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Racing Info</p>
                    <div className="grid grid-cols-2 gap-y-5">
                      <InfoRow label="Bike Manufacturer" value={r.bikeManufacturer} />
                      <InfoRow label="Bike Model" value={(r as any).bikeModel} />
                      <InfoRow label="Bike Year" value={(r as any).bikeYear} />
                      <InfoRow label="Default Bib #" value={rider.bibNumber} />
                      <InfoRow label="AMA #" value={r.amaNumber} />
                      <InfoRow label="RM TrackR Transponder #" value={r.mylapsTransponderId} />
                      <InfoRow label="Club ID #" value={(rider as any).clubIdNumber} />
                    </div>
                    {r.sponsors && (
                      <div className="mt-5">
                        <InfoRow label="Sponsors" value={r.sponsors} />
                      </div>
                    )}
                  </div>

                  {/* Emergency */}
                  <div className="border-t pt-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Emergency Contact</p>
                    <div className="grid grid-cols-2 gap-y-5">
                      <InfoRow label="Name" value={rider.emergencyContact} />
                      <InfoRow label="Phone" value={rider.emergencyPhone} />
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Assigned Discount Codes */}
          {canManageDiscountCodes && <RiderAssignedCodesSection riderId={riderId} />}

          {/* Sponsors callout (read view) */}
          {!isEditing && r.sponsors && (
            <Card className="border-primary/20 bg-primary/5">
              <CardContent className="p-5 flex items-start gap-3">
                <Star size={18} className="text-primary mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs font-bold text-primary uppercase tracking-widest mb-1">Sponsors</div>
                  <div className="font-medium">{r.sponsors}</div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Recent Results */}
          <Card>
            <CardHeader className="border-b">
              <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
                <History className="text-primary" size={20} /> Recent Results
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {rider.recentResults && rider.recentResults.length > 0 ? (
                <div className="divide-y">
                  {rider.recentResults.map((result: RiderRecentResultView) => (
                    <div key={result.id} className="p-4 flex items-center justify-between gap-3 hover:bg-muted/30 transition-colors">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-heading font-bold text-lg">{result.raceClass}</span>
                          <OfficialResultsBadge official={!!result.official} compact />
                        </div>
                        <div className="text-sm text-muted-foreground truncate">{result.eventName || `Event ${result.eventId}`}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <Activity size={12} /> {result.motoName || `Moto ${result.motoId}`}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        {result.dns ? (
                          <Badge variant="secondary" className="font-heading uppercase">DNS</Badge>
                        ) : result.dnf ? (
                          <Badge variant="destructive" className="font-heading uppercase">DNF</Badge>
                        ) : (
                          <div className="text-2xl font-heading font-bold text-primary">{ordinal(result.position)}</div>
                        )}
                        {result.points != null && (
                          <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{result.points} PTS</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-muted-foreground">No recent race results on record.</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* RFID */}
          <Card className={rider.rfidNumber ? "border-secondary" : "border-destructive/30"}>
            <CardHeader className={`${rider.rfidNumber ? "bg-secondary/5" : "bg-destructive/5"} border-b pb-4`}>
              <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
                <Tag className={rider.rfidNumber ? "text-secondary" : "text-destructive"} size={20} />
                RFID Status
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              {rider.rfidNumber ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-center p-6 bg-secondary/10 rounded-lg border border-secondary/20">
                    <div className="text-center">
                      <div className="text-xs font-bold text-secondary uppercase tracking-widest mb-2">RFID Sticker Number</div>
                      <div className="font-mono text-xl font-bold text-secondary break-all">{rider.rfidNumber}</div>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground text-center">Used for automatic RFID check-in at events.</p>
                </div>
              ) : (
                <div className="flex items-center justify-center p-6 bg-destructive/10 rounded-lg border border-destructive/20">
                  <div className="text-center">
                    <div className="text-xs font-bold text-destructive uppercase tracking-widest mb-2">No RFID Sticker Assigned</div>
                    <div className="text-sm text-destructive/80 font-medium">Manual check-in required</div>
                  </div>
                </div>
              )}
              <div className="mt-6 pt-6 border-t space-y-3">
                <label className="text-sm font-bold uppercase tracking-wider block">Assign RFID Sticker</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Scan or enter RFID sticker number..."
                    value={rfidInput}
                    onChange={(e) => setRfidInput(e.target.value)}
                    className="font-mono"
                  />
                  <Button onClick={handleAssignRfid} disabled={!rfidInput || assignRfidMutation.isPending} className="font-heading uppercase">
                    Assign
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Active timing transponder */}
          <Card className={r.mylapsTransponderId ? "border-primary" : "border-muted"}>
            <CardHeader className={`${r.mylapsTransponderId ? "bg-primary/5" : "bg-muted/30"} border-b pb-4`}>
              <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
                <Radio className={r.mylapsTransponderId ? "text-primary" : "text-muted-foreground"} size={20} />
                RM TrackR Transponder
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <div className="flex items-center justify-center p-6 bg-muted/40 rounded-lg border">
                <div className="text-center">
                  <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">
                    Active Transponder Number
                  </div>
                  <div className="font-mono text-xl font-bold break-all">
                    {r.mylapsTransponderId || <span className="text-muted-foreground/60 text-sm font-sans">None assigned</span>}
                  </div>
                </div>
              </div>
              <div className="mt-6 pt-6 border-t space-y-3">
                <label className="text-sm font-bold uppercase tracking-wider block">
                  {r.mylapsTransponderId ? "Replace Active Transponder" : "Assign Active Transponder"}
                </label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Enter transponder number..."
                    value={activeTransponderInput}
                    onChange={(e) => setActiveTransponderInput(e.target.value)}
                    className="font-mono"
                    onKeyDown={(e) => { if (e.key === "Enter") handleAssignActiveTransponder(); }}
                  />
                  <Button
                    onClick={handleAssignActiveTransponder}
                    disabled={!activeTransponderInput.trim() || updateMutation.isPending}
                    className="font-heading uppercase"
                  >
                    {updateMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : "Assign"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Used by the Active Timing Reader. This is separate from the rider&apos;s RFID sticker number.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Discount Code */}
          {clubId && canManageDiscountCodes && (
            <DiscountCodeCard riderId={riderId} clubId={clubId} />
          )}

          {/* Waiver acknowledgment history */}
          {clubId && (
            <WaiverAcknowledgmentsCard riderId={riderId} clubId={clubId} riderName={`${r.firstName ?? ""} ${r.lastName ?? ""}`.trim()} />
          )}

          {/* Active transponder quick view */}
          {r.mylapsTransponderId && (
            <Card>
              <CardContent className="p-5 space-y-1">
                <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest">RM TrackR Transponder</div>
                <div className="font-mono text-lg font-bold">{r.mylapsTransponderId}</div>
              </CardContent>
            </Card>
          )}

          {/* AMA quick view */}
          {r.amaNumber && (
            <Card>
              <CardContent className="p-5 space-y-1">
                <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest">AMA Membership #</div>
                <div className="font-mono text-lg font-bold">{r.amaNumber}</div>
              </CardContent>
            </Card>
          )}

          {/* Club ID quick view */}
          {(rider as any).clubIdNumber && (
            <Card>
              <CardContent className="p-5 space-y-1">
                <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Club ID #</div>
                <div className="font-mono text-lg font-bold">{(rider as any).clubIdNumber}</div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
