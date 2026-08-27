import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  attachVideoWebSocket,
  canRelayToViewer,
  isEventLive,
  MAX_VIEWER_BUFFERED_BYTES,
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
} from "./videoRelay.ts";

function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return once(ws, "open").then(() => ws);
}

test("relay policy evicts a viewer before its socket queue becomes unbounded", () => {
  assert.equal(canRelayToViewer(MAX_VIEWER_BUFFERED_BYTES - 10, 10), true);
  assert.equal(canRelayToViewer(MAX_VIEWER_BUFFERED_BYTES - 10, 11), false);
});

test("a superseded broadcaster cannot end its replacement", async () => {
  const server = createServer();
  attachVideoWebSocket(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}`;
  const eventId = 94001;
  const first = await openSocket(`${url}/api/video/broadcast/${eventId}`);
  const replacement = await openSocket(`${url}/api/video/broadcast/${eventId}`);
  await once(first, "close");
  assert.equal(isEventLive(eventId), true);

  replacement.close();
  await once(replacement, "close");
  assert.equal(isEventLive(eventId), false);
  server.close();
  await once(server, "close");
});

test("sustained chunks continue reaching a normal viewer", async () => {
  const server = createServer();
  attachVideoWebSocket(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}`;
  const eventId = 94002;
  const broadcaster = await openSocket(`${url}/api/video/broadcast/${eventId}`);
  let keyframeRefreshRequested = false;
  broadcaster.on("message", data => {
    try {
      keyframeRefreshRequested = JSON.parse(data.toString()).type === "request-keyframe";
    } catch {}
  });
  broadcaster.send(JSON.stringify({ type: "init", mimeType: "video/webm" }));
  const init = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  broadcaster.send(init);

  const viewer = await openSocket(`${url}/api/video/watch/${eventId}`);
  let binaryFrames = 0;
  viewer.on("message", (_data, isBinary) => {
    if (isBinary) binaryFrames++;
  });
  viewer.send(JSON.stringify({ type: "hello" }));
  await new Promise(resolve => setTimeout(resolve, 250));
  for (let i = 0; i < 100; i++) {
    broadcaster.send(Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x80, i & 0xff]));
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(binaryFrames >= 100, `expected sustained delivery, got ${binaryFrames} frames`);
  assert.equal(keyframeRefreshRequested, true, "relay should recover when periodic keyframes are missing");

  viewer.close();
  broadcaster.close();
  await Promise.all([once(viewer, "close"), once(broadcaster, "close")]);
  server.close();
  await once(server, "close");
});

test("same-format recorder rotation does not reset active viewer media", async () => {
  const server = createServer();
  attachVideoWebSocket(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}`;
  const eventId = 94003;
  const broadcaster = await openSocket(`${url}/api/video/broadcast/${eventId}`);
  const initMessage = JSON.stringify({ type: "init", mimeType: "video/webm", is360: false });
  broadcaster.send(initMessage);
  broadcaster.send(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));

  const viewer = await openSocket(`${url}/api/video/watch/${eventId}`);
  const controlMessages: string[] = [];
  let binaryFrames = 0;
  viewer.on("message", (data, isBinary) => {
    if (isBinary) binaryFrames++;
    else controlMessages.push(data.toString());
  });
  viewer.send(JSON.stringify({ type: "hello" }));
  await new Promise(resolve => setTimeout(resolve, 250));
  controlMessages.length = 0;
  binaryFrames = 0;

  broadcaster.send(initMessage);
  broadcaster.send(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 4, 5, 6]));
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(
    controlMessages.some(message => JSON.parse(message).type === "init"),
    false,
    "same-format rotation must not tell active viewers to rebuild their MediaSource",
  );
  assert.equal(binaryFrames, 1, "active viewer should receive the rotated recorder initialization segment");

  viewer.close();
  broadcaster.close();
  await Promise.all([once(viewer, "close"), once(broadcaster, "close")]);
  server.close();
  await once(server, "close");
});