import http from "http";
import app from "./app";
import { startAutoSync, AUTO_SYNC_ENABLED, CLOUD_URL, CLUB_ID, EMAIL } from "./auto-sync";

const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 8080;

if (isNaN(port) || port <= 0) {
  console.error(`Invalid PORT value: "${rawPort}"`);
  process.exit(1);
}

const server = http.createServer(app);

server.listen(port, () => {
  const dbFile = process.env.SQLITE_FILE ?? "./race_data.db";
  const staticDir = process.env.STATIC_FILES_DIR;

  console.log(`\n  ============================================`);
  console.log(`   🏁  Rocky Mountain Race — Local Server`);
  console.log(`  ============================================`);
  console.log(`   URL:      http://localhost:${port}`);
  console.log(`   Database: ${dbFile}`);
  if (staticDir) {
    console.log(`   Frontend: ${staticDir}`);
  } else {
    console.log(`   Frontend: (not configured — set STATIC_FILES_DIR)`);
  }
  console.log(`  ============================================`);

  if (AUTO_SYNC_ENABLED) {
    console.log(`\n  ── Auto-sync ────────────────────────────────`);
    console.log(`   Cloud URL: ${CLOUD_URL}`);
    console.log(`   Club ID:   ${CLUB_ID}`);
    console.log(`   Account:   ${EMAIL}`);
    console.log(`   Fires when: cloud reachable + event completed`);
    console.log(`   Poll every: 2 minutes`);
    console.log(`   Status at:  http://localhost:${port}/api/status`);
    console.log(`  ─────────────────────────────────────────────\n`);
  } else {
    console.log(`\n  ⚠️  Auto-sync DISABLED — cloud credentials not set.`);
    console.log(`     Set CLOUD_URL, CLUB_ID, CLOUD_EMAIL, and CLOUD_PASSWORD`);
    console.log(`     to enable automatic sync, or use "npm run sync" manually.\n`);
  }

  startAutoSync();
});
