import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { WebSocketServer } from "ws";

const outputFile = path.join(os.tmpdir(), `rm-connect-cloud-${process.pid}.cjs`);
const policyOutputFile = path.join(os.tmpdir(), `rm-connect-policy-${process.pid}.cjs`);
const migrationsOutputFile = path.join(os.tmpdir(), `rm-connect-settings-migrations-${process.pid}.cjs`);
await build({
  entryPoints: [path.resolve("src/cloud.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: outputFile,
});
await build({
  entryPoints: [path.resolve("src/crossing-policy.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: policyOutputFile,
});
await build({
  entryPoints: [path.resolve("src/settings-migrations.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: migrationsOutputFile,
});
const cloudModule = await import(pathToFileURL(outputFile).href);
const { CloudLink } = cloudModule.default ?? cloudModule;
const policyModule = await import(pathToFileURL(policyOutputFile).href);
const { shouldForwardCrossing } = policyModule.default ?? policyModule;
const migrationsModule = await import(pathToFileURL(migrationsOutputFile).href);
const { migrateLegacyActiveTransponderAddress } = migrationsModule.default ?? migrationsModule;

async function receiveCommand(message) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const { port } = server.address();
  const link = new CloudLink();
  const command = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for connector command")), 1_000);
    link.once("command", value => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
  server.once("connection", socket => socket.send(JSON.stringify(message)));
  link.start(`http://127.0.0.1:${port}`, "test-reader-token");
  try {
    return await command;
  } finally {
    link.stop();
    await new Promise(resolve => server.close(resolve));
  }
}

test("forwards a validated Active Timing Reader configuration command", async () => {
  const message = {
    type: "set_active_timing_config",
    config: { channel: 2, power: 65, loop1Enabled: true, loop2Enabled: false },
    syncClock: true,
  };
  assert.deepEqual(await receiveCommand(message), message);
});

test("forwards a validated RFID LLRP configuration command", async () => {
  const message = {
    type: "set_llrp_config",
    config: { transmitPowerIndex: 50, rfModeIndex: 2, tagPopulation: 16, tagTransitTime: 500 },
  };
  assert.deepEqual(await receiveCommand(message), message);
});

test("active-transponder crossings bypass missing moto commands", () => {
  assert.equal(shouldForwardCrossing("active_transponder", false, false), true);
});

test("passive RFID crossings retain moto and test gating", () => {
  assert.equal(shouldForwardCrossing("passive_rfid", false, false), false);
  assert.equal(shouldForwardCrossing("passive_rfid", true, false), true);
  assert.equal(shouldForwardCrossing("passive_rfid", false, true), true);
});

test("migrates legacy active timing port 3333 to 55555", () => {
  assert.equal(migrateLegacyActiveTransponderAddress("active_transponder", "192.168.1.50:3333"), "192.168.1.50:55555");
  assert.equal(migrateLegacyActiveTransponderAddress("mylaps", "timing.local:3333"), "timing.local:55555");
  assert.equal(migrateLegacyActiveTransponderAddress("active_transponder", "[fe80::1]:3333"), "[fe80::1]:55555");
});

test("preserves bare, custom-port, and passive reader addresses", () => {
  assert.equal(migrateLegacyActiveTransponderAddress("active_transponder", "192.168.1.50"), "192.168.1.50");
  assert.equal(migrateLegacyActiveTransponderAddress("active_transponder", "192.168.1.50:6000"), "192.168.1.50:6000");
  assert.equal(migrateLegacyActiveTransponderAddress("impinj", "reader.local:3333"), "reader.local:3333");
});

test("reports the connector version in cloud status", async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const { port } = server.address();
  const link = new CloudLink();
  link.setStatusProvider(() => ({
    connectorVersion: "1.0.12",
    hardware: "active_transponder",
    connected: true,
    detail: null,
    lastReadAt: null,
    readCount: 0,
    antennaIds: [],
  }));
  const status = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for connector status")), 1_000);
    server.once("connection", socket => socket.once("message", data => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    }));
  });
  link.start(`http://127.0.0.1:${port}`, "test-reader-token");
  try {
    assert.equal((await status).connectorVersion, "1.0.12");
  } finally {
    link.stop();
    await new Promise(resolve => server.close(resolve));
  }
});

async function captureCrossingPayload(eventId) {
  let resolvePayload;
  const payload = new Promise(resolve => { resolvePayload = resolve; });
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      resolvePayload(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const webSockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const link = new CloudLink();
  link.start(`http://127.0.0.1:${address.port}`, "test-reader-token");
  try {
    await link.postCrossing({
      rfidNumber: "12345",
      crossingTime: new Date("2025-01-02T03:04:05.000Z"),
      eventId,
    });
    return await payload;
  } finally {
    link.stop();
    webSockets.close();
    await new Promise(resolve => server.close(resolve));
  }
}

test("includes armed event context in the token crossing payload", async () => {
  const payload = await captureCrossingPayload(42);
  assert.equal(payload.eventId, 42);
});

test("omits event context from an unarmed crossing payload", async () => {
  const payload = await captureCrossingPayload(null);
  assert.equal(Object.hasOwn(payload, "eventId"), false);
});
