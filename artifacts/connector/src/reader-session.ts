/**
 * One reader on this laptop: its RM Roost cloud link (by reader token), its
 * hardware connection (LLRP RFID reader or RM TrackR), its crossing retry
 * queue and its test/identify state. RM Connect runs one session per reader,
 * so a single laptop can time a finish line and its split readers together.
 */
import { EventEmitter } from "events";
import { LlrpClient, impinjHostFromMac } from "./llrp";
import { ActiveTransponderClient, type ActiveTimingReceiptMetadata } from "./active-transponder-client";
import { RecentReadDeduper } from "./recent-read-deduper";
import { shouldForwardCrossing, type CrossingSource } from "./crossing-policy";
import { CrossingRetryQueue, isRetryableCrossingResult, type QueuedCrossing } from "./crossing-retry-queue";
import { CloudLink, type CloudCommand } from "./cloud";
import type { ReaderConfig, ActiveTimingConfig } from "./settings-migrations";

const LOCAL_DEDUPE_MS = 1_500;
const RECONNECT_DELAY_MS = 10_000;
/** Failed reconnects before RM Connect looks for the reader at a new address. */
const REDISCOVER_AFTER_FAILURES = 3;
const RECENT_READS = 12;

export type SessionState = "disconnected" | "connecting" | "connected_idle" | "testing" | "race_active" | "reconnecting" | "error";
export type TestProgress = "inactive" | "opening_loops" | "waiting_for_tag" | "sending_crossing" | "confirmed" | "unresolved";

export interface RecentRead {
  tag: string;
  at: string;
  /** RFID antenna port. RM TrackR loop numbers are not reported by the device. */
  antennaId: number | null;
  rssi: number | null;
}

export interface ReaderSessionStatus {
  readerId: number;
  readerName: string;
  hardware: ReaderConfig["hardware"];
  hardwareAddress: string;
  state: SessionState;
  cloud: { connected: boolean; error: string | null };
  device: {
    connected: boolean;
    ready: boolean;
    error: string | null;
    diagnosis: string | null;
    detail: string | null;
    machineId: string | null;
    loop1State: string | null;
    loop2State: string | null;
    heartbeatFresh: boolean;
    readCount: number;
    lastReadAt: string | null;
    antennaIds: number[];
  };
  reconnectInSeconds: number | null;
  activeMoto: { motoId: number; name: string } | null;
  testMode: boolean;
  testProgress: TestProgress;
  testMessage: string | null;
  identifying: boolean;
  /** Set for a few seconds after a read while Identify is on. */
  identifiedAt: string | null;
  recentReads: RecentRead[];
  pendingCrossings: number;
}

export interface ReaderSessionOptions {
  config: ReaderConfig;
  cloudUrl: string;
  clubId: number | null;
  connectorVersion: string;
  queueFile: string | null;
  /** Looks for the reader at a new address after repeated connection failures. */
  rediscover?: (session: ReaderSession) => Promise<string | null>;
}

/** Turns socket and LLRP errors into something an organizer can act on. */
export function friendlyRfidError(error: unknown, host: string): string {
  const err = error as NodeJS.ErrnoException;
  const message = err?.message ?? String(error);
  // A "disconnected" reason arrives as plain text, e.g. "connect ECONNREFUSED 10.0.0.5:5084".
  const code = err?.code ?? /\b(E[A-Z]{4,})\b/.exec(message)?.[1];
  if (code === "ECONNREFUSED") {
    return `The reader at ${host} refused the connection. Turn on its LLRP interface (Impinj: set "RFID interface" to LLRP), and close any other program connected to it, such as ItemTest.`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `Couldn't find ${host} on this network. Check the reader is powered and plugged in, then use Find readers.`;
  }
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || /timed out/i.test(message)) {
    return `No answer from ${host}. Check the reader's power and network cable, and that this laptop is on the same network.`;
  }
  if (/another LLRP client|client connection already exists/i.test(message)) {
    return `Another program is already connected to the reader at ${host}. Close it (for example ItemTest, or RM Connect on another laptop) and RM Connect will reconnect.`;
  }
  if (/connection event|LLRP mode/i.test(message)) {
    return `The device at ${host} isn't answering as an RFID reader. Turn on its LLRP interface and try again.`;
  }
  return message;
}

/**
 * Events:
 *   "change" ()                     — status changed; refresh the window/tray
 *   "read"   (read: RecentRead)     — any tag/transponder read (for Identify)
 */
export class ReaderSession extends EventEmitter {
  config: ReaderConfig;
  private readonly cloud = new CloudLink();
  private readonly llrp = new LlrpClient();
  private readonly active = new ActiveTransponderClient();
  private readonly deduper = new RecentReadDeduper(LOCAL_DEDUPE_MS);
  private readonly queue: CrossingRetryQueue;
  private cloudUrl: string;
  private clubId: number | null;
  private readonly connectorVersion: string;
  private readonly rediscover?: ReaderSessionOptions["rediscover"];

  private wanted = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAt: number | null = null;
  private failures = 0;
  private rfidError: string | null = null;
  private activeMoto: { motoId: number; name: string; eventId: number | null } | null = null;
  private testMode = false;
  private testProgress: TestProgress = "inactive";
  private testMessage: string | null = null;
  private identifying = false;
  private identifiedAt: string | null = null;
  private recentReads: RecentRead[] = [];

  constructor(opts: ReaderSessionOptions) {
    super();
    this.config = opts.config;
    this.cloudUrl = opts.cloudUrl;
    this.clubId = opts.clubId;
    this.connectorVersion = opts.connectorVersion;
    this.rediscover = opts.rediscover;
    this.queue = new CrossingRetryQueue({
      send: (crossing) => this.send(crossing),
      filePath: opts.queueFile,
      onChange: () => this.emit("change"),
    });
    this.queue.load();
    this.wireEvents();
  }

  get isRfid(): boolean {
    return this.config.hardware !== "active_transponder";
  }

  /** The host the device is reached at (Impinj MAC digits become impinj-xx-xx-xx.local). */
  get host(): string {
    const addr = this.config.hardwareAddress.trim();
    if (this.config.hardware === "impinj" && !addr.includes(".") && /^[0-9a-f]{6}$/i.test(addr.replace(/[^0-9a-f]/gi, ""))) {
      return impinjHostFromMac(addr);
    }
    return addr;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    this.cloud.start(this.cloudUrl, this.config.readerToken);
    this.connectDevice().catch(() => this.scheduleReconnect());
  }

  stop(): void {
    this.wanted = false;
    this.clearReconnect();
    this.cloud.stop();
    this.llrp.disconnect().catch(() => {});
    this.active.disconnect();
    this.activeMoto = null;
    this.testMode = false;
    this.identifying = false;
    this.emit("change");
  }

  dispose(): void {
    this.stop();
    this.queue.dispose();
    this.removeAllListeners();
  }

  /** Apply edited settings (name, address, RM TrackR config) and reconnect if needed. */
  update(config: ReaderConfig, cloudUrl = this.cloudUrl, clubId = this.clubId): void {
    const addressChanged = config.hardwareAddress !== this.config.hardwareAddress || config.hardware !== this.config.hardware;
    const cloudChanged = cloudUrl !== this.cloudUrl || config.readerToken !== this.config.readerToken;
    this.config = config;
    this.cloudUrl = cloudUrl;
    this.clubId = clubId;
    if (cloudChanged) this.cloud.start(this.cloudUrl, this.config.readerToken);
    if (addressChanged) {
      this.connectDevice().catch(() => this.scheduleReconnect());
    } else if (!this.isRfid) {
      this.applyActiveTiming();
    }
    this.emit("change");
  }

  reconnect(): Promise<void> {
    this.failures = 0;
    return this.connectDevice();
  }

  private async connectDevice(): Promise<void> {
    this.wanted = true;
    this.clearReconnect();
    this.connecting = true;
    this.rfidError = null;
    this.emit("change");
    const host = this.host;
    try {
      if (this.isRfid) {
        this.active.disconnect();
        try {
          await this.llrp.connect(host, { impinjExtensions: this.config.hardware === "impinj" });
        } catch (err) {
          this.rfidError = friendlyRfidError(err, host);
          throw err;
        }
        if (this.shouldReadRfid()) await this.llrp.startReading().catch(() => {});
      } else {
        await this.llrp.disconnect().catch(() => {});
        this.applyActiveTiming();
        await this.active.connect(host);
        // Keep active timing live continuously. A dropped WebSocket start
        // command must not stop the RM TrackR from recording a real crossing.
        this.active.startReading();
      }
      this.failures = 0;
    } finally {
      this.connecting = false;
      this.emit("change");
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAt = null;
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer) return;
    this.failures++;
    this.reconnectAt = Date.now() + RECONNECT_DELAY_MS;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAt = null;
      if (!this.wanted) return;
      // The reader may have been given a new address (router restarted, DHCP).
      if (this.failures >= REDISCOVER_AFTER_FAILURES && this.failures % REDISCOVER_AFTER_FAILURES === 0 && this.rediscover) {
        const found = await this.rediscover(this).catch(() => null);
        if (found && found !== this.config.hardwareAddress) {
          this.config = { ...this.config, hardwareAddress: found };
          this.emit("addressChanged", found);
        }
      }
      this.connectDevice().catch(() => this.scheduleReconnect());
    }, RECONNECT_DELAY_MS);
    this.emit("change");
  }

  // ── Reading control ─────────────────────────────────────────────────────────

  private shouldReadRfid(): boolean {
    return this.activeMoto !== null || this.testMode || this.identifying;
  }

  private syncRfidReading(): void {
    if (!this.isRfid || !this.llrp.getStatus().connected) return;
    const reading = this.llrp.getStatus().reading;
    if (this.shouldReadRfid() && !reading) {
      this.llrp.startReading().catch(() => this.scheduleReconnect());
    } else if (!this.shouldReadRfid() && reading) {
      this.llrp.stopReading().catch(() => {});
    }
  }

  private applyActiveTiming(): void {
    try {
      this.active.configure(this.config.activeTiming);
    } catch {
      // Invalid values never reach here (validated on save); keep the last good config.
    }
  }

  setActiveTiming(config: ActiveTimingConfig, syncClock = false): void {
    this.config = { ...this.config, activeTiming: config };
    this.applyActiveTiming();
    if (syncClock && this.active.getStatus().transportReady) this.active.syncClock();
    this.emit("change");
  }

  async setTestMode(enabled: boolean): Promise<void> {
    this.testMode = enabled;
    this.recentReads = enabled ? [] : this.recentReads;
    if (!enabled) {
      this.testProgress = "inactive";
      this.testMessage = null;
    } else if (this.isRfid) {
      this.testProgress = "waiting_for_tag";
      this.testMessage = "Hold a tag near an antenna.";
    } else {
      this.testProgress = this.active.getStatus().ready ? "waiting_for_tag" : "opening_loops";
      this.testMessage = this.testProgress === "waiting_for_tag"
        ? "Walk an RM TrackR Transponder over either loop."
        : "Opening loops 1 and 2. Waiting for the RM TrackR to confirm they're running…";
      this.active.startReading();
    }
    this.syncRfidReading();
    this.emit("change");
  }

  setIdentifying(enabled: boolean): void {
    this.identifying = enabled;
    if (!enabled) this.identifiedAt = null;
    this.syncRfidReading();
    this.emit("change");
  }

  // ── Reads and crossings ─────────────────────────────────────────────────────

  private noteRead(read: RecentRead): void {
    this.recentReads = [read, ...this.recentReads].slice(0, RECENT_READS);
    if (this.identifying) this.identifiedAt = read.at;
    this.emit("read", read);
    this.emit("change");
  }

  private send(crossing: QueuedCrossing) {
    return this.cloud.postCrossing({
      rfidNumber: crossing.rfidNumber,
      crossingTime: new Date(crossing.crossingTime),
      antennaId: crossing.antennaId,
      clubId: crossing.clubId,
      eventId: crossing.eventId,
      receivedAtUtc: crossing.receivedAtUtc ? new Date(crossing.receivedAtUtc) : undefined,
      deviceTimezone: crossing.deviceTimezone,
      source: crossing.source,
    });
  }

  private async forwardCrossing(
    source: CrossingSource,
    rfidNumber: string,
    crossingTime: Date,
    antennaId?: number | null,
    receipt?: ActiveTimingReceiptMetadata,
  ): Promise<void> {
    if (!shouldForwardCrossing(source, this.activeMoto !== null, this.testMode)) return;
    if (!this.deduper.accept(rfidNumber)) return;

    // Keep the original crossing and receipt timestamps so a delayed delivery
    // is scored at the moment the rider crossed.
    const crossing: QueuedCrossing = {
      rfidNumber,
      crossingTime: crossingTime.toISOString(),
      antennaId,
      clubId: this.clubId,
      eventId: this.activeMoto?.eventId ?? null,
      receivedAtUtc: receipt?.receivedAt?.toISOString(),
      deviceTimezone: receipt?.deviceTimezone,
      source: receipt?.source,
    };

    // While earlier crossings are still waiting for the cloud, queue behind
    // them so crossings arrive in order. Test reads are never queued.
    if (!this.testMode && this.queue.size > 0) {
      this.queue.enqueue(crossing, 0);
      return;
    }

    const testing = this.testMode;
    try {
      if (testing) {
        this.testProgress = "sending_crossing";
        this.testMessage = "Read received. Sending it to RM Roost…";
        this.emit("change");
      }
      const result = await this.send(crossing);
      if (!testing && isRetryableCrossingResult(result)) this.queue.enqueue(crossing, 1);
      if (testing) {
        this.testProgress = result.ok ? "confirmed" : "unresolved";
        this.testMessage = result.ok
          ? (result.message ?? "Read received and confirmed by RM Roost. This reader is ready.")
          : (result.message ?? "The read reached this laptop, but RM Roost couldn't confirm it. Check the internet connection.");
        this.emit("change");
      }
    } catch {
      if (testing) {
        this.testProgress = "unresolved";
        this.testMessage = "The read reached this laptop, but not RM Roost. Check the internet connection.";
        this.emit("change");
        return;
      }
      // Network error — queue it for retry with backoff instead of dropping the lap.
      this.queue.enqueue(crossing, 1);
    }
  }

  private wireEvents(): void {
    this.llrp.on("tag", (read) => {
      const at = new Date();
      this.noteRead({ tag: read.epcHex, at: at.toISOString(), antennaId: read.antennaId, rssi: read.peakRssi });
      // Identify-only reads (no moto, no test) stay on this laptop.
      this.forwardCrossing("passive_rfid", read.epcHex, at, read.antennaId).catch(() => {});
    });
    this.active.on("tag", (tag: string, crossingTime: Date, receipt: ActiveTimingReceiptMetadata) => {
      this.noteRead({ tag, at: crossingTime.toISOString(), antennaId: null, rssi: null });
      this.forwardCrossing("active_transponder", tag, crossingTime, undefined, receipt).catch(() => {});
    });
    this.llrp.on("disconnected", (reason: string) => {
      this.rfidError = friendlyRfidError(new Error(reason), this.host);
      this.scheduleReconnect();
    });
    this.llrp.on("error", () => this.emit("change"));
    this.active.on("disconnected", () => this.scheduleReconnect());
    this.active.on("error", () => this.emit("change"));
    this.active.on("status", () => {
      const status = this.active.getStatus();
      if (this.testMode && this.testProgress === "opening_loops" && status.ready) {
        this.testProgress = "waiting_for_tag";
        this.testMessage = "Both loops are running. Walk an RM TrackR Transponder over either loop.";
      }
      this.emit("change");
    });

    this.cloud.setStatusProvider(() => {
      const s = this.getStatus();
      return {
        connectorVersion: this.connectorVersion,
        hardware: this.config.hardware,
        connected: s.device.connected,
        ready: s.device.ready,
        detail: s.device.error ?? s.device.detail ?? null,
        lastReadAt: s.device.lastReadAt,
        readCount: s.device.readCount,
        antennaIds: s.device.antennaIds,
        hostTimezone: this.active.getStatus().hostTimezone,
        utcOffsetMinutes: this.active.getStatus().utcOffsetMinutes,
      };
    });
    this.cloud.on("command", (cmd: CloudCommand) => this.handleCommand(cmd));
    this.cloud.on("connected", () => {
      // The cloud is reachable again: deliver anything queued during the outage.
      this.queue.retryNow();
      this.emit("change");
    });
    this.cloud.on("disconnected", () => this.emit("change"));
  }

  private handleCommand(cmd: CloudCommand): void {
    if (cmd.type === "start_moto" && cmd.motoId) {
      this.activeMoto = {
        motoId: cmd.motoId,
        name: cmd.motoName ?? `Moto ${cmd.motoId}`,
        eventId: typeof cmd.eventId === "number" && Number.isInteger(cmd.eventId) && cmd.eventId > 0 ? cmd.eventId : null,
      };
      if (!this.isRfid) {
        this.applyActiveTiming();
        this.active.startReading();
      }
      this.syncRfidReading();
    } else if (cmd.type === "stop_moto") {
      this.activeMoto = null;
      this.syncRfidReading();
    } else if (cmd.type === "set_llrp_config" && cmd.config && this.isRfid) {
      this.llrp.applyRfConfig(cmd.config as { transmitPowerIndex: number; rfModeIndex: number; tagPopulation: number; tagTransitTime: number }).catch(() => {
        // Non-fatal — the config is kept and applied on the next reconnect.
      });
    } else if (cmd.type === "set_active_timing_config" && cmd.config && !this.isRfid) {
      const config = cmd.config as ActiveTimingConfig;
      this.setActiveTiming({
        channel: config.channel,
        power: config.power,
        loop1Enabled: !!config.loop1Enabled,
        loop2Enabled: !!config.loop2Enabled,
      }, cmd.syncClock === true);
      this.emit("activeTimingChanged", this.config.activeTiming);
    }
    this.cloud.sendStatus();
    this.emit("change");
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  getStatus(): ReaderSessionStatus {
    const rfid = this.isRfid ? this.llrp.getStatus() : null;
    const active = this.isRfid ? null : this.active.getStatus();
    const cloud = this.cloud.getStatus();
    const connected = rfid?.connected ?? active?.connected ?? false;
    const error = rfid ? (connected ? null : this.rfidError ?? (rfid.error ? friendlyRfidError(new Error(rfid.error), this.host) : null)) : active?.error ?? null;
    const state: SessionState = error && !this.reconnectTimer ? "error"
      : this.reconnectTimer ? "reconnecting"
        : this.connecting ? "connecting"
          : this.activeMoto ? "race_active"
            : this.testMode ? "testing"
              : connected ? "connected_idle" : "disconnected";
    const ready = rfid ? connected : !!active?.ready;
    const diagnosis = error
      ?? (rfid ? null : active?.diagnosis ?? null)
      ?? (!cloud.connected ? (cloud.error ?? "Can't reach RM Roost. Check this laptop's internet connection.") : null);
    return {
      readerId: this.config.readerId,
      readerName: this.config.readerName,
      hardware: this.config.hardware,
      hardwareAddress: this.config.hardwareAddress,
      state,
      cloud: { connected: cloud.connected, error: cloud.error },
      device: {
        connected,
        ready,
        error,
        diagnosis,
        detail: active?.detail ?? null,
        machineId: active?.machineId ?? null,
        loop1State: active?.loop1State ?? null,
        loop2State: active?.loop2State ?? null,
        heartbeatFresh: active?.heartbeatFresh ?? false,
        readCount: rfid?.readCount ?? active?.passingCount ?? 0,
        lastReadAt: rfid?.lastReadAt ?? active?.lastPassingAt ?? null,
        antennaIds: rfid?.antennaIds ?? [],
      },
      reconnectInSeconds: this.reconnectAt ? Math.max(0, Math.ceil((this.reconnectAt - Date.now()) / 1000)) : null,
      activeMoto: this.activeMoto ? { motoId: this.activeMoto.motoId, name: this.activeMoto.name } : null,
      testMode: this.testMode,
      testProgress: this.testProgress,
      testMessage: this.testMessage,
      identifying: this.identifying,
      identifiedAt: this.identifiedAt,
      recentReads: this.recentReads,
      pendingCrossings: this.queue.size,
    };
  }

  /** Address the device is actually connected at (so a scan can skip it). */
  connectedAddress(): string | null {
    const s = this.isRfid ? this.llrp.getStatus() : this.active.getStatus();
    return s.connected ? s.host : null;
  }
}
