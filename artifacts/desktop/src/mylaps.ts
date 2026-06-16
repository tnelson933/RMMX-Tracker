import net from "net";

// ── Public types ──────────────────────────────────────────────────────────────

export interface MyLapsStatus {
  connected: boolean;
  decoderIp: string | null;
  error: string | null;
  lastPassingAt: string | null;
  passingCount: number;
}

export type MyLapsPassingCallback = (transponder: string, crossingTime: Date) => void;

// ── AMBrc protocol constants ──────────────────────────────────────────────────
//
// The AMBrc binary protocol is used by AMB TranX 160/260, RC4, RC4-WA, MX,
// MyLaps X2, P3 Flex, and any decoder supported by AMBrc 4.x/5.x.
//
// Record format: 28 bytes
//   Byte  0:     STX (0x02)
//   Bytes 1–4:   Transponder number (32-bit unsigned, big-endian)
//   Bytes 5–8:   Passing time (1/100s since midnight, 32-bit big-endian)
//   Bytes 9–10:  Lap counter (16-bit big-endian)
//   Bytes 11–12: Hits counter (16-bit big-endian)
//   Byte  13:    Loop ID
//   Bytes 14–15: Decoder ID
//   Bytes 16–17: Signal strength
//   Bytes 18–19: Battery level (units: 10 mV)
//   Bytes 20–26: Reserved
//   Byte  27:    ETX (0x03)

const AMB_PORT = 3601;
const RECORD_SIZE = 28;
const STX = 0x02;
const ETX = 0x03;
const CONNECT_TIMEOUT_MS = 8_000;

// ── Module-level state ────────────────────────────────────────────────────────

let socket: net.Socket | null = null;
let decoderIp: string | null = null;
let lastPassingAt: string | null = null;
let passingCount = 0;
let connectError: string | null = null;
let recvBuf = Buffer.alloc(0);

// ── Public API ────────────────────────────────────────────────────────────────

export function getMyLapsStatus(): MyLapsStatus {
  return {
    connected: !!socket && !socket.destroyed,
    decoderIp,
    error: connectError,
    lastPassingAt,
    passingCount,
  };
}

export function connectDecoder(
  ip: string,
  onPassing: MyLapsPassingCallback,
): Promise<void> {
  disconnectDecoder();
  connectError = null;
  recvBuf = Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    const s = net.createConnection({
      host: ip,
      port: AMB_PORT,
      timeout: CONNECT_TIMEOUT_MS,
    });

    let resolved = false;

    s.once("connect", () => {
      socket = s;
      decoderIp = ip;
      connectError = null;
      resolved = true;
      resolve();
    });

    s.once("timeout", () => {
      const err = new Error(
        "Connection timed out — check that the decoder is powered on and reachable on this network.",
      );
      connectError = err.message;
      s.destroy();
      if (!resolved) reject(err);
    });

    s.on("data", (chunk: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      processBuffer(onPassing);
    });

    s.on("error", (err) => {
      connectError = err.message;
      if (!resolved) reject(err);
    });

    s.on("close", () => {
      if (socket === s) {
        socket = null;
      }
    });
  });
}

export function disconnectDecoder(): void {
  if (socket && !socket.destroyed) {
    socket.destroy();
  }
  socket = null;
  connectError = null;
}

// ── Internal: parse accumulated binary buffer ─────────────────────────────────

function processBuffer(onPassing: MyLapsPassingCallback): void {
  while (recvBuf.length >= RECORD_SIZE) {
    const stxIdx = recvBuf.indexOf(STX);

    if (stxIdx < 0) {
      recvBuf = Buffer.alloc(0);
      return;
    }

    if (stxIdx > 0) {
      recvBuf = recvBuf.subarray(stxIdx);
      continue;
    }

    if (recvBuf.length < RECORD_SIZE) break;

    const record = recvBuf.subarray(0, RECORD_SIZE);

    if (record[RECORD_SIZE - 1] !== ETX) {
      // Bad record boundary — skip this STX and search for the next
      recvBuf = recvBuf.subarray(1);
      continue;
    }

    const transponder = record.readUInt32BE(1);

    if (transponder > 0) {
      lastPassingAt = new Date().toISOString();
      passingCount++;
      // Use wall-clock time — more reliable for debounce/lap-gap calculations
      // than the decoder's centisecond-since-midnight field.
      onPassing(String(transponder), new Date());
    }

    recvBuf = recvBuf.subarray(RECORD_SIZE);
  }
}
