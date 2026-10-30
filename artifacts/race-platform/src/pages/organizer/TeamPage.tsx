import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetClubSettings, usePutClubSettings } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { Settings, Plus, Trash2, RefreshCw, Flag, FileText, ListChecks, MapPin, Info, UploadCloud, X, ExternalLink, ShieldCheck, LayoutTemplate, Radio, ShoppingBag, Pencil } from "lucide-react";
import { PdfFieldEditor, type WaiverField } from "@/components/PdfFieldEditor";
import { StateSelect } from "@/components/ui/StateSelect";
import { TrackCourseMap, type LibraryTrack } from "./CourseMap";
import { RentalInventory } from "@/components/organizer/RentalInventory";
import { SellItemsManager } from "@/components/organizer/SellItems";
import { errorText, responseErrorMessage } from "@/lib/friendlyErrors";

type AdminTab = "forms" | "tracks" | "rentals" | "sell" | "classes" | "brands";
const ADMIN_TABS: Array<{ key: AdminTab; label: string; icon: typeof FileText }> = [
  { key: "forms", label: "Forms", icon: FileText },
  { key: "tracks", label: "Track Library", icon: MapPin },
  { key: "rentals", label: "Rentals", icon: Radio },
  { key: "sell", label: "Sell Items", icon: ShoppingBag },
  { key: "classes", label: "Race Classes", icon: ListChecks },
  { key: "brands", label: "Brand Contingencies", icon: Flag },
];

/** "Finish line + 2 splits", or a nudge to set one up. */
function courseSummary(course: LibraryTrack["course"]): string {
  const points = course ?? [];
  if (points.length === 0) return "No course map yet";
  const finish = points.some(p => p.role === "finish");
  const splits = points.filter(p => p.role === "split").length;
  return [finish ? "Finish line" : "No finish line", splits ? `${splits} split${splits === 1 ? "" : "s"}` : null].filter(Boolean).join(" + ");
}


function ClassDetailRow({
  cls,
  onSave,
  onDelete,
  isSaving,
}: {
  cls: { id: string; name: string; details?: string };
  /** Returns false when the change was refused (e.g. a duplicate name), keeping the editor open. */
  onSave: (id: string, changes: { name: string; details: string }) => boolean;
  onDelete: (id: string) => void;
  isSaving: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [localName, setLocalName] = useState(cls.name);
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
          title={expanded ? "Hide details" : "Rename or edit class rules"}
          aria-label={expanded ? `Hide ${cls.name} details` : `Edit ${cls.name}`}
          className={`h-7 w-7 p-0 ${expanded || cls.details ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
          onClick={() => {
            setLocalName(cls.name);
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
          title="Remove class"
          aria-label={`Remove ${cls.name}`}
        >
          <Trash2 size={14} />
        </Button>
      </div>
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <Input
            value={localName}
            onChange={e => setLocalName(e.target.value)}
            maxLength={80}
            aria-label="Class name"
            className="h-8 text-sm"
          />
          <Textarea
            rows={3}
            placeholder="Class rules, eligibility requirements, bike specs, or any other details riders should know…"
            value={localDetails}
            onChange={e => setLocalDetails(e.target.value)}
            maxLength={2000}
            aria-label={`${cls.name} rules and details`}
            className="text-sm resize-none"
          />
          <p className="text-[11px] text-muted-foreground">Renaming changes the template only. Events you already made keep their class names.</p>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => { setLocalName(cls.name); setLocalDetails(cls.details ?? ""); setExpanded(false); }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={isSaving || !localName.trim()}
              onClick={() => { if (onSave(cls.id, { name: localName, details: localDetails })) setExpanded(false); }}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Case- and spacing-insensitive name match, as the server dedupes. */
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

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
  const [tracks, setTracks] = useState<{ id: number; name: string; address: string | null; city: string | null; state: string | null; zip: string | null; course?: LibraryTrack["course"]; eventCount?: number }[]>([]);
  const [tracksError, setTracksError] = useState(false);
  // Track being edited in place (name and address).
  const [editTrack, setEditTrack] = useState<{ id: number; name: string; address: string; city: string; state: string; zip: string } | null>(null);
  const [savingTrack, setSavingTrack] = useState(false);
  // Track whose course map (finish + split readers) is open for editing.
  const [courseTrackId, setCourseTrackId] = useState<number | null>(null);
  // Which Admin section is showing (kept in the URL, e.g. /team?tab=tracks).
  const [adminTab, setAdminTab] = useState<AdminTab>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return ADMIN_TABS.some(x => x.key === t) ? (t as AdminTab) : "forms";
  });
  const selectAdminTab = (tab: AdminTab) => {
    setAdminTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
  };
  const [newTrackName, setNewTrackName] = useState("");
  const [newTrackAddress, setNewTrackAddress] = useState("");
  const [newTrackCity, setNewTrackCity] = useState("");
  const [newTrackState, setNewTrackState] = useState("");
  const [newTrackZip, setNewTrackZip] = useState("");
  const [addingTrack, setAddingTrack] = useState(false);

  // Default Classes state
  const [classes, setClasses] = useState<{ id: string; name: string; details?: string }[]>([]);
  const [newClassName, setNewClassName] = useState("");
  const [expandedClassDetails, setExpandedClassDetails] = useState<Set<string>>(new Set());

  // Brand Contingencies state
  const [brands, setBrands] = useState<string[]>([]);
  const [newBrandName, setNewBrandName] = useState("");

  // Load settings once. Saving one section refreshes the settings; reloading
  // every section then would wipe what's typed but not yet saved in another.
  const settingsLoaded = useRef(false);
  useEffect(() => {
    if (settingsData && !settingsLoaded.current) {
      settingsLoaded.current = true;
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
  const loadTracks = () => {
    fetch("/api/tracks", { credentials: "include" })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(list => { setTracks(list); setTracksError(false); })
      .catch(() => setTracksError(true));
  };

  /** The server's plain-language error from a failed response. */
  const responseError = async (res: Response) =>
    new Error(responseErrorMessage(res.status, await res.json().catch(() => null)));
  useEffect(loadTracks, []);

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
        body: JSON.stringify({
          name: trimmed,
          address: newTrackAddress.trim() || undefined,
          city: newTrackCity.trim() || undefined,
          state: newTrackState.trim() || undefined,
          zip: newTrackZip.trim() || undefined,
        }),
      });
      if (!res.ok) throw await responseError(res);
      const track = await res.json();
      setTracks(prev => [...prev, track].sort((a, b) => a.name.localeCompare(b.name)));
      setNewTrackName("");
      setNewTrackAddress("");
      setNewTrackCity("");
      setNewTrackState("");
      setNewTrackZip("");
      toast({ title: "Track added" });
    } catch (err) {
      toast({ title: "Couldn't add track", description: errorText(err), variant: "destructive" });
    } finally {
      setAddingTrack(false);
    }
  };

  const deleteTrack = async (id: number) => {
    const track = tracks.find(t => t.id === id);
    if (!track) return;
    const used = track.eventCount ?? 0;
    const warning = used > 0
      ? `Remove ${track.name}? ${used} event${used === 1 ? " uses" : "s use"} it. ${used === 1 ? "It keeps its" : "They keep their"} course map, but won't get later changes to this track.`
      : `Remove ${track.name} from your Track Library?`;
    if (!window.confirm(warning)) return;
    try {
      const res = await fetch(`/api/tracks/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok && res.status !== 404) throw await responseError(res);
      setTracks(prev => prev.filter(t => t.id !== id));
      toast({ title: "Track removed" });
    } catch (err) {
      toast({ title: "Couldn't remove track", description: errorText(err), variant: "destructive" });
    }
  };

  const saveTrackEdit = async () => {
    if (!editTrack || savingTrack) return;
    setSavingTrack(true);
    try {
      const { id, ...fields } = editTrack;
      const res = await fetch(`/api/tracks/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) throw await responseError(res);
      const saved = await res.json();
      setTracks(prev => prev.map(t => t.id === id ? { ...t, ...saved } : t).sort((a, b) => a.name.localeCompare(b.name)));
      setEditTrack(null);
      toast({ title: "Track saved" });
    } catch (err) {
      toast({ title: "Couldn't save track", description: errorText(err), variant: "destructive" });
    } finally {
      setSavingTrack(false);
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
    if (!window.confirm("Remove the liability waiver PDF and its signing fields? Waivers riders already signed are kept.")) return;
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
          toast({ title: "Error", description: err?.data?.error ?? "Couldn't save", variant: "destructive" });
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
    if (!window.confirm("Remove the acknowledgement PDF? Riders won't see it at registration.")) return;
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
    const trimmed = newClassName.trim().replace(/\s+/g, " ");
    if (!trimmed || !clubId || putSettings.isPending) return;
    if (classes.some(c => sameName(c.name, trimmed))) {
      toast({ title: "Class already added", description: `${trimmed} is already one of your classes.`, variant: "destructive" });
      return;
    }
    const updated = [...classes, { id: crypto.randomUUID(), name: trimmed }];
    setClasses(updated);
    setNewClassName("");
    putSettings.mutate(
      { clubId, data: { defaultClasses: updated } },
      {
        onError: (err: any) => {
          setClasses(classes);
          toast({ title: "Error", description: err?.data?.error ?? "Couldn't save", variant: "destructive" });
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
          toast({ title: "Error", description: err?.data?.error ?? "Couldn't save", variant: "destructive" });
        },
      }
    );
  };

  // Rename a class or update its rules, and save immediately
  const updateClass = (id: string, changes: { name: string; details: string }) => {
    const name = changes.name.trim().replace(/\s+/g, " ");
    if (!name || !clubId) return false;
    if (classes.some(c => c.id !== id && sameName(c.name, name))) {
      toast({ title: "Class already added", description: `${name} is already one of your classes.`, variant: "destructive" });
      return false;
    }
    const updated = classes.map(c => c.id === id ? { ...c, name, details: changes.details.trim() || undefined } : c);
    setClasses(updated);
    putSettings.mutate(
      { clubId, data: { defaultClasses: updated } },
      {
        onSuccess: () => toast({ title: "Class saved" }),
        onError: (err: any) => {
          setClasses(classes);
          toast({ title: "Error", description: err?.data?.error ?? "Couldn't save", variant: "destructive" });
        },
      }
    );
    return true;
  };

  // Add a new brand contingency and save immediately
  const addBrand = () => {
    const trimmed = newBrandName.trim();
    if (!trimmed || !clubId) return;
    if (brands.some(b => sameName(b, trimmed))) {
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
          toast({ title: "Error", description: err?.data?.error ?? "Couldn't save", variant: "destructive" });
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
          toast({ title: "Error", description: err?.data?.error ?? "Couldn't save", variant: "destructive" });
        },
      }
    );
  };

  return (
    <>
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <Settings size={24} className="text-primary" />
        <div>
          <h1 className="font-heading font-bold text-2xl uppercase tracking-wider">Admin</h1>
          <p className="text-sm text-muted-foreground">Club settings, waivers, default classes, and brand contingencies</p>
        </div>
      </div>

      {/* Sections, one at a time */}
      {/* All tabs always visible: they wrap on narrow screens instead of scrolling. */}
      <div role="tablist" aria-label="Admin sections" className="flex flex-wrap gap-x-1 border-b mb-6">
        {ADMIN_TABS.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={adminTab === t.key}
            onClick={() => selectAdminTab(t.key)}
            className={`flex items-center gap-1.5 px-2.5 py-2 text-xs sm:text-sm font-heading font-semibold uppercase tracking-wide whitespace-nowrap border-b-2 -mb-px transition-colors ${
              adminTab === t.key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {adminTab === "forms" && (<>
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

      </>)}

      {adminTab === "tracks" && (<>
      {/* Track Library */}
      <div className="rounded-xl border bg-card p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <MapPin size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Track Library</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Save your venues and their timing readers once. Every race and practice at a track uses its course map.</p>
          </div>
        </div>

        {tracksError && (
          <p className="text-sm text-muted-foreground mb-4">
            Couldn't load your tracks. <button className="underline" onClick={loadTracks}>Try again</button>
          </p>
        )}

        {/* Existing tracks */}
        {tracks.length > 0 && (
          <div className="space-y-2 mb-4">
            {tracks.map(track => {
              const addressLine = [track.address, track.city, track.state, track.zip].filter(Boolean).join(", ");
              if (editTrack?.id === track.id) {
                const set = (key: keyof typeof editTrack) => (value: string) => setEditTrack(prev => prev && { ...prev, [key]: value });
                return (
                  <div key={track.id} className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2">
                    <Input value={editTrack.name} onChange={e => set("name")(e.target.value)} maxLength={120} placeholder="Track / venue name *" aria-label="Track name" />
                    <Input value={editTrack.address} onChange={e => set("address")(e.target.value)} maxLength={200} placeholder="Street address" aria-label="Street address" />
                    <div className="grid grid-cols-2 gap-2">
                      <Input value={editTrack.city} onChange={e => set("city")(e.target.value)} maxLength={80} placeholder="City" aria-label="City" />
                      <Input value={editTrack.zip} onChange={e => set("zip")(e.target.value)} maxLength={20} placeholder="ZIP" aria-label="ZIP" />
                    </div>
                    <StateSelect value={editTrack.state} onChange={set("state")} placeholder="Select state…" />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setEditTrack(null)} disabled={savingTrack}>Cancel</Button>
                      <Button size="sm" className="h-8 text-xs" onClick={saveTrackEdit} disabled={savingTrack || !editTrack.name.trim()}>
                        {savingTrack ? "Saving…" : "Save"}
                      </Button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={track.id} className="flex flex-wrap items-start gap-3 rounded-lg border bg-muted/30 px-4 py-3">
                  <MapPin size={13} className="text-muted-foreground shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-[10rem]">
                    <p className="text-sm font-medium">{track.name}</p>
                    {addressLine && <p className="text-xs text-muted-foreground mt-0.5">{addressLine}</p>}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {courseSummary(track.course)}
                      {(track.eventCount ?? 0) > 0 && ` · ${track.eventCount} event${track.eventCount === 1 ? "" : "s"}`}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-xs shrink-0" onClick={() => setCourseTrackId(track.id)}>
                    <Flag size={12} /> Course map
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-primary shrink-0"
                    onClick={() => setEditTrack({ id: track.id, name: track.name, address: track.address ?? "", city: track.city ?? "", state: track.state ?? "", zip: track.zip ?? "" })}
                    title="Edit name and address"
                    aria-label={`Edit ${track.name}`}
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => deleteTrack(track.id)}
                    title="Remove track"
                    aria-label={`Remove ${track.name}`}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add track form */}
        <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add New Track</p>
          <div className="space-y-2">
            <Input
              placeholder="Track / venue name *"
              value={newTrackName}
              onChange={e => setNewTrackName(e.target.value)}
            />
            <Input
              placeholder="Street address"
              value={newTrackAddress}
              onChange={e => setNewTrackAddress(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="City"
                value={newTrackCity}
                onChange={e => setNewTrackCity(e.target.value)}
              />
              <Input
                placeholder="ZIP"
                value={newTrackZip}
                onChange={e => setNewTrackZip(e.target.value)}
              />
            </div>
            <StateSelect
              value={newTrackState}
              onChange={setNewTrackState}
              placeholder="Select state…"
            />
          </div>
          <Button
            onClick={addTrack}
            disabled={addingTrack || !newTrackName.trim()}
            className="w-full"
          >
            <Plus size={15} className="mr-1" />
            {addingTrack ? "Adding…" : "Add Track"}
          </Button>
        </div>
        {tracks.length === 0 && (
          <p className="text-xs text-muted-foreground mt-2">No tracks yet — add your first venue above.</p>
        )}
      </div>

      {/* A track's course map: finish-line reader and split readers */}
      <Dialog open={courseTrackId != null} onOpenChange={open => { if (!open) setCourseTrackId(null); }}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          {(() => {
            const track = tracks.find(t => t.id === courseTrackId);
            if (!track) return null;
            return (
              <div className="space-y-2">
                <DialogTitle className="font-heading font-bold uppercase tracking-wider text-lg">{track.name}: Course Map</DialogTitle>
                <TrackCourseMap key={track.id} track={track} onSaved={loadTracks} />
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      </>)}

      {adminTab === "rentals" && <RentalInventory />}

      {adminTab === "sell" && <SellItemsManager />}

      {adminTab === "classes" && (<>
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
                onSave={updateClass}
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

      </>)}

      {adminTab === "brands" && (<>
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
                  aria-label={`Remove ${brand}`}
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
      </>)}

    </div>

    {/* ── Liability Waiver Field Editor ── */}
    <Dialog open={showFieldEditor} onOpenChange={(open) => { if (!open && !fieldsSaving) setShowFieldEditor(false); }}>
      <DialogContent className="max-w-[96vw] w-[96vw] h-[94vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">Place signing fields on the liability waiver</DialogTitle>
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
