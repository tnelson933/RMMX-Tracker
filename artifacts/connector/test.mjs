import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { WebSocketServer } from "ws";

const outputFile = path.join(os.tmpdir(), `rm-connect-cloud-${process.pid}.cjs`);
const policyOutputFile = path.join(os.tmpdir(), `rm-connect-policy-${process.pid}.cjs`);
const migrationsOutputFile = path.join(os.tmpdir(), `rm-connect-settings-migrations-${process.pid}.cjs`);
const activeReaderOutputFile = path.join(os.tmpdir(), `rm-connect-active-reader-${process.pid}.cjs`);
const deduperOutputFile = path.join(os.tmpdir(), `rm-connect-deduper-${process.pid}.cjs`);
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
await build({
  entryPoints: [path.resolve("src/active-transponder-client.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: activeReaderOutputFile,
});
await build({
  entryPoints: [path.resolve("src/recent-read-deduper.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: deduperOutputFile,
});
const cloudModule = await import(pathToFileURL(outputFile).href);
const { CloudLink } = cloudModule.default ?? cloudModule;
const policyModule = await import(pathToFileURL(policyOutputFile).href);
const { shouldForwardCrossing } = policyModule.default ?? policyModule;
const migrationsModule = await import(pathToFileURL(migrationsOutputFile).href);
const { migrateLegacyActiveTransponderAddress } = migrationsModule.default ?? migrationsModule;
const activeReaderModule = await import(pathToFileURL(activeReaderOutputFile).href);
const {
  ActiveTransponderClient,
  formatLocalClockCommands,
  parseTimestamp,
} = activeReaderModule.default ?? activeReaderModule;
const deduperModule = await import(pathToFileURL(deduperOutputFile).href);
const { RecentReadDeduper } = deduperModule.default ?? deduperModule;

function commandsFromWire(messages) {
  return messages.join("").split(";").filter(Boolean).map(packet => packet.split("@")[1]);
}

function commandPackets(messages) {
  return messages.join("").split(";").filter(Boolean).map(packet => {
    const [machineId, command, sequence, parameters] = packet.split("@");
    return { machineId, command, sequence, parameters };
  });
}

async function waitFor(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fake reader traffic");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("initialization writes precede reader open and a first-packet crossing", async () => {
  const sessions = [];
  const peers = [];
  const server = net.createServer(peer => {
    const messages = [];
    sessions.push(messages);
    peers.push(peer);
    peer.on("data", chunk => messages.push(chunk.toString("utf8")));
    peer.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new ActiveTransponderClient();
  client.configure({ channel: 2, power: 65, loop1Enabled: true, loop2Enabled: false });
  const crossing = new Promise(resolve => client.once("tag", (...args) => resolve(args)));
  try {
    await client.connect(`127.0.0.1:${server.address().port}`);
    client.startReading();
    peers[0].write("unit-1@epc@0001@2025-01-15_10:00:00.120,ABC123;");
    const [, , receipt] = await crossing;
    await waitFor(() => commandsFromWire(sessions[0]).length >= 7);
    const commandsAtCrossing = commandsFromWire(sessions[0]);
    assert.deepEqual(commandsAtCrossing.slice(0, 6), [
      "setDate", "setTime", "setActiveChannel", "setActivePower", "loopEnable", "loopDisable",
    ]);
    assert.equal(commandsAtCrossing[6], "readerOpen");
    assert.deepEqual(commandPackets(sessions[0]).slice(2, 7).map(({ command, parameters }) => [command, parameters]), [
      ["setActiveChannel", "2"], ["setActivePower", "65"], ["loopEnable", "1"], ["loopDisable", "2"], ["readerOpen", "1"],
    ]);
    assert.equal(commandsAtCrossing.includes("setTimezone"), false);
    assert.equal(commandsAtCrossing.includes("setOffset"), false);
    assert.ok(receipt.receivedAt instanceof Date);
  } finally {
    client.disconnect();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test("a reconnect resends local date, time, and configuration", async () => {
  const sessions = [];
  const peers = [];
  const server = net.createServer(peer => {
    const messages = [];
    sessions.push(messages);
    peers.push(peer);
    peer.on("data", chunk => messages.push(chunk.toString("utf8")));
    peer.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = `127.0.0.1:${server.address().port}`;
  const client = new ActiveTransponderClient();
  client.configure({ channel: 1, power: 80, loop1Enabled: true, loop2Enabled: true });
  try {
    await client.connect(address);
    peers[0].write("unit-1@heartBeat@0001@;");
    await waitFor(() => commandsFromWire(sessions[0]).length >= 6);
    await client.connect(address);
    await waitFor(() => peers.length >= 2);
    peers[1].write("unit-1@heartBeat@0002@;");
    await waitFor(() => commandsFromWire(sessions[1]).length >= 6);
    for (const session of sessions) {
      assert.deepEqual(commandsFromWire(session).slice(0, 6), [
        "setDate", "setTime", "setActiveChannel", "setActivePower", "loopEnable", "loopEnable",
      ]);
      assert.deepEqual(commandPackets(session).slice(2, 6).map(({ command, parameters }) => [command, parameters]), [
        ["setActiveChannel", "1"], ["setActivePower", "80"], ["loopEnable", "1"], ["loopEnable", "2"],
      ]);
    }
  } finally {
    client.disconnect();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test("retries stopped loop telemetry on its owned timer and stops after working telemetry", async () => {
  const messages = [];
  let peer;
  const server = net.createServer(connection => {
    peer = connection;
    connection.on("data", chunk => messages.push(chunk.toString("utf8")));
    connection.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new ActiveTransponderClient();
  client.configure({ channel: 3, power: 70, loop1Enabled: true, loop2Enabled: false });
  try {
    await client.connect(`127.0.0.1:${server.address().port}`);
    client.startReading();
    peer.write("unit-1@machineState@0001@reader1Working=stopped,reader2Working=stopped;");
    await waitFor(() => commandsFromWire(messages).filter(command => command === "readerOpen").length >= 2, 3_000);
    const retried = commandPackets(messages);
    assert.deepEqual(retried.slice(-5).map(({ command, parameters }) => [command, parameters]), [
      ["setActiveChannel", "3"], ["setActivePower", "70"], ["loopEnable", "1"], ["loopDisable", "2"], ["readerOpen", "1"],
    ]);
    peer.write("unit-1@machineState@0002@reader1Working=working,reader2Working=stopped;");
    await new Promise(resolve => setTimeout(resolve, 2_100));
    assert.equal(commandsFromWire(messages).filter(command => command === "readerOpen").length, 2);
  } finally {
    client.disconnect();
    peer?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test("a disabled loop does not prevent a fresh-heartbeat reader from becoming ready", async () => {
  const messages = [];
  let peer;
  const server = net.createServer(connection => {
    peer = connection;
    connection.on("data", chunk => messages.push(chunk.toString("utf8")));
    connection.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new ActiveTransponderClient();
  client.configure({ channel: 0, power: 100, loop1Enabled: true, loop2Enabled: false });
  try {
    await client.connect(`127.0.0.1:${server.address().port}`);
    client.startReading();
    peer.write("unit-1@heartBeat@0001@;unit-1@machineState@0002@reader1Working=running,reader2Working=stopped;");
    await waitFor(() => client.getStatus().ready);
    assert.equal(client.getStatus().heartbeatFresh, true);
    const opens = commandPackets(messages).filter(({ command }) => command === "readerOpen");
    assert.ok(opens.length > 0);
    assert.equal(opens.every(({ parameters }) => parameters === "1"), true);
  } finally {
    client.disconnect();
    peer?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const [zone, expected] of [
  ["America/Denver", { date: "2025-01-15", time: "10:04:05.67" }],
  ["Asia/Kathmandu", { date: "2025-01-15", time: "22:49:05.67" }],
]) {
  test(`formats clock synchronization in local timezone ${zone}`, () => {
    const script = `const {formatLocalClockCommands}=require(${JSON.stringify(activeReaderOutputFile)});`
      + `process.stdout.write(JSON.stringify(formatLocalClockCommands(new Date("2025-01-15T17:04:05.678Z"))))`;
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, TZ: zone },
      encoding: "utf8",
    })), expected);
  });
}

test("replaces a device timestamp two hours ahead with receive time", () => {
  const receivedAt = new Date(2026, 7, 27, 15, 29, 18, 123);
  assert.equal(
    parseTimestamp("2026-8-27_17:29:18.000", receivedAt).getTime(),
    receivedAt.getTime(),
  );
});

test("preserves normal timestamps and rejects clocks six hours behind", () => {
  const receivedAt = new Date(2026, 7, 27, 15, 29, 18, 123);
  assert.equal(
    parseTimestamp("2026-8-27_15:29:17.900", receivedAt).getTime(),
    new Date(2026, 7, 27, 15, 29, 17, 900).getTime(),
  );
  assert.equal(
    parseTimestamp("2026-8-26_12:00:00.000", receivedAt).getTime(),
    receivedAt.getTime(),
  );
});

for (const [zone, wall, receipt] of [
  ["America/Denver", "2025-01-15_10:00:00.120", "2025-01-15T17:00:00.120Z"],
  ["America/New_York", "2025-01-15_10:00:00.120", "2025-01-15T15:00:00.120Z"],
  ["America/Los_Angeles", "2025-01-15_10:00:00.120", "2025-01-15T18:00:00.120Z"],
  ["UTC", "2025-01-15_10:00:00.120", "2025-01-15T10:00:00.120Z"],
  ["Asia/Kathmandu", "2025-01-15_10:00:00.120", "2025-01-15T04:15:00.120Z"],
  ["Australia/Eucla", "2025-01-15_10:00:00.120", "2025-01-15T01:15:00.120Z"],
]) {
  test(`interprets device calendar fields in host timezone ${zone}`, () => {
    const script = `const {parseTimestamp}=require(${JSON.stringify(activeReaderOutputFile)});`
      + `process.stdout.write(parseTimestamp(${JSON.stringify(wall)},new Date(${JSON.stringify(receipt)})).toISOString())`;
    assert.equal(execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, TZ: zone },
      encoding: "utf8",
    }), receipt);
  });
}

test("uses receipt proximity for fall ambiguity and spring nonexistent time", () => {
  const parseInNewYork = (wall, receipt) => execFileSync(process.execPath, ["-e",
    `const {parseTimestamp}=require(${JSON.stringify(activeReaderOutputFile)});`
      + `process.stdout.write(parseTimestamp(${JSON.stringify(wall)},new Date(${JSON.stringify(receipt)})).toISOString())`,
  ], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" });
  assert.equal(parseInNewYork("2025-11-02_01:30:00.000", "2025-11-02T06:30:00.000Z"), "2025-11-02T06:30:00.000Z");
  assert.equal(parseInNewYork("2025-03-09_02:30:00.000", "2025-03-09T07:30:00.000Z"), "2025-03-09T07:30:00.000Z");
});

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

async function captureCrossingPayload(eventId, metadata = {}) {
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
      ...metadata,
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

test("includes original receipt and timing metadata", async () => {
  const payload = await captureCrossingPayload(42, {
    receivedAtUtc: new Date("2025-01-02T03:04:06.000Z"),
    deviceTimezone: "Asia/Kathmandu",
    source: "connector_live_tcp",
  });
  assert.equal(payload.receivedAt, "2025-01-02T03:04:06.000Z");
  assert.equal(payload.receivedAtUtc, "2025-01-02T03:04:06.000Z");
  assert.equal(payload.readerReceivedAt, "2025-01-02T03:04:06.000Z");
  assert.equal(payload.deviceTimezone, "Asia/Kathmandu");
  assert.equal(payload.timeSource, "connector_live_tcp");
});

test("suppresses duplicate reader callbacks inside the local debounce window", () => {
  const deduper = new RecentReadDeduper(1_500);
  assert.equal(deduper.accept("ABC123", 10_000), true);
  assert.equal(deduper.accept("ABC123", 10_100), false);
  assert.equal(deduper.accept("OTHER", 10_100), true);
  assert.equal(deduper.accept("ABC123", 11_501), true);
});
