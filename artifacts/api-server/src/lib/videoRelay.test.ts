import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import {
  attachVideoWebSocket,
  canRelayToViewer,
  createBroadcastTicket,
  getLiveCameras,
  isEventLive,
  MAX_VIEWER_BUFFERED_BYTES,
  verifyBroadcastTicket,
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
} from "./videoRelay.ts";

const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/chrome-vp9-slices.json", import.meta.url), "utf8")) as { mime: string; chunks: string[] };
const slices = fixture.chunks.map(c => Buffer.from(c, "base64"));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

async function startServer() {
  const server = createServer();
  attachVideoWebSocket(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

const broadcastUrl = (url: string, eventId: number, cameraId = "main", name = "") =>
  `${url}/api/video/broadcast/${eventId}/${cameraId}?ticket=${encodeURIComponent(createBroadcastTicket(eventId, cameraId))}&name=${encodeURIComponent(name)}`;

/** Collects a viewer's binary frames and JSON messages. */
function collect(ws: WebSocket) {
  const binary: Buffer[] = [];
  const json: Record<string, unknown>[] = [];
  ws.on("message", (data: Buffer, isBinary) => {
    if (isBinary) binary.push(Buffer.from(data));
    else json.push(JSON.parse(data.toString()));
  });
  return { binary, json };
}

test("relay policy evicts a viewer before its socket queue becomes unbounded", () => {
  assert.equal(canRelayToViewer(MAX_VIEWER_BUFFERED_BYTES - 10, 10), true);
  assert.equal(canRelayToViewer(MAX_VIEWER_BUFFERED_BYTES - 10, 11), false);
});

test("broadcast tickets are tied to one event and camera and expire", () => {
  const t = createBroadcastTicket(5, "main", 1_000);
  assert.equal(verifyBroadcastTicket(t, 5, "main", 2_000), true);
  assert.equal(verifyBroadcastTicket(t, 6, "main", 2_000), false);
  assert.equal(verifyBroadcastTicket(t, 5, "turn-3", 2_000), false);
  assert.equal(verifyBroadcastTicket(t, 5, "main", 1_000 + 3 * 60_000), false);
  assert.equal(verifyBroadcastTicket(t.slice(0, -2) + "xx", 5, "main", 2_000), false);
});

test("broadcasting without a valid ticket is refused", async () => {
  const { server, url } = await startServer();
  await assert.rejects(openSocket(`${url}/api/video/broadcast/94000`), /401/);
  await assert.rejects(openSocket(`${url}/api/video/broadcast/94000/main?ticket=${createBroadcastTicket(94001, "main")}`), /401/);
  assert.equal(isEventLive(94000), false);
  server.close();
});

test("a superseded broadcaster cannot end its replacement; stop ends the camera", async () => {
  const { server, url } = await startServer();
  const eventId = 94001;
  const first = await openSocket(broadcastUrl(url, eventId));
  const replacement = await openSocket(broadcastUrl(url, eventId));
  await once(first, "close");
  assert.equal(isEventLive(eventId), true);

  replacement.send(JSON.stringify({ type: "stop" }));
  await once(replacement, "close");
  assert.equal(isEventLive(eventId), false);
  server.close();
});

test("a late joiner starts at the latest keyframe and keeps receiving live media", async () => {
  const { server, url } = await startServer();
  const eventId = 94002;
  const broadcaster = await openSocket(broadcastUrl(url, eventId));
  broadcaster.send(JSON.stringify({ type: "init", mimeType: fixture.mime }));
  for (const s of slices.slice(0, 5)) broadcaster.send(s);
  await sleep(100);

  const viewer = await openSocket(`${url}/api/video/watch/${eventId}`);
  const got = collect(viewer);
  await sleep(300);
  assert.equal(got.json[0].type, "init");
  assert.equal(got.binary.length, 1, "init segment and everything since the keyframe arrive as one message");
  assert.deepEqual([...got.binary[0].subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  assert.ok(got.binary[0].includes(Buffer.from([0x1f, 0x43, 0xb6, 0x75])), "includes the keyframe Cluster");

  const before = got.binary.length;
  for (const s of slices.slice(5)) broadcaster.send(s);
  await sleep(200);
  assert.ok(got.binary.length > before, "live media keeps flowing");
  assert.ok(got.binary.length - before <= slices.length - 5, "one message per broadcaster slice, not one per frame");

  viewer.close();
  broadcaster.close();
  server.close();
});

test("several cameras stream side by side and viewers pick one", async () => {
  const { server, url } = await startServer();
  const eventId = 94003;
  const finish = await openSocket(broadcastUrl(url, eventId, "finish", "Finish line"));
  const whoops = await openSocket(broadcastUrl(url, eventId, "whoops", "Whoops"));
  for (const b of [finish, whoops]) {
    b.send(JSON.stringify({ type: "init", mimeType: fixture.mime }));
    for (const s of slices.slice(0, 3)) b.send(s);
  }
  await sleep(100);
  assert.deepEqual(getLiveCameras(eventId).map((c: { name: string }) => c.name).sort(), ["Finish line", "Whoops"]);

  const viewer = await openSocket(`${url}/api/video/watch/${eventId}/whoops`);
  const got = collect(viewer);
  await sleep(1300);
  assert.equal(got.json[0].cameraName, "Whoops");
  const heartbeat = got.json.find(m => m.type === "heartbeat") as { cameras: unknown[] } | undefined;
  assert.equal(heartbeat?.cameras.length, 2);

  whoops.send(JSON.stringify({ type: "stop" }));
  await sleep(100);
  const ended = got.json.find(m => m.type === "ended") as { cameras: { id: string }[] } | undefined;
  assert.deepEqual(ended?.cameras.map(c => c.id), ["finish"], "viewer learns which camera is still live");

  viewer.close();
  finish.close();
  server.close();
});

test("a dropped broadcaster keeps its viewers and resumes them on return", async () => {
  const { server, url } = await startServer();
  const eventId = 94004;
  const b1 = await openSocket(broadcastUrl(url, eventId));
  b1.send(JSON.stringify({ type: "init", mimeType: fixture.mime }));
  for (const s of slices.slice(0, 3)) b1.send(s);
  await sleep(50);
  const viewer = await openSocket(`${url}/api/video/watch/${eventId}`);
  const got = collect(viewer);
  await sleep(250);

  b1.terminate(); // connection lost, no "stop"
  await sleep(100);
  assert.equal(isEventLive(eventId), true, "still listed while it may come back");
  assert.ok(got.json.some(m => m.type === "reconnecting"));

  const b2 = await openSocket(broadcastUrl(url, eventId));
  b2.send(JSON.stringify({ type: "init", mimeType: fixture.mime }));
  const before = got.binary.length;
  for (const s of slices.slice(0, 3)) b2.send(s);
  await sleep(150);
  assert.ok(got.binary.length > before, "viewer resumes on the new recorder's keyframe");
  assert.deepEqual([...got.binary[before].subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  assert.equal(got.json.some(m => m.type === "ended"), false);

  viewer.close();
  b2.send(JSON.stringify({ type: "stop" }));
  server.close();
});
