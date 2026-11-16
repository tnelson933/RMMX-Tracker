import { useState, useEffect } from "react";
import { Link } from "wouter";
import { CheckCircle2, XCircle, Radio, Activity, Battery, AlertCircle, Settings } from "lucide-react";
import { useGetConnectorStatus } from "@workspace/api-client-react";

interface ActiveTransponderStatus {
  connected: boolean;
  deviceIp: string | null;
  machineId: string | null;
  error: string | null;
  lastPassingAt: string | null;
  passingCount: number;
  lastHeartbeatAt: string | null;
  batteryPercent: number | null;
  reader1Working: string | null;
  reader2Working: string | null;
  loopEnabled?: [boolean, boolean];
  loopsReading?: boolean;
  state?: string;
}

/** One reader from the desktop app's reader list (it can connect several at once). */
interface DesktopReader {
  id: string;
  name: string;
  kind: "rm_trackr" | "rfid";
  state: string;
  connected: boolean;
  error: string | null;
  readCount: number;
  active: ActiveTransponderStatus | null;
}

/**
 * Loops as set in RM TrackR settings; a transponder pass proves they read.
 * The reader's own loop status isn't used: some firmware reports a loop as
 * 0 (off) while it reads.
 */
type LoopShow = "reading" | "waiting" | "unused";
function loopShows(status: { loopEnabled?: [boolean, boolean]; loopsReading?: boolean }): { l1: LoopShow; l2: LoopShow } {
  const show = (enabled: boolean | undefined): LoopShow => enabled === false ? "unused" : status.loopsReading ? "reading" : "waiting";
  return { l1: show(status.loopEnabled?.[0]), l2: show(status.loopEnabled?.[1]) };
}

export function ActiveTransponderConnectionStatus({ className = "" }: { className?: string }) {
  const isDesktop = typeof (window as any).electronAPI !== "undefined";
  const [activeStatus, setActiveStatus] = useState<ActiveTransponderStatus | null>(null);

  const [desktopReaders, setDesktopReaders] = useState<DesktopReader[] | null>(null);

  // Desktop direct mode
  useEffect(() => {
    if (!isDesktop) return;
    const readersApi = (window as any).electronAPI?.readers;
    if (readersApi) {
      // Several RM TrackRs can be connected at once.
      const keep = (list: DesktopReader[]) => setDesktopReaders(list.filter(r => r.kind === "rm_trackr"));
      readersApi.list().then(keep).catch(() => {});
      const offChanged = readersApi.onChanged(keep);
      const offStatus = readersApi.onStatus((status: DesktopReader) =>
        setDesktopReaders(prev => prev ? prev.map(r => (r.id === status.id ? status : r)) : prev));
      return () => { offChanged(); offStatus(); };
    }
    const api = (window as any).electronAPI?.activeTransponder;
    if (!api) return;
    api.getStatus().then(setActiveStatus).catch(() => {});
    return api.onStatus(setActiveStatus);
  }, [isDesktop]);

  // Cloud/Connector mode
  const { data: connectorStatuses = [] } = useGetConnectorStatus({
    query: { refetchInterval: 5000, enabled: !isDesktop } as any,
  });

  const activeConnector = !isDesktop ? connectorStatuses.find(c => c.readerType === "active_transponder") : null;

  // Derive unified state
  let isConnected = false;
  let hasError = false;
  let readCount = 0;
  let loops: { l1: LoopShow; l2: LoopShow } | null = null;
  let battery: number | null = null;

  // Not connected yet, but the app keeps trying by itself: a warning, not an error.
  let isRetrying = false;
  let readerSummary: string | null = null;

  if (isDesktop && desktopReaders && desktopReaders.length > 1) {
    const connectedCount = desktopReaders.filter(r => r.connected).length;
    isConnected = connectedCount > 0;
    hasError = desktopReaders.some(r => r.state === "error") || connectedCount < desktopReaders.length;
    isRetrying = connectedCount === 0 && desktopReaders.some(r => r.state === "retrying" || r.state === "connecting");
    readCount = desktopReaders.reduce((sum, r) => sum + r.readCount, 0);
    readerSummary = `${connectedCount} of ${desktopReaders.length} connected`;
  } else if (isDesktop && desktopReaders && desktopReaders.length === 1 && desktopReaders[0].active) {
    const only = desktopReaders[0];
    const status = only.active!;
    isConnected = only.connected;
    hasError = only.state === "error";
    isRetrying = !only.connected && (only.state === "retrying" || only.state === "connecting");
    readCount = status.passingCount;
    battery = status.batteryPercent;
    if (only.connected) loops = loopShows(status);
  } else if (isDesktop && activeStatus) {
    isConnected = activeStatus.connected;
    hasError = !!activeStatus.error;
    isRetrying = !activeStatus.connected && (activeStatus.state === "reconnecting" || activeStatus.state === "connecting");
    readCount = activeStatus.passingCount;
    battery = activeStatus.batteryPercent;
    if (activeStatus.connected) loops = loopShows(activeStatus);
  } else if (!isDesktop && activeConnector) {
    isConnected = activeConnector.hardware.connected;
    readCount = activeConnector.hardware.readCount;
    try {
      if (activeConnector.hardware.detail) {
        const detail = JSON.parse(activeConnector.hardware.detail);
        if (detail.batteryPercent != null) battery = detail.batteryPercent;
        void detail;
      }
    } catch {
      // Ignore parse error
    }
  }

  // When not connected and not desktop, and no active connector exists, we assume we need setup.
  if (!isConnected && !hasError && !isDesktop && !activeConnector) {
    return (
      <Link href="/rfid/setup" className={`inline-flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-500/20 transition-colors ${className}`}>
        <AlertCircle size={14} className="shrink-0" />
        <span className="font-medium">Active Timing Reader Disconnected</span>
        <Settings size={12} className="ml-1 opacity-70" />
      </Link>
    );
  }

  return (
    <Link href="/rfid/setup" className={`inline-flex items-center gap-3 rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-muted/50 ${isConnected ? (hasError ? "border-amber-500/30 bg-amber-500/5 text-amber-700" : "border-green-500/30 bg-green-500/5 text-green-700") : isRetrying ? "border-amber-500/30 bg-amber-500/5 text-amber-700" : "border-red-500/30 bg-red-500/5 text-red-700"} ${className}`}>
      <div className="flex items-center gap-1.5 font-medium">
        {isConnected ? <CheckCircle2 size={14} className={hasError ? "text-amber-500" : "text-green-500"} /> : isRetrying ? <AlertCircle size={14} className="text-amber-500" /> : <XCircle size={14} className="text-red-500" />}
        <span>{isConnected ? (readerSummary ? `RM TrackR · ${readerSummary}` : "RM TrackR") : isRetrying ? "RM TrackR not connected, retrying" : "Active Timing Reader Disconnected"}</span>
      </div>

      {isConnected && (
        <>
          <div className="w-px h-3 bg-border" />
          <div className="flex items-center gap-2 opacity-80 text-[11px]">
            <div className="flex items-center gap-1" title="Crossings">
              <Activity size={12} />
              <span className="tabular-nums">{readCount}</span>
            </div>

            {battery != null && (
              <div className="flex items-center gap-1 ml-1" title={`Battery: ${battery}%`}>
                <Battery size={12} />
                <span>{battery}%</span>
              </div>
            )}

            {loops && (
              <div className="flex items-center gap-1 ml-1" title={`Loop 1 ${loops.l1 === "waiting" ? "on, waiting for a pass" : loops.l1 === "unused" ? "not used" : "reading"} · Loop 2 ${loops.l2 === "waiting" ? "on, waiting for a pass" : loops.l2 === "unused" ? "not used" : "reading"}`}>
                <Radio size={12} />
                <span>
                  {[loops.l1 !== "unused" ? "L1" : null, loops.l2 !== "unused" ? "L2" : null].filter(Boolean).join("/")}
                  {loops.l1 !== "reading" && loops.l2 !== "reading" && <span className="text-muted-foreground"> · waiting for a pass</span>}
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </Link>
  );
}