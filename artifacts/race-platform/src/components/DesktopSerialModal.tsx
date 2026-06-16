import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

interface SerialPortInfo {
  path: string;
  manufacturer?: string;
}

interface SerialStatus {
  connected: boolean;
  portPath?: string;
  tagCount?: number;
  error?: string;
}

function eAPI(): any {
  return (window as any).electronAPI ?? null;
}

export function DesktopSerialModal() {
  const [open, setOpen] = useState(false);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [baudRate, setBaudRate] = useState("9600");
  const [status, setStatus] = useState<SerialStatus | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "error" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = eAPI();
    if (!api) return;

    const handler = () => {
      setMsg(null);
      setSelectedPort("");

      api.serial.getStatus().then((s: SerialStatus) => setStatus(s)).catch(() => {});
      api.serial.listPorts().then((p: SerialPortInfo[]) => setPorts(p)).catch(() => {});
      setOpen(true);
    };

    window.addEventListener("rm-open-serial-settings", handler);
    return () => window.removeEventListener("rm-open-serial-settings", handler);
  }, []);

  if (!eAPI()) return null;

  const api = eAPI();

  const refreshStatus = async () => {
    try {
      const s = await api.serial.getStatus();
      setStatus(s);
    } catch {
      /* ignore */
    }
  };

  const handleConnect = async () => {
    if (!selectedPort) {
      setMsg({ text: "Select a port first.", kind: "error" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.serial.connect(selectedPort, Number(baudRate) || 9600);
      setMsg({ text: "Connected!", kind: "success" });
      await refreshStatus();
      setTimeout(() => setOpen(false), 1200);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      setMsg({ text: `Error: ${m}`, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.serial.disconnect();
      setMsg({ text: "Disconnected.", kind: "success" });
      await refreshStatus();
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      setMsg({ text: `Error: ${m}`, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const statusText = status
    ? status.connected
      ? `Connected: ${status.portPath ?? ""}  ·  ${status.tagCount ?? 0} tags read`
      : status.error
        ? `Error: ${status.error}`
        : "Not connected"
    : "Loading…";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>RFID Reader — Serial Port</DialogTitle>
          <DialogDescription>{statusText}</DialogDescription>
        </DialogHeader>

        {msg && (
          <div
            className={`rounded px-3 py-2 text-sm ${
              msg.kind === "error"
                ? "bg-destructive/10 text-destructive"
                : "bg-green-500/10 text-green-600 dark:text-green-400"
            }`}
          >
            {msg.text}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <Label>Port</Label>
            <Select value={selectedPort} onValueChange={setSelectedPort}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="— select port —" />
              </SelectTrigger>
              <SelectContent>
                {ports.map((p) => (
                  <SelectItem key={p.path} value={p.path}>
                    {p.path}{p.manufacturer ? ` (${p.manufacturer})` : ""}
                  </SelectItem>
                ))}
                {ports.length === 0 && (
                  <SelectItem value="_none" disabled>
                    No ports found
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="baud-rate">Baud rate</Label>
            <Input
              id="baud-rate"
              type="number"
              value={baudRate}
              onChange={(e) => setBaudRate(e.target.value)}
              min={1200}
              max={115200}
              className="mt-1"
            />
          </div>
        </div>

        <div className="flex justify-between gap-2 pt-1">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={busy || !status?.connected}
            >
              Disconnect
            </Button>
            <Button onClick={handleConnect} disabled={busy || !selectedPort}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
