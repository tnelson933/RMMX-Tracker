import { useState, useCallback } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  WifiOff, Download, PlayCircle, UploadCloud, AlertTriangle,
  CheckCircle2, XCircle, RefreshCw, Copy, Check, ChevronDown, ChevronUp,
} from "lucide-react";
import { useGetOfflinePackageInfo } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";

const LAST_DOWNLOAD_KEY = "offline_package_last_downloaded_etag";

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
  const { data: pkgInfo, isError: pkgError } = useGetOfflinePackageInfo({ query: { retry: false } as any });

  const [lastDownloadedEtag, setLastDownloadedEtag] = useState<string | null>(() =>
    localStorage.getItem(LAST_DOWNLOAD_KEY),
  );

  const handleDownload = useCallback(() => {
    if (pkgInfo?.etag) {
      localStorage.setItem(LAST_DOWNLOAD_KEY, pkgInfo.etag);
      setLastDownloadedEtag(pkgInfo.etag);
    }
  }, [pkgInfo?.etag]);

  const [os, setOs] = useState<"mac" | "windows">("mac");

  const { user } = useAuth();
  const cloudDomain = window.location.origin;
  const clubId = user?.clubId ?? "<your-club-id>";

  const cloudEndpoint = `${cloudDomain}/api/timing/active/crossing?clubId=${clubId}`;
  const localEndpoint = `http://<laptop-ip>:8080/api/timing/active/crossing?clubId=${clubId}`;

  const installCmdMac = `unzip rocky-mountain-local-server-latest.zip\ncd rocky-mountain-local-server\nnpm install`;
  const installCmdWindows = `tar -xf rocky-mountain-local-server-latest.zip\ncd rocky-mountain-local-server\nnpm install`;

  const startCmdMac = `cd rocky-mountain-local-server\nnpm start`;
  const startCmdWindows = `cd rocky-mountain-local-server\nnpm start`;

  const syncCmdMac = `CLOUD_URL=${cloudDomain} CLUB_ID=${clubId} CLOUD_EMAIL=you@club.com CLOUD_PASSWORD=yourpassword npm start`;
  const syncCmdWindows = `set CLOUD_URL=${cloudDomain}\nset CLUB_ID=${clubId}\nset CLOUD_EMAIL=you@club.com\nset CLOUD_PASSWORD=yourpassword\nnpm start`;

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
              <PackageInfoBanner
                builtAt={pkgInfo.builtAt}
                version={pkgInfo.version}
                etag={pkgInfo.etag}
                lastEtag={lastDownloadedEtag}
              />
            )}
            {pkgError && (
              <div className="rounded-lg border-2 border-destructive/30 bg-destructive/5 p-3 flex gap-2 text-xs">
                <AlertTriangle size={13} className="text-destructive shrink-0 mt-0.5" />
                <span className="text-muted-foreground">Download info unavailable — contact support if this persists.</span>
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
          </div>

          {/* 1b — Install */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Install it (one time only)</p>
            <p>Unzip the file you just downloaded, then run a quick install so everything is ready for race day.</p>
            <OsToggle os={os} onChange={setOs} />
            <ShowMeHow label="Show me how to install">
              <p className="text-xs text-muted-foreground">Open the Terminal app and type:</p>
              <CopyableCodeBlock>{os === "mac" ? installCmdMac : installCmdWindows}</CopyableCodeBlock>
            </ShowMeHow>
          </div>

          {/* 1c — Test it */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Test it at home first</p>
            <p>Start the software and make sure it runs on your laptop before the day of the event.</p>
            <ShowMeHow label="Show me how to start it">
              <p className="text-xs text-muted-foreground">In your Terminal, type:</p>
              <CopyableCodeBlock>{os === "mac" ? startCmdMac : startCmdWindows}</CopyableCodeBlock>
              <p className="text-xs text-muted-foreground">
                You should see a startup message and the software will be running at <span className="font-mono bg-muted rounded px-1">http://localhost:8080</span>.
                Open that address in your browser to confirm it's working.
              </p>
            </ShowMeHow>
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

          {/* 2a — Start the software */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Start the software on your laptop</p>
            <p>Open a terminal window and start the software the same way you tested it at home. Keep that window open all day — don't close it.</p>
            <ShowMeHow label="Show me the start command">
              <p className="text-xs text-muted-foreground">Type this in your terminal:</p>
              <CopyableCodeBlock>{os === "mac" ? startCmdMac : startCmdWindows}</CopyableCodeBlock>
            </ShowMeHow>
          </div>

          {/* 2b — Point your reader at the laptop */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Point your timing reader at your laptop</p>
            <p>
              Your timing reader normally sends data to the cloud. For offline mode, you need to change
              that address to your laptop instead. Your laptop's address on the local network will look
              something like <span className="font-mono bg-muted rounded px-1 text-foreground">192.168.x.x</span>.
            </p>
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">Use this address for your reader:</p>
              <CopyableCodeBlock>{localEndpoint}</CopyableCodeBlock>
            </div>
            <p className="text-xs">
              Replace <span className="font-mono bg-muted rounded px-1">&lt;laptop-ip&gt;</span> with your
              laptop's actual address on your hotspot network.{" "}
              <a href="/rfid/setup" className="text-primary underline underline-offset-2">
                See the Reader Setup page
              </a>{" "}
              for step-by-step screenshots.
            </p>
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
            <p>After syncing, update your timing reader to point back to the normal cloud address so it's ready for your next event.</p>
            <CopyableCodeBlock>{`POST ${cloudEndpoint}`}</CopyableCodeBlock>
          </div>

          <Callout kind="warning">
            Don't delete or reset anything on your laptop until you've confirmed the sync went through. Check the public Results page — if your results are showing, you're good to go.
          </Callout>

        </CardContent>
      </Card>

    </div>
  );
}
