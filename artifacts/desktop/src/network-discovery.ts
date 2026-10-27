import os from "os";
import net from "net";
import dns from "dns";

// Finds timing hardware on the local network without any internet access.
// Both supported device families listen on fixed TCP ports, so a short TCP
// connect sweep of this computer's subnet finds them:
//   F2000 active timing reader — TCP 55555
//   LLRP RFID readers (Impinj R700, Zebra FX7500/FX9600) — TCP 5084

export const F2000_PORT = 55555;
export const LLRP_PORT = 5084;

export type DeviceKind = "active_transponder" | "rfid";

export interface NetworkAdapter {
  name: string;
  address: string;
  netmask: string;
  prefixLength: number;
  /** "link-local" = 169.254.x.x: the OS found no DHCP server (direct cable). */
  kind: "private" | "link-local" | "other";
}

export interface NetworkInfo {
  adapters: NetworkAdapter[];
  internet: boolean;
}

export interface DiscoveredDevice {
  address: string;
  port: number;
  kind: DeviceKind;
  hostname: string | null;
  adapter: string;
}

export interface ScanResult {
  devices: DiscoveredDevice[];
  scannedHosts: number;
  /** Adapters that were skipped because their subnet is too large to sweep. */
  skippedAdapters: string[];
}

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function prefixFromNetmask(mask: string): number {
  return ipToInt(mask).toString(2).replace(/0/g, "").length;
}

function classify(ip: string): NetworkAdapter["kind"] {
  if (ip.startsWith("169.254.")) return "link-local";
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return "private";
  return "other";
}

export function listAdapters(): NetworkAdapter[] {
  const adapters: NetworkAdapter[] = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      adapters.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        prefixLength: prefixFromNetmask(entry.netmask),
        kind: classify(entry.address),
      });
    }
  }
  return adapters;
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

/** Best-effort internet check: any public TCP endpoint answering means online. */
export async function checkInternet(): Promise<boolean> {
  const checks = await Promise.all([
    probePort("1.1.1.1", 443, 2500),
    probePort("8.8.8.8", 53, 2500),
  ]);
  return checks.some(Boolean);
}

export async function getNetworkInfo(): Promise<NetworkInfo> {
  return { adapters: listAdapters(), internet: await checkInternet() };
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

/** Host addresses to sweep for one adapter; null when the subnet is too big. */
function hostsForAdapter(adapter: NetworkAdapter): string[] | null {
  if (adapter.kind !== "private") return null;
  // Larger subnets (e.g. /16) are swept only around this computer's own /24,
  // which is where small race-day routers hand out addresses.
  const prefix = Math.max(adapter.prefixLength, 24);
  const size = 2 ** (32 - prefix);
  const network = (ipToInt(adapter.address) & (prefix === 0 ? 0 : (~0 << (32 - prefix)))) >>> 0;
  const own = ipToInt(adapter.address);
  const hosts: string[] = [];
  for (let i = 1; i < size - 1; i++) {
    const host = network + i;
    if (host !== own) hosts.push(intToIp(host));
  }
  return hosts;
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

/**
 * Sweeps every private adapter's subnet for timing hardware. `skipAddresses`
 * holds readers this app is already connected to: some readers accept only
 * one client, so a probe could interrupt a live session.
 */
export async function scanLocalNetwork(skipAddresses: string[] = []): Promise<ScanResult> {
  const skip = new Set(skipAddresses);
  const targets: Array<{ host: string; adapter: string }> = [];
  const skippedAdapters: string[] = [];
  for (const adapter of listAdapters()) {
    const hosts = hostsForAdapter(adapter);
    if (!hosts) {
      if (adapter.kind === "link-local") skippedAdapters.push(adapter.name);
      continue;
    }
    for (const host of hosts) if (!skip.has(host)) targets.push({ host, adapter: adapter.name });
  }

  const devices: DiscoveredDevice[] = [];
  const probes = targets.flatMap(t => [
    { ...t, port: F2000_PORT, kind: "active_transponder" as const },
    { ...t, port: LLRP_PORT, kind: "rfid" as const },
  ]);
  await runPool(probes, 128, async (probe) => {
    if (await probePort(probe.host, probe.port, 500)) {
      devices.push({ address: probe.host, port: probe.port, kind: probe.kind, hostname: null, adapter: probe.adapter });
    }
  });
  await Promise.all(devices.map(async d => { d.hostname = await reverseLookup(d.address); }));
  devices.sort((a, b) => ipToInt(a.address) - ipToInt(b.address));
  return { devices, scannedHosts: targets.length, skippedAdapters };
}

/**
 * Checks one address or hostname (including mDNS names such as
 * impinj-xx-xx-xx.local, which work without a DNS server) for either device.
 */
export async function probeDevice(host: string): Promise<{ resolved: string | null; kinds: DeviceKind[] }> {
  const trimmed = host.trim();
  const resolved = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    dns.lookup(trimmed, { family: 4 }, (err, address) => {
      clearTimeout(timer);
      resolve(err ? null : address);
    });
  });
  if (!resolved) return { resolved: null, kinds: [] };
  const [f2000, llrp] = await Promise.all([
    probePort(resolved, F2000_PORT, 2000),
    probePort(resolved, LLRP_PORT, 2000),
  ]);
  const kinds: DeviceKind[] = [];
  if (f2000) kinds.push("active_transponder");
  if (llrp) kinds.push("rfid");
  return { resolved, kinds };
}
