import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetClubSettings, usePutClubSettings } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { Settings, Plus, Trash2, RefreshCw, Flag, FileText, ListChecks, MapPin, Info, UploadCloud, X, ExternalLink, ShieldCheck, LayoutTemplate } from "lucide-react";
import { PdfFieldEditor, type WaiverField } from "@/components/PdfFieldEditor";


function ClassDetailRow({
  cls,
  onSave,
  onDelete,
  isSaving,
}: {
  cls: { id: string; name: string; details?: string };
  onSave: (id: string, details: string) => void;
  onDelete: (id: string) => void;
  isSaving: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [localDetails, setLocalDetails] = useState(cls.details ?? "");

  return (
    <div className="rounded-lg border bg-muted/30">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <span className="flex-1 text-sm font-medium">{cls.name}</span>
        {cls.details && !expanded && (
          <span className="text-xs text-muted-foreground italic truncate max-w-[180px]">{cls.details}</span>
        )}
        <Button
          size="sm"
          variant="ghost"
          title={expanded ? "Hide details" : "Add / edit class rules"}
          className={`h-7 w-7 p-0 ${expanded || cls.details ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
          onClick={() => {
            setLocalDetails(cls.details ?? "");
            setExpanded(e => !e);
          }}
        >
          <Info size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
          onClick={() => onDelete(cls.id)}
          disabled={isSaving}
        >
          <Trash2 size={14} />
        </Button>
      </div>
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <Textarea
            rows={3}
            placeholder="Class rules, eligibility requirements, bike specs, or any other details riders should know…"
            value={localDetails}
            onChange={e => setLocalDetails(e.target.value)}
            className="text-sm resize-none"
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => { setLocalDetails(cls.details ?? ""); setExpanded(false); }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={isSaving}
              onClick={() => { onSave(cls.id, localDetails); setExpanded(false); }}
            >
              Save Details
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TeamPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const clubId = user?.clubId ?? 0;
  const queryClient = useQueryClient();

  const { data: settingsData, queryKey: settingsQueryKey } = useGetClubSettings(clubId, { query: { enabled: !!clubId } as any });

  const putSettings = usePutClubSettings();

  // Rider Acknowledgement state
  const [ackText, setAckText] = useState("");
  const [ackSaving, setAckSaving] = useState(false);
  const [ackMode, setAckMode] = useState<"text" | "pdf">("text");
  const [pdfUploading, setPdfUploading] = useState(false);
  const [waiverPdfUrl, setWaiverPdfUrl] = useState<string | null>(null);
  const pdfFileInputRef = useRef<HTMLInputElement>(null);
  // Liability Waiver PDF state
  const [liabilityWaiverPdfUrl, setLiabilityWaiverPdfUrl] = useState<string | null>(null);
  const [liabilityWaiverPdfUploading, setLiabilityWaiverPdfUploading] = useState(false);
  const liabilityWaiverPdfFileInputRef = useRef<HTMLInputElement>(null);
  // Field editor state
  const [liabilityWaiverFields, setLiabilityWaiverFields] = useState<WaiverField[]>([]);
  const [showFieldEditor, setShowFieldEditor] = useState(false);
  const [fieldsSaving, setFieldsSaving] = useState(false);

  // Track Library state
  const [tracks, setTracks] = useState<{ id: number; name: string; state: string | null }[]>([]);
  const [newTrackName, setNewTrackName] = useState("");
  const [addingTrack, setAddingTrack] = useState(false);

  // Default Classes state
  const [classes, setClasses] = useState<{ id: string; name: string; details?: string }[]>([]);
  const [newClassName, setNewClassName] = useState("");
  const [expandedClassDetails, setExpandedClassDetails] = useState<Set<string>>(new Set());

  // Brand Contingencies state
  const [brands, setBrands] = useState<string[]>([]);
  const [newBrandName, setNewBrandName] = useState("");

  // Load settings on mount
  useEffect(() => {
    if (settingsData) {
      setAckText(settingsData.riderAcknowledgement ?? "");
      const pdfUrl = (settingsData as any).waiverPdfUrl ?? null;
      setWaiverPdfUrl(pdfUrl);
      if (pdfUrl && !settingsData.riderAcknowledgement) setAckMode("pdf");
      setLiabilityWaiverPdfUrl((settingsData as any).liabilityWaiverPdfUrl ?? null);
      setLiabilityWaiverFields(((settingsData as any).liabilityWaiverFields as WaiverField[]) ?? []);
      setClasses((settingsData.defaultClasses as { id: string; name: string }[]) ?? []);
      setBrands(((settingsData as any).brandContingencies as string[]) ?? []);
    }
  }, [settingsData]);

  // Load track library
  useEffect(() => {
    fetch("/api/tracks", { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then(setTracks)
      .catch(() => {});
  }, []);

  // Track Library functions
  const addTrack = async () => {
    const trimmed = newTrackName.trim();
    if (!trimmed || addingTrack) return;
    setAddingTrack(true);
    try {
      const res = await fetch("/api/tracks", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error();
      const track = await res.json();
      setTracks(prev => [...prev, track].sort((a, b) => a.name.localeCompare(b.name)));
      setNewTrackName("");
      toast({ title: "Track added" });
    } catch {
      toast({ title: "Failed to add track", variant: "destructive" });
    } finally {
      setAddingTrack(false);
    }
  };

  const deleteTrack = async (id: number) => {
    try {
      await fetch(`/api/tracks/${id}`, { method: "DELETE", credentials: "include" });
      setTracks(prev => prev.filter(t => t.id !== id));
      toast({ title: "Track removed" });
    } catch {
      toast({ title: "Failed to remove track", variant: "destructive" });
    }
  };

  // Upload liability waiver PDF
  const uploadLiabilityWaiverPdf = async (file: File) => {
    if (!clubId || liabilityWaiverPdfUploading) return;
    setLiabilityWaiverPdfUploading(true);
    try {
      const res = await fetch("/api/storage/uploads/file", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/pdf",
          "x-file-name": file.name,
          "x-content-type": "application/pdf",
        },
        body: file,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { objectPath } = await res.json();
      const serveUrl = `/api/storage${objectPath}`;
      setLiabilityWaiverPdfUrl(serveUrl);
      putSettings.mutate(
        { clubId, data: { liabilityWaiverPdfUrl: serveUrl } as any },
        {
          onSuccess: () => toast({ title: "PDF uploaded", description: "Liability waiver PDF saved successfully." }),
          onError: () => toast({ title: "Error saving PDF URL", variant: "destructive" }),
        }
      );
    } catch {
      toast({ title: "Upload failed", description: "Could not upload the PDF. Please try again.", variant: "destructive" });
    } finally {
      setLiabilityWaiverPdfUploading(false);
    }
  };

  // Remove liability waiver PDF
  const removeLiabilityWaiverPdf = () => {
    if (!clubId) return;
    setLiabilityWaiverPdfUrl(null);
    setLiabilityWaiverFields([]);
    putSettings.mutate(
      { clubId, data: { liabilityWaiverPdfUrl: null, liabilityWaiverFields: null } as any },
      {
        onSuccess: () => toast({ title: "PDF removed" }),
        onError: () => toast({ title: "Error removing PDF", variant: "destructive" }),
      }
    );
  };

  // Save field layout from the field editor
  const saveLiabilityWaiverFields = (fields: WaiverField[]) => {
    if (!clubId) return;
    setFieldsSaving(true);
    putSettings.mutate(
      { clubId, data: { liabilityWaiverFields: fields } as any },
      {
        onSuccess: () => {
          setLiabilityWaiverFields(fields);
          setShowFieldEditor(false);
          toast({ title: "Field layout saved", description: `${fields.length} signing field${fields.length !== 1 ? "s" : ""} saved to the waiver.` });
        },
        onError: () => toast({ title: "Error saving field layout", variant: "destructive" }),
        onSettled: () => setFieldsSaving(false),
      }
    );
  };

  // Save rider acknowledgement text
  const saveAck = () => {
    if (!clubId) return;
    setAckSaving(true);
    putSettings.mutate(
      { clubId, data: { riderAcknowledgement: ackText } },
      {
        onSuccess: () => {
          toast({ title: "Saved", description: "Rider acknowledgement form saved." });
        },
        onError: (err: any) => {
          toast({ title: "Error", description: err?.data?.error ?? "Failed to save", variant: "destructive" });
        },
        onSettled: () => setAckSaving(false),
      }
    );
  };

  // Upload waiver PDF
  const uploadWaiverPdf = async (file: File) => {
    if (!clubId || pdfUploading) return;
    setPdfUploading(true);
    try {
      const res = await fetch("/api/storage/uploads/file", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/pdf",
          "x-file-name": file.name,
          "x-content-type": "application/pdf",
        },
        body: file,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { objectPath } = await res.json();
      const serveUrl = `/api/storage${objectPath}`;
      setWaiverPdfUrl(serveUrl);
      putSettings.mutate(
        { clubId, data: { waiverPdfUrl: serveUrl } as any },
        {
          onSuccess: () => toast({ title: "PDF uploaded", description: "Waiver PDF saved successfully." }),
          onError: () => toast({ title: "Error saving PDF URL", variant: "destructive" }),
        }
      );
    } catch {
      toast({ title: "Upload failed", description: "Could not upload the PDF. Please try again.", variant: "destructive" });
    } finally {
      setPdfUploading(false);
    }
  };

  // Remove waiver PDF
  const removeWaiverPdf = () => {
    if (!clubId) return;
    setWaiverPdfUrl(null);
    putSettings.mutate(
      { clubId, data: { waiverPdfUrl: null } as any },
      {
        onSuccess: () => toast({ title: "PDF removed" }),
        onError: () => toast({ title: "Error removing PDF", variant: "destructive" }),
      }
    );
  };

  // Add a new default class and save immediately
  const addClass = () => {
    const trimmed = newClassName.trim();
    if (!trimmed || !clubId) return;
    const updated = [...classes, { id: crypto.randomUUID(), name: trimmed }];
    setClasses(updated);
    setNewClassName("");
    putSettings.mutate(
      { clubId, data: { defaultClasses: updated } },
      {
        onError: (err: any) => {
          setClasses(classes);
          toast({ title: "Error", description: err?.data?.error ?? "Failed to save", variant: "destructive" });
        },
      }
    );
  };

  // Delete a class and save immediately
  const deleteClass = (id: string) => {
    const updated = classes.filter((c) => c.id !== id);
    setClasses(updated);
    setExpandedClassDetails(prev => { const next = new Set(prev); next.delete(id); return next; });
    if (!clubId) return;
    putSettings.mutate(
      { clubId, data: { defaultClasses: updated } },
      {
        onError: (err: any) => {
          setClasses(classes);
          toast({ title: "Error", description: err?.data?.error ?? "Failed to save", variant: "destructive" });
        },
      }
    );
  };

  // Update class details and save immediately
  const updateClassDetails = (id: string, details: string) => {
    const updated = classes.map(c => c.id === id ? { ...c, details: details.trim() || undefined } : c);
    setClasses(updated);
    if (!clubId) return;
    putSettings.mutate(
      { clubId, data: { defaultClasses: updated } },
      {
        onSuccess: () => toast({ title: "Details saved" }),
        onError: (err: any) => {
          setClasses(classes);
          toast({ title: "Error", description: err?.data?.error ?? "Failed to save", variant: "destructive" });
        },
      }
    );
  };

  // Add a new brand contingency and save immediately
  const addBrand = () => {
    const trimmed = newBrandName.trim();
    if (!trimmed || !clubId) return;
    if (brands.includes(trimmed)) {
      toast({ title: "Brand already exists", variant: "destructive" });
      return;
    }
    const updated = [...brands, trimmed];
    setBrands(updated);
    setNewBrandName("");
    putSettings.mutate(
      { clubId, data: { brandContingencies: updated } as any },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(settingsQueryKey, data);
        },
        onError: (err: any) => {
          setBrands(brands);
          toast({ title: "Error", description: err?.data?.error ?? "Failed to save", variant: "destructive" });
        },
      }
    );
  };

  // Remove a brand and save immediately
  const deleteBrand = (brand: string) => {
    const updated = brands.filter(b => b !== brand);
    setBrands(updated);
    if (!clubId) return;
    putSettings.mutate(
      { clubId, data: { brandContingencies: updated } as any },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(settingsQueryKey, data);
        },
        onError: (err: any) => {
          setBrands(brands);
          toast({ title: "Error", description: err?.data?.error ?? "Failed to save", variant: "destructive" });
        },
      }
    );
  };

  return (
    <>
    <div className="p-6 max-w-4xl mx-auto">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <Settings size={24} className="text-primary" />
        <div>
          <h1 className="font-heading font-bold text-2xl uppercase tracking-wider">Admin</h1>
          <p className="text-sm text-muted-foreground">Club settings, waivers, default classes, and brand contingencies</p>
        </div>
      </div>

      {/* Rider Acknowledgement Form */}
      <div className="rounded-xl border bg-card p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <FileText size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Rider Acknowledgement Form</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Custom rules or waiver text shown to riders at registration</p>
          </div>
        </div>

        {/* Mode tabs */}
        <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit mb-4">
          <button
            type="button"
            onClick={() => setAckMode("text")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${ackMode === "text" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            Type Text
          </button>
          <button
            type="button"
            onClick={() => setAckMode("pdf")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${ackMode === "pdf" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            Upload PDF
          </button>
        </div>

        {ackMode === "text" && (
          <>
            <Textarea
              placeholder="Type your club rules, waiver, or acknowledgement text here…"
              className="min-h-[140px] resize-y font-mono text-sm"
              value={ackText}
              onChange={(e) => setAckText(e.target.value)}
            />
            <div className="flex justify-end mt-3">
              <Button onClick={saveAck} disabled={ackSaving || putSettings.isPending}>
                {ackSaving ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        )}

        {ackMode === "pdf" && (
          <div className="space-y-4">
            {waiverPdfUrl ? (
              <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3">
                <FileText size={16} className="text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">Waiver PDF uploaded</p>
                  <a
                    href={waiverPdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline flex items-center gap-1 mt-0.5"
                  >
                    <ExternalLink size={11} /> View / download PDF
                  </a>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={removeWaiverPdf}
                  title="Remove PDF"
                >
                  <X size={14} />
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border-2 border-dashed border-border p-6 text-center space-y-3">
                <UploadCloud size={28} className="mx-auto text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Upload your waiver as a PDF</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Max 20 MB · PDF only</p>
                </div>
                <input
                  ref={pdfFileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadWaiverPdf(file);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pdfUploading}
                  onClick={() => pdfFileInputRef.current?.click()}
                >
                  {pdfUploading ? (
                    <><RefreshCw size={14} className="mr-2 animate-spin" /> Uploading…</>
                  ) : (
                    <><UploadCloud size={14} className="mr-2" /> Choose PDF</>
                  )}
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Riders will see a link to view this PDF and must acknowledge it before completing registration.
            </p>
          </div>
        )}
      </div>

      {/* Liability Waiver */}
      <div className="rounded-xl border bg-card p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <ShieldCheck size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Liability Waiver</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Full release-of-liability waiver — riders must type their name to e-sign before registering</p>
          </div>
        </div>

        <div className="space-y-4">
          {liabilityWaiverPdfUrl ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3">
                <FileText size={16} className="text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">Liability Waiver PDF uploaded</p>
                  <a
                    href={liabilityWaiverPdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline flex items-center gap-1 mt-0.5"
                  >
                    <ExternalLink size={11} /> View / download PDF
                  </a>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-xs shrink-0"
                  onClick={() => setShowFieldEditor(true)}
                >
                  <LayoutTemplate size={13} />
                  {liabilityWaiverFields.length > 0
                    ? `Edit Fields (${liabilityWaiverFields.length})`
                    : "Place Signing Fields"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={removeLiabilityWaiverPdf}
                  title="Remove PDF"
                >
                  <X size={14} />
                </Button>
              </div>

              {liabilityWaiverFields.length > 0 && (
                <div className="flex flex-wrap gap-2 px-1">
                  {["name","email","date","signature"].map(type => {
                    const count = liabilityWaiverFields.filter(f => f.type === type).length;
                    if (!count) return null;
                    const colors: Record<string,string> = { name:"#3b82f6", email:"#8b5cf6", date:"#10b981", signature:"#ef4444" };
                    const labels: Record<string,string> = { name:"Rider Name", email:"Rider Email", date:"Date", signature:"Signature" };
                    return (
                      <span key={type} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border" style={{ borderColor: colors[type]+"50", backgroundColor: colors[type]+"10", color: colors[type] }}>
                        <span style={{ width:7, height:7, borderRadius:2, backgroundColor: colors[type], display:"inline-block" }} />
                        {count}× {labels[type]}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border-2 border-dashed border-border p-6 text-center space-y-3">
              <UploadCloud size={28} className="mx-auto text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Upload your liability waiver as a PDF</p>
                <p className="text-xs text-muted-foreground mt-0.5">Max 20 MB · PDF only</p>
              </div>
              <input
                ref={liabilityWaiverPdfFileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadLiabilityWaiverPdf(file);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={liabilityWaiverPdfUploading}
                onClick={() => liabilityWaiverPdfFileInputRef.current?.click()}
              >
                {liabilityWaiverPdfUploading ? (
                  <><RefreshCw size={14} className="mr-2 animate-spin" /> Uploading…</>
                ) : (
                  <><UploadCloud size={14} className="mr-2" /> Choose PDF</>
                )}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Once saved, enable per-event on the Event Settings page under "Require liability waiver e-signature".
            Riders will view the PDF and must type their full legal name to e-sign.
            Each signature is stored with a SHA-256 document hash, signer IP, browser, and timestamp.
            A signed copy is automatically emailed to the rider.
          </p>
        </div>
      </div>

      {/* Track Library */}
      <div className="rounded-xl border bg-card p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <MapPin size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Track Library</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Save your venues here — pick one when starting a practice session</p>
          </div>
        </div>

        {/* Existing tracks */}
        {tracks.length > 0 && (
          <div className="space-y-2 mb-4">
            {tracks.map(track => (
              <div key={track.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-2.5">
                <MapPin size={13} className="text-muted-foreground shrink-0" />
                <span className="flex-1 text-sm font-medium">{track.name}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => deleteTrack(track.id)}
                  title="Remove track"
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Add track form */}
        <div className="flex gap-2">
          <Input
            placeholder="e.g. Thunder Valley MX"
            value={newTrackName}
            onChange={e => setNewTrackName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addTrack()}
            className="flex-1"
          />
          <Button onClick={addTrack} disabled={addingTrack || !newTrackName.trim()}>
            <Plus size={15} className="mr-1" />
            Add
          </Button>
        </div>
        {tracks.length === 0 && (
          <p className="text-xs text-muted-foreground mt-2">No tracks yet — add your first venue above.</p>
        )}
      </div>

      {/* Default Race Classes */}
      <div className="rounded-xl border bg-card p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <ListChecks size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Default Race Classes</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Reusable class templates for your events (e.g. 125cc Class A, 250cc Class B)</p>
          </div>
        </div>

        {/* Class list */}
        {classes.length > 0 && (
          <div className="space-y-2 mb-4">
            {classes.map((cls) => (
              <ClassDetailRow
                key={cls.id}
                cls={cls}
                onSave={updateClassDetails}
                onDelete={deleteClass}
                isSaving={putSettings.isPending}
              />
            ))}
          </div>
        )}

        {/* Add new class */}
        <div className="flex gap-2">
          <Input
            placeholder="Class name (e.g. 125cc Class A)"
            value={newClassName}
            onChange={(e) => setNewClassName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addClass()}
            className="flex-1"
          />
          <Button
            onClick={addClass}
            disabled={!newClassName.trim() || putSettings.isPending}
            variant="outline"
          >
            <Plus size={16} className="mr-1.5" />
            Add Class
          </Button>
        </div>

        {classes.length === 0 && (
          <p className="text-xs text-muted-foreground mt-3">No classes yet. Add your first default race class above.</p>
        )}
      </div>

      {/* Brand Contingencies */}
      <div className="rounded-xl border bg-card p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Flag size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Brand Contingencies</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Brands you may offer contingency sponsorships with (e.g. Yamaha, Honda, Fox Racing)</p>
          </div>
        </div>

        {brands.length > 0 && (
          <div className="space-y-2 mb-4">
            {brands.map(brand => (
              <div key={brand} className="rounded-lg border bg-muted/30 flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1 text-sm font-medium">{brand}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  onClick={() => deleteBrand(brand)}
                  disabled={putSettings.isPending}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Input
            placeholder="Brand name (e.g. Yamaha, Fox Racing)"
            value={newBrandName}
            onChange={e => setNewBrandName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addBrand()}
            className="flex-1"
          />
          <Button
            onClick={addBrand}
            disabled={!newBrandName.trim() || putSettings.isPending}
            variant="outline"
          >
            <Plus size={16} className="mr-1.5" />
            Add Brand
          </Button>
        </div>

        {brands.length === 0 && (
          <p className="text-xs text-muted-foreground mt-3">No brands yet. Add the brands you partner with for contingencies.</p>
        )}
      </div>

    </div>

    {/* ── Liability Waiver Field Editor ── */}
    <Dialog open={showFieldEditor} onOpenChange={(open) => { if (!open && !fieldsSaving) setShowFieldEditor(false); }}>
      <DialogContent className="max-w-[96vw] w-[96vw] h-[94vh] flex flex-col p-0 gap-0 overflow-hidden">
        {liabilityWaiverPdfUrl && (
          <PdfFieldEditor
            url={liabilityWaiverPdfUrl}
            initialFields={liabilityWaiverFields}
            onSave={saveLiabilityWaiverFields}
            onCancel={() => setShowFieldEditor(false)}
          />
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
