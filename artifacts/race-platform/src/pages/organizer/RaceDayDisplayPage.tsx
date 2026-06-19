import { useState } from "react";
import { Monitor, Copy, Check, ExternalLink, Tv2, ClipboardList, Radio } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

export default function RaceDayDisplayPage() {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);

  const clubId = user?.clubId;
  const displayUrl = clubId
    ? `${window.location.origin}/gate?club=${clubId}`
    : null;

  const handleCopy = async () => {
    if (!displayUrl) return;
    try {
      await navigator.clipboard.writeText(displayUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      const el = document.createElement("textarea");
      el.value = displayUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const handleOpen = () => {
    if (displayUrl) window.open(displayUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10">
          <Monitor size={22} className="text-primary" />
        </div>
        <div>
          <h1 className="font-heading font-bold text-2xl">Race Day Display</h1>
          <p className="text-sm text-muted-foreground">Live gate list for TV screens and announcer stations</p>
        </div>
      </div>

      {/* What it shows */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <p className="text-sm font-semibold text-foreground">What's on the display</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-3">
            <ClipboardList size={15} className="text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold">Gate Order</p>
              <p className="text-xs text-muted-foreground mt-0.5">Live list of riders at the gate, sorted by class and gate pick</p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-3">
            <Radio size={15} className="text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold">Moto Status</p>
              <p className="text-xs text-muted-foreground mt-0.5">Current moto name, class, and real-time race status</p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-3">
            <Tv2 size={15} className="text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold">TV Ready</p>
              <p className="text-xs text-muted-foreground mt-0.5">Full-screen layout built for large monitors and projectors</p>
            </div>
          </div>
        </div>
      </div>

      {/* The link */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div>
          <p className="text-sm font-semibold text-foreground">Display link</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Open this on any TV, laptop, or tablet at the track. Share it with announcers so they can pull it up on their own device.
          </p>
        </div>

        {displayUrl ? (
          <>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <span className="flex-1 font-mono text-xs text-foreground truncate select-all">{displayUrl}</span>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1.5 rounded-md border border-border bg-background hover:bg-muted transition-colors px-3 py-2 text-xs font-medium text-foreground"
              >
                {copied ? (
                  <>
                    <Check size={13} className="text-green-500" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy size={13} />
                    Copy Link
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleOpen}
                className="flex items-center gap-1.5 rounded-md bg-primary hover:bg-primary/90 transition-colors px-3 py-2 text-xs font-medium text-primary-foreground"
              >
                <ExternalLink size={13} />
                Open Display
              </button>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No club linked to your account. Contact support if this is unexpected.
          </p>
        )}
      </div>

      {/* Tips */}
      <div className="rounded-xl border border-border bg-muted/20 p-5 space-y-2">
        <p className="text-xs font-semibold text-foreground">Tips</p>
        <ul className="space-y-1.5 text-xs text-muted-foreground list-disc list-inside">
          <li>The display updates in real time — no refreshing needed</li>
          <li>Open it in full-screen mode on the TV browser (usually F11)</li>
          <li>The gate list only shows when a race day event is active</li>
          <li>Announcers can keep the link bookmarked for every race day</li>
        </ul>
      </div>
    </div>
  );
}
