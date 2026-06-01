#!/usr/bin/env python3
"""
RMMX Tracker — Local RFID Bridge
=================================
Run this script on your scoring laptop at the track.

Instead of pointing your RFID reader directly at the cloud API, point it at
this bridge running locally on your laptop. The bridge:

  • Forwards each crossing to the cloud immediately when online.
  • Caches crossings in a local SQLite database when offline.
  • Automatically replays all cached crossings (in order, with their original
    hardware timestamps) the moment connectivity is restored.

Your lap times are never lost — even if you lose internet for the entire race.

────────────────────────────────────────────────────────────────────────────────
QUICK START
────────────────────────────────────────────────────────────────────────────────

1. Install Python 3.8+ from https://www.python.org/downloads/
   (no extra packages needed — this script uses only the standard library)

2. Run the bridge (replace the URL with your platform URL):

       python rfid_bridge.py --api-url https://your-app.replit.app

3. Change your RFID reader's HTTP output endpoint from:
       https://your-app.replit.app/api/timing/crossing
   to:
       http://localhost:5555/timing/crossing

4. Verify at http://localhost:5555 — the status page shows pending/sent counts.

Optional flags:
  --port   5555           Local port (default 5555)
  --db     cache.sqlite3  Local cache file path
  --retry  10             Seconds between offline retry attempts

Environment variables (alternative to flags):
  RMMX_API_URL   Cloud API base URL
  RMMX_PORT      Local port
  RMMX_DB        Cache file path
────────────────────────────────────────────────────────────────────────────────
"""

import argparse
import json
import logging
import os
import socketserver
import sqlite3
import sys
import threading
import time
import http.server
import urllib.request
import urllib.error
from datetime import datetime, timezone


# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("rfid-bridge")


# ── SQLite cache ───────────────────────────────────────────────────────────────
def init_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS crossings (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            payload      TEXT    NOT NULL,      -- original JSON from reader
            received_at  TEXT    NOT NULL,      -- UTC ISO-8601 when bridge got it
            sent_at      TEXT,                  -- UTC ISO-8601 when cloud confirmed
            attempts     INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.commit()
    return conn


def count_pending(db: sqlite3.Connection) -> int:
    return db.execute("SELECT COUNT(*) FROM crossings WHERE sent_at IS NULL").fetchone()[0]


# ── Cloud forwarding ────────────────────────────────────────────────────────────
def forward_to_cloud(api_url: str, payload: dict, timeout: int = 8) -> bool:
    """
    POST a crossing payload to the cloud API.
    Returns True if the cloud accepted it (or permanently rejected it — 400/409
    means it will never succeed, so we mark it done anyway).
    Returns False if the network is unreachable or the server errored (5xx).
    """
    url = f"{api_url.rstrip('/')}/api/timing/crossing"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return True
    except urllib.error.HTTPError as e:
        if e.code in (400, 409):
            # Permanent rejection (bad payload or moto ended) — don't retry
            log.warning("Cloud rejected crossing with HTTP %d — marking done (no retry)", e.code)
            return True
        log.debug("Cloud HTTP %d — will retry later", e.code)
        return False
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        log.debug("Network unreachable: %s", e)
        return False


# ── Retry loop (background thread) ─────────────────────────────────────────────
def retry_loop(api_url: str, db: sqlite3.Connection, db_lock: threading.Lock,
               stop: threading.Event, interval: int):
    """Periodically flush all unsent cached crossings to the cloud."""
    while not stop.wait(interval):
        with db_lock:
            rows = db.execute(
                "SELECT id, payload FROM crossings WHERE sent_at IS NULL ORDER BY id LIMIT 100"
            ).fetchall()

        if not rows:
            continue

        log.info("Retrying %d cached crossing(s)…", len(rows))
        flushed = 0
        for row_id, payload_json in rows:
            try:
                payload = json.loads(payload_json)
            except json.JSONDecodeError:
                log.error("Corrupt cache row id=%d — skipping", row_id)
                with db_lock:
                    db.execute("UPDATE crossings SET sent_at=? WHERE id=?",
                               (_now(), row_id))
                    db.commit()
                continue

            if forward_to_cloud(api_url, payload):
                with db_lock:
                    db.execute("UPDATE crossings SET sent_at=?, attempts=attempts+1 WHERE id=?",
                               (_now(), row_id))
                    db.commit()
                log.info("  ✓ Flushed cached crossing id=%-4d  tag=%s  t=%s",
                         row_id,
                         payload.get("rfidNumber", "?"),
                         str(payload.get("crossingTime", ""))[:19])
                flushed += 1
            else:
                with db_lock:
                    db.execute("UPDATE crossings SET attempts=attempts+1 WHERE id=?", (row_id,))
                    db.commit()
                log.warning("Still offline — will retry in %ds  (%d/%d flushed this cycle)",
                            interval, flushed, len(rows))
                break  # stop hammering; wait for next interval


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── HTTP request handler ────────────────────────────────────────────────────────
class BridgeHandler(http.server.BaseHTTPRequestHandler):
    # Injected by main() before server starts
    api_url: str = ""
    local_port: int = 5555
    db: sqlite3.Connection = None   # type: ignore
    db_lock: threading.Lock = threading.Lock()

    def log_message(self, fmt, *args):
        pass  # suppress default noisy access log

    # ── GET /  or  GET /status ──────────────────────────────────────────────
    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/status"):
            self._status_page()
        else:
            self._reply(404, {"error": "not found"})

    # ── POST /timing/crossing ───────────────────────────────────────────────
    def do_POST(self):
        if self.path.rstrip("/") != "/timing/crossing":
            self._reply(404, {"error": "unknown endpoint"})
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._reply(400, {"error": "invalid JSON"})
            return

        if not payload.get("rfidNumber") or not payload.get("motoId"):
            self._reply(400, {"error": "rfidNumber and motoId are required"})
            return

        # Ensure crossingTime is set — prefer reader's hardware timestamp
        if not payload.get("crossingTime"):
            payload["crossingTime"] = _now()

        received_at = _now()

        # Try live forward first
        if forward_to_cloud(self.api_url, payload):
            log.info("→ LIVE   tag=%-14s  moto=%-4s  t=%s",
                     payload.get("rfidNumber"), payload.get("motoId"),
                     str(payload.get("crossingTime", ""))[:19])
            self._reply(200, {"ok": True, "via": "live"})

        else:
            # Cache locally and acknowledge to reader so it doesn't retry
            with self.db_lock:
                self.db.execute(
                    "INSERT INTO crossings (payload, received_at) VALUES (?, ?)",
                    (json.dumps(payload), received_at),
                )
                self.db.commit()
                pending = count_pending(self.db)

            log.warning("✗ CACHED tag=%-14s  moto=%-4s  [%d pending]",
                        payload.get("rfidNumber"), payload.get("motoId"), pending)
            self._reply(200, {"ok": True, "via": "cache", "pending": pending})

    # ── Helpers ─────────────────────────────────────────────────────────────
    def _reply(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _status_page(self):
        with self.db_lock:
            total   = self.db.execute("SELECT COUNT(*) FROM crossings").fetchone()[0]
            pending = count_pending(self.db)
        sent = total - pending

        color   = "#f59e0b" if pending else "#22c55e"
        status  = f"{pending} PENDING" if pending else "All synced ✓"

        html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5">
  <title>RMMX Bridge</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: monospace; background: #0f0f0f; color: #e0e0e0;
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; min-height: 100vh; gap: 1.5rem; padding: 2rem; }}
    h1 {{ color: #ef4444; font-size: 2rem; letter-spacing: 0.1em; }}
    .card {{ background: #1a1a1a; border: 1px solid #333; border-radius: 0.75rem;
             padding: 1.5rem 2rem; min-width: 340px; }}
    .card h2 {{ font-size: 0.75rem; text-transform: uppercase;
                letter-spacing: 0.15em; color: #666; margin-bottom: 1rem; }}
    .row {{ display: flex; justify-content: space-between;
            padding: 0.4rem 0; border-bottom: 1px solid #222; }}
    .row:last-child {{ border: none; }}
    .val {{ font-weight: bold; }}
    .status {{ font-size: 1.5rem; font-weight: bold; color: {color}; }}
    code {{ background: #111; border: 1px solid #333; border-radius: 4px;
            padding: 0.5rem 1rem; display: block; margin-top: 0.5rem;
            font-size: 0.85rem; color: #a3e635; }}
    .dim {{ color: #555; font-size: 0.8rem; text-align: center; }}
  </style>
</head>
<body>
  <h1>RMMX RFID BRIDGE</h1>
  <div class="card">
    <h2>Sync Status</h2>
    <div class="row"><span>Status</span> <span class="status">{status}</span></div>
    <div class="row"><span>Pending (unsent)</span> <span class="val" style="color:{color}">{pending}</span></div>
    <div class="row"><span>Sent to cloud</span> <span class="val" style="color:#22c55e">{sent}</span></div>
    <div class="row"><span>Total recorded</span> <span class="val">{total}</span></div>
    <div class="row"><span>Cloud API</span> <span class="val" style="color:#818cf8">{self.api_url}</span></div>
  </div>
  <div class="card">
    <h2>Reader Endpoint</h2>
    <p style="color:#aaa;font-size:0.85rem">Point your RFID reader&apos;s HTTP output to:</p>
    <code>http://localhost:{self.local_port}/timing/crossing</code>
  </div>
  <p class="dim">Page refreshes every 5 seconds</p>
</body>
</html>"""

        data = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


# ── Entry point ────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="RMMX Local RFID Bridge — offline-safe lap timing",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--api-url",
        default=os.getenv("RMMX_API_URL", ""),
        metavar="URL",
        help="Cloud API base URL, e.g. https://your-app.replit.app  (or set RMMX_API_URL)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("RMMX_PORT", "5555")),
        metavar="N",
        help="Local port to listen on (default 5555)",
    )
    parser.add_argument(
        "--db",
        default=os.getenv("RMMX_DB", "rfid_bridge_cache.sqlite3"),
        metavar="FILE",
        help="SQLite cache file (default rfid_bridge_cache.sqlite3)",
    )
    parser.add_argument(
        "--retry",
        type=int,
        default=int(os.getenv("RMMX_RETRY", "10")),
        metavar="SECS",
        help="Seconds between retry attempts when offline (default 10)",
    )
    args = parser.parse_args()

    if not args.api_url:
        print()
        print("ERROR: --api-url is required.")
        print()
        print("Example:")
        print("  python rfid_bridge.py --api-url https://your-app.replit.app")
        print()
        sys.exit(1)

    log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log.info("  RMMX Local RFID Bridge")
    log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log.info("  Cloud API  : %s", args.api_url)
    log.info("  Local port : %d", args.port)
    log.info("  Cache file : %s", args.db)
    log.info("  Retry every: %ds", args.retry)
    log.info("")
    log.info("  Reader endpoint → http://localhost:%d/timing/crossing", args.port)
    log.info("  Status page     → http://localhost:%d", args.port)
    log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    db = init_db(args.db)
    db_lock = threading.Lock()

    pending = count_pending(db)
    if pending > 0:
        log.info("")
        log.info("Found %d unsent crossing(s) from a previous session.", pending)
        log.info("They will be flushed to the cloud automatically.")

    stop_event = threading.Event()
    retry_thread = threading.Thread(
        target=retry_loop,
        args=(args.api_url, db, db_lock, stop_event, args.retry),
        daemon=True,
        name="retry-loop",
    )
    retry_thread.start()

    BridgeHandler.api_url = args.api_url
    BridgeHandler.local_port = args.port
    BridgeHandler.db = db
    BridgeHandler.db_lock = db_lock

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", args.port), BridgeHandler) as server:
        log.info("")
        log.info("Bridge is LIVE — press Ctrl+C to stop")
        log.info("")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            log.info("")
            log.info("Shutting down bridge…")
            stop_event.set()
            server.shutdown()


if __name__ == "__main__":
    main()
