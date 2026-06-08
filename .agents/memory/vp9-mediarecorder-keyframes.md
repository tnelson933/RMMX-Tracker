---
name: VP9 MediaRecorder keyframe behavior + live stream graduation
description: VP9 P-frames form a chain (not a star); late-joining viewers need initSegment + lastKeyframeChunk + gopTail to decode correctly.
---

## VP9 keyframe emission

Chrome MediaRecorder VP9 emits exactly **one keyframe** at the very start of the recording (the first `ondataavailable` chunk = EBML header + Tracks + first Cluster). All subsequent 500 ms timeslice chunks are P-frames with no keyframe flag. This breaks any "pending viewer queue" design that parks late-joining viewers until the next keyframe — they wait forever.

**Fix:** Add `videoKeyFrameIntervalDuration: 2_000` (milliseconds) to `MediaRecorder` options. Chrome 94+ honours it; older browsers silently ignore it. Cast the options object `as MediaRecorderOptions` since TypeScript's lib.dom.d.ts may not yet include this property.

```js
const recorder = new MediaRecorder(stream, {
  mimeType,
  videoBitsPerSecond: 500_000,
  audioBitsPerSecond: 64_000,
  videoKeyFrameIntervalDuration: 2_000,
} as MediaRecorderOptions);
```

## VP9 reference chain — the gopTail problem

VP9 P-frames form a **chain**, not a star from the keyframe. Each P-frame is encoded with `LAST = previously decoded frame`. Sending a viewer only `initSegment + lastKeyframeChunk` is NOT enough when time has passed since that keyframe:

- keyframe(t=0) → P(t=0.5) → P(t=1.0) → ... → P(t=6.5) → P(t=7.0)
- If viewer receives keyframe(t=0) and then live P(t=7.0), the decoder's LAST slot = keyframe(t=0), but P(t=7.0) was encoded expecting LAST = P(t=6.5) → garbage output → freeze.

**Fix:** When graduating a late-joining viewer, always send:
1. `initSegment` (EBML header + Tracks)
2. `lastKeyframeChunk` (most recent keyframe)
3. `gopTail` (all P-frames since that keyframe, in order — bridges decoder to current live edge)

After that, the very next live P-frame is decodable because the decoder's LAST slot matches.

**Exception:** The `flushPendingViewers()` path (called exactly at a fresh keyframe boundary) does NOT need gopTail because gopTail is reset to `[]` at that moment. The next live chunk is P-frame #1 of the new GOP, which correctly references that fresh keyframe.

**gopTail cap:** Keep at least 60 frames (30 s at 500 ms timeslices). With periodic keyframes every 2 s the tail normally stays at ≤4 frames, but a larger cap protects against missed keyframe detection.

**Why:** Without gopTail, video shows 0-1 decoded frames then freezes permanently. With it, video plays continuously from the join point forward.
