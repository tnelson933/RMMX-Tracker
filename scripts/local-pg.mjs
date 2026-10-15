#!/usr/bin/env node
// Manage a disposable, portable PostgreSQL for local development.
//
//   node scripts/local-pg.mjs init    -> initdb into ./.local-pg/data and create rmtracker_dev
//   node scripts/local-pg.mjs start   -> start on 127.0.0.1:5432 (logs to ./.local-pg/postgres.log)
//   node scripts/local-pg.mjs stop
//   node scripts/local-pg.mjs status
//
// Binaries: PG_BIN env var, else %LOCALAPPDATA%\pgsql17\bin (EnterpriseDB portable zip).
// Auth is `trust` and the server listens on localhost only — development use only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pgBin =
  process.env.PG_BIN ?? path.join(process.env.LOCALAPPDATA ?? "", "pgsql17", "bin");
const exe = name => path.join(pgBin, process.platform === "win32" ? `${name}.exe` : name);
const baseDir = path.join(root, ".local-pg");
const dataDir = path.join(baseDir, "data");
const logFile = path.join(baseDir, "postgres.log");
const port = process.env.PGPORT ?? "5432";
const dbName = "rmtracker_dev";

// `pg_ctl start` hands its stdio to the long-lived postgres process; on Windows an
// inherited handle keeps this script blocked forever, so starts run detached from it.
function sh(name, args, { allowFail = false, quiet = false } = {}) {
  const r = spawnSync(exe(name), args, { stdio: quiet ? "ignore" : "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) process.exit(r.status ?? 1);
  return r.status;
}

if (!existsSync(exe("pg_ctl"))) {
  console.error(`PostgreSQL binaries not found in ${pgBin}. Set PG_BIN.`);
  process.exit(1);
}

const pgCtl = args => sh("pg_ctl", ["-D", dataDir, ...args]);
const pgStart = () => {
  sh("pg_ctl", ["-D", dataDir, "-l", logFile, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-w", "start"], { quiet: true });
  console.log(`PostgreSQL running on 127.0.0.1:${port} (log: ${logFile})`);
};

switch (process.argv[2]) {
  case "init":
    if (existsSync(path.join(dataDir, "PG_VERSION"))) {
      console.log(`Already initialized: ${dataDir}`);
      break;
    }
    mkdirSync(baseDir, { recursive: true });
    sh("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--locale=C"]);
    pgStart();
    sh("createdb", ["-h", "127.0.0.1", "-p", port, "-U", "postgres", dbName]);
    console.log(`Created database ${dbName} on 127.0.0.1:${port}`);
    break;
  case "start":
    pgStart();
    break;
  case "stop":
    pgCtl(["-m", "fast", "stop"]);
    break;
  case "status":
    sh("pg_ctl", ["-D", dataDir, "status"], { allowFail: true });
    break;
  default:
    console.error("Usage: node scripts/local-pg.mjs <init|start|stop|status>");
    process.exit(1);
}
