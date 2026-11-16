import fs from "fs";
import path from "path";
import http from "http";
import { randomUUID } from "crypto";
import {
  ActiveTransponderSession,
  normalizeActiveTransponderAddress,
  validateActiveTransponderConfiguration,
  type ActiveTransponderConfiguration,
  type ActiveTransponderStatus,
} from "./active-transponder";
import { RfidNetworkSession, resolveRfidHost, type RfidHardware, type RfidNetworkStatus } from "./rfid-network";
import { postCrossingToLocalServer, type LocalCrossing } from "./crossing-post";

// The desktop app's timing readers: a saved list, and one live session per
// reader, so a finish line and its split or section readers all time at once.
// Each read is sent to the local timing server with its reader's id and name.
// No Electron imports: a plain Node script can run this against test servers.

export type ReaderKind = "rm_trackr" | "rfid";

export interface SavedReader {
  /** Stable id, sent with every crossing. Never changes for a reader. */
  id: string;
  name: string;
  kind: ReaderKind;
  address: string;
  /** RFID readers only. */
  hardware?: RfidHardware;
  /** Connect by itself at launch. Off after the organizer disconnects it. */
  autoConnect: boolean;
  /** RM TrackR only: channel, power and enabled loops, applied on every connect. */
  configuration?: ActiveTransponderConfiguration;
}

export type ReaderState =
  | "disconnected"
  | "connecting"
  | "connected_idle"
  | "reading"
  | "testing"
  | "retrying"
  | "error";

export interface ReaderStatus {
  id: string;
  name: string;
  kind: ReaderKind;
  address: string;
  hardware: RfidHardware | null;
  autoConnect: boolean;
  state: ReaderState;
  connected: boolean;
  /** A real problem (never set just because a reader isn't plugged in). */
  error: string | null;
  /** Plain-language line for the current state. */
  message: string;
  readCount: number;
  lastReadAt: string | null;
  /** Full RM TrackR status (rm_trackr readers). */
  active: ActiveTransponderStatus | null;
  /** Full RFID status (rfid readers). */
  rfid: RfidNetworkStatus | null;
}

export interface ReaderInput {
  name?: string;
  kind: ReaderKind;
  address: string;
  hardware?: RfidHardware;
}

export interface ReaderManagerOptions {
  /** Folder for readers.json (the app's userData folder). */
  settingsDir: string;
  /** Port of the local timing server on 127.0.0.1. */
  localServerPort: number;
  httpAgent?: http.Agent;
  /** A reader's status changed. */
  onStatus?: (status: ReaderStatus) => void;
  /** The local server answered a crossing (any HTTP status). */
  onCrossingResponse?: (statusCode: number) => void;
  /**
   * Looks for a reader at a new address after repeated failed attempts (the
   * router may have given it another one). `others` are the other saved readers.
   */
  rediscover?: (reader: SavedReader, others: SavedReader[]) => Promise<string | null>;
  log?: (message: string) => void;
}

const READERS_FILE = "readers.json";
const LEGACY_RM_TRACKR_FILE = "active-transponder.json";
const LEGACY_RFID_FILE = "rfid-network.json";
const RFID_HARDWARE: RfidHardware[] = ["impinj", "zebra", "generic"];
/** Failed attempts before the app looks for the reader at a new address. */
const REDISCOVER_AFTER_FAILURES = 3;
/** After the first few searches, look again only this often (in failed attempts). */
const REDISCOVER_SLOW_EVERY = 30;

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isConfiguration(value: unknown): value is ActiveTransponderConfiguration {
  try {
    validateActiveTransponderConfiguration(value as ActiveTransponderConfiguration);
    return true;
  } catch {
    return false;
  }
}

function hostOf(address: string): string {
  return address.trim().replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/:\d+$/, "").toLowerCase();
}

type Session =
  | { kind: "rm_trackr"; session: ActiveTransponderSession }
  | { kind: "rfid"; session: RfidNetworkSession };

export class ReaderManager {
  private readers: SavedReader[] = [];
  private readonly sessions = new Map<string, Session>();
  private reading = false;
  private disposed = false;
  private rediscoveryQueue: Promise<void> = Promise.resolve();
  private readonly rediscoveredAt = new Map<string, number>();

  constructor(private readonly options: ReaderManagerOptions) {
    this.load();
  }

  // ── Saved list ──────────────────────────────────────────────────────────────

  private get file(): string {
    return path.join(this.options.settingsDir, READERS_FILE);
  }

  private load(): void {
    const saved = readJson(this.file) as { readers?: unknown } | null;
    if (saved && Array.isArray(saved.readers)) {
      this.readers = saved.readers.flatMap((raw) => {
        const r = raw as Partial<SavedReader>;
        if (!r || typeof r.id !== "string" || !r.id || typeof r.address !== "string") return [];
        if (r.kind !== "rm_trackr" && r.kind !== "rfid") return [];
        const reader: SavedReader = {
          id: r.id,
          name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : defaultName(r.kind),
          kind: r.kind,
          address: r.address,
          autoConnect: r.autoConnect === true,
        };
        if (r.kind === "rfid") reader.hardware = RFID_HARDWARE.includes(r.hardware as RfidHardware) ? r.hardware : "impinj";
        if (r.kind === "rm_trackr" && isConfiguration(r.configuration)) reader.configuration = r.configuration;
        return [reader];
      });
    } else {
      // First run with several readers: bring over the single RM TrackR and
      // RFID reader an earlier version saved. Their files are left in place.
      this.readers = this.readLegacyReaders();
      if (this.readers.length) this.save();
    }
    for (const reader of this.readers) this.createSession(reader);
  }

  private readLegacyReaders(): SavedReader[] {
    const readers: SavedReader[] = [];
    const active = readJson(path.join(this.options.settingsDir, LEGACY_RM_TRACKR_FILE)) as
      { address?: unknown; configuration?: unknown; autoConnect?: unknown } | null;
    if (active && typeof active.address === "string" && active.address.trim()) {
      const reader: SavedReader = {
        id: randomUUID(),
        name: defaultName("rm_trackr"),
        kind: "rm_trackr",
        address: active.address.trim(),
        autoConnect: active.autoConnect === true,
      };
      if (isConfiguration(active.configuration)) reader.configuration = active.configuration;
      readers.push(reader);
    }
    const rfid = readJson(path.join(this.options.settingsDir, LEGACY_RFID_FILE)) as { address?: unknown; hardware?: unknown } | null;
    if (rfid && typeof rfid.address === "string" && rfid.address.trim()) {
      readers.push({
        id: randomUUID(),
        name: defaultName("rfid"),
        kind: "rfid",
        address: rfid.address.trim(),
        hardware: RFID_HARDWARE.includes(rfid.hardware as RfidHardware) ? (rfid.hardware as RfidHardware) : "impinj",
        // Earlier versions never reconnected an RFID reader at launch.
        autoConnect: false,
      });
    }
    return readers;
  }

  private save(): void {
    const write = (file: string, data: unknown) => {
      const target = path.join(this.options.settingsDir, file);
      const temp = `${target}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temp, target);
    };
    try {
      write(READERS_FILE, { version: 1, readers: this.readers });
      // Keep the single-reader files an earlier version reads in step with
      // the first reader of each kind.
      const active = this.firstOfKind("rm_trackr");
      if (active) write(LEGACY_RM_TRACKR_FILE, { address: active.address, configuration: active.configuration, autoConnect: active.autoConnect });
      const rfid = this.firstOfKind("rfid");
      if (rfid) write(LEGACY_RFID_FILE, { address: rfid.address, hardware: rfid.hardware ?? "impinj" });
    } catch (err) {
      this.options.log?.(`Could not save the reader list: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private find(id: string): SavedReader {
    const reader = this.readers.find(r => r.id === id);
    if (!reader) throw new Error("That reader is no longer in the list.");
    return reader;
  }

  getReaders(): SavedReader[] {
    return this.readers.map(r => ({ ...r }));
  }

  firstOfKind(kind: ReaderKind): SavedReader | null {
    return this.readers.find(r => r.kind === kind) ?? null;
  }

  private normalize(input: { kind: ReaderKind; address: string; hardware?: RfidHardware }, exceptId?: string): { address: string; hardware?: RfidHardware } {
    let address: string;
    let hardware: RfidHardware | undefined;
    if (input.kind === "rm_trackr") {
      address = normalizeActiveTransponderAddress(String(input.address ?? "")).address;
    } else {
      hardware = input.hardware ?? "impinj";
      if (!RFID_HARDWARE.includes(hardware)) throw new Error("Unknown RFID reader type.");
      resolveRfidHost(String(input.address ?? ""), hardware);
      address = String(input.address).trim();
    }
    // Host and port together: two readers behind one address differ by port.
    const clash = this.readers.find(r => r.id !== exceptId && r.kind === input.kind && r.address.toLowerCase() === address.toLowerCase());
    if (clash) throw new Error(`"${clash.name}" already uses ${address}. Each reader needs its own address.`);
    return { address, hardware };
  }

  add(input: ReaderInput): ReaderStatus {
    if (input.kind !== "rm_trackr" && input.kind !== "rfid") throw new Error("Unknown reader type.");
    const { address, hardware } = this.normalize(input);
    const reader: SavedReader = {
      id: randomUUID(),
      name: this.uniqueName(String(input.name ?? "").trim() || defaultName(input.kind)),
      kind: input.kind,
      address,
      autoConnect: false,
    };
    if (hardware) reader.hardware = hardware;
    this.readers.push(reader);
    this.createSession(reader);
    this.save();
    return this.statusOf(reader);
  }

  /** Rename a reader, or point it at a new address (it reconnects there if it was connected). */
  update(id: string, changes: { name?: string; address?: string; hardware?: RfidHardware }): ReaderStatus {
    const reader = this.find(id);
    if (changes.name !== undefined) {
      const name = String(changes.name).trim();
      if (!name) throw new Error("Give the reader a name.");
      reader.name = name;
    }
    if (changes.address !== undefined || changes.hardware !== undefined) {
      const next = this.normalize({
        kind: reader.kind,
        address: changes.address ?? reader.address,
        hardware: changes.hardware ?? reader.hardware,
      }, reader.id);
      const moved = next.address !== reader.address || next.hardware !== reader.hardware;
      reader.address = next.address;
      if (next.hardware) reader.hardware = next.hardware;
      if (moved && this.isWanted(reader.id)) {
        this.openSession(reader).catch(() => {});
      }
    }
    this.save();
    this.emit(reader);
    return this.statusOf(reader);
  }

  remove(id: string): void {
    const reader = this.find(id);
    this.sessions.get(id)?.session.disconnect(false);
    this.sessions.delete(id);
    this.rediscoveredAt.delete(id);
    this.readers = this.readers.filter(r => r.id !== reader.id);
    this.save();
  }

  // ── Sessions ────────────────────────────────────────────────────────────────

  private createSession(reader: SavedReader): Session {
    const existing = this.sessions.get(reader.id);
    if (existing) return existing;
    let entry: Session;
    if (reader.kind === "rm_trackr") {
      const session = new ActiveTransponderSession({
        onPassing: (epc, crossingTime, metadata) => {
          this.post(reader, { tag: epc, fieldName: "transponder", crossingTime, ...metadata }, (error) => session.reportError(error));
        },
        onStatus: () => this.onSessionStatus(reader),
      });
      session.setReading(this.reading);
      entry = { kind: "rm_trackr", session };
    } else {
      const session = new RfidNetworkSession({
        onTag: (epc) => this.post(reader, { tag: epc }),
        onStatus: () => this.onSessionStatus(reader),
      });
      entry = { kind: "rfid", session };
    }
    this.sessions.set(reader.id, entry);
    return entry;
  }

  private post(reader: SavedReader, crossing: LocalCrossing, onFailure?: (message: string) => void): void {
    postCrossingToLocalServer(
      { port: this.options.localServerPort, agent: this.options.httpAgent },
      // The name is read now, so a renamed reader reports its new name.
      { ...crossing, readerId: reader.id, readerName: reader.name },
      { onFailure, onResponse: this.options.onCrossingResponse },
    );
  }

  private isWanted(id: string): boolean {
    return this.sessions.get(id)?.session.wanted ?? false;
  }

  private openSession(reader: SavedReader, sameDevice = false): Promise<void> {
    const entry = this.createSession(reader);
    if (entry.kind === "rm_trackr") {
      if (reader.configuration) entry.session.configure(reader.configuration);
      entry.session.setReading(this.reading);
      return entry.session.connect(reader.address, { sameDevice });
    }
    return entry.session.connect(reader.address, reader.hardware ?? "impinj");
  }

  /**
   * Connects a reader and remembers to reconnect it at the next launch. The
   * promise reports the first attempt; if that fails the app keeps retrying
   * in the background until the reader answers or is disconnected.
   */
  async connect(id: string): Promise<void> {
    const reader = this.find(id);
    if (!reader.autoConnect) {
      reader.autoConnect = true;
      this.save();
    }
    this.rediscoveredAt.delete(id);
    try {
      await this.openSession(reader);
    } finally {
      this.emit(reader);
    }
  }

  /** Turned off on purpose: the reader stays off until the organizer connects it again. */
  disconnect(id: string): void {
    const reader = this.find(id);
    this.sessions.get(id)?.session.disconnect(false);
    reader.autoConnect = false;
    this.save();
    this.emit(reader);
  }

  /** At launch: connect every reader that was connected when the app last closed. */
  connectSavedReaders(): void {
    for (const reader of this.readers) {
      if (!reader.autoConnect) continue;
      this.openSession(reader).then(
        () => this.options.log?.(`${reader.name} connected at ${reader.address}`),
        (err) => this.options.log?.(`${reader.name} not reachable at ${reader.address} yet (${err instanceof Error ? err.message : String(err)}); retrying in the background.`),
      );
    }
  }

  /** The local timing server's reader state: loops open only while it says reading (or during a loop test). */
  setReading(reading: boolean): void {
    this.reading = reading;
    for (const entry of this.sessions.values()) {
      if (entry.kind === "rm_trackr") entry.session.setReading(reading);
    }
    for (const reader of this.readers) {
      if (reader.kind === "rfid") this.emit(reader);
    }
  }

  private activeSession(id: string): { reader: SavedReader; session: ActiveTransponderSession } {
    const reader = this.find(id);
    const entry = this.sessions.get(id);
    if (reader.kind !== "rm_trackr" || !entry || entry.kind !== "rm_trackr") {
      throw new Error("That only works on an RM TrackR.");
    }
    return { reader, session: entry.session };
  }

  startTest(id: string): void {
    this.activeSession(id).session.startTest();
  }

  stopTest(id: string): void {
    this.activeSession(id).session.stopTest();
  }

  /** Channel, power and enabled loops for one RM TrackR: applied now and on every later connect. */
  configure(id: string, configuration: ActiveTransponderConfiguration): void {
    const { reader, session } = this.activeSession(id);
    session.configure(configuration);
    reader.configuration = {
      activeChannel: configuration.activeChannel,
      activePower: configuration.activePower,
      loopEnabled: [configuration.loopEnabled[0], configuration.loopEnabled[1]],
    };
    this.save();
  }

  syncClock(id: string): void {
    this.activeSession(id).session.syncClock();
  }

  /** Addresses of readers that hold a live connection (a network scan must not probe them). */
  connectedAddresses(): string[] {
    const addresses: string[] = [];
    for (const entry of this.sessions.values()) {
      const host = entry.session.connectedHost();
      if (host) addresses.push(host);
    }
    return addresses;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.sessions.values()) entry.session.disconnect(false);
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  list(): ReaderStatus[] {
    return this.readers.map(r => this.statusOf(r));
  }

  status(id: string): ReaderStatus {
    return this.statusOf(this.find(id));
  }

  /** Full RM TrackR status of one reader (an idle status when there is none). */
  activeStatus(id: string | null | undefined): ActiveTransponderStatus {
    const entry = id ? this.sessions.get(id) : undefined;
    return entry?.kind === "rm_trackr" ? entry.session.getStatus() : new ActiveTransponderSession().getStatus();
  }

  rfidStatus(id: string | null | undefined): RfidNetworkStatus {
    const entry = id ? this.sessions.get(id) : undefined;
    return entry?.kind === "rfid" ? entry.session.getStatus() : new RfidNetworkSession().getStatus();
  }

  private statusOf(reader: SavedReader): ReaderStatus {
    const entry = this.sessions.get(reader.id);
    const base = {
      id: reader.id,
      name: reader.name,
      kind: reader.kind,
      address: reader.address,
      hardware: reader.hardware ?? null,
      autoConnect: reader.autoConnect,
    };
    if (entry?.kind === "rm_trackr") {
      const active = entry.session.getStatus();
      const state: ReaderState =
        active.state === "reconnecting" ? "retrying"
          : active.state === "race_active" ? "reading"
            : active.state;
      return {
        ...base,
        state,
        connected: active.connected,
        error: state === "error" ? active.error ?? active.diagnosis : null,
        message: state === "retrying"
          ? `Not connected, retrying. ${active.retryReason ?? "Check the RM TrackR's power and network cable."}`
          : state === "disconnected" ? "Not connected."
            : active.diagnosis,
        readCount: active.passingCount,
        lastReadAt: active.lastPassingAt,
        active,
        rfid: null,
      };
    }
    const rfid = entry?.kind === "rfid" ? entry.session.getStatus() : new RfidNetworkSession().getStatus();
    const wanted = entry?.session.wanted ?? false;
    const state: ReaderState = rfid.connected
      ? (rfid.error ? "error" : this.reading ? "reading" : "connected_idle")
      : !wanted ? "disconnected"
        : rfid.connecting && rfid.failures === 0 ? "connecting"
          : "retrying";
    return {
      ...base,
      state,
      connected: rfid.connected,
      error: state === "error" ? rfid.error : null,
      message: state === "retrying"
        ? `Not connected, retrying. ${rfid.retryReason ?? "Check the reader's power and network cable."}`
        : state === "disconnected" ? "Not connected."
          : state === "connecting" ? "Connecting to the RFID reader."
            : state === "error" ? rfid.error ?? "The RFID reader needs attention."
              : state === "reading" ? "Connected and reading tags for the running moto or practice."
                : "Connected. Tags are timed once a moto or practice is running.",
      readCount: rfid.readCount,
      lastReadAt: rfid.lastReadAt,
      active: null,
      rfid,
    };
  }

  private emit(reader: SavedReader): void {
    if (this.disposed || !this.readers.includes(reader)) return;
    this.options.onStatus?.(this.statusOf(reader));
  }

  private onSessionStatus(reader: SavedReader): void {
    if (this.disposed || !this.readers.includes(reader)) return;
    this.emit(reader);
    this.maybeRediscover(reader);
  }

  // ── Finding a reader that changed address ───────────────────────────────────

  private maybeRediscover(reader: SavedReader): void {
    if (!this.options.rediscover) return;
    const entry = this.sessions.get(reader.id);
    if (!entry || !entry.session.wanted || entry.session.connectedHost()) return;
    const failures = entry.kind === "rm_trackr" ? entry.session.getStatus().reconnectAttempt : entry.session.getStatus().failures;
    const due = failures >= REDISCOVER_AFTER_FAILURES && failures % REDISCOVER_AFTER_FAILURES === 0
      && (failures <= REDISCOVER_AFTER_FAILURES * 3 || failures % REDISCOVER_SLOW_EVERY === 0);
    if (!due || this.rediscoveredAt.get(reader.id) === failures) return;
    this.rediscoveredAt.set(reader.id, failures);
    // One network search at a time, however many readers are retrying, and each
    // sees the addresses the earlier ones took.
    this.rediscoveryQueue = this.rediscoveryQueue.then(async () => {
      if (this.disposed || !this.readers.includes(reader)) return;
      const current = this.sessions.get(reader.id);
      if (!current || !current.session.wanted || current.session.connectedHost()) return;
      const found = await this.options.rediscover!({ ...reader }, this.readers.filter(r => r !== reader).map(r => ({ ...r }))).catch(() => null);
      if (!found || this.disposed || !this.readers.includes(reader)) return;
      if (!current.session.wanted || current.session.connectedHost()) return;
      if (hostOf(found) === hostOf(reader.address)) return;
      if (this.readers.some(r => r !== reader && r.kind === reader.kind && hostOf(r.address) === hostOf(found))) return;
      this.options.log?.(`${reader.name} found at a new address: ${found} (was ${reader.address})`);
      reader.address = found;
      this.save();
      this.openSession(reader, true).catch(() => {});
    });
  }

  private uniqueName(name: string): string {
    if (!this.readers.some(r => r.name === name)) return name;
    for (let n = 2; ; n++) {
      const candidate = `${name} ${n}`;
      if (!this.readers.some(r => r.name === candidate)) return candidate;
    }
  }
}

function defaultName(kind: ReaderKind): string {
  return kind === "rm_trackr" ? "RM TrackR" : "RFID reader";
}
