export type CrossingSource = "passive_rfid" | "active_transponder";

/**
 * Active-transponder crossings are authoritative physical events and must
 * reach the cloud even if a WebSocket start command was missed. Passive RFID
 * remains gated to an active moto or an explicit hardware test.
 */
export function shouldForwardCrossing(
  source: CrossingSource,
  hasActiveMoto: boolean,
  testMode: boolean,
): boolean {
  return source === "active_transponder" || hasActiveMoto || testMode;
}