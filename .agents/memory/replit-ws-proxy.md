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

## Replit proxy application-data idle timeout (~2 seconds)

The Replit proxy closes WebSocket connections that have no **application-layer data frames** for ~2 seconds. Protocol-level PING/PONG control frames do NOT reset this timer.

**Why:** Confirmed when viewer WebSockets kept disconnecting ~2 seconds after connecting in the "offline" (no broadcaster) state. Server was sending one `{"type":"offline"}` then only `ws.ping()` every 5 s. Proxy closed the connection before the first ping fired, causing a perpetual reconnect loop showing "Connecting…" to users.

**How to apply:** Any WebSocket that can be idle for more than ~2 seconds must send application-level data frames in **both directions** — not just protocol pings, and not just one-directional. The proxy has a per-direction idle timeout. Server→client heartbeats alone (e.g. `{"type":"heartbeat"}` every 1.5 s) are not enough; the client side must also send data back or the proxy will close the connection from the client side.

**Pattern (bidirectional heartbeat):**
- Server: send `{"type":"heartbeat"}` every 1.5 s to ALL viewer connections (not just when offline — video chunks may have gaps)
- Client: on receiving heartbeat, immediately reply `{"type":"pong"}` back to the server
- Server: handle `{"type":"pong"}` from viewers — ignore it (just prevents it being misread as binary video data)

This creates continuous bidirectional application-data flow that keeps both proxy directions alive indefinitely.

## Broadcaster-side idle timeout (~20–30 seconds on the silent direction)

The broadcaster sends video chunks every 500 ms (broadcaster→server active), but if the server never sends anything back the server→broadcaster direction idles. The proxy kills the broadcaster connection after ~20–30 seconds of server→broadcaster silence, which cuts off the chunk stream to all viewers (video freezes).

**Pattern (broadcaster heartbeat):**
- Server (`handleBroadcaster`): start a `setInterval` every 1 s on broadcaster connect; send `{"type":"heartbeat"}` to the broadcaster; clear the interval in both `close` and `error` handlers.
- Broadcaster client (`BroadcastContext.tsx`): `ws.onmessage = () => {}` — silently consume; the broadcaster never needs to process server messages.
