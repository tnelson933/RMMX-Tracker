/**
 * Minimal LLRP (Low Level Reader Protocol v1.0.1) client for the Impinj R700.
 *
 * Zero external dependencies — implements just the subset of LLRP needed to:
 *   - connect to the reader on TCP port 5084 (reader is the TCP server)
 *   - enable Impinj vendor extensions
 *   - configure a periodic keepalive
 *   - add/enable a single continuous-inventory ROSpec (all antennas)
 *   - start/stop that ROSpec on command
 *   - decode RO_ACCESS_REPORT tag reports (EPC hex, antenna, RSSI)
 *
 * LLRP framing: every message is
 *   [ u16: rsvd(3) + version(3) + messageType(10) ]
 *   [ u32: total length including this 10-byte header ]
 *   [ u32: message ID ]
 *   [ payload: parameters ]
 *
 * TLV parameter: [ u16: rsvd(6)+type(10) ][ u16: length incl 4-byte header ][ body ]
 * TV  parameter: [ u8: 0x80 | type ][ fixed-length body ]
 */
import net from "net";
import { EventEmitter } from "events";

// ── Message types ─────────────────────────────────────────────────────────────
const MSG = {
  GET_READER_CAPABILITIES: 1,
  SET_READER_CONFIG: 3,
  SET_READER_CONFIG_RESPONSE: 13,
  CLOSE_CONNECTION: 14,
  ADD_ROSPEC: 20,
  DELETE_ROSPEC: 21,
  START_ROSPEC: 22,
  STOP_ROSPEC: 23,
  ENABLE_ROSPEC: 24,
  ADD_ROSPEC_RESPONSE: 30,
  DELETE_ROSPEC_RESPONSE: 31,
  START_ROSPEC_RESPONSE: 32,
  STOP_ROSPEC_RESPONSE: 33,
  ENABLE_ROSPEC_RESPONSE: 34,
  RO_ACCESS_REPORT: 61,
  KEEPALIVE: 62,
  READER_EVENT_NOTIFICATION: 63,
  ENABLE_EVENTS_AND_REPORTS: 64,
  KEEPALIVE_ACK: 72,
  ERROR_MESSAGE: 100,
  CUSTOM_MESSAGE: 1023,
} as const;

// ── Parameter types (TLV) ─────────────────────────────────────────────────────
const PARAM = {
  ROSpec: 177,
  ROBoundarySpec: 178,
  ROSpecStartTrigger: 179,
  ROSpecStopTrigger: 182,
  AISpec: 183,
  AISpecStopTrigger: 184,
  InventoryParameterSpec: 186,
  KeepaliveSpec: 220,
  ROReportSpec: 237,
  TagReportContentSelector: 238,
  TagReportData: 240,
  EPCData: 241,
  ConnectionAttemptEvent: 256,
  LLRPStatus: 287,
  C1G2EPCMemorySelector: 348,
} as const;

// TV parameter types found inside TagReportData
const TV = {
  AntennaID: 1,
  FirstSeenTimestampUTC: 2,
  FirstSeenTimestampUptime: 3,
  LastSeenTimestampUTC: 4,
  LastSeenTimestampUptime: 5,
  PeakRSSI: 6,
  ChannelIndex: 7,
  TagSeenCount: 8,
  ROSpecID: 9,
  InventoryParameterSpecID: 10,
  C1G2CRC: 11,
  C1G2PC: 12,
  EPC96: 13,
  SpecIndex: 14,
  ClientRequestOpSpecResult: 15,
  AccessSpecID: 16,
} as const;

// Fixed body lengths (bytes) for TV params, keyed by type
const TV_LENGTHS: Record<number, number> = {
  [TV.AntennaID]: 2,
  [TV.FirstSeenTimestampUTC]: 8,
  [TV.FirstSeenTimestampUptime]: 8,
  [TV.LastSeenTimestampUTC]: 8,
  [TV.LastSeenTimestampUptime]: 8,
  [TV.PeakRSSI]: 1,
  [TV.ChannelIndex]: 2,
  [TV.TagSeenCount]: 2,
  [TV.ROSpecID]: 4,
  [TV.InventoryParameterSpecID]: 2,
  [TV.C1G2CRC]: 2,
  [TV.C1G2PC]: 2,
  [TV.EPC96]: 12,
  [TV.SpecIndex]: 2,
  [TV.ClientRequestOpSpecResult]: 2,
  [TV.AccessSpecID]: 4,
};

const IMPINJ_VENDOR_ID = 25882;
const IMPINJ_ENABLE_EXTENSIONS_SUBTYPE = 21;

const LLRP_PORT = 5084;
const ROSPEC_ID = 14150;
const CONNECT_TIMEOUT_MS = 10_000;
const RESPONSE_TIMEOUT_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 10_000;

// ── Encoding helpers ──────────────────────────────────────────────────────────

function message(type: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(0x0400 | type, 0); // version 1, type
  header.writeUInt32BE(10 + payload.length, 2);
  header.writeUInt32BE(id, 6);
  return Buffer.concat([header, payload]);
}

function tlv(type: number, body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type & 0x03ff, 0);
  header.writeUInt16BE(body.length + 4, 2);
  return Buffer.concat([header, body]);
}

function u8(v: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(v, 0);
  return b;
}
function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v, 0);
  return b;
}

// ── ROSpec construction ───────────────────────────────────────────────────────

/**
 * A single continuous ROSpec:
 *   - starts only when START_ROSPEC is sent (null start trigger)
 *   - runs until STOP_ROSPEC (null stop triggers)
 *   - all antennas (antenna id 0)
 *   - reports every tag observation immediately (N=1)
 *   - report contents: AntennaID + PeakRSSI + FirstSeenTimestampUTC
 */
function buildROSpec(): Buffer {
  const roSpecStartTrigger = tlv(PARAM.ROSpecStartTrigger, u8(0)); // null
  const roSpecStopTrigger = tlv(PARAM.ROSpecStopTrigger, Buffer.concat([u8(0), u32(0)])); // null
  const roBoundarySpec = tlv(PARAM.ROBoundarySpec, Buffer.concat([roSpecStartTrigger, roSpecStopTrigger]));

  const aiSpecStopTrigger = tlv(PARAM.AISpecStopTrigger, Buffer.concat([u8(0), u32(0)])); // null
  const inventoryParameterSpec = tlv(
    PARAM.InventoryParameterSpec,
    Buffer.concat([u16(1) /* spec id */, u8(1) /* EPCGlobalClass1Gen2 */]),
  );
  const aiSpec = tlv(
    PARAM.AISpec,
    Buffer.concat([
      u16(1), // antenna count
      u16(0), // antenna id 0 = all antennas
      aiSpecStopTrigger,
      inventoryParameterSpec,
    ]),
  );

  // TagReportContentSelector bitfield (u16, MSB-first):
  //   bit15 EnableROSpecID, bit14 EnableSpecIndex, bit13 EnableInventoryParameterSpecID,
  //   bit12 EnableAntennaID, bit11 EnableChannelIndex, bit10 EnablePeakRSSI,
  //   bit9  EnableFirstSeenTimestamp, bit8 EnableLastSeenTimestamp,
  //   bit7  EnableTagSeenCount, bit6 EnableAccessSpecID
  const contentBits = (1 << 12) | (1 << 10) | (1 << 9);
  const epcMemorySelector = tlv(PARAM.C1G2EPCMemorySelector, u8(0)); // no CRC, no PC bits
  const contentSelector = tlv(
    PARAM.TagReportContentSelector,
    Buffer.concat([u16(contentBits), epcMemorySelector]),
  );
  const roReportSpec = tlv(
    PARAM.ROReportSpec,
    Buffer.concat([
      u8(1), // trigger: upon N TagReportData or end of AISpec
      u16(1), // N = 1 → report immediately
      contentSelector,
    ]),
  );

  const roSpecBody = Buffer.concat([
    u32(ROSPEC_ID),
    u8(0), // priority
    u8(0), // current state: disabled
    roBoundarySpec,
    aiSpec,
    roReportSpec,
  ]);

  return tlv(PARAM.ROSpec, roSpecBody);
}

// ── Parameter parsing ─────────────────────────────────────────────────────────

interface ParsedParam {
  type: number;
  body: Buffer;
}

/** Parse a flat run of TLV parameters (skips unparseable tails safely). */
function parseTLVs(buf: Buffer): ParsedParam[] {
  const params: ParsedParam[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const first = buf[pos];
    if (first & 0x80) {
      // TV parameter
      const type = first & 0x7f;
      const len = TV_LENGTHS[type];
      if (len === undefined || pos + 1 + len > buf.length) break;
      params.push({ type, body: buf.subarray(pos + 1, pos + 1 + len) });
      pos += 1 + len;
      continue;
    }
    const type = buf.readUInt16BE(pos) & 0x03ff;
    const len = buf.readUInt16BE(pos + 2);
    if (len < 4 || pos + len > buf.length) break;
    params.push({ type, body: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return params;
}

/** Depth-first search for a TLV parameter type anywhere in a parameter tree. */
function findParam(buf: Buffer, type: number): Buffer | null {
  for (const p of parseTLVs(buf)) {
    if (p.type === type) return p.body;
    if (p.body.length >= 4) {
      const inner = findParam(p.body, type);
      if (inner) return inner;
    }
  }
  return null;
}

export interface TagRead {
  epcHex: string;
  antennaId: number | null;
  peakRssi: number | null;
  firstSeenUtcMicros: bigint | null;
}

function parseTagReportData(body: Buffer): TagRead | null {
  let epcHex: string | null = null;
  let antennaId: number | null = null;
  let peakRssi: number | null = null;
  let firstSeenUtcMicros: bigint | null = null;

  for (const p of parseTLVs(body)) {
    if (p.type === PARAM.EPCData) {
      // u16 bit length, then EPC bytes
      if (p.body.length >= 2) {
        const bitLen = p.body.readUInt16BE(0);
        const byteLen = Math.ceil(bitLen / 8);
        epcHex = p.body.subarray(2, 2 + byteLen).toString("hex").toUpperCase();
      }
    } else if (p.type === TV.EPC96 && p.body.length === 12) {
      epcHex = p.body.toString("hex").toUpperCase();
    } else if (p.type === TV.AntennaID) {
      antennaId = p.body.readUInt16BE(0);
    } else if (p.type === TV.PeakRSSI) {
      peakRssi = p.body.readInt8(0);
    } else if (p.type === TV.FirstSeenTimestampUTC) {
      firstSeenUtcMicros = p.body.readBigUInt64BE(0);
    }
  }

  if (!epcHex) return null;
  return { epcHex, antennaId, peakRssi, firstSeenUtcMicros };
}

/** Extract the LLRPStatus code from a response body. 0 = M_Success. */
function statusCode(body: Buffer): number | null {
  const status = findParam(body, PARAM.LLRPStatus);
  if (!status || status.length < 2) return null;
  return status.readUInt16BE(0);
}

// ── Client ────────────────────────────────────────────────────────────────────

export interface LlrpStatus {
  connected: boolean;
  reading: boolean;
  host: string | null;
  error: string | null;
  lastReadAt: string | null;
  readCount: number;
}

/**
 * Events:
 *   "tag"          (read: TagRead)         — every decoded tag observation
 *   "connected"    ()                      — LLRP session established + ROSpec loaded
 *   "disconnected" (reason: string)        — socket closed / lost
 *   "error"        (err: Error)
 */
export class LlrpClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private recvBuf = Buffer.alloc(0);
  private nextMessageId = 1;
  private pending = new Map<number, { resolve: (body: Buffer) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private host: string | null = null;
  private reading = false;
  private lastReadAt: string | null = null;
  private readCount = 0;
  private lastError: string | null = null;
  private closingIntentionally = false;

  getStatus(): LlrpStatus {
    return {
      connected: !!this.socket && !this.socket.destroyed,
      reading: this.reading,
      host: this.host,
      error: this.lastError,
      lastReadAt: this.lastReadAt,
      readCount: this.readCount,
    };
  }

  /**
   * Connect to the reader and prepare (but do not start) the inventory ROSpec.
   * `host` may be an IP or an mDNS hostname like impinj-XX-XX-XX.local.
   */
  async connect(host: string): Promise<void> {
    await this.disconnect();
    this.closingIntentionally = false;
    this.lastError = null;
    this.recvBuf = Buffer.alloc(0);

    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host, port: LLRP_PORT, timeout: CONNECT_TIMEOUT_MS });

      const onError = (err: Error) => {
        this.lastError = err.message;
        s.destroy();
        reject(err);
      };

      s.once("connect", () => {
        s.setTimeout(0); // connection established — disable idle timeout
        s.setNoDelay(true);
        this.socket = s;
        this.host = host;
        resolve();
      });
      s.once("timeout", () => onError(new Error(`Connection to ${host}:${LLRP_PORT} timed out — check the reader is powered on, on this network, and set to LLRP mode.`)));
      s.once("error", onError);

      s.on("data", (chunk: Buffer) => this.onData(chunk));
      s.on("close", () => {
        const wasIntentional = this.closingIntentionally;
        if (this.socket === s) {
          this.socket = null;
          this.reading = false;
        }
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("Connection closed"));
        }
        this.pending.clear();
        if (!wasIntentional) {
          this.emit("disconnected", this.lastError ?? "Connection lost");
        }
      });
    });

    // Wait for the reader's ConnectionAttemptEvent (READER_EVENT_NOTIFICATION).
    // Status 0 = success; anything else means another client holds the connection.
    await this.waitForConnectionAttemptEvent();

    // Handshake sequence
    await this.enableImpinjExtensions();
    await this.setKeepalive();
    await this.deleteAllROSpecs();
    await this.addROSpec();
    await this.enableROSpec();
    this.send(message(MSG.ENABLE_EVENTS_AND_REPORTS, this.nextMessageId++));

    this.emit("connected");
  }

  async disconnect(): Promise<void> {
    this.closingIntentionally = true;
    if (this.socket && !this.socket.destroyed) {
      try {
        this.send(message(MSG.CLOSE_CONNECTION, this.nextMessageId++));
      } catch {
        // best effort
      }
      this.socket.destroy();
    }
    this.socket = null;
    this.reading = false;
  }

  /** Begin inventory — tags start streaming. */
  async startReading(): Promise<void> {
    this.ensureConnected();
    const body = await this.request(MSG.START_ROSPEC, u32(ROSPEC_ID));
    const code = statusCode(body);
    if (code !== 0) throw new Error(`START_ROSPEC failed (LLRP status ${code})`);
    this.reading = true;
  }

  /** Stop inventory. */
  async stopReading(): Promise<void> {
    this.ensureConnected();
    const body = await this.request(MSG.STOP_ROSPEC, u32(ROSPEC_ID));
    const code = statusCode(body);
    if (code !== 0) throw new Error(`STOP_ROSPEC failed (LLRP status ${code})`);
    this.reading = false;
  }

  // ── Handshake steps ─────────────────────────────────────────────────────────

  private waitForConnectionAttemptEvent(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("_readerEvent", onEvent);
        reject(new Error("Reader did not send a connection event — is it in LLRP mode?"));
      }, RESPONSE_TIMEOUT_MS);

      const onEvent = (body: Buffer) => {
        const attempt = findParam(body, PARAM.ConnectionAttemptEvent);
        if (!attempt || attempt.length < 2) return; // some other event — keep waiting
        clearTimeout(timer);
        this.removeListener("_readerEvent", onEvent);
        const status = attempt.readUInt16BE(0);
        if (status === 0) {
          resolve();
        } else {
          const reasons: Record<number, string> = {
            1: "reader rejected the connection (client connection already exists)",
            2: "another LLRP client is already connected to this reader",
            3: "another LLRP client is already connected to this reader",
            4: "reader initiated the connection and got an unexpected response",
          };
          reject(new Error(`LLRP connection refused: ${reasons[status] ?? `status ${status}`}`));
        }
      };
      this.on("_readerEvent", onEvent);
    });
  }

  private async enableImpinjExtensions(): Promise<void> {
    const payload = Buffer.concat([
      u32(IMPINJ_VENDOR_ID),
      u8(IMPINJ_ENABLE_EXTENSIONS_SUBTYPE),
      u32(0), // reserved
    ]);
    // Response is CUSTOM_MESSAGE too — treat any LLRPStatus!=0 as fatal, but a
    // missing status (older firmware quirk) as OK.
    const body = await this.request(MSG.CUSTOM_MESSAGE, payload);
    const code = statusCode(body);
    if (code !== null && code !== 0) {
      throw new Error(`ImpinjEnableExtensions failed (LLRP status ${code})`);
    }
  }

  private async setKeepalive(): Promise<void> {
    const keepaliveSpec = tlv(
      PARAM.KeepaliveSpec,
      Buffer.concat([u8(1) /* periodic */, u32(KEEPALIVE_INTERVAL_MS)]),
    );
    const payload = Buffer.concat([u8(0) /* no factory reset */, keepaliveSpec]);
    const body = await this.request(MSG.SET_READER_CONFIG, payload);
    const code = statusCode(body);
    if (code !== 0) throw new Error(`SET_READER_CONFIG failed (LLRP status ${code})`);
  }

  private async deleteAllROSpecs(): Promise<void> {
    const body = await this.request(MSG.DELETE_ROSPEC, u32(0)); // 0 = all
    const code = statusCode(body);
    if (code !== 0) throw new Error(`DELETE_ROSPEC failed (LLRP status ${code})`);
  }

  private async addROSpec(): Promise<void> {
    const body = await this.request(MSG.ADD_ROSPEC, buildROSpec());
    const code = statusCode(body);
    if (code !== 0) throw new Error(`ADD_ROSPEC failed (LLRP status ${code})`);
  }

  private async enableROSpec(): Promise<void> {
    const body = await this.request(MSG.ENABLE_ROSPEC, u32(ROSPEC_ID));
    const code = statusCode(body);
    if (code !== 0) throw new Error(`ENABLE_ROSPEC failed (LLRP status ${code})`);
  }

  // ── Transport ───────────────────────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Not connected to reader");
    }
  }

  private send(buf: Buffer): void {
    this.ensureConnected();
    this.socket!.write(buf);
  }

  /** Send a message and wait for its response (matched by message ID). */
  private request(type: number, payload: Buffer): Promise<Buffer> {
    const id = this.nextMessageId++;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for response to LLRP message type ${type}`));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(message(type, id, payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);

    while (this.recvBuf.length >= 10) {
      const totalLen = this.recvBuf.readUInt32BE(2);
      if (totalLen < 10) {
        // Corrupt frame — drop the buffer and let keepalive recovery handle it
        this.recvBuf = Buffer.alloc(0);
        return;
      }
      if (this.recvBuf.length < totalLen) return; // wait for the rest

      const frame = this.recvBuf.subarray(0, totalLen);
      this.recvBuf = this.recvBuf.subarray(totalLen);
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Buffer): void {
    const type = frame.readUInt16BE(0) & 0x03ff;
    const messageId = frame.readUInt32BE(6);
    const body = frame.subarray(10);

    // Response to a pending request?
    const pending = this.pending.get(messageId);
    if (pending && type !== MSG.RO_ACCESS_REPORT && type !== MSG.KEEPALIVE && type !== MSG.READER_EVENT_NOTIFICATION) {
      clearTimeout(pending.timer);
      this.pending.delete(messageId);
      pending.resolve(body);
      return;
    }

    switch (type) {
      case MSG.RO_ACCESS_REPORT: {
        for (const p of parseTLVs(body)) {
          if (p.type !== PARAM.TagReportData) continue;
          const read = parseTagReportData(p.body);
          if (read) {
            this.lastReadAt = new Date().toISOString();
            this.readCount++;
            this.emit("tag", read);
          }
        }
        break;
      }
      case MSG.KEEPALIVE: {
        // Must ACK or the reader closes the connection
        try {
          this.send(message(MSG.KEEPALIVE_ACK, messageId));
        } catch {
          // socket already gone — close handler fires
        }
        break;
      }
      case MSG.READER_EVENT_NOTIFICATION: {
        this.emit("_readerEvent", body);
        break;
      }
      case MSG.ERROR_MESSAGE: {
        const code = statusCode(body);
        this.lastError = `Reader error (LLRP status ${code})`;
        this.emit("error", new Error(this.lastError));
        break;
      }
      default:
        break;
    }
  }
}

/** Build the mDNS hostname for an Impinj reader from the last 6 MAC digits. */
export function impinjHostFromMac(macSuffix: string): string {
  const clean = macSuffix.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (clean.length !== 6) {
    throw new Error("Enter the last 6 characters of the reader's MAC address (e.g. 16-25-B2 or 1625B2)");
  }
  return `impinj-${clean.slice(0, 2)}-${clean.slice(2, 4)}-${clean.slice(4, 6)}.local`;
}
