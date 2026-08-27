export const MAX_CLIENT_QUEUE_BYTES = 4 * 1024 * 1024;
export const MAX_CLIENT_QUEUE_CHUNKS = 16;

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