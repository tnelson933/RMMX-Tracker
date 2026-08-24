import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { FeibotClient } = require("../.test-dist/feibot.cjs");
const { RecentReadDeduper } = require("../.test-dist/recent-read-deduper.cjs");

async function withFeibotServer(run) {
  const received = [];
  let connection;
  const server = net.createServer((socket) => {
    connection = socket;
    socket.on("data", (chunk) => received.push(chunk.toString("utf8")));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run({
      address: `127.0.0.1:${address.port}`,
      received,
      send: (value) => connection.write(value),
    });
  } finally {
    connection?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("parses split F2000 packets and preserves the device millisecond timestamp", async () => {
  await withFeibotServer(async ({ address, send }) => {
    const client = new FeibotClient();
    await client.connect(address);
    const passing = new Promise((resolve) => client.once("tag", (tag, time) => resolve({ tag, time })));

    send("U001@heartBeat@0001@;U001@ep");
    send("c@0002@2026-8-24_12:34:56.789,090b0902;");

    const { tag, time } = await passing;
    assert.equal(tag, "090b0902");
    assert.equal(time.getFullYear(), 2026);
    assert.equal(time.getMonth(), 7);
    assert.equal(time.getDate(), 24);
    assert.equal(time.getHours(), 12);
    assert.equal(time.getMinutes(), 34);
    assert.equal(time.getSeconds(), 56);
    assert.equal(time.getMilliseconds(), 789);
    assert.equal(client.getStatus().passingCount, 1);
    assert.ok(client.getStatus().lastHeartbeatAt);
    client.disconnect();
  });
});

test("queues readerOpen until the F2000 machine id arrives and controls both readers", async () => {
  await withFeibotServer(async ({ address, received, send }) => {
    const client = new FeibotClient();
    await client.connect(address);
    client.startReading();
    send("F2000-01@heartBeat@0001@;");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(received.join(""), /F2000-01@readerOpen@\d{4}@1;/);
    assert.match(received.join(""), /F2000-01@readerOpen@\d{4}@2;/);

    client.stopReading();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(received.join(""), /F2000-01@readerStop@\d{4}@1;/);
    assert.match(received.join(""), /F2000-01@readerStop@\d{4}@2;/);
    client.disconnect();
  });
});

test("suppresses duplicate tag reads inside the debounce window", () => {
  const deduper = new RecentReadDeduper(1_500);
  assert.equal(deduper.accept("TAG-1", 10_000), true);
  assert.equal(deduper.accept("TAG-1", 10_500), false);
  assert.equal(deduper.accept("TAG-2", 10_500), true);
  assert.equal(deduper.accept("TAG-1", 11_500), true);
});

test("discards malformed and impossible F2000 timestamps", async () => {
  await withFeibotServer(async ({ address, send }) => {
    const client = new FeibotClient();
    await client.connect(address);
    const tags = [];
    client.on("tag", (tag) => tags.push(tag));
    send("U001@epc@0001@not-a-date,TAG-1;");
    send("U001@epc@0002@2026-2-31_12:00:00.000,TAG-2;");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(tags, []);
    assert.equal(client.getStatus().passingCount, 0);
    client.disconnect();
  });
});