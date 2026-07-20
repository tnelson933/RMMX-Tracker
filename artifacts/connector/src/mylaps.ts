/**
 * MyLaps / AMB decoder bridge — AMBrc binary protocol over TCP port 3601.
 *
 * Record format: 28 bytes
 *   Byte  0:     STX (0x02)
 *   Bytes 1–4:   Transponder number (32-bit unsigned, big-endian)
 *   Bytes 5–8:   Passing time (1/100s since midnight, 32-bit big-endian)
 *   Bytes 9–10:  Lap counter
 *   Bytes 11–12: Hits counter
 *   Byte  13:    Loop ID
 *   Bytes 14–15: Decoder ID
 *   Bytes 16–17: Signal strength
 *   Bytes 18–19: Battery level
 *   Bytes 20–26: Reserved
 *   Byte  27:    ETX (0x03)
 */
import net from "net";
import { EventEmitter } from "events";

const AMB_PORT = 3601;
const RECORD_SIZE = 28;
const STX = 0x02;
const ETX = 0x03;
const CONNECT_TIMEOUT_MS = 8_000;

export interface MyLapsStatus {
  connected: boolean;
  decoderIp: string | null;
  error: string | null;
  lastPassingAt: string | null;
  passingCount: number;
}

/**
 * Events:
 *   "passing"      (transponder: string, crossingTime: Date)
 *   "connected"    ()
 *   "disconnected" (reason: string)
 */
export class MyLapsClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private decoderIp: string | null = null;
  private lastPassingAt: string | null = null;
  private passingCount = 0;
  private lastError: string | null = null;
  private recvBuf = Buffer.alloc(0);
  private closingIntentionally = false;

  getStatus(): MyLapsStatus {
    return {
      connected: !!this.socket && !this.socket.destroyed,
      decoderIp: this.decoderIp,
      error: this.lastError,
      lastPassingAt: this.lastPassingAt,
      passingCount: this.passingCount,
    };
  }

  connect(ip: string): Promise<void> {
    this.disconnect();
    this.closingIntentionally = false;
    this.lastError = null;
    this.recvBuf = Buffer.alloc(0);

    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: ip, port: AMB_PORT, timeout: CONNECT_TIMEOUT_MS });
      let resolved = false;

      s.once("connect", () => {
        s.setTimeout(0);
        this.socket = s;
        this.decoderIp = ip;
        this.lastError = null;
        resolved = true;
        this.emit("connected");
        resolve();
      });

      s.once("timeout", () => {
        const err = new Error("Connection timed out — check that the decoder is powered on and reachable on this network.");
        this.lastError = err.message;
        s.destroy();
        if (!resolved) reject(err);
      });

      s.on("data", (chunk: Buffer) => {
        this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
        this.processBuffer();
      });

      s.on("error", (err) => {
        this.lastError = err.message;
        if (!resolved) reject(err);
      });

      s.on("close", () => {
        const wasIntentional = this.closingIntentionally;
        if (this.socket === s) this.socket = null;
        if (!wasIntentional && resolved) {
          this.emit("disconnected", this.lastError ?? "Connection lost");
        }
      });
    });
  }

  disconnect(): void {
    this.closingIntentionally = true;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }

  private processBuffer(): void {
    while (this.recvBuf.length >= RECORD_SIZE) {
      const stxIdx = this.recvBuf.indexOf(STX);

      if (stxIdx < 0) {
        this.recvBuf = Buffer.alloc(0);
        return;
      }
      if (stxIdx > 0) {
        this.recvBuf = this.recvBuf.subarray(stxIdx);
        continue;
      }
      if (this.recvBuf.length < RECORD_SIZE) break;

      const record = this.recvBuf.subarray(0, RECORD_SIZE);

      if (record[RECORD_SIZE - 1] !== ETX) {
        this.recvBuf = this.recvBuf.subarray(1);
        continue;
      }

      const transponder = record.readUInt32BE(1);
      if (transponder > 0) {
        this.lastPassingAt = new Date().toISOString();
        this.passingCount++;
        // Wall-clock time — consistent with the cloud webhook path
        this.emit("passing", String(transponder), new Date());
      }

      this.recvBuf = this.recvBuf.subarray(RECORD_SIZE);
    }
  }
}
