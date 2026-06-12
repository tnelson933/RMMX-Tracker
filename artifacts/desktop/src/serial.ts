import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import type { SerialPortInfo, SerialStatus } from "./ipc-types";

export type TagReadCallback = (rfidNumber: string) => void;

let activePort: SerialPort | null = null;
let activePortPath: string | null = null;
let lastTagAt: string | null = null;
let tagCount = 0;
let connectError: string | null = null;

export async function listPorts(): Promise<SerialPortInfo[]> {
  try {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      pnpId: p.pnpId,
      locationId: p.locationId,
      productId: p.productId,
      vendorId: p.vendorId,
    }));
  } catch {
    return [];
  }
}

export function getSerialStatus(): SerialStatus {
  return {
    connected: activePort?.isOpen ?? false,
    portPath: activePortPath,
    error: connectError,
    lastTagAt,
    tagCount,
  };
}

export async function connectPort(
  portPath: string,
  baudRate: number = 9600,
  onTagRead: TagReadCallback,
): Promise<void> {
  disconnectPort();

  connectError = null;
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path: portPath, baudRate }, (err) => {
      if (err) {
        connectError = err.message;
        reject(err);
        return;
      }
      activePort = port;
      activePortPath = portPath;

      const parser = port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

      parser.on("data", (line: string) => {
        const tag = parseTagLine(line.trim());
        if (tag) {
          lastTagAt = new Date().toISOString();
          tagCount++;
          onTagRead(tag);
        }
      });

      port.on("error", (err) => {
        connectError = err.message;
      });

      port.on("close", () => {
        if (activePort === port) {
          activePort = null;
          activePortPath = null;
        }
      });

      resolve();
    });
  });
}

export function disconnectPort(): void {
  if (activePort?.isOpen) {
    activePort.close(() => {});
  }
  activePort = null;
  activePortPath = null;
  connectError = null;
}

function parseTagLine(line: string): string | null {
  if (!line) return null;

  // Hex EPC format: e.g. "E2001234567890AB" or "3000E20041411601"
  if (/^[0-9A-Fa-f]{8,24}$/.test(line)) {
    return line.toUpperCase();
  }

  // CSV / delimited: "tag,<hex>,<timestamp>" — common with some bridge scripts
  const parts = line.split(",");
  if (parts.length >= 2) {
    const candidate = parts[1].trim();
    if (/^[0-9A-Fa-f]{8,24}$/.test(candidate)) {
      return candidate.toUpperCase();
    }
  }

  // JSON: { "epc": "...", ... }
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const epc = obj.epc ?? obj.rfid ?? obj.tag ?? obj.id;
    if (typeof epc === "string" && /^[0-9A-Fa-f]{8,24}$/.test(epc)) {
      return epc.toUpperCase();
    }
  } catch {
    // not JSON
  }

  return null;
}
