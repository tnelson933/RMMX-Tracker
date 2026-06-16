import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import {
  useGetClubDashboard,
  useGetClub,
  useUpdateClub,
  useUpdateMe,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Calendar, Users, CheckCircle, Plus, Tag, Activity,
  Upload, ImageIcon, Loader2, X, Sparkles, Save, Building2, LayoutDashboard, Mail, Copy, ClipboardCheck,
  Cloud, CloudOff, RefreshCw, AlertTriangle,
} from "lucide-react";
import { Link } from "wouter";
import { format, parseISO, formatDistanceToNow } from "date-fns";

interface SyncState {
  enabled: boolean;
  cloudUrl: string | null;
  clubId: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  rowsSynced: Record<string, number> | null;
}

function SyncStatusBanner({ syncStatus, loading }: { syncStatus: SyncState | null; loading: boolean }) {
  if (!syncStatus) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 flex items-center gap-3 text-muted-foreground">
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          <span className="text-sm font-medium">Checking cloud sync status…</span>
        </CardContent>
      </Card>
    );
  }

  const { enabled, cloudUrl, lastSuccessAt, lastAttemptAt, lastError, rowsSynced } = syncStatus;

  if (!enabled) {
    return (
      <Card className="border-dashed border-muted-foreground/30">
        <CardContent className="p-4 flex items-center gap-3 text-muted-foreground">
          <CloudOff size={16} />
          <div>
            <span className="text-sm font-medium">Auto-sync disabled</span>
            <span className="text-xs text-muted-foreground ml-2">Running in local-only mode — data is not being pushed to the cloud.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasSynced = !!lastSuccessAt;
  const isError = !!lastError && (!hasSynced || (lastAttemptAt && lastSuccessAt && lastAttemptAt > lastSuccessAt));

  let timeAgo: string | null = null;
  if (lastSuccessAt) {
    try { timeAgo = formatDistanceToNow(new Date(lastSuccessAt), { addSuffix: true }); } catch { /* ignore */ }
  }

  const totalRows = rowsSynced
    ? Object.values(rowsSynced).reduce((sum, n) => sum + n, 0)
    : null;

  const rowBreakdown = rowsSynced && Object.keys(rowsSynced).length > 0
    ? Object.entries(rowsSynced)
        .filter(([, n]) => n > 0)
        .map(([table, n]) => `${n.toLocaleString()} ${table}`)
        .join(", ")
    : null;

  if (isError) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardContent className="p-4 flex items-start gap-3">
          <AlertTriangle size={16} className="text-destructive mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold uppercase tracking-wider text-destructive font-heading">Sync Error</span>
              {loading && <RefreshCw size={12} className="animate-spin text-muted-foreground" />}
            </div>
            <p className="text-xs text-destructive/80 mt-0.5 truncate max-w-lg">{lastError}</p>
            {timeAgo && (
              <p className="text-xs text-muted-foreground mt-1">
                Last successful sync {timeAgo}
                {totalRows != null ? ` · ${totalRows.toLocaleString()} rows` : ""}
              </p>
            )}
            {cloudUrl && <p className="text-xs text-muted-foreground mt-0.5 truncate">→ {cloudUrl}</p>}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-green-500/30 bg-green-500/5">
      <CardContent className="p-4 flex items-center gap-3">
        <Cloud size={16} className="text-green-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold uppercase tracking-wider text-green-700 font-heading">Cloud Synced</span>
            {loading && <RefreshCw size={12} className="animate-spin text-muted-foreground" />}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
            {timeAgo && <span className="text-xs text-muted-foreground">Last sync {timeAgo}</span>}
            {totalRows != null && (
              <span className="text-xs text-muted-foreground" title={rowBreakdown ?? undefined}>
                {totalRows.toLocaleString()} rows synced
              </span>
            )}
            {cloudUrl && <span className="text-xs text-muted-foreground truncate max-w-xs">→ {cloudUrl}</span>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const isDesktop = typeof (window as any).electronAPI !== "undefined";
  const queryClient = useQueryClient();
  const clubId = user?.clubId;

  // ── Local-mode sync status ────────────────────────────────────────────────
  const [isLocalMode, setIsLocalMode] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<SyncState | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function checkMode() {
      try {
        const res = await fetch("/api/healthz", { credentials: "include" });
        if (!res.ok || cancelled) return;
        const data = await res.json() as { mode?: string };
        if (data.mode === "local" && !cancelled) {
          setIsLocalMode(true);
          fetchSyncStatus();
          intervalId = setInterval(fetchSyncStatus, 30_000);
        }
      } catch {
        // not local mode or unreachable — stay hidden
      }
    }

    async function fetchSyncStatus() {
      if (cancelled) return;
      setSyncLoading(true);
      try {
        const res = await fetch("/api/status", { credentials: "include" });
        if (!res.ok || cancelled) return;
        const data = await res.json() as { autoSync: SyncState };
        if (!cancelled) setSyncStatus(data.autoSync);
      } catch {
        // silent — keep last known state
      } finally {
        if (!cancelled) setSyncLoading(false);
      }
    }

    checkMode();
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  const { data: dashboard, isLoading } = useGetClubDashboard(clubId || 0, {
    query: { enabled: !!clubId } as any,
  });

  const { data: club, refetch: refetchClub } = useGetClub(clubId || 0, {
    query: { enabled: !!clubId } as any,
  });

  const { mutateAsync: updateClub } = useUpdateClub();
  const { mutateAsync: updateMe } = useUpdateMe();

  // ── Logo upload ──────────────────────────────────────────────────────────
  const [uploadState, setUploadState] = useState<"idle" | "processing" | "uploading" | "done" | "error">("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeBg, setRemoveBg] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !clubId) return;
    setUploadState("processing");
    let processedBlob: Blob = file;
    let processedName = file.name.replace(/\.[^.]+$/, ".png");
    if (removeBg) {
      try {
        const { removeBackground } = await import("@imgly/background-removal");
        const result = await removeBackground(file);
        processedBlob = result;
        setPreviewUrl(URL.createObjectURL(result));
      } catch {
        setPreviewUrl(URL.createObjectURL(file));
        processedBlob = file;
        processedName = file.name;
      }
    } else {
      setPreviewUrl(URL.createObjectURL(file));
      processedBlob = file;
      processedName = file.name;
    }
    setUploadState("uploading");
    try {
      const uploadRes = await fetch("/api/storage/uploads/file", {
        method: "POST",
        headers: { "Content-Type": "image/png", "x-file-name": processedName, "x-content-type": "image/png" },
        credentials: "include",
        body: processedBlob,
      });
      if (!uploadRes.ok) throw new Error("Failed to upload");
      const { objectPath } = await uploadRes.json() as { objectPath: string };
      await updateClub({ clubId, data: { logoUrl: `/api/storage${objectPath}` } });
      await refetchClub();
      setUploadState("done");
    } catch {
      setUploadState("error");
      setPreviewUrl(null);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemoveLogo = async () => {
    if (!clubId) return;
    await updateClub({ clubId, data: { logoUrl: "" } });
    await refetchClub();
    setPreviewUrl(null);
    setUploadState("idle");
  };

  const currentLogo = previewUrl || club?.logoUrl || null;

  // ── Profile form ─────────────────────────────────────────────────────────
  const [organizerName, setOrganizerName] = useState(user?.name || "");
  const [clubName, setClubName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [description, setDescription] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [clubIdCopied, setClubIdCopied] = useState(false);
  const handleCopyClubId = () => {
    if (!clubId) return;
    navigator.clipboard.writeText(String(clubId)).then(() => {
      setClubIdCopied(true);
      setTimeout(() => setClubIdCopied(false), 2000);
    });
  };

  useEffect(() => {
    if (club) {
      setClubName(club.name || "");
      setContactEmail((club as any).contactEmail || "");
      setContactPhone((club as any).contactPhone || "");
      setWebsite((club as any).website || "");
      setDescription((club as any).description || "");
    }
  }, [club]);

  useEffect(() => {
    if (user?.name) setOrganizerName(user.name);
  }, [user?.name]);

  const handleSaveProfile = async () => {
    if (!clubId) return;
    setProfileSaving(true);
    setProfileSaved(false);
    setProfileError("");
    try {
      await Promise.all([
        updateMe({ data: { name: organizerName } }),
        updateClub({
          clubId,
          data: {
            name: clubName,
            contactEmail,
            contactPhone,
            website,
            description,
          },
        }),
      ]);
      await refetchClub();
      await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 3000);
    } catch {
      setProfileError("Failed to save — please try again.");
    } finally {
      setProfileSaving(false);
    }
  };

  if (isLoading) return <div className="p-8">Loading dashboard...</div>;
  if (!clubId) return <div className="p-8">No club associated with your account.</div>;

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      {/* Page header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">{club?.name || "Club"} — organizer portal</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/events">
            <Button className="font-heading uppercase tracking-wider">
              <Plus size={16} className="mr-2" /> New Event
            </Button>
          </Link>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="mb-2">
          <TabsTrigger value="overview" className="font-heading uppercase tracking-wider gap-2">
            <LayoutDashboard size={14} /> Overview
          </TabsTrigger>
          <TabsTrigger value="profile" className="font-heading uppercase tracking-wider gap-2">
            <Building2 size={14} /> Club Profile
          </TabsTrigger>
        </TabsList>

        {/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-8 mt-4">
          {/* Cloud Sync Status — only shown in local mode */}
          {isLocalMode && (
            <SyncStatusBanner syncStatus={syncStatus} loading={syncLoading} />
          )}

          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-6">
            <Card className="border-sidebar-border bg-sidebar text-sidebar-foreground">
              <CardContent className="p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-sidebar-foreground/70 uppercase tracking-widest mb-1">Upcoming Events</p>
                  <h2 className="text-4xl font-heading font-bold">{dashboard?.upcomingEvents || 0}</h2>
                </div>
                <div className="h-12 w-12 rounded-full bg-primary/20 flex items-center justify-center text-primary">
                  <Calendar size={24} />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Total Riders</p>
                  <h2 className="text-4xl font-heading font-bold">{dashboard?.totalRiders || 0}</h2>
                </div>
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                  <Users size={24} />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Registrations</p>
                  <h2 className="text-4xl font-heading font-bold">{dashboard?.totalRegistrations || 0}</h2>
                </div>
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                  <Tag size={24} />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Unique Registrants</p>
                  <h2 className="text-4xl font-heading font-bold">{dashboard?.uniqueRegistrations ?? 0}</h2>
                  <p className="text-xs text-muted-foreground mt-1">distinct emails</p>
                </div>
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                  <Mail size={24} />
                </div>
              </CardContent>
            </Card>
            <Card className="border-secondary bg-secondary/5">
              <CardContent className="p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-secondary uppercase tracking-widest mb-1">Total Checked In</p>
                  <h2 className="text-4xl font-heading font-bold text-secondary">{dashboard?.checkedInToday || 0}</h2>
                </div>
                <div className="h-12 w-12 rounded-full bg-secondary/20 flex items-center justify-center text-secondary">
                  <CheckCircle size={24} />
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
            <div className="xl:col-span-2 space-y-6">
              <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
                <Calendar className="text-primary" /> Upcoming Events
              </h2>
              <div className="space-y-4">
                {dashboard?.upcomingEventList?.length ? (
                  dashboard.upcomingEventList.map(event => (
                    <Link key={event.id} href={`/events/${event.id}`}>
                      <Card className="hover:border-primary transition-colors cursor-pointer hover-elevate">
                        <CardContent className="p-4 flex items-center justify-between">
                          <div className="flex items-center gap-4">
                            <div className="bg-muted px-4 py-2 rounded text-center min-w-16">
                              <div className="text-xs font-bold text-muted-foreground uppercase">{format(parseISO(event.date.substring(0, 10)), 'MMM')}</div>
                              <div className="text-xl font-heading font-bold">{format(parseISO(event.date.substring(0, 10)), 'dd')}</div>
                            </div>
                            <div>
                              <h3 className="font-heading font-bold text-xl uppercase">{event.name}</h3>
                              <p className="text-sm text-muted-foreground">{event.trackName || event.location}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="inline-block bg-primary/10 text-primary px-2 py-1 rounded text-xs font-bold uppercase tracking-wider">
                              {event.status.replace('_', ' ')}
                            </span>
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  ))
                ) : (
                  <Card>
                    <CardContent className="p-8 text-center text-muted-foreground">No upcoming events.</CardContent>
                  </Card>
                )}
              </div>
            </div>

            <div className="space-y-6">
              <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
                <Activity className="text-primary" /> Recent Activity
              </h2>
              <Card>
                <CardContent className="p-0">
                  {dashboard?.recentActivity?.length ? (
                    <div className="divide-y">
                      {dashboard.recentActivity.map((activity, i) => (
                        <div key={i} className="p-4 flex items-start gap-4">
                          <div className="mt-1">
                            {activity.type === 'registration' && <Tag size={16} className="text-primary" />}
                            {activity.type === 'checkin' && <CheckCircle size={16} className="text-secondary" />}
                            {activity.type === 'result' && <Activity size={16} className="text-sidebar-primary" />}
                          </div>
                          <div>
                            <p className="text-sm font-medium">{activity.description}</p>
                            <p className="text-xs text-muted-foreground mt-1">{new Date(activity.timestamp).toLocaleString()}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-8 text-center text-muted-foreground text-sm">No recent activity to display.</div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* ── CLUB PROFILE TAB ─────────────────────────────────────────── */}
        <TabsContent value="profile" className="space-y-8 mt-4">
          {/* Logo — upload is cloud-only; hidden on desktop */}
          {!isDesktop && <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/svg+xml,image/webp"
            onChange={handleFileChange}
            className="hidden"
            id="logo-upload"
          />
          <Card className="overflow-hidden">
            <CardHeader className="pb-3">
              <CardTitle className="font-heading uppercase tracking-tight text-base">Club Logo</CardTitle>
              <p className="text-sm text-muted-foreground">Shown on public registration pages and race info / live standings for all your events.</p>
            </CardHeader>
            {currentLogo ? (
              <>
                <div className="bg-sidebar border-t border-b border-sidebar-border px-8 py-8 flex items-center gap-6">
                  <img src={currentLogo} alt="Club logo" className="h-32 w-32 object-contain rounded-lg shrink-0" />
                  <p className="text-xs text-sidebar-foreground/60 uppercase tracking-widest font-bold">Preview</p>
                </div>
                <CardContent className="p-5 flex flex-wrap items-center gap-3">
                  <label htmlFor="logo-upload" className="cursor-pointer">
                    <Button asChild variant="outline" disabled={uploadState === "processing" || uploadState === "uploading"} className="font-heading uppercase tracking-wider">
                      <span>
                        {uploadState === "processing" ? <><Sparkles size={15} className="mr-2 animate-pulse" /> Removing bg…</> : uploadState === "uploading" ? <><Loader2 size={15} className="mr-2 animate-spin" /> Uploading…</> : <><Upload size={15} className="mr-2" /> Replace Logo</>}
                      </span>
                    </Button>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-muted-foreground">
                    <Checkbox checked={removeBg} onCheckedChange={v => setRemoveBg(!!v)} disabled={uploadState === "processing" || uploadState === "uploading"} />
                    Remove background
                  </label>
                  <Button variant="ghost" size="sm" onClick={handleRemoveLogo} disabled={uploadState === "processing" || uploadState === "uploading"} className="text-muted-foreground hover:text-destructive font-heading uppercase tracking-wider">
                    <X size={15} className="mr-1.5" /> Remove
                  </Button>
                  {uploadState === "done" && <span className="text-sm text-green-600 font-medium flex items-center gap-1.5 ml-1"><CheckCircle size={14} /> Saved</span>}
                  {uploadState === "error" && <span className="text-sm text-destructive font-medium ml-1">Upload failed — try again</span>}
                </CardContent>
              </>
            ) : (
              <CardContent className="p-8 flex flex-col sm:flex-row items-center gap-6">
                <div className="w-24 h-24 rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/20 flex items-center justify-center shrink-0">
                  <ImageIcon size={32} className="text-muted-foreground/30" />
                </div>
                <div className="space-y-3 text-center sm:text-left">
                  <div>
                    <h3 className="font-heading font-bold uppercase tracking-tight text-lg">No Club Logo</h3>
                    <p className="text-xs text-muted-foreground mt-1">PNG, JPG, SVG or WebP · Recommended square, at least 200×200px</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <label htmlFor="logo-upload" className="cursor-pointer">
                      <Button asChild disabled={uploadState === "processing" || uploadState === "uploading"} className="font-heading uppercase tracking-wider">
                        <span>
                          {uploadState === "processing" ? <><Sparkles size={15} className="mr-2 animate-pulse" /> Removing bg…</> : uploadState === "uploading" ? <><Loader2 size={15} className="mr-2 animate-spin" /> Uploading…</> : <><Upload size={15} className="mr-2" /> Upload Logo</>}
                        </span>
                      </Button>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-muted-foreground">
                      <Checkbox checked={removeBg} onCheckedChange={v => setRemoveBg(!!v)} disabled={uploadState === "processing" || uploadState === "uploading"} />
                      Remove background
                    </label>
                    {uploadState === "error" && <span className="text-sm text-destructive font-medium">Upload failed — try again</span>}
                  </div>
                </div>
              </CardContent>
            )}
          </Card>
          </>}

          {/* Club ID — read-only, for RFID bridge / internal reference */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-heading uppercase tracking-tight text-base">Club ID</CardTitle>
              <p className="text-sm text-muted-foreground">
                Your permanent club identifier. Use this when configuring the RFID bridge in practice mode (<code className="text-xs bg-muted px-1 py-0.5 rounded">--club-id</code>) or for any hardware timing integration. This value is assigned automatically and cannot be changed.
              </p>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-3 bg-muted border border-border rounded-lg px-4 py-3 flex-1 max-w-xs">
                  <span className="text-xs text-muted-foreground font-heading uppercase tracking-widest">Club ID</span>
                  <span className="font-mono font-bold text-2xl text-foreground tracking-wider">{clubId}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyClubId}
                  className="font-heading uppercase tracking-wider h-11 gap-2"
                >
                  {clubIdCopied
                    ? <><ClipboardCheck size={14} className="text-green-500" /> Copied</>
                    : <><Copy size={14} /> Copy</>}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Organizer & Club name */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-heading uppercase tracking-tight text-base">Club &amp; Organizer Info</CardTitle>
              <p className="text-sm text-muted-foreground">This information appears on public-facing pages and in rider communications.</p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-2">
                  <Label htmlFor="clubName" className="font-heading uppercase tracking-wider text-xs">Club Name</Label>
                  <Input
                    id="clubName"
                    value={clubName}
                    onChange={e => setClubName(e.target.value)}
                    placeholder="e.g. Desert Storm MX Club"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="organizerName" className="font-heading uppercase tracking-wider text-xs">Your Name (Organizer)</Label>
                  <Input
                    id="organizerName"
                    value={organizerName}
                    onChange={e => setOrganizerName(e.target.value)}
                    placeholder="e.g. Jake Morrison"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-2">
                  <Label htmlFor="contactEmail" className="font-heading uppercase tracking-wider text-xs">Contact Email</Label>
                  <Input
                    id="contactEmail"
                    type="email"
                    value={contactEmail}
                    onChange={e => setContactEmail(e.target.value)}
                    placeholder="info@yourclub.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactPhone" className="font-heading uppercase tracking-wider text-xs">Contact Phone</Label>
                  <Input
                    id="contactPhone"
                    type="tel"
                    value={contactPhone}
                    onChange={e => setContactPhone(e.target.value)}
                    placeholder="(555) 000-0000"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="website" className="font-heading uppercase tracking-wider text-xs">Website</Label>
                <Input
                  id="website"
                  type="url"
                  value={website}
                  onChange={e => setWebsite(e.target.value)}
                  placeholder="https://yourclub.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description" className="font-heading uppercase tracking-wider text-xs">About Your Club</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Tell riders about your club, track, and events…"
                  rows={4}
                />
              </div>

              <div className="flex items-center gap-4 pt-2">
                <Button
                  onClick={handleSaveProfile}
                  disabled={profileSaving}
                  className="font-heading uppercase tracking-wider"
                >
                  {profileSaving ? <><Loader2 size={15} className="mr-2 animate-spin" /> Saving…</> : <><Save size={15} className="mr-2" /> Save Changes</>}
                </Button>
                {profileSaved && (
                  <span className="text-sm text-green-600 font-medium flex items-center gap-1.5">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
                {profileError && (
                  <span className="text-sm text-destructive font-medium">{profileError}</span>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
