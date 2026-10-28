export type Hardware = "impinj" | "zebra" | "generic" | "active_transponder";

export interface ActiveTimingConfig {
  channel: number;
  power: number;
  loop1Enabled: boolean;
  loop2Enabled: boolean;
}

/** One physical reader this laptop connects to, linked to its RM Roost registration. */
export interface ReaderConfig {
  readerId: number;
  readerToken: string;
  readerName: string;
  hardware: Hardware;
  /** Impinj: last 6 MAC chars, hostname or IP. RM TrackR: host/IP[:port]. */
  hardwareAddress: string;
  activeTiming: ActiveTimingConfig;
}

export interface ConnectorSettings {
  cloudUrl: string;
  /** Unused since pairing (1.0.20); kept so older files load. */
  email: string;
  clubId: number | null;
  /** Club this laptop is paired with. */
  clubName: string;
  readers: ReaderConfig[];
  /** Reconnect hardware + cloud automatically when the app launches. */
  autoConnect: boolean;
}

export const DEFAULT_ACTIVE_TIMING: ActiveTimingConfig = { channel: 0, power: 100, loop1Enabled: true, loop2Enabled: true };

const HARDWARE: Hardware[] = ["impinj", "zebra", "generic", "active_transponder"];

export function migrateLegacyActiveTransponderAddress(
  hardware: string | null,
  address: unknown,
): string {
  const value = typeof address === "string" ? address.trim() : "";
  if (hardware !== "active_transponder" && hardware !== "mylaps") return value;
  return value.replace(/:3333$/, ":55555");
}

function activeTimingFrom(raw: Record<string, any> | null | undefined, legacy?: (suffix: string) => unknown): ActiveTimingConfig {
  const pick = <T>(value: unknown, legacyValue: unknown, fallback: T, valid: (v: unknown) => boolean): T =>
    (valid(value) ? value : valid(legacyValue) ? legacyValue : fallback) as T;
  const isInt = (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  const isBool = (v: unknown) => typeof v === "boolean";
  return {
    channel: pick(raw?.channel ?? raw?.activeTimingChannel, legacy?.("Channel"), DEFAULT_ACTIVE_TIMING.channel, isInt(0, 5)),
    power: pick(raw?.power ?? raw?.activeTimingPower, legacy?.("Power"), DEFAULT_ACTIVE_TIMING.power, isInt(0, 100)),
    loop1Enabled: pick(raw?.loop1Enabled ?? raw?.activeTimingLoop1Enabled, legacy?.("Loop1Enabled"), true, isBool),
    loop2Enabled: pick(raw?.loop2Enabled ?? raw?.activeTimingLoop2Enabled, legacy?.("Loop2Enabled"), true, isBool),
  };
}

function readerFrom(raw: Record<string, any>): ReaderConfig | null {
  const hardware = raw.hardware === "mylaps" ? "active_transponder" : raw.hardware;
  if (!Number.isInteger(raw.readerId) || typeof raw.readerToken !== "string" || !raw.readerToken) return null;
  if (!HARDWARE.includes(hardware)) return null;
  return {
    readerId: raw.readerId,
    readerToken: raw.readerToken,
    readerName: typeof raw.readerName === "string" && raw.readerName ? raw.readerName : `Reader ${raw.readerId}`,
    hardware,
    hardwareAddress: migrateLegacyActiveTransponderAddress(hardware, raw.hardwareAddress),
    activeTiming: activeTimingFrom(raw.activeTiming ?? raw),
  };
}

/**
 * Normalizes saved settings. Releases before 1.0.18 saved exactly one reader
 * at the top level (readerId, readerToken, hardware…); those become the first
 * entry of `readers`. Even older releases used vendor-prefixed active timing
 * keys, composed here so the retired vendor token never appears in source.
 */
export function migrateSettings(raw: unknown, migrateCloudUrl: (url: unknown) => string): ConnectorSettings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const legacyPrefix = ["fei", "bot"].join("");
  const legacy = (suffix: string) => value[legacyPrefix + suffix];

  let readers: ReaderConfig[] = [];
  if (Array.isArray(value.readers)) {
    readers = value.readers.map((r: unknown) => (r && typeof r === "object" ? readerFrom(r as Record<string, any>) : null))
      .filter((r: ReaderConfig | null): r is ReaderConfig => r !== null);
  } else {
    const single = readerFrom(value);
    if (single) readers = [{ ...single, activeTiming: activeTimingFrom(value, legacy) }];
  }
  // One entry per registration.
  readers = readers.filter((r, i) => readers.findIndex(o => o.readerId === r.readerId) === i);

  return {
    cloudUrl: migrateCloudUrl(value.cloudUrl),
    email: typeof value.email === "string" ? value.email : "",
    clubId: Number.isInteger(value.clubId) ? value.clubId : null,
    clubName: typeof value.clubName === "string" ? value.clubName : "",
    readers,
    autoConnect: value.autoConnect !== false,
  };
}
