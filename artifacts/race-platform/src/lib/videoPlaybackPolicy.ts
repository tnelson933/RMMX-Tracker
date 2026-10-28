export const MAX_CLIENT_QUEUE_BYTES = 4 * 1024 * 1024;
// The relay sends one message per recorder slice (2 a second), so this is ~30 s.
export const MAX_CLIENT_QUEUE_CHUNKS = 64;

export function isVideoQueueOverLimit(chunkCount: number, byteCount: number): boolean {
  return chunkCount > MAX_CLIENT_QUEUE_CHUNKS || byteCount > MAX_CLIENT_QUEUE_BYTES;
}

export function isPlaybackStalled(
  state: string,
  paused: boolean,
  currentTime: number,
  previousTime: number,
): boolean {
  return state === "playing" && !paused && currentTime === previousTime;
}