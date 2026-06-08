import http from "http";
import app from "./app";

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
  console.log(`  ============================================\n`);
});
