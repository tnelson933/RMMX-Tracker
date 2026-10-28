/**
 * Incremental WebM reader for live MediaRecorder streams.
 *
 * Browsers hand MediaRecorder output over in arbitrary byte slices: Chrome's
 * first slice is a single byte and later slices start mid-element, so a slice
 * boundary says nothing about where a Cluster or a keyframe begins. This parser
 * follows the real EBML structure across slices and hands back whole units:
 *
 *  - "init": everything before the first Cluster (EBML header, Segment start,
 *    Info, Tracks). A viewer's MediaSource needs this before any media.
 *  - "media": a complete Cluster element header or block. The unit that opens a
 *    Cluster carries the Cluster header, any audio before the first video
 *    frame, and that first video frame, with `keyframe` saying whether a viewer
 *    can start decoding there. Chrome opens a new Cluster at every keyframe.
 *
 * A new EBML header mid-stream (the recorder was restarted) starts over and
 * produces a fresh "init" unit.
 */

export type WebmUnit =
  | { kind: "init"; data: Buffer }
  | { kind: "media"; data: Buffer; clusterStart: boolean; keyframe: boolean };

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_CLUSTER = 0x1f43b675;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_REFERENCE_BLOCK = 0xfb;
// Segment-level elements: seeing one inside an unknown-size Cluster ends it.
const SEGMENT_CHILDREN = new Set([
  ID_CLUSTER, 0x114d9b74, 0x1549a966, ID_TRACKS, 0x1c53bb6b, 0x1043a770, 0x1941a469, 0x1254c367,
]);

/** Largest single element accepted (a 4K keyframe is well under this). */
export const MAX_ELEMENT_BYTES = 16 * 1024 * 1024;

type Header = { id: number; size: number | null; headerLen: number };

/** Reads an element ID and size at `pos`; null when more bytes are needed. */
function readHeader(buf: Buffer, pos: number): Header | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let idLen = 1;
  while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++;
  if (idLen > 4) throw new Error("Invalid WebM element ID");
  if (pos + idLen >= buf.length) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i];

  const sp = pos + idLen;
  const s0 = buf[sp];
  let sizeLen = 1;
  while (sizeLen <= 8 && !(s0 & (0x80 >> (sizeLen - 1)))) sizeLen++;
  if (sizeLen > 8) throw new Error("Invalid WebM element size");
  if (sp + sizeLen > buf.length) return null;
  let size = s0 & (0xff >> sizeLen);
  let allOnes = size === (0xff >> sizeLen);
  for (let i = 1; i < sizeLen; i++) {
    const b = buf[sp + i];
    if (b !== 0xff) allOnes = false;
    size = size * 256 + b;
  }
  return { id, size: allOnes ? null : size, headerLen: idLen + sizeLen };
}

/** Reads a size-style variable integer (track numbers in blocks). */
function readVint(buf: Buffer, pos: number): { value: number; len: number } | null {
  if (pos >= buf.length) return null;
  const b0 = buf[pos];
  let len = 1;
  while (len <= 8 && !(b0 & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > buf.length) return null;
  let value = b0 & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  return { value, len };
}

/** Calls `fn` for each child element inside [start, end). */
function forEachChild(buf: Buffer, start: number, end: number, fn: (h: Header, dataStart: number) => void) {
  let pos = start;
  while (pos < end) {
    const h = readHeader(buf, pos);
    if (!h || h.size === null) return;
    fn(h, pos + h.headerLen);
    pos += h.headerLen + h.size;
  }
}

/** Track number of the first video track in a Tracks element body. */
function findVideoTrack(buf: Buffer, start: number, end: number): number | null {
  let video: number | null = null;
  forEachChild(buf, start, end, (entry, entryStart) => {
    if (video !== null || entry.id !== ID_TRACK_ENTRY || entry.size === null) return;
    let num: number | null = null;
    let type: number | null = null;
    forEachChild(buf, entryStart, entryStart + entry.size, (f, d) => {
      if (f.size === null || f.size > 8) return;
      let v = 0;
      for (let i = 0; i < f.size; i++) v = v * 256 + buf[d + i];
      if (f.id === ID_TRACK_NUMBER) num = v;
      if (f.id === ID_TRACK_TYPE) type = v;
    });
    if (type === 1 && num !== null) video = num;
  });
  return video;
}

/** Track number and keyframe flag of a SimpleBlock or BlockGroup. */
function blockInfo(buf: Buffer, h: Header, dataStart: number): { track: number; keyframe: boolean } | null {
  const end = dataStart + (h.size ?? 0);
  if (h.id === ID_SIMPLE_BLOCK) {
    const t = readVint(buf, dataStart);
    if (!t || dataStart + t.len + 2 >= end) return null;
    return { track: t.value, keyframe: (buf[dataStart + t.len + 2] & 0x80) !== 0 };
  }
  if (h.id === ID_BLOCK_GROUP) {
    let track: number | null = null;
    let referenced = false;
    forEachChild(buf, dataStart, end, (c, d) => {
      if (c.id === ID_BLOCK) track = readVint(buf, d)?.value ?? null;
      if (c.id === ID_REFERENCE_BLOCK) referenced = true;
    });
    return track === null ? null : { track, keyframe: !referenced };
  }
  return null;
}

export class WebmStreamParser {
  private buf: Buffer = Buffer.alloc(0);
  private stage: "header" | "segment" | "cluster" = "header";
  private initParts: Buffer[] = [];
  private initSent = false;
  private videoTrack: number | null = null;
  // Cluster opening bytes held until its first video frame shows whether it
  // starts on a keyframe.
  private clusterHead: Buffer[] | null = null;
  private clusterRemaining: number | null = null;

  /** Feeds the next slice; returns every unit it completed. */
  push(chunk: Buffer): WebmUnit[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: WebmUnit[] = [];
    let pos = 0;

    for (;;) {
      if (this.stage === "cluster" && this.clusterRemaining === 0) {
        this.endCluster(out);
        continue;
      }
      const h = readHeader(this.buf, pos);
      if (!h) break;

      // A recorder restart begins a brand-new file.
      if (h.id === ID_EBML && this.stage !== "header") {
        this.endCluster(out);
        this.resetStream();
        continue;
      }

      if (this.stage === "header") {
        if (h.id !== ID_EBML || h.size === null) throw new Error("WebM stream must start with an EBML header");
        if (h.size > MAX_ELEMENT_BYTES) throw new Error("WebM element too large");
        const total = h.headerLen + h.size;
        if (pos + total > this.buf.length) break;
        this.initParts.push(this.buf.subarray(pos, pos + total));
        pos += total;
        this.stage = "segment";
        continue;
      }

      if (this.stage === "segment") {
        if (h.id === ID_SEGMENT) {
          // A container: keep its header and read its children in place.
          this.initParts.push(this.buf.subarray(pos, pos + h.headerLen));
          pos += h.headerLen;
          continue;
        }
        if (h.id === ID_CLUSTER) {
          if (!this.initSent) {
            out.push({ kind: "init", data: Buffer.concat(this.initParts) });
            this.initSent = true;
            this.initParts = [];
          }
          this.clusterHead = [Buffer.from(this.buf.subarray(pos, pos + h.headerLen))];
          this.clusterRemaining = h.size;
          pos += h.headerLen;
          this.stage = "cluster";
          continue;
        }
        if (h.size === null) throw new Error("Unexpected unknown-size WebM element");
        if (h.size > MAX_ELEMENT_BYTES) throw new Error("WebM element too large");
        const total = h.headerLen + h.size;
        if (pos + total > this.buf.length) break;
        if (!this.initSent) {
          if (h.id === ID_TRACKS) this.videoTrack = findVideoTrack(this.buf, pos + h.headerLen, pos + total);
          this.initParts.push(this.buf.subarray(pos, pos + total));
        }
        // After the first Cluster: Cues/Tags and the like aren't needed live.
        pos += total;
        continue;
      }

      // Inside a Cluster.
      if (this.clusterRemaining === null && SEGMENT_CHILDREN.has(h.id)) {
        this.endCluster(out);
        continue;
      }
      if (h.size === null) throw new Error("Unexpected unknown-size WebM element");
      if (h.size > MAX_ELEMENT_BYTES) throw new Error("WebM element too large");
      const total = h.headerLen + h.size;
      if (pos + total > this.buf.length) break;
      const element = Buffer.from(this.buf.subarray(pos, pos + total));
      const info = blockInfo(this.buf, h, pos + h.headerLen);
      pos += total;
      if (this.clusterRemaining !== null) this.clusterRemaining = Math.max(0, this.clusterRemaining - total);

      const isVideo = info !== null && (this.videoTrack === null || info.track === this.videoTrack);
      if (this.clusterHead) {
        this.clusterHead.push(element);
        if (isVideo) {
          out.push({ kind: "media", data: Buffer.concat(this.clusterHead), clusterStart: true, keyframe: info!.keyframe });
          this.clusterHead = null;
        }
      } else {
        out.push({ kind: "media", data: element, clusterStart: false, keyframe: false });
      }
    }

    // Keep only the unread tail; copy init pieces so they don't pin the buffer.
    this.initParts = this.initParts.map(p => Buffer.from(p));
    this.buf = pos >= this.buf.length ? Buffer.alloc(0) : Buffer.from(this.buf.subarray(pos));
    if (this.buf.length > MAX_ELEMENT_BYTES + 64) throw new Error("WebM element too large");
    return out;
  }

  /** Throws away everything buffered; the next byte must start a new file. */
  reset(): void {
    this.buf = Buffer.alloc(0);
    this.resetStream();
  }

  private resetStream(): void {
    this.stage = "header";
    this.initParts = [];
    this.initSent = false;
    this.videoTrack = null;
    this.clusterHead = null;
    this.clusterRemaining = null;
  }

  private endCluster(out: WebmUnit[]): void {
    // A Cluster with no video frame (audio only) still has to reach viewers.
    if (this.clusterHead && this.clusterHead.length > 1) {
      out.push({ kind: "media", data: Buffer.concat(this.clusterHead), clusterStart: true, keyframe: false });
    }
    this.clusterHead = null;
    this.clusterRemaining = null;
    if (this.stage === "cluster") this.stage = "segment";
  }
}
