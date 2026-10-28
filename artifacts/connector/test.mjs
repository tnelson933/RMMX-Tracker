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
const { migrateLegacyActiveTransponderAddress, migrateSettings } = migrationsModule.default ?? migrationsModule;
const activeReaderModule = await import(pathToFileURL(activeReaderOutputFile).href);
const {
  ActiveTransponderClient,
  formatLocalClockCommands,
  parseTimestamp,
  isLoopWorking,
} = activeReaderModule.default ?? activeReaderModule;
const deduperModule = await import(pathToFileURL(deduperOutputFile).href);
const { RecentReadDeduper } = deduperModule.default ?? deduperModule;
const retryQueueOutputFile = path.join(os.tmpdir(), `rm-connect-retry-queue-${process.pid}.cjs`);
await build({
  entryPoints: [path.resolve("src/crossing-retry-queue.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: retryQueueOutputFile,
});
const retryQueueModule = await import(pathToFileURL(retryQueueOutputFile).href);
const { CrossingRetryQueue, isRetryableCrossingResult } = retryQueueModule.default ?? retryQueueModule;
const cloudUrlOutputFile = path.join(os.tmpdir(), `rm-connect-cloud-url-${process.pid}.cjs`);
const loadCloudUrlModule = async (bakedUrl) => {
  const file = cloudUrlOutputFile.replace(/\.cjs$/, `-${Buffer.from(String(bakedUrl)).toString("hex")}.cjs`);
  await build({
    entryPoints: [path.resolve("src/cloud-url.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: file,
    ...(bakedUrl === undefined ? {} : { define: { __DEFAULT_CLOUD_URL__: JSON.stringify(bakedUrl) } }),
  });
  const mod = await import(pathToFileURL(file).href);
  return mod.default ?? mod;
};

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

test("retries readerOpen without continuously resetting stopped loops", async () => {
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
    assert.deepEqual(
      (({ machineId, command, parameters }) => ({ machineId, command, parameters }))(retried.at(-1)),
      { machineId: "unit-1", command: "readerOpen", parameters: "1" },
    );
    assert.equal(commandsFromWire(messages).filter(command => command === "setActiveChannel").length, 1);
    assert.equal(commandsFromWire(messages).filter(command => command === "setActivePower").length, 1);
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

test("facility fallback authenticates with the reader token", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, authorization: request.headers.authorization ?? null });
      response.writeHead(request.url.includes("/readers/") ? 422 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(request.url.includes("/readers/")
        ? { ok: false, message: "Reader has no checkpoint assignment for this event" }
        : { ok: true }));
    });
  });
  const webSockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const link = new CloudLink();
  link.start(`http://127.0.0.1:${server.address().port}`, "test-reader-token");
  try {
    const result = await link.postCrossing({
      rfidNumber: "12345",
      crossingTime: new Date("2025-01-02T03:04:05.000Z"),
      clubId: 1000,
    });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "/api/timing/readers/test-reader-token/crossing");
    assert.equal(requests[0].authorization, null);
    assert.equal(requests[1].url, "/api/timing/active/crossing?clubId=1000");
    assert.equal(requests[1].authorization, "Bearer test-reader-token");
  } finally {
    link.stop();
    webSockets.close();
    await new Promise(resolve => server.close(resolve));
  }
});

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

test("retries only transient cloud failures", () => {
  assert.equal(isRetryableCrossingResult({ ok: false, status: 503 }), true);
  assert.equal(isRetryableCrossingResult({ ok: false, status: 429 }), true);
  assert.equal(isRetryableCrossingResult({ ok: false, status: 409 }), false);
  assert.equal(isRetryableCrossingResult({ ok: false, status: 422 }), false);
  assert.equal(isRetryableCrossingResult({ ok: true, status: 200 }), false);
});

test("retry queue delivers in order with original timestamps and never resends a success", async () => {
  const sent = [];
  let failuresLeft = 2;
  const queue = new CrossingRetryQueue({
    baseDelayMs: 5,
    maxDelayMs: 10,
    log: () => {},
    send: async (crossing) => {
      sent.push(crossing);
      if (failuresLeft-- > 0) throw new Error("ECONNREFUSED");
      return { ok: true, status: 200 };
    },
  });
  queue.enqueue({ rfidNumber: "A", crossingTime: "2025-01-02T03:04:05.000Z" }, 1);
  queue.enqueue({ rfidNumber: "B", crossingTime: "2025-01-02T03:04:06.000Z" }, 0);
  for (let i = 0; i < 100 && queue.size > 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  queue.dispose();
  assert.equal(queue.size, 0);
  assert.deepEqual(sent.map(c => c.rfidNumber), ["A", "A", "A", "B"]);
  assert.equal(sent[2].crossingTime, "2025-01-02T03:04:05.000Z");
});

test("retry queue persists undelivered crossings across restarts", async () => {
  const file = path.join(os.tmpdir(), `rm-connect-pending-${process.pid}.json`);
  const first = new CrossingRetryQueue({ filePath: file, baseDelayMs: 60_000, log: () => {}, send: async () => ({ ok: false, status: 502 }) });
  first.enqueue({ rfidNumber: "C", crossingTime: "2025-01-02T03:04:07.000Z" }, 1);
  first.dispose();
  const delivered = [];
  const second = new CrossingRetryQueue({ filePath: file, log: () => {}, send: async (c) => { delivered.push(c); return { ok: true, status: 200 }; } });
  second.load();
  for (let i = 0; i < 100 && second.size > 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  second.dispose();
  assert.deepEqual(delivered.map(c => c.crossingTime), ["2025-01-02T03:04:07.000Z"]);
});

test("a restarted cloud link does not reconnect from the replaced socket", async () => {
  const server = createServer();
  const webSockets = new WebSocketServer({ server });
  let connections = 0;
  webSockets.on("connection", () => { connections++; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const link = new CloudLink();
  let disconnects = 0;
  link.on("disconnected", () => { disconnects++; });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    link.start(url, "token-a");
    await once(link, "connected");
    link.start(url, "token-b");
    await once(link, "connected");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(disconnects, 0);
    assert.equal(connections, 2);
    assert.equal(link.getStatus().connected, true);
  } finally {
    link.stop();
    webSockets.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test("cloud URL defaults to the build-time CLOUD_URL, else the RM Roost site", async () => {
  const baked = await loadCloudUrlModule("https://staging.example.test/ ");
  assert.equal(baked.builtInCloudUrl(), "https://staging.example.test");
  const empty = await loadCloudUrlModule("");
  assert.equal(empty.builtInCloudUrl(), "https://www.rmroost.com");
  const undefinedBuild = await loadCloudUrlModule(undefined);
  assert.equal(undefinedBuild.builtInCloudUrl(), "https://www.rmroost.com");
  // A build that still carries the retired Replit host must not use it.
  const retired = await loadCloudUrlModule("https://rmmx-tracker.replit.app");
  assert.equal(retired.builtInCloudUrl(), "https://www.rmroost.com");
});

test("saved Replit cloud URLs migrate to the built-in URL; other choices stay", async () => {
  const { migrateCloudUrl, normalizeCloudUrl } = await loadCloudUrlModule("https://www.rmroost.com");
  assert.equal(migrateCloudUrl("https://rmmx-tracker.replit.app/"), "https://www.rmroost.com");
  assert.equal(migrateCloudUrl("https://RMMX-Tracker.Replit.App"), "https://www.rmroost.com");
  assert.equal(migrateCloudUrl(""), "https://www.rmroost.com");
  assert.equal(migrateCloudUrl(undefined), "https://www.rmroost.com");
  assert.equal(migrateCloudUrl("http://192.168.1.20:8080/"), "http://192.168.1.20:8080");
  assert.equal(migrateCloudUrl("https://www.rmroost.com"), "https://www.rmroost.com");
  assert.equal(normalizeCloudUrl(" rmroost.com/ "), "https://rmroost.com");
});

test("facility fallback without a saved clubId uses the per-reader URL", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push({ url: request.url, authorization: request.headers.authorization ?? null });
      const checkpoint = request.url === "/api/timing/readers/test-reader-token/crossing";
      response.writeHead(checkpoint ? 422 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(checkpoint
        ? { ok: false, message: "Reader has no checkpoint assignment for this event" }
        : { ok: true }));
    });
  });
  const webSockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const link = new CloudLink();
  link.start(`http://127.0.0.1:${server.address().port}`, "test-reader-token");
  try {
    const result = await link.postCrossing({
      rfidNumber: "12345",
      crossingTime: new Date("2025-01-02T03:04:05.000Z"),
      clubId: null,
    });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "/api/timing/readers/test-reader-token/active/crossing");
  } finally {
    link.stop();
    webSockets.close();
    await new Promise(resolve => server.close(resolve));
  }
});

// ── Multi-reader sessions, discovery and settings migration (1.0.18) ─────────

const sessionOutputFile = path.join(os.tmpdir(), `rm-connect-reader-session-${process.pid}.cjs`);
const discoveryOutputFile = path.join(os.tmpdir(), `rm-connect-discovery-${process.pid}.cjs`);
await build({ entryPoints: [path.resolve("src/reader-session.ts")], bundle: true, platform: "node", format: "cjs", outfile: sessionOutputFile });
await build({ entryPoints: [path.resolve("src/discovery.ts")], bundle: true, platform: "node", format: "cjs", outfile: discoveryOutputFile });
const sessionModule = await import(pathToFileURL(sessionOutputFile).href);
const { ReaderSession, friendlyRfidError } = sessionModule.default ?? sessionModule;
const discoveryModule = await import(pathToFileURL(discoveryOutputFile).href);
const { probeAddress, rfidHardwareFromHostname } = discoveryModule.default ?? discoveryModule;

const keepUrl = (url) => (typeof url === "string" && url ? url : "https://www.rmroost.com");

test("a single-reader settings file becomes the first entry of the reader list", () => {
  const legacyPrefix = ["fei", "bot"].join("");
  const migrated = migrateSettings({
    cloudUrl: "https://www.rmroost.com", email: "org@example.test", clubId: 7,
    readerId: 12, readerToken: "tok-12", readerName: "Finish", hardware: "mylaps",
    hardwareAddress: "192.168.1.50:3333", [legacyPrefix + "Power"]: 80, activeTimingChannel: 3,
  }, keepUrl);
  assert.equal(migrated.readers.length, 1);
  assert.deepEqual(migrated.readers[0], {
    readerId: 12, readerToken: "tok-12", readerName: "Finish", hardware: "active_transponder",
    hardwareAddress: "192.168.1.50:55555",
    activeTiming: { channel: 3, power: 80, loop1Enabled: true, loop2Enabled: true },
  });
  assert.equal(migrated.clubId, 7);
  assert.equal(migrated.autoConnect, true);
});

test("reader lists keep valid entries once each", () => {
  const migrated = migrateSettings({
    readers: [
      { readerId: 1, readerToken: "a", readerName: "Finish", hardware: "impinj", hardwareAddress: "16-25-B2" },
      { readerId: 1, readerToken: "a", readerName: "Duplicate", hardware: "impinj", hardwareAddress: "x" },
      { readerId: 2, readerToken: "", hardware: "zebra", hardwareAddress: "10.0.0.5" },
      { readerId: 3, readerToken: "c", readerName: "Split", hardware: "toaster", hardwareAddress: "10.0.0.6" },
      { readerId: 4, readerToken: "d", readerName: "Halfway", hardware: "active_transponder", hardwareAddress: "10.0.0.7",
        activeTiming: { channel: 9, power: 50, loop1Enabled: false, loop2Enabled: true } },
    ],
  }, keepUrl);
  assert.deepEqual(migrated.readers.map(r => [r.readerId, r.readerName]), [[1, "Finish"], [4, "Halfway"]]);
  // An out-of-range channel falls back to the default; valid values are kept.
  assert.deepEqual(migrated.readers[1].activeTiming, { channel: 0, power: 50, loop1Enabled: false, loop2Enabled: true });
  assert.deepEqual(migrateSettings(null, keepUrl).readers, []);
});

test("RFID connection errors are explained in plain language", () => {
  const err = (code, message = code) => Object.assign(new Error(message), { code });
  assert.match(friendlyRfidError(err("ECONNREFUSED"), "10.0.0.5"), /LLRP interface/);
  assert.match(friendlyRfidError(err("ENOTFOUND"), "impinj-16-25-b2.local"), /find impinj-16-25-b2\.local/);
  assert.match(friendlyRfidError(err("ETIMEDOUT"), "10.0.0.5"), /No answer from 10\.0\.0\.5/);
  assert.match(friendlyRfidError(new Error("LLRP connection refused: another LLRP client is already connected to this reader"), "10.0.0.5"), /Another program/);
});

test("RFID reader model is named from its network name", () => {
  assert.equal(rfidHardwareFromHostname("impinj-16-25-B2.local"), "impinj");
  assert.equal(rfidHardwareFromHostname("FX9600F1A2B3"), "zebra");
  assert.equal(rfidHardwareFromHostname(null), "generic");
});

test("checking an address finds an RM TrackR listening there", async () => {
  const server = net.createServer(peer => peer.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const { resolved, devices } = await probeAddress(`127.0.0.1:${port}`);
    assert.equal(resolved, "127.0.0.1");
    assert.deepEqual(devices.map(d => [d.hardware, d.address]), [["active_transponder", `127.0.0.1:${port}`]]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

/** Fake RM Roost: records crossings per reader token and accepts the command socket. */
async function fakeCloud() {
  const crossings = [];
  const statuses = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const match = /^\/api\/timing\/readers\/([^/]+)\/crossing$/.exec(request.url);
      if (request.method === "POST" && match) {
        crossings.push({ token: match[1], ...JSON.parse(body) });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, message: "Lap recorded" }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", socket => socket.on("message", data => statuses.push(JSON.parse(data.toString()))));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    crossings,
    statuses,
    close: async () => { sockets.close(); await new Promise(resolve => server.close(resolve)); },
  };
}

/** Fake RM TrackR that identifies itself and can send a crossing. */
async function fakeTrackr(machineId) {
  const peers = [];
  const server = net.createServer(peer => {
    peers.push(peer);
    peer.on("error", () => {});
    peer.write(`${machineId}@heartBeat@0001@;`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const stamp = () => {
    const { date, time } = formatLocalClockCommands(new Date());
    return `${date}_${time}`;
  };
  return {
    address: `127.0.0.1:${server.address().port}`,
    cross: (tag) => peers.at(-1).write(`${machineId}@epc@0002@${stamp()},${tag};`),
    close: async () => { for (const p of peers) p.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

function session(config, cloudUrl) {
  return new ReaderSession({
    config: {
      readerName: `Reader ${config.readerId}`,
      hardware: "active_transponder",
      activeTiming: { channel: 0, power: 100, loop1Enabled: true, loop2Enabled: true },
      ...config,
    },
    cloudUrl, clubId: 7, connectorVersion: "test", queueFile: null,
  });
}

test("two readers on one laptop each send their own crossings, and a test read is confirmed", async () => {
  const cloud = await fakeCloud();
  const finish = await fakeTrackr("finish-unit");
  const halfway = await fakeTrackr("half-unit");
  const a = session({ readerId: 1, readerToken: "finish-token", hardwareAddress: finish.address }, cloud.url);
  const b = session({ readerId: 2, readerToken: "half-token", hardwareAddress: halfway.address }, cloud.url);
  try {
    a.start();
    b.start();
    await waitFor(() => a.getStatus().device.machineId === "finish-unit" && b.getStatus().device.machineId === "half-unit", 3_000);

    await a.setTestMode(true);
    finish.cross("ABC123");
    await waitFor(() => a.getStatus().testProgress === "confirmed", 3_000);
    assert.equal(a.getStatus().recentReads[0].tag, "ABC123");

    halfway.cross("ABC123");
    await waitFor(() => cloud.crossings.length === 2, 3_000);
    assert.deepEqual(cloud.crossings.map(c => [c.token, c.rfidNumber]), [["finish-token", "ABC123"], ["half-token", "ABC123"]]);
    await waitFor(() => cloud.statuses.some(s => typeof s.ready === "boolean"), 3_000);
  } finally {
    a.dispose();
    b.dispose();
    await finish.close();
    await halfway.close();
    await cloud.close();
  }
});

test("identify marks the reader that saw the read", async () => {
  const cloud = await fakeCloud();
  const device = await fakeTrackr("unit-9");
  const s = session({ readerId: 9, readerToken: "tok-9", hardwareAddress: device.address }, cloud.url);
  try {
    s.start();
    await waitFor(() => s.getStatus().device.machineId === "unit-9", 3_000);
    s.setIdentifying(true);
    assert.equal(s.getStatus().identifiedAt, null);
    device.cross("FEED01");
    await waitFor(() => s.getStatus().identifiedAt !== null, 3_000);
    s.setIdentifying(false);
    assert.equal(s.getStatus().identifiedAt, null);
  } finally {
    s.dispose();
    await device.close();
    await cloud.close();
  }
});

test("an unreachable RFID reader reports a plain-language reason and retries", async () => {
  const cloud = await fakeCloud();
  const s = session({ readerId: 5, readerToken: "tok-5", hardware: "generic", hardwareAddress: "127.0.0.1" }, cloud.url);
  try {
    s.start();
    await waitFor(() => s.getStatus().state === "reconnecting", 5_000);
    assert.match(s.getStatus().device.error ?? "", /refused the connection|No answer/);
    assert.ok(s.getStatus().reconnectInSeconds > 0);
  } finally {
    s.dispose();
    await cloud.close();
  }
});

test("loop status counts 1 and words like working as running", () => {
  for (const value of ["1", "true", "working", "Running", "open"]) assert.equal(isLoopWorking(value), true, value);
  for (const value of ["0", "", "stopped", "closed"]) assert.equal(isLoopWorking(value), false, value);
});
