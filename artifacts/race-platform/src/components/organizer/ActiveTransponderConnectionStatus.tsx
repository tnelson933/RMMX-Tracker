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
}

export function ActiveTransponderConnectionStatus({ className = "" }: { className?: string }) {
  const isDesktop = typeof (window as any).electronAPI !== "undefined";
  const [activeStatus, setActiveStatus] = useState<ActiveTransponderStatus | null>(null);

  // Desktop direct mode
  useEffect(() => {
    if (!isDesktop) return;
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
  let loops: { l1: boolean; l2: boolean } | null = null;
  let battery: number | null = null;

  if (isDesktop && activeStatus) {
    isConnected = activeStatus.connected;
    hasError = !!activeStatus.error;
    readCount = activeStatus.passingCount;
    battery = activeStatus.batteryPercent;
    if (activeStatus.reader1Working != null) {
      loops = {
        l1: activeStatus.reader1Working === "1",
        l2: activeStatus.reader2Working === "1"
      };
    }
  } else if (!isDesktop && activeConnector) {
    isConnected = activeConnector.hardware.connected;
    readCount = activeConnector.hardware.readCount;
    try {
      if (activeConnector.hardware.detail) {
        const detail = JSON.parse(activeConnector.hardware.detail);
        if (detail.batteryPercent != null) battery = detail.batteryPercent;
        if (detail.reader1Working != null) {
          loops = {
            l1: detail.reader1Working === "1",
            l2: detail.reader2Working === "1"
          };
        }
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
    <Link href="/rfid/setup" className={`inline-flex items-center gap-3 rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-muted/50 ${isConnected ? (hasError ? "border-amber-500/30 bg-amber-500/5 text-amber-700" : "border-green-500/30 bg-green-500/5 text-green-700") : "border-red-500/30 bg-red-500/5 text-red-700"} ${className}`}>
      <div className="flex items-center gap-1.5 font-medium">
        {isConnected ? <CheckCircle2 size={14} className={hasError ? "text-amber-500" : "text-green-500"} /> : <XCircle size={14} className="text-red-500" />}
        <span>{isConnected ? "F2000" : "Active Timing Reader Disconnected"}</span>
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
              <div className="flex items-center gap-1 ml-1" title={`Loops: L1 ${loops.l1 ? 'OK' : 'FAIL'}, L2 ${loops.l2 ? 'OK' : 'FAIL'}`}>
                <Radio size={12} />
                <span className={!loops.l1 || !loops.l2 ? "text-amber-600 font-bold" : ""}>
                  {loops.l1 ? "L1" : <del>L1</del>}/{loops.l2 ? "L2" : <del>L2</del>}
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </Link>
  );
}