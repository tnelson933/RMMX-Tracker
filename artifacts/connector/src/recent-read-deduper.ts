export class RecentReadDeduper {
  private readonly reads = new Map<string, number>();

  constructor(private readonly windowMs: number, private readonly maxEntries = 2_000) {}

  accept(tag: string, now = Date.now()): boolean {
    const last = this.reads.get(tag);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.reads.set(tag, now);

    if (this.reads.size > this.maxEntries) {
      for (const [key, seenAt] of this.reads) {
        if (now - seenAt >= this.windowMs) this.reads.delete(key);
      }
    }
    return true;
  }
}