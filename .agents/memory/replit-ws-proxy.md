---
name: Replit proxy WebSocket frame conversion
description: The Replit dev proxy converts text WebSocket frames (opcode 0x1) into binary frames (opcode 0x2), so typeof e.data is always "object" (ArrayBuffer) at the browser, never "string".
---

## The rule

Never rely on `typeof e.data === "string"` to distinguish control messages from binary video/audio data in a WebSocket onmessage handler. The Replit proxy forwards all WebSocket frames as binary, so text frames arrive as `ArrayBuffer`, not `string`.

**Why:** Confirmed during live-stream viewer debugging. The JSON `{"type":"init","mimeType":"video/webm; codecs=\"vp8,opus\""}` (60 bytes) was arriving as an ArrayBuffer with first bytes `7b 22 74 79` (`{"ty`). The browser reported `CHUNK_DEMUXER_ERROR_APPEND_FAILED: Unexpected element ID 0x7b22` when it was fed to a MediaSource SourceBuffer.

## How to apply

Detect JSON control messages by checking the first byte of the ArrayBuffer for `0x7b` (`{`), then decode with TextDecoder and parse. Fall through to binary data handling if the first byte is not `0x7b` or JSON.parse throws.

```typescript
ws.onmessage = (e) => {
  let jsonMsg: Record<string, unknown> | null = null;
  if (typeof e.data === "string") {
    jsonMsg = JSON.parse(e.data);
  } else {
    const bytes = new Uint8Array(e.data as ArrayBuffer);
    if (bytes[0] === 0x7b) { // '{' — JSON control message
      try {
        jsonMsg = JSON.parse(new TextDecoder().decode(e.data as ArrayBuffer));
      } catch { /* not JSON — treat as binary */ }
    }
  }

  if (jsonMsg !== null) {
    // handle control message (init, offline, ended, etc.)
  } else {
    // handle binary data (video chunks, etc.)
  }
};
```

This pattern works whether the proxy converts frames or not.
