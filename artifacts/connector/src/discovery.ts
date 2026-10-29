/**
 * Finds timing hardware on the laptop's local network. Both supported device
 * families listen on fixed TCP ports, so a short TCP connect sweep of each
 * network adapter's subnet finds them without any setup on the device:
 *   RM TrackR active timing reader — TCP 55555
 *   LLRP RFID readers (Impinj R700, Zebra FX7500/FX9600) — TCP 5084
 *
 * Only outgoing TCP connections are used, so the sweep never triggers a
 * firewall prompt (broadcast/UDP discovery would).
 */
import os from "os";
import net from "net";
import dns from "dns";

export const RM_TRACKR_PORT = 55555;
export const LLRP_PORT = 5084;

export type DeviceHardware = "impinj" | "zebra" | "generic" | "active_transponder";

export interface DiscoveredDevice {
  address: string;
  port: number;
  hardware: DeviceHardware;
  hostname: string | null;
  adapter: string;
}

export interface ScanResult {
  devices: DiscoveredDevice[];
  scannedHosts: number;
}

interface Adapter {
  name: string;
  address: string;
  prefixLength: number;
  kind: "private" | "link-local" | "other";
}

/**
 * Addresses worth checking even when they are outside every adapter's /24:
 * a reader's own fallback address (Impinj answers on 169.254.1.1 when it got no
 * address from a router) and a common fixed address (192.168.1.200). Readers are
 * meant to be on a router; these only help find one that was set up differently.
 */
const KNOWN_DEFAULT_ADDRESSES = ["169.254.1.1", "192.168.1.200"];

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function classify(ip: string): Adapter["kind"] {
  if (ip.startsWith("169.254.")) return "link-local";
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return "private";
  return "other";
}

function listAdapters(): Adapter[] {
  const adapters: Adapter[] = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      adapters.push({
        name,
        address: entry.address,
        prefixLength: ipToInt(entry.netmask).toString(2).replace(/0/g, "").length,
        kind: classify(entry.address),
      });
    }
  }
  return adapters;
}

/** Host addresses to sweep for one adapter: its own /24 at most. */
function hostsForAdapter(adapter: Adapter): string[] {
  if (adapter.kind === "other") return [];
  // A /16 (or a 169.254 link-local network) is far too big to sweep, so only
  // the /24 around this computer is checked; small race-day routers and
  // direct cables put devices there.
  const prefix = Math.max(adapter.prefixLength, 24);
  const size = 2 ** (32 - prefix);
  const network = (ipToInt(adapter.address) & (~0 << (32 - prefix))) >>> 0;
  const own = ipToInt(adapter.address);
  const hosts: string[] = [];
  for (let i = 1; i < size - 1; i++) {
    if (network + i !== own) hosts.push(intToIp(network + i));
  }
  return hosts;
}

/** Resolves true when a TCP connection to host:port opens within the timeout. */
export function probePort(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function reverseLookup(ip: string, timeoutMs = 1200): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    dns.reverse(ip, (err, names) => {
      clearTimeout(timer);
      resolve(err || !names?.length ? null : names[0]);
    });
  });
}

/**
 * Names the RFID reader model from its network name. Impinj readers call
 * themselves impinj-XX-XX-XX; Zebra readers usually include their model.
 * Anything else connects as a standard LLRP reader, which works for all of them.
 */
export function rfidHardwareFromHostname(hostname: string | null): DeviceHardware {
  if (hostname && /impinj/i.test(hostname)) return "impinj";
  if (hostname && /zebra|fx7500|fx9600/i.test(hostname)) return "zebra";
  return "generic";
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

/**
 * Sweeps every private and link-local adapter's subnet, plus the known
 * fallback addresses, for timing hardware. `skipAddresses` holds devices
 * this app is already connected to: a reader accepts only one client, so even
 * a probe could disturb a live session.
 */
export async function scanLocalNetwork(skipAddresses: string[] = []): Promise<ScanResult> {
  const skip = new Set(skipAddresses);
  const targets = new Map<string, string>(); // host → adapter name
  for (const adapter of listAdapters()) {
    for (const host of hostsForAdapter(adapter)) {
      if (!skip.has(host) && !targets.has(host)) targets.set(host, adapter.name);
    }
  }
  for (const host of KNOWN_DEFAULT_ADDRESSES) {
    if (!skip.has(host) && !targets.has(host)) targets.set(host, "default address");
  }

  const found: Array<{ address: string; port: number; adapter: string }> = [];
  const probes = [...targets].flatMap(([host, adapter]) => [
    { host, adapter, port: RM_TRACKR_PORT },
    { host, adapter, port: LLRP_PORT },
  ]);
  await runPool(probes, 128, async (probe) => {
    if (await probePort(probe.host, probe.port, 500)) {
      found.push({ address: probe.host, port: probe.port, adapter: probe.adapter });
    }
  });

  const devices = await Promise.all(found.map(async (f): Promise<DiscoveredDevice> => {
    const hostname = await reverseLookup(f.address);
    return {
      ...f,
      hostname,
      hardware: f.port === RM_TRACKR_PORT ? "active_transponder" : rfidHardwareFromHostname(hostname),
    };
  }));
  devices.sort((a, b) => ipToInt(a.address) - ipToInt(b.address) || a.port - b.port);
  return { devices, scannedHosts: targets.size };
}

/**
 * Checks one address or hostname, including mDNS names such as
 * impinj-xx-xx-xx.local that work without a DNS server.
 */
export async function probeAddress(input: string): Promise<{ resolved: string | null; devices: DiscoveredDevice[] }> {
  const raw = input.trim();
  const [hostPart, portPart] = raw.includes(":") && !raw.includes("::") ? raw.split(":") : [raw, ""];
  const host = /^[0-9a-f]{6}$/i.test(hostPart.replace(/[^0-9a-f]/gi, "")) && !hostPart.includes(".")
    ? `impinj-${hostPart.replace(/[^0-9a-f]/gi, "").match(/../g)!.join("-").toLowerCase()}.local`
    : hostPart;
  const resolved = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    dns.lookup(host, { family: 4 }, (err, address) => {
      clearTimeout(timer);
      resolve(err ? null : address);
    });
  });
  if (!resolved) return { resolved: null, devices: [] };
  const activePort = portPart && /^\d+$/.test(portPart) ? Number(portPart) : RM_TRACKR_PORT;
  const [active, llrp] = await Promise.all([
    probePort(resolved, activePort, 2000),
    probePort(resolved, LLRP_PORT, 2000),
  ]);
  const hostname = host !== resolved ? host : await reverseLookup(resolved);
  const devices: DiscoveredDevice[] = [];
  if (active) devices.push({ address: activePort === RM_TRACKR_PORT ? resolved : `${resolved}:${activePort}`, port: activePort, hardware: "active_transponder", hostname, adapter: "" });
  if (llrp) devices.push({ address: host.endsWith(".local") ? host : resolved, port: LLRP_PORT, hardware: rfidHardwareFromHostname(hostname), hostname, adapter: "" });
  return { resolved, devices };
}
