import { useState, useCallback, useEffect } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  WifiOff, Download, UploadCloud, AlertTriangle,
  CheckCircle2, XCircle, RefreshCw, Copy, Check, ChevronDown, ChevronUp,
  Wifi, Loader2, Database, Timer,
} from "lucide-react";
import { useGetOfflinePackageInfo, useRebuildOfflinePackage } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";

const LAST_DOWNLOAD_KEY = "offline_package_last_downloaded_etag";

// ── Local IP detection via WebRTC ICE candidate probe ─────────────────────────
// The browser opens a local peer connection to gather ICE candidates, which
// includes the machine's LAN IP without any external request.
// Falls back gracefully when the browser blocks local IP discovery
// (Chrome with mDNS obfuscation, strict privacy mode, etc.).
function useLocalIp(): { ip: string | null; loading: boolean } {
  const [ip, setIp] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let done = false;
    let pc: RTCPeerConnection | null = null;

    const finish = (found: string | null) => {
      if (done) return;
      done = true;
      setIp(found);
      setLoading(false);
      pc?.close();
    };

    const timer = setTimeout(() => finish(null), 2000);

    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("");
      pc.onicecandidate = (e) => {
        if (!e.candidate) { finish(null); return; }
        // Parse IPv4 address from the candidate string
        const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(e.candidate.candidate);
        if (m && !m[1].startsWith("127.")) {
          clearTimeout(timer);
          finish(m[1]);
        }
      };
      void pc.createOffer().then((offer) => pc!.setLocalDescription(offer));
    } catch {
      finish(null);
      clearTimeout(timer);
    }

    return () => { clearTimeout(timer); pc?.close(); };
  }, []);

  return { ip, loading };
}

function StepHeader({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-base font-heading font-bold flex-shrink-0">
        {n}
      </div>
      <h2 className="text-xl font-heading font-bold uppercase tracking-tight">{title}</h2>
    </div>
  );
}

function CopyableCodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative group">
      <pre className="bg-background border border-border rounded-lg px-4 py-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre pr-12">
        {children}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
        title="Copy"
      >
        {copied ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Callout({ kind, children }: { kind: "warning" | "tip" | "info"; children: React.ReactNode }) {
  const styles = {
    warning: { wrapper: "border-amber-500/40 bg-amber-500/10", icon: <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" /> },
    tip:     { wrapper: "border-green-500/40 bg-green-500/10",  icon: <CheckCircle2  size={15} className="text-green-500 shrink-0 mt-0.5" /> },
    info:    { wrapper: "border-primary/40 bg-primary/10",      icon: <RefreshCw     size={15} className="text-primary shrink-0 mt-0.5" /> },
  };
  const s = styles[kind];
  return (
    <div className={`rounded-lg border-2 ${s.wrapper} p-4 flex gap-3 text-sm`}>
      {s.icon}
      <span className="text-foreground/90">{children}</span>
    </div>
  );
}

function CheckItem({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok
        ? <CheckCircle2 size={15} className="text-green-500 shrink-0 mt-0.5" />
        : <XCircle size={15} className="text-destructive shrink-0 mt-0.5" />}
      <span className={ok ? "text-foreground" : "text-muted-foreground"}>{children}</span>
    </li>
  );
}

function ShowMeHow({ label = "Show me how", children }: { label?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
      >
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {open ? "Hide" : label}
      </button>
      {open && <div className="space-y-2">{children}</div>}
    </div>
  );
}

function OsToggle({ os, onChange }: { os: "mac" | "windows"; onChange: (os: "mac" | "windows") => void }) {
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground mr-1">My computer:</span>
      <button
        onClick={() => onChange("mac")}
        className={`px-2.5 py-1 rounded border font-medium transition-colors ${os === "mac" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
      >
        Mac / Linux
      </button>
      <button
        onClick={() => onChange("windows")}
        className={`px-2.5 py-1 rounded border font-medium transition-colors ${os === "windows" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
      >
        Windows
      </button>
    </div>
  );
}

function formatBuildDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}
function formatBuildDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

function PackageInfoBanner({ builtAt, version, etag, lastEtag }: { builtAt: string; version: string; etag: string; lastEtag: string | null }) {
  const isOutOfDate = lastEtag !== null && lastEtag !== etag;
  const hasNeverDownloaded = lastEtag === null;

  if (isOutOfDate) {
    return (
      <div className="rounded-lg border-2 border-amber-500/40 bg-amber-500/10 p-3 flex gap-2 text-xs">
        <RefreshCw size={13} className="text-amber-500 shrink-0 mt-0.5" />
        <span className="text-foreground/90">
          A newer version was built on <strong>{formatBuildDate(builtAt)}</strong> — re-download before your next event.
        </span>
      </div>
    );
  }
  if (hasNeverDownloaded) {
    return (
      <p className="text-xs text-muted-foreground">
        Package built <span className="font-medium text-foreground">{formatBuildDate(builtAt)}</span> (v{version})
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      <CheckCircle2 size={11} className="text-green-500 inline mr-1 -mt-0.5" />
      You have the latest version — published <span className="font-medium text-foreground">{formatBuildDateTime(builtAt)}</span>
    </p>
  );
}

export default function OfflineMode() {
  const { data: pkgInfo, isError: pkgError, refetch: refetchPkgInfo } = useGetOfflinePackageInfo({ query: { staleTime: 60_000 } as any });

  const [lastDownloadedEtag, setLastDownloadedEtag] = useState<string | null>(() =>
    localStorage.getItem(LAST_DOWNLOAD_KEY),
  );

  const handleDownload = useCallback(() => {
    if (pkgInfo?.etag) {
      localStorage.setItem(LAST_DOWNLOAD_KEY, pkgInfo.etag);
      setLastDownloadedEtag(pkgInfo.etag);
    }
  }, [pkgInfo?.etag]);

  const { mutate: triggerRebuild, isPending: isRebuilding, isError: rebuildFailed, error: rebuildError, reset: resetRebuild } = useRebuildOfflinePackage({
    mutation: {
      onSuccess: () => {
        refetchPkgInfo();
      },
    },
  });

  const handleRebuild = useCallback(() => {
    resetRebuild();
    triggerRebuild();
  }, [resetRebuild, triggerRebuild]);

  const [os, setOs] = useState<"mac" | "windows">("mac");
  const [tech, setTech] = useState<"rfid" | "mylaps">("rfid");
  const [decoderIp, setDecoderIp] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportDone, setExportDone] = useState(false);

  const { user } = useAuth();
  const cloudDomain = window.location.origin;
  const clubId = user?.clubId ?? "<your-club-id>";

  const handleExportRaceData = useCallback(async () => {
    if (!user?.clubId || exporting) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/clubs/${user.clubId}/export`, { credentials: "include" });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const today = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `race-data-${today}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportDone(true);
      setTimeout(() => setExportDone(false), 4000);
    } catch {
      // silent
    } finally {
      setExporting(false);
    }
  }, [user?.clubId, exporting]);

  const { ip: localIp, loading: ipLoading } = useLocalIp();

  const cloudEndpoint = `${cloudDomain}/api/timing/active/crossing?clubId=${clubId}`;
  const bridgeCmdLocal = `python rfid_bridge.py --api-url http://localhost:8080`;
  const bridgeCmdCloud = `python rfid_bridge.py --api-url ${cloudDomain}`;
  const decoderIpDisplay = decoderIp || "<decoder-ip>";
  const mylapsBridgeCmdLocal = `python rfid_bridge.py --mylaps ${decoderIpDisplay} --club-id ${clubId} --api-url http://localhost:8080`;
  const mylapsBridgeCmdCloud = `python rfid_bridge.py --mylaps ${decoderIpDisplay} --club-id ${clubId} --api-url ${cloudDomain}`;

  const installCmdMac = `unzip rocky-mountain-local-server-latest.zip\ncd rocky-mountain-local-server\nnpm install`;
  const installCmdWindows = `tar -xf rocky-mountain-local-server-latest.zip\ncd rocky-mountain-local-server\nnpm install`;

  const startCmdMac = `cd rocky-mountain-local-server\nnpm start`;
  const startCmdWindows = `cd rocky-mountain-local-server\nnpm start`;

  const syncCmdMac = `CLOUD_URL=${cloudDomain} CLUB_ID=${clubId} CLOUD_EMAIL=you@club.com CLOUD_PASSWORD=yourpassword npm start`;
  const syncCmdWindows = `set CLOUD_URL=${cloudDomain}\nset CLUB_ID=${clubId}\nset CLOUD_EMAIL=you@club.com\nset CLOUD_PASSWORD=yourpassword\nnpm start`;

  const downloadLauncher = (platform: "windows" | "mac", cmd: string) => {
    const cmd3 = cmd.replace(/^python /, "python3 ");
    let content: string;
    let filename: string;
    if (platform === "windows") {
      content = [
        "@echo off",
        "title Rocky Mountain Race Timing Bridge",
        "echo ================================================",
        "echo   Rocky Mountain Race Timing Bridge",
        "echo ================================================",
        "echo.",
        "echo Starting... Keep this window open while racing.",
        "echo.",
        "set SCRIPT_DIR=%~dp0",
        'cd /d "%SCRIPT_DIR%"',
        cmd,
        "echo.",
        "echo Bridge stopped. Press any key to close.",
        "pause > nul",
      ].join("\r\n");
      filename = "start-timing.bat";
    } else {
      content = [
        "#!/bin/bash",
        'cd "$(dirname "$0")"',
        "echo '================================================'",
        "echo '  Rocky Mountain Race Timing Bridge'",
        "echo '================================================'",
        "echo ''",
        "echo 'Starting... Keep this window open while racing.'",
        "echo ''",
        cmd3,
        "echo ''",
        "echo 'Bridge stopped.'",
      ].join("\n");
      filename = "start-timing.command";
    }
    const blob = new Blob([content], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadInstallScript = (platform: "windows" | "mac") => {
    let content: string;
    let filename: string;
    if (platform === "windows") {
      content = [
        "@echo off",
        "title Rocky Mountain Local Server — Install",
        "echo ================================================",
        "echo   Rocky Mountain Local Server — Install",
        "echo ================================================",
        "echo.",
        "cd %USERPROFILE%\\Downloads",
        "echo Unzipping server package...",
        "tar -xf rocky-mountain-local-server-latest.zip",
        "cd rocky-mountain-local-server",
        "echo.",
        "echo Installing dependencies (this may take a minute)...",
        "npm install",
        "echo.",
        "echo Done! Press any key to close.",
        "pause > nul",
      ].join("\r\n");
      filename = "install-server.bat";
    } else {
      content = [
        "#!/bin/bash",
        "cd ~/Downloads",
        "echo 'Unzipping server package...'",
        "unzip -o rocky-mountain-local-server-latest.zip",
        "cd rocky-mountain-local-server",
        "echo ''",
        "echo 'Installing dependencies (this may take a minute)...'",
        "npm install",
        "echo ''",
        "echo 'Done! You can close this window.'",
        "read -n1",
      ].join("\n");
      filename = "install-server.command";
    }
    const blob = new Blob([content], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadStartScript = (platform: "windows" | "mac") => {
    let content: string;
    let filename: string;
    if (platform === "windows") {
      content = [
        "@echo off",
        "title Rocky Mountain Local Server",
        "cd %USERPROFILE%\\Downloads\\rocky-mountain-local-server",
        "npm start",
        "pause > nul",
      ].join("\r\n");
      filename = "start-server.bat";
    } else {
      content = [
        "#!/bin/bash",
        "cd ~/Downloads/rocky-mountain-local-server",
        "npm start",
      ].join("\n");
      filename = "start-server.command";
    }
    const blob = new Blob([content], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">

      {/* ── Page header ─────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
          <WifiOff className="text-primary" size={32} /> Offline Mode
        </h1>
        <p className="text-muted-foreground mt-1">
          Run a full race day with no internet — your laptop handles everything, then syncs back to the cloud when you're done.
        </p>

        {/* Tech picker */}
        <div className="mt-5 space-y-2">
          <p className="text-sm font-semibold text-foreground">What timing technology do you use?</p>
          <div className="grid grid-cols-2 gap-3 max-w-sm">
            <button
              onClick={() => setTech("rfid")}
              className={`flex items-center gap-3 rounded-xl border-2 p-3 text-left transition-all ${tech === "rfid" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
            >
              <Wifi size={18} className={tech === "rfid" ? "text-primary" : "text-muted-foreground"} />
              <div>
                <p className="font-semibold text-sm">RFID Sticker Tags</p>
                <p className="text-xs text-muted-foreground">Bridge script</p>
              </div>
            </button>
            <button
              onClick={() => setTech("mylaps")}
              className={`flex items-center gap-3 rounded-xl border-2 p-3 text-left transition-all ${tech === "mylaps" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
            >
              <Timer size={18} className={tech === "mylaps" ? "text-primary" : "text-muted-foreground"} />
              <div>
                <p className="font-semibold text-sm">MyLaps / AMB</p>
                <p className="text-xs text-muted-foreground">Transponder decoder</p>
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* ── Step 1 — Before Race Day ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <StepHeader n={1} title="Before Race Day — One-Time Setup" />
        </CardHeader>
        <CardContent className="pt-5 space-y-6 text-sm text-muted-foreground">

          {/* 1a — Download */}
          <div className="space-y-3">
            <p className="text-foreground font-semibold">Download the software to your laptop</p>

            {pkgInfo && (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <PackageInfoBanner
                    builtAt={pkgInfo.builtAt}
                    version={pkgInfo.version}
                    etag={pkgInfo.etag}
                    lastEtag={lastDownloadedEtag}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleRebuild}
                  disabled={isRebuilding}
                  className="shrink-0 flex items-center gap-1.5 rounded-md border border-border bg-background hover:bg-muted transition-colors px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isRebuilding ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      Rebuilding…
                    </>
                  ) : (
                    <>
                      <RefreshCw size={12} />
                      Rebuild
                    </>
                  )}
                </button>
              </div>
            )}
            {!pkgInfo && !pkgError && (
              <button
                type="button"
                onClick={handleRebuild}
                disabled={isRebuilding}
                className="flex items-center gap-1.5 rounded-md border border-border bg-background hover:bg-muted transition-colors px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isRebuilding ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    Rebuilding…
                  </>
                ) : (
                  <>
                    <RefreshCw size={12} />
                    Rebuild Now
                  </>
                )}
              </button>
            )}
            {pkgError && (
              <div className="rounded-lg border-2 border-destructive/30 bg-destructive/5 p-3 flex gap-2 text-xs">
                <AlertTriangle size={13} className="text-destructive shrink-0 mt-0.5" />
                <span className="text-muted-foreground">Download info unavailable — contact support if this persists.</span>
              </div>
            )}
            {rebuildFailed && (
              <div className="rounded-lg border-2 border-destructive/30 bg-destructive/5 p-3 flex gap-2 text-xs">
                <AlertTriangle size={13} className="text-destructive shrink-0 mt-0.5" />
                <span className="text-muted-foreground">
                  Rebuild failed: {(rebuildError as any)?.response?.data?.error ?? (rebuildError as any)?.message ?? "Unknown error"}
                </span>
              </div>
            )}

            <a
              href="/api/offline/package"
              download="rocky-mountain-local-server-latest.zip"
              onClick={handleDownload}
              className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 hover:bg-primary/10 transition-colors px-4 py-3 group"
            >
              <Download size={14} className="text-primary shrink-0 group-hover:scale-110 transition-transform" />
              <span className="text-xs font-mono text-primary flex-1">rocky-mountain-local-server-latest.zip</span>
              {pkgInfo ? (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 ml-auto font-mono text-muted-foreground">v{pkgInfo.version}</Badge>
              ) : (
                <Badge variant="default" className="text-[10px] px-1.5 py-0 ml-auto">Download</Badge>
              )}
            </a>
            <p className="text-xs text-muted-foreground">
              Save it to your <strong>Downloads</strong> folder — the install script will look for it there.
            </p>
          </div>

          {/* 1b — Install */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Install it (one time only)</p>
            <p>Download this script and double-click it — it unzips and installs everything automatically. No typing needed.</p>
            <OsToggle os={os} onChange={setOs} />
            <button onClick={() => downloadInstallScript(os)}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
              <Download size={12} /> {os === "windows" ? "install-server.bat" : "install-server.command"}
            </button>
            {os === "mac" && <p className="text-xs text-muted-foreground opacity-70">Right-click the file → Open the first time to allow it past Gatekeeper.</p>}
          </div>

          {/* 1c — Test it */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Test it at home first</p>
            <p>Start the software and make sure it runs on your laptop before the day of the event.</p>
            <button onClick={() => downloadStartScript(os)}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
              <Download size={12} /> {os === "windows" ? "start-server.bat" : "start-server.command"}
            </button>
            <p className="text-xs text-muted-foreground">
              Double-click to start. Then open{" "}
              <a href="http://localhost:8080" target="_blank" rel="noopener noreferrer" className="font-mono bg-muted rounded px-1 text-primary underline underline-offset-2 hover:bg-muted/70 transition-colors">http://localhost:8080</a>{" "}
              in your browser to confirm it's working.
            </p>
            {os === "mac" && <p className="text-xs text-muted-foreground opacity-70">Right-click the file → Open the first time to allow it past Gatekeeper.</p>}
          </div>

          <Callout kind="tip">
            Do this at home before your first event — a quick test now prevents surprises on race day.
          </Callout>

        </CardContent>
      </Card>

      {/* ── Step 2 — On Race Day ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <StepHeader n={2} title="On Race Day" />
        </CardHeader>
        <CardContent className="pt-5 space-y-6 text-sm text-muted-foreground">

          {/* 2a — Download race data */}
          <div className="space-y-3">
            <p className="text-foreground font-semibold">Download your race data</p>
            <p>
              Before you leave home (while you still have internet), download a copy of your
              rider database and event info. Your laptop uses this file to run the event offline.
            </p>
            <Button
              variant="outline"
              onClick={handleExportRaceData}
              disabled={exporting}
              className="font-heading uppercase tracking-wider gap-2"
            >
              {exporting
                ? <Loader2 size={15} className="animate-spin" />
                : exportDone
                  ? <CheckCircle2 size={15} className="text-green-500" />
                  : <Database size={15} />}
              {exporting ? "Downloading…" : exportDone ? "Downloaded!" : "Download Race Data"}
            </Button>
            <Callout kind="warning">
              Do this at home before heading to the venue — you need internet to download it.
            </Callout>
          </div>

          {/* 2b — Start the software */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Start the software on your laptop</p>
            <p>Double-click the same start script you downloaded in Step 1. Keep the window open all day — don't close it.</p>
            <button onClick={() => downloadStartScript(os)}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
              <Download size={12} /> {os === "windows" ? "start-server.bat" : "start-server.command"}
            </button>
          </div>

          {/* 2c — Point your reader at the laptop */}
          <div className="space-y-3">
            <p className="text-foreground font-semibold">Point your timing reader at your laptop</p>
            <p>
              Your timing reader normally sends data to the cloud. For offline mode, redirect
              it to your laptop instead.
            </p>

            {tech === "rfid" ? (
              <div className="space-y-2">
                {/* IP detection — needed so user knows what address to put in the reader's config */}
                {ipLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 size={13} className="animate-spin" />
                    Detecting your laptop's IP address…
                  </div>
                ) : localIp ? (
                  <div className="flex items-center gap-2 rounded-lg border border-green-500/40 bg-green-500/10 px-3 py-2 text-xs">
                    <Wifi size={13} className="text-green-500 shrink-0" />
                    <span className="text-foreground">
                      Your laptop's IP address on this network is{" "}
                      <span className="font-mono font-bold text-green-600 dark:text-green-400">{localIp}</span>
                      {" "}— use this when configuring your reader.
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <Wifi size={13} className="shrink-0" />
                    <span>Couldn't auto-detect your IP. Check your network settings to find your laptop's address on the hotspot, then enter it in your reader's configuration.</span>
                  </div>
                )}
                <p className="text-xs font-medium text-foreground">
                  Start your bridge pointed at the laptop instead of the cloud:
                </p>
                <div className="flex flex-wrap gap-2">
                  <a href="/rfid_bridge.py" download="rfid_bridge.py"
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                    <Download size={12} /> rfid_bridge.py
                  </a>
                  <button onClick={() => downloadLauncher(os, bridgeCmdLocal)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                    <Download size={12} /> {os === "windows" ? "start-timing.bat" : "start-timing.command"}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Save both files to your <strong>Downloads</strong> folder — they must be in the same folder.
                  Open your Downloads folder and double-click <strong>{os === "windows" ? "start-timing.bat" : "start-timing.command"}</strong> — a terminal opens and the bridge starts. Keep the window open — closing it cuts the reader connection.
                </p>
                <p className="text-xs">
                  <a href="/rfid/setup" className="text-primary underline underline-offset-2">Reader Setup page</a>{" "}
                  has per-reader configuration screenshots.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs font-medium text-foreground">
                  Start the bridge pointed at your laptop — it will connect to your decoder and forward crossings locally:
                </p>
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    Decoder IP address <span className="opacity-60">(from the decoder label or AMBrc)</span>:
                  </p>
                  <Input
                    value={decoderIp}
                    onChange={e => setDecoderIp(e.target.value)}
                    placeholder="e.g. 192.168.1.50"
                    className="font-mono h-8 text-xs max-w-xs"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href="/rfid_bridge.py" download="rfid_bridge.py"
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                    <Download size={12} /> rfid_bridge.py
                  </a>
                  <button onClick={() => downloadLauncher(os, mylapsBridgeCmdLocal)}
                    disabled={!decoderIp.trim()}
                    className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background transition-colors ${decoderIp.trim() ? "hover:bg-muted" : "opacity-40 cursor-not-allowed"}`}>
                    <Download size={12} /> {os === "windows" ? "start-timing.bat" : "start-timing.command"}
                  </button>
                </div>
                {!decoderIp.trim() && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">Enter the decoder IP above to enable the download.</p>
                )}
                <p className="text-xs text-muted-foreground">
                  Save both files to your <strong>Downloads</strong> folder — they must be in the same folder.
                  Open your Downloads folder and double-click <strong>{os === "windows" ? "start-timing.bat" : "start-timing.command"}</strong> — a terminal opens and the bridge starts. Keep the window open all day — closing it disconnects from the decoder.
                </p>
              </div>
            )}
          </div>

          {/* 2c — Run the event */}
          <div className="space-y-3">
            <p className="text-foreground font-semibold">Run your event normally</p>
            <p>Open the organizer portal in your browser and run the day exactly as you would with the cloud. Everything below works with no internet.</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4">
                <p className="font-semibold text-green-600 dark:text-green-400 text-xs uppercase tracking-wider mb-2.5">Works offline</p>
                <ul className="space-y-1.5">
                  <CheckItem ok={true}>Rider check-in</CheckItem>
                  <CheckItem ok={true}>Live transponder timing</CheckItem>
                  <CheckItem ok={true}>Moto scoring &amp; results</CheckItem>
                  <CheckItem ok={true}>Transponder / bib setup</CheckItem>
                  <CheckItem ok={true}>Walk-up registration</CheckItem>
                </ul>
              </div>
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <p className="font-semibold text-destructive text-xs uppercase tracking-wider mb-2.5">Not available offline</p>
                <ul className="space-y-1.5">
                  <CheckItem ok={false}>Series points &amp; standings</CheckItem>
                  <CheckItem ok={false}>Online pre-registration</CheckItem>
                  <CheckItem ok={false}>Public results page</CheckItem>
                  <CheckItem ok={false}>Email confirmations</CheckItem>
                  <CheckItem ok={false}>Payment processing</CheckItem>
                </ul>
              </div>
            </div>
          </div>

          <Callout kind="tip">
            Keep the terminal window open all day — closing it stops the software and your timing reader will lose its connection.
          </Callout>

        </CardContent>
      </Card>

      {/* ── Step 3 — After the Race ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <StepHeader n={3} title="After the Race — Sync Your Results" />
        </CardHeader>
        <CardContent className="pt-5 space-y-6 text-sm text-muted-foreground">

          {/* 3a — Auto-sync */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Results sync automatically when you get internet</p>
            <p>
              As soon as your laptop connects to the internet — whether that's driving home or stopping at a café —
              the software will push all your race data to the cloud on its own. Results will appear publicly within minutes.
            </p>
            <p>
              For this to work, you need to start the software with your cloud account details. Expand the section below to set that up.
            </p>
            <ShowMeHow label="Set up automatic sync (recommended)">
              <p className="text-xs text-muted-foreground">
                Start the software with your login details instead of the plain start command.
                Replace <span className="font-mono bg-muted rounded px-1">you@club.com</span> and <span className="font-mono bg-muted rounded px-1">yourpassword</span> with your organizer account credentials:
              </p>
              <OsToggle os={os} onChange={setOs} />
              <CopyableCodeBlock>{os === "mac" ? syncCmdMac : syncCmdWindows}</CopyableCodeBlock>
              <p className="text-xs text-muted-foreground">
                Once you have internet, the software will sync automatically. You don't need to do anything else.
              </p>
            </ShowMeHow>
          </div>

          {/* 3b — Manual upload fallback */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Or upload manually from the cloud portal</p>
            <p>
              If auto-sync didn't run, you can upload your results file directly from this website.
            </p>
            <Link
              href="/offline/sync"
              className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 hover:bg-primary/10 transition-colors px-4 py-3 group"
            >
              <UploadCloud size={14} className="text-primary shrink-0 group-hover:scale-110 transition-transform" />
              <span className="text-xs font-mono text-primary flex-1">Upload Offline Results →</span>
            </Link>
          </div>

          {/* 3c — Point reader back */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Switch your timing reader back to the cloud</p>
            <p>After syncing, point your reader back at the cloud so it's ready for your next event.</p>
            {tech === "rfid" ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">Restart the bridge without the local override:</p>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => downloadLauncher(os, bridgeCmdCloud)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                    <Download size={12} /> {os === "windows" ? "start-timing.bat" : "start-timing.command"}
                  </button>
                </div>
                <CopyableCodeBlock>{bridgeCmdCloud}</CopyableCodeBlock>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">Restart the bridge pointed back at the cloud:</p>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => downloadLauncher(os, mylapsBridgeCmdCloud)}
                    disabled={!decoderIp.trim()}
                    className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background transition-colors ${decoderIp.trim() ? "hover:bg-muted" : "opacity-40 cursor-not-allowed"}`}>
                    <Download size={12} /> {os === "windows" ? "start-timing.bat" : "start-timing.command"}
                  </button>
                </div>
                <CopyableCodeBlock>{mylapsBridgeCmdCloud}</CopyableCodeBlock>
                <p className="text-xs text-muted-foreground">
                  This is the same command you use on normal race days — just run it once and the decoder reconnects automatically.
                </p>
              </div>
            )}
          </div>

          <Callout kind="warning">
            Don't delete or reset anything on your laptop until you've confirmed the sync went through. Check the public Results page — if your results are showing, you're good to go.
          </Callout>

        </CardContent>
      </Card>

    </div>
  );
}
