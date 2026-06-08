---
name: VP9 MediaRecorder keyframe behavior
description: Chrome MediaRecorder VP9 only emits one keyframe by default; must force periodic keyframes for live streaming to work.
---

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

**Why:** Without periodic keyframes, late-joining viewers receive only the original initSegment keyframe, then immediately receive live P-frames that reference a much newer GOP keyframe they never received. VP9 decoder cannot reconstruct those frames → video "starts then immediately freezes".

**How to apply:** Any time MediaRecorder is used for live streaming with a pending/late-joiner queue that depends on keyframe boundaries. The server-side `containsKeyframe()` WebM SimpleBlock scan does work correctly — the real problem is VP9 producing no new keyframes to scan.
