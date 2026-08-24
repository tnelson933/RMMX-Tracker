import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { WebSocketServer } from "ws";

const outputFile = path.join(os.tmpdir(), `rm-connect-cloud-${process.pid}.cjs`);
await build({
  entryPoints: [path.resolve("src/cloud.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: outputFile,
});
const cloudModule = await import(pathToFileURL(outputFile).href);
const { CloudLink } = cloudModule.default ?? cloudModule;

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