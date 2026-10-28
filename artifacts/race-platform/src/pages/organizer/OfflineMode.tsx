import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { WifiOff, Download, CheckCircle2, Monitor, Apple, Radio, RefreshCw, CloudUpload } from "lucide-react";

// Offline race days run in the RM Roost desktop app: it bundles the local race
// server, connects to timing hardware over a local network, and syncs back to
// the cloud when internet returns. This page only points organizers to it.

const FALLBACK_TAG = "desktop-v1.0.111";
const FALLBACK_BASE = `https://github.com/tnelson933/RMMX-Tracker/releases/download/${FALLBACK_TAG}`;

interface DesktopDownloads { macArm: string; macX64: string; windows: string }

function detectPlatform(): "windows" | "mac" | "other" {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  return "other";
}

const STEPS = [
  { icon: RefreshCw, title: "Sync before you leave", body: "Sign in to the desktop app while you have internet. It copies your events, riders and registrations to the laptop." },
  { icon: Radio, title: "Connect your reader at the track", body: "In Reader Setup, choose \"No, connect without internet\". The app finds your RFID reader or RM TrackR on the local network." },
  { icon: CloudUpload, title: "Results upload automatically", body: "Run check-in, timing and results offline. Everything syncs to the cloud once the laptop is back online." },
];

export default function OfflineMode() {
  const isDesktopApp = typeof window !== "undefined" &&
    typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== "undefined";
  const platform = detectPlatform();
  const [downloads, setDownloads] = useState<DesktopDownloads>({
    macArm:  `${FALLBACK_BASE}/RM-Tracker-arm64.dmg`,
    macX64:  `${FALLBACK_BASE}/RM-Tracker-x64.dmg`,
    windows: `${FALLBACK_BASE}/RM-Tracker-Setup.exe`,
  });

  useEffect(() => {
    if (isDesktopApp) return;
    fetch("/api/config/desktop-release")
      .then(r => r.ok ? r.json() : null)
      .then((data: DesktopDownloads | null) => {
        if (data?.macArm) setDownloads({ macArm: data.macArm, macX64: data.macX64, windows: data.windows });
      })
      .catch(() => {});
  }, [isDesktopApp]);

  const windowsButton = (
    <Button asChild size="lg" variant={platform === "windows" ? "default" : "outline"} className="gap-2">
      <a href={downloads.windows}><Monitor size={18} /> Download for Windows</a>
    </Button>
  );
  const macButtons = (
    <>
      <Button asChild size="lg" variant={platform === "mac" ? "default" : "outline"} className="gap-2">
        <a href={downloads.macArm}><Apple size={18} /> Mac (Apple silicon)</a>
      </Button>
      <Button asChild size="lg" variant="outline" className="gap-2">
        <a href={downloads.macX64}><Apple size={18} /> Mac (Intel)</a>
      </Button>
    </>
  );

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
          <WifiOff className="text-primary" size={32} /> Offline Mode
        </h1>
        <p className="text-muted-foreground mt-1">
          No internet at the track? Run the whole race day from the RM Roost desktop app on your laptop.
        </p>
      </div>

      {isDesktopApp ? (
        <Card className="border-2 border-green-500/40">
          <CardContent className="pt-6 space-y-3">
            <p className="flex items-center gap-2 font-semibold">
              <CheckCircle2 size={18} className="text-green-500" /> You're in the desktop app. Offline mode is built in.
            </p>
            <p className="text-sm text-muted-foreground">
              Nothing else to install. To time without internet, open Reader Setup and choose "No, connect without internet".
            </p>
            <Button asChild className="gap-2">
              <Link href="/rfid/setup"><Radio size={16} /> Open Reader Setup</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-2 border-primary/25">
          <CardContent className="pt-6 space-y-4">
            <div>
              <p className="font-heading font-bold uppercase tracking-wider text-sm flex items-center gap-2">
                <Download size={16} className="text-primary" /> Download RM Roost for desktop
              </p>
              <p className="text-sm text-muted-foreground mt-1">Sign in with your RM Roost account after installing.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {platform === "mac" ? <>{macButtons}{windowsButton}</> : <>{windowsButton}{macButtons}</>}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <div key={title} className="rounded-xl border bg-card p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">{i + 1}</span>
              <Icon size={16} className="text-muted-foreground" />
            </div>
            <p className="font-semibold text-sm">{title}</p>
            <p className="text-xs text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
