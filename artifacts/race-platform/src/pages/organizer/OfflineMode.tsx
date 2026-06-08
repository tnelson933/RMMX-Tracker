import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  WifiOff, Download, Settings, PlayCircle, UploadCloud, AlertTriangle,
  CheckCircle2, XCircle, Info, Terminal, Link as LinkIcon, RefreshCw,
} from "lucide-react";
import { useGetOfflinePackageInfo } from "@workspace/api-client-react";

// ── Local-storage key for last-downloaded package ETag ────────────────────────
const LAST_DOWNLOAD_KEY = "offline_package_last_downloaded_etag";

// ── Reusable primitives ────────────────────────────────────────────────────────

function PhaseHeader({ n, title, icon: Icon }: { n: number; title: string; icon: React.ElementType }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-heading font-bold flex-shrink-0">
        {n}
      </div>
      <Icon size={20} className="text-primary flex-shrink-0" />
      <h2 className="text-xl font-heading font-bold uppercase tracking-tight">{title}</h2>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-background border border-border rounded-lg px-4 py-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre">
      {children}
    </pre>
  );
}

function Callout({
  kind,
  children,
}: {
  kind: "warning" | "tip" | "info";
  children: React.ReactNode;
}) {
  const styles = {
    warning: {
      wrapper: "border-amber-500/40 bg-amber-500/10",
      icon: <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />,
      label: "Warning",
      labelClass: "text-amber-500",
    },
    tip: {
      wrapper: "border-green-500/40 bg-green-500/10",
      icon: <CheckCircle2 size={15} className="text-green-500 shrink-0 mt-0.5" />,
      label: "Tip",
      labelClass: "text-green-500",
    },
    info: {
      wrapper: "border-primary/40 bg-primary/10",
      icon: <Info size={15} className="text-primary shrink-0 mt-0.5" />,
      label: "Note",
      labelClass: "text-primary",
    },
  };
  const s = styles[kind];
  return (
    <div className={`rounded-lg border-2 ${s.wrapper} p-4 flex gap-3 text-sm`}>
      {s.icon}
      <div>
        <span className={`font-bold ${s.labelClass}`}>{s.label}: </span>
        <span className="text-foreground/90">{children}</span>
      </div>
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

// ── Build-date display helpers ─────────────────────────────────────────────────

function formatBuildDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatBuildDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

// ── Package info banner ────────────────────────────────────────────────────────

function PackageInfoBanner({
  builtAt,
  version,
  etag,
  onDownload,
}: {
  builtAt: string;
  version: string;
  etag: string;
  onDownload: () => void;
}) {
  const [lastEtag, setLastEtag] = useState<string | null>(null);

  useEffect(() => {
    setLastEtag(localStorage.getItem(LAST_DOWNLOAD_KEY));
  }, []);

  const isOutOfDate = lastEtag !== null && lastEtag !== etag;
  const hasNeverDownloaded = lastEtag === null;

  if (isOutOfDate) {
    return (
      <div className="rounded-lg border-2 border-amber-500/40 bg-amber-500/10 p-4 flex gap-3 text-sm">
        <RefreshCw size={15} className="text-amber-500 shrink-0 mt-0.5" />
        <div>
          <span className="font-bold text-amber-500">Update available: </span>
          <span className="text-foreground/90">
            A newer package was built on{" "}
            <strong>{formatBuildDate(builtAt)}</strong> — your previous download
            is out of date. Re-download below before your next event.
          </span>
        </div>
      </div>
    );
  }

  if (hasNeverDownloaded) {
    return (
      <p className="text-xs text-muted-foreground">
        Package built{" "}
        <span className="font-medium text-foreground">{formatBuildDate(builtAt)}</span>
        {" "}(v{version})
      </p>
    );
  }

  return (
    <p className="text-xs text-muted-foreground">
      <CheckCircle2 size={11} className="text-green-500 inline mr-1 -mt-0.5" />
      You have the latest build — published{" "}
      <span className="font-medium text-foreground">{formatBuildDateTime(builtAt)}</span>
    </p>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OfflineMode() {
  const { data: pkgInfo, isError: pkgError } = useGetOfflinePackageInfo(
    { query: { retry: false } as any },
  );

  const handleDownload = useCallback(() => {
    if (pkgInfo?.etag) {
      localStorage.setItem(LAST_DOWNLOAD_KEY, pkgInfo.etag);
    }
  }, [pkgInfo?.etag]);

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">

      {/* ── Page header ───────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
          <WifiOff className="text-primary" size={32} /> Offline Mode
        </h1>
        <p className="text-muted-foreground mt-1">
          Run a complete race day with no internet — then sync everything back to the cloud when you're done.
        </p>
      </div>

      {/* ── Phase 1 — Overview ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <PhaseHeader n={1} title="Overview" icon={WifiOff} />
        </CardHeader>
        <CardContent className="pt-5 space-y-4 text-sm text-muted-foreground leading-relaxed">
          <p>
            Many race venues — desert washes, mountain tracks, fairgrounds — have little or no cell
            signal on race day. Offline Mode lets you run a full event on a laptop connected directly
            to your timing hardware over a local Wi-Fi hotspot. Nothing reaches the internet until
            you choose to sync.
          </p>
          <p>
            The local server is an exact mirror of the cloud platform. Check-in, RFID timing, moto
            scoring, and results entry all work the same way. When the day is over you export the
            local database and upload it — results appear publicly within minutes.
          </p>
          <Callout kind="info">
            Offline Mode requires a one-time download and setup before you leave for the venue.
            Complete Steps 2–4 at home or at the office where you have reliable internet.
          </Callout>
        </CardContent>
      </Card>

      {/* ── Phase 2 — Prerequisites ──────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <PhaseHeader n={2} title="Prerequisites" icon={CheckCircle2} />
        </CardHeader>
        <CardContent className="pt-5 space-y-4 text-sm">
          <p className="text-muted-foreground">
            Before race day you'll need the following items ready on your laptop.
          </p>
          <ul className="space-y-3">
            <CheckItem ok={true}>
              <span>
                <strong>Node.js 20 or later</strong> — download from{" "}
                <a
                  href="https://nodejs.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 inline-flex items-center gap-1"
                >
                  nodejs.org <LinkIcon size={11} />
                </a>
                . Verify with <code className="bg-muted rounded px-1 py-0.5 text-xs font-mono">node --version</code>.
              </span>
            </CheckItem>
            <CheckItem ok={true}>
              <span>
                <strong>Local server package</strong> — downloaded and unzipped from the link in Step 3 below.
              </span>
            </CheckItem>
            <CheckItem ok={true}>
              <span>
                <strong>Laptop with a Wi-Fi adapter</strong> — you'll create a hotspot that your timing
                hardware joins. Ethernet also works if your reader supports it.
              </span>
            </CheckItem>
            <CheckItem ok={true}>
              <span>
                <strong>Your club ID</strong> — visible in the URL bar on any organizer page, or on the
                Reader Setup page. You'll need it when pointing hardware at the local server.
              </span>
            </CheckItem>
          </ul>
          <Callout kind="warning">
            Test the full offline workflow at least once before an actual event. A 30-minute dry
            run at home will surface any hardware or network issues before race day.
          </Callout>
        </CardContent>
      </Card>

      {/* ── Phase 3 — Download & Install ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <PhaseHeader n={3} title="Download & Install the Local Server" icon={Download} />
        </CardHeader>
        <CardContent className="pt-5 space-y-4 text-sm text-muted-foreground">
          <p>
            The local server package is a self-contained Node.js application. Follow these steps on
            the laptop you'll bring to the venue.
          </p>

          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">1</div>
              <div className="space-y-2 flex-1">
                <p className="text-foreground font-medium">Download the package</p>

                {/* ── Out-of-date / version warning ─────────────────────────────── */}
                {pkgInfo && (
                  <PackageInfoBanner
                    builtAt={pkgInfo.builtAt}
                    version={pkgInfo.version}
                    etag={pkgInfo.etag}
                    onDownload={handleDownload}
                  />
                )}
                {pkgError && (
                  <div className="rounded-lg border-2 border-destructive/30 bg-destructive/5 p-3 flex gap-2 text-xs">
                    <AlertTriangle size={13} className="text-destructive shrink-0 mt-0.5" />
                    <span className="text-muted-foreground">
                      Package info unavailable — the server bundle may not be built yet.
                      Contact support if this persists.
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
                  <span className="text-xs font-mono text-primary flex-1">
                    rocky-mountain-local-server-latest.zip
                  </span>
                  {pkgInfo ? (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 ml-auto font-mono text-muted-foreground">
                      v{pkgInfo.version}
                    </Badge>
                  ) : (
                    <Badge variant="default" className="text-[10px] px-1.5 py-0 ml-auto">Download</Badge>
                  )}
                </a>
                <p className="text-xs">
                  Downloads a self-contained Node.js server bundle (~1 MB). Run{" "}
                  <code className="bg-muted rounded px-1 font-mono">npm install</code> once after
                  unzipping to add the native SQLite driver, then{" "}
                  <code className="bg-muted rounded px-1 font-mono">npm start</code> on race day.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">2</div>
              <div className="space-y-2">
                <p className="text-foreground font-medium">Unzip and install dependencies</p>
                <CodeBlock>{`unzip rocky-mountain-local-server-latest.zip
cd rocky-mountain-local-server
npm install`}</CodeBlock>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">3</div>
              <div className="space-y-2">
                <p className="text-foreground font-medium">Set the database path</p>
                <p className="text-xs">
                  The local server uses SQLite. Set{" "}
                  <code className="bg-muted rounded px-1 font-mono">SQLITE_FILE</code> to where
                  you want the database file stored. If not set, it defaults to{" "}
                  <code className="bg-muted rounded px-1 font-mono">./race_data.db</code> in the
                  server directory.
                </p>
                <CodeBlock>{`# macOS / Linux (optional — default is ./race_data.db)
export SQLITE_FILE="./race_data.db"

# Windows (Command Prompt)
set SQLITE_FILE=./race_data.db`}</CodeBlock>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">4</div>
              <div className="space-y-2">
                <p className="text-foreground font-medium">Start the server and verify</p>
                <CodeBlock>{`npm start

# Expected output:
#   ============================================
#    🏁  Rocky Mountain Race — Local Server
#   ============================================
#    URL:      http://localhost:8080
#    Database: ./race_data.db
#   ============================================`}</CodeBlock>
                <p className="text-xs">
                  Open <code className="bg-muted rounded px-1 font-mono text-xs">http://localhost:8080/api/healthz</code> in
                  a browser. You should see <code className="bg-muted rounded px-1 font-mono text-xs">{`{"status":"ok","mode":"local"}`}</code>.
                </p>
                <p className="text-xs text-muted-foreground">
                  You can also check the build version inside the downloaded package:{" "}
                  <code className="bg-muted rounded px-1 font-mono text-xs">cat package.json | grep version</code>.
                  It should match the version shown on the download button above.
                </p>
              </div>
            </div>
          </div>

          <Callout kind="tip">
            Keep the server running in a terminal window throughout race day. If you close it,
            crossings will queue on the hardware and may be lost depending on your reader's buffer
            size.
          </Callout>
        </CardContent>
      </Card>

      {/* ── Phase 4 — Configure Hardware ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <PhaseHeader n={4} title="Configure Your Timing Hardware" icon={Settings} />
        </CardHeader>
        <CardContent className="pt-5 space-y-4 text-sm text-muted-foreground">
          <p>
            Update your reader's HTTP POST endpoint from the cloud URL to your laptop's local IP
            address. Everything else — method, headers, body template — stays the same.
          </p>

          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground uppercase tracking-wider">Cloud endpoint (your current setting)</p>
            <CodeBlock>{`POST https://<your-domain>/api/timing/active/crossing?clubId=<id>`}</CodeBlock>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground uppercase tracking-wider">Local endpoint (replace before race day)</p>
            <CodeBlock>{`POST http://<laptop-ip>:8080/api/timing/active/crossing?clubId=<id>`}</CodeBlock>
          </div>

          <div className="rounded-lg border bg-muted/30 p-4 space-y-2 text-xs">
            <p className="font-semibold text-foreground">Finding your laptop's IP address</p>
            <CodeBlock>{`# macOS / Linux
ipconfig getifaddr en0      # Wi-Fi
ipconfig getifaddr en1      # Ethernet

# Windows
ipconfig                    # Look for "IPv4 Address" under your adapter`}</CodeBlock>
            <p className="text-muted-foreground">
              Your laptop and the reader must be on the same local network (e.g. both joined to
              your mobile hotspot). The IP is typically <code className="bg-background border rounded px-1 font-mono">192.168.x.x</code>.
            </p>
          </div>

          <Callout kind="info">
            For per-reader configuration screenshots and payload format details, see the{" "}
            <a href="/rfid/setup" className="text-primary underline underline-offset-2">
              Reader Setup
            </a>{" "}
            page. Swap the domain portion of the URL shown there with your laptop's local IP.
          </Callout>

          <Callout kind="warning">
            Use <strong>http://</strong> (not https) for the local address. The local server does
            not have a TLS certificate — readers will reject the connection if you use https.
          </Callout>
        </CardContent>
      </Card>

      {/* ── Phase 5 — Run Race Day ───────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <PhaseHeader n={5} title="Run Race Day Offline" icon={PlayCircle} />
        </CardHeader>
        <CardContent className="pt-5 space-y-4 text-sm text-muted-foreground">
          <p>
            Once the local server is running and your hardware is pointed at it, open the organizer
            portal in a browser on the same laptop. All normal race-day workflows operate exactly as
            they do in the cloud.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4">
              <p className="font-semibold text-green-600 dark:text-green-400 text-xs uppercase tracking-wider mb-2.5">Works offline</p>
              <ul className="space-y-1.5">
                <CheckItem ok={true}>Rider check-in &amp; sign-in</CheckItem>
                <CheckItem ok={true}>RFID &amp; MyLaps live timing</CheckItem>
                <CheckItem ok={true}>Moto scoring &amp; results entry</CheckItem>
                <CheckItem ok={true}>RFID tag assignment</CheckItem>
                <CheckItem ok={true}>Bib number management</CheckItem>
                <CheckItem ok={true}>Walk-up registration management</CheckItem>
              </ul>
            </div>
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <p className="font-semibold text-destructive text-xs uppercase tracking-wider mb-2.5">Not available offline</p>
              <ul className="space-y-1.5">
                <CheckItem ok={false}>Series points calculation</CheckItem>
                <CheckItem ok={false}>Online pre-registration</CheckItem>
                <CheckItem ok={false}>Public results page</CheckItem>
                <CheckItem ok={false}>Email confirmations</CheckItem>
                <CheckItem ok={false}>Payment processing</CheckItem>
              </ul>
            </div>
          </div>

          <Callout kind="tip">
            Walk-up registration still works — add riders manually through the Riders page, then
            register them for the event. Their results will sync to the cloud along with everything
            else.
          </Callout>
        </CardContent>
      </Card>

      {/* ── Phase 6 — Sync Back ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <PhaseHeader n={6} title="Sync Back to the Cloud" icon={UploadCloud} />
        </CardHeader>
        <CardContent className="pt-5 space-y-4 text-sm text-muted-foreground">
          <p>
            When the local server detects internet connectivity and at least one event is marked
            completed, it automatically pushes all data — check-ins, RFID assignments, walk-up
            registrations — to the cloud. No terminal commands needed.
          </p>

          {/* Auto-sync explanation */}
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <RefreshCw size={14} className="text-primary shrink-0" />
              <p className="text-xs font-semibold text-foreground uppercase tracking-wider">How auto-sync works</p>
            </div>
            <ul className="space-y-2 text-xs">
              <li className="flex items-start gap-2">
                <CheckCircle2 size={13} className="text-green-500 shrink-0 mt-0.5" />
                <span>The server checks for internet every 2 minutes in the background.</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={13} className="text-green-500 shrink-0 mt-0.5" />
                <span>Sync fires automatically once the cloud is reachable <strong>and</strong> at least one event is set to <em>completed</em>.</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={13} className="text-green-500 shrink-0 mt-0.5" />
                <span>Re-running sync never duplicates data — the watermark system skips rows that already exist in the cloud.</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={13} className="text-green-500 shrink-0 mt-0.5" />
                <span>Auto-sync requires <code className="bg-background border rounded px-1 font-mono">CLOUD_URL</code>, <code className="bg-background border rounded px-1 font-mono">CLUB_ID</code>, <code className="bg-background border rounded px-1 font-mono">CLOUD_EMAIL</code>, and <code className="bg-background border rounded px-1 font-mono">CLOUD_PASSWORD</code> to be set when starting the server.</span>
              </li>
            </ul>
          </div>

          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">1</div>
              <div className="space-y-1.5">
                <p className="text-foreground font-medium">Start the server with cloud credentials</p>
                <p className="text-xs">
                  Set your cloud credentials when launching the local server. Auto-sync will start automatically once an event is completed and internet is detected.
                </p>
                <CodeBlock>{`# macOS / Linux
CLOUD_URL=https://your-app.replit.app \\
CLUB_ID=1 \\
CLOUD_EMAIL=you@club.com \\
CLOUD_PASSWORD=yourpassword \\
npm start

# Windows (Command Prompt — set vars first)
set CLOUD_URL=https://your-app.replit.app
set CLUB_ID=1
set CLOUD_EMAIL=you@club.com
set CLOUD_PASSWORD=yourpassword
npm start`}</CodeBlock>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">2</div>
              <div className="space-y-1.5">
                <p className="text-foreground font-medium">Check sync status</p>
                <p className="text-xs">
                  Open the status page from any browser on your local network to confirm sync happened and see how many rows were uploaded.
                </p>
                <CodeBlock>{`http://<laptop-ip>:8080/api/status`}</CodeBlock>
                <p className="text-xs">
                  The response shows <code className="bg-muted rounded px-1 font-mono">autoSync.lastSuccessAt</code> when sync completed, plus row counts for each table.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">3</div>
              <div className="space-y-1.5">
                <p className="text-foreground font-medium">Restore hardware to the cloud endpoint</p>
                <p className="text-xs">
                  Update each reader's HTTP endpoint back to the cloud URL. You only need to do this
                  once — the reader will continue using the cloud URL for all future events.
                </p>
                <CodeBlock>{`POST https://<your-domain>/api/timing/active/crossing?clubId=<id>`}</CodeBlock>
              </div>
            </div>
          </div>

          <Callout kind="warning">
            <strong>Sync before wiping the laptop.</strong> The local SQLite database (
            <code className="bg-amber-500/20 rounded px-1 font-mono text-xs">race-data.db</code>) is the
            only copy of your race data until the sync completes. Do not delete it, reformat the
            laptop, or run <code className="bg-amber-500/20 rounded px-1 font-mono text-xs">npm run reset-db</code> until
            you have confirmed a successful upload.
          </Callout>

          <Callout kind="info">
            If credentials aren't configured, auto-sync is disabled and the server will print a
            warning at startup. You can still sync manually using{" "}
            <code className="bg-primary/10 rounded px-1 font-mono text-xs">npm run sync</code> from the
            local server directory — see the README in the downloaded package for details.
          </Callout>

          <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Terminal size={14} className="text-primary shrink-0" />
              <p className="text-xs font-semibold text-foreground uppercase tracking-wider">Verify the sync</p>
            </div>
            <p className="text-xs">
              After sync, open the public Results page for your event. If lap counts and
              positions match what you saw on the local portal, the sync was successful. You can
              then safely archive the local database file.
            </p>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
