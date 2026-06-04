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
QUICK START — Generic / custom readers
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

────────────────────────────────────────────────────────────────────────────────
QUICK START — Impinj R700 (native IoT Connector format)
────────────────────────────────────────────────────────────────────────────────

       python rfid_bridge.py --api-url https://your-app.replit.app \
                             --reader impinj-r700 \
                             --event-id 12

   Point the R700's IoT Connector HTTP destination to:
       http://localhost:5555/timing/impinj-crossing?eventId=12

────────────────────────────────────────────────────────────────────────────────
QUICK START — Zebra FX7500 (native IoT Connector format)
────────────────────────────────────────────────────────────────────────────────

       python rfid_bridge.py --api-url https://your-app.replit.app \
                             --reader zebra-fx7500 \
                             --event-id 12

   Point the FX7500's IoT Connector HTTP destination to:
       http://localhost:5555/timing/zebra-crossing?eventId=12

────────────────────────────────────────────────────────────────────────────────
Optional flags (all readers):
  --port   5555           Local port (default 5555)
  --db     cache.sqlite3  Local cache file path
  --retry  10             Seconds between offline retry attempts

Native reader flags:
  --reader  impinj-r700 | zebra-fx7500 | generic
              Reader mode (default: generic)
  --event-id N
              Event ID for native reader endpoints (required for
              impinj-r700 and zebra-fx7500 modes)

Environment variables (alternative to flags):
  RMMX_API_URL   Cloud API base URL
  RMMX_PORT      Local port
  RMMX_DB        Cache file path
  RMMX_READER    Reader mode
  RMMX_EVENT_ID  Event ID for native reader mode
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
            cloud_path   TEXT    NOT NULL DEFAULT '/api/timing/crossing',
            received_at  TEXT    NOT NULL,      -- UTC ISO-8601 when bridge got it
            sent_at      TEXT,                  -- UTC ISO-8601 when cloud confirmed
            attempts     INTEGER NOT NULL DEFAULT 0
        )
    """)
    # Add cloud_path column if upgrading from an older schema that doesn't have it
    try:
        conn.execute("ALTER TABLE crossings ADD COLUMN cloud_path TEXT NOT NULL DEFAULT '/api/timing/crossing'")
    except Exception:
        pass  # column already exists
    conn.commit()
    return conn


def count_pending(db: sqlite3.Connection) -> int:
    return db.execute("SELECT COUNT(*) FROM crossings WHERE sent_at IS NULL").fetchone()[0]


# ── Cloud forwarding ────────────────────────────────────────────────────────────
def forward_to_cloud(api_url: str, cloud_path: str, payload: dict, timeout: int = 8) -> bool:
    """
    POST a crossing payload to the cloud API.
    Returns True if the cloud accepted it (or permanently rejected it — 400/409
    means it will never succeed, so we mark it done anyway).
    Returns False if the network is unreachable or the server errored (5xx).
    """
    url = f"{api_url.rstrip('/')}{cloud_path}"
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
            # Permanent rejection (bad payload or no active moto) — don't retry
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
                "SELECT id, payload, cloud_path FROM crossings WHERE sent_at IS NULL ORDER BY id LIMIT 100"
            ).fetchall()

        if not rows:
            continue

        log.info("Retrying %d cached crossing(s)…", len(rows))
        flushed = 0
        for row_id, payload_json, cloud_path in rows:
            try:
                payload = json.loads(payload_json)
            except json.JSONDecodeError:
                log.error("Corrupt cache row id=%d — skipping", row_id)
                with db_lock:
                    db.execute("UPDATE crossings SET sent_at=? WHERE id=?", (_now(), row_id))
                    db.commit()
                continue

            if forward_to_cloud(api_url, cloud_path, payload):
                with db_lock:
                    db.execute("UPDATE crossings SET sent_at=?, attempts=attempts+1 WHERE id=?",
                               (_now(), row_id))
                    db.commit()
                log.info("  ✓ Flushed cached crossing id=%-4d  t=%s", row_id,
                         str(payload.get("crossingTime") or payload.get("timestamp", ""))[:19])
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
    reader_mode: str = "generic"    # "generic" | "impinj-r700" | "zebra-fx7500"
    event_id: str = ""              # required for native reader modes
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

    # ── POST — dispatch by path ─────────────────────────────────────────────
    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")

        if path == "/timing/crossing" and self.reader_mode == "generic":
            self._handle_generic()
        elif path == "/timing/impinj-crossing" and self.reader_mode == "impinj-r700":
            self._handle_native("impinj-r700")
        elif path == "/timing/zebra-crossing" and self.reader_mode == "zebra-fx7500":
            self._handle_native("zebra-fx7500")
        else:
            self._reply(404, {
                "error": "unknown endpoint",
                "hint": f"This bridge is running in '{self.reader_mode}' mode. "
                        f"Check the reader mode and endpoint path.",
            })

    # ── Generic reader handler ──────────────────────────────────────────────
    def _handle_generic(self):
        payload = self._read_json()
        if payload is None:
            return  # _read_json already replied with 400

        if not payload.get("rfidNumber") or not payload.get("motoId"):
            self._reply(400, {"error": "rfidNumber and motoId are required"})
            return

        # Ensure crossingTime is set — prefer reader's hardware timestamp
        if not payload.get("crossingTime"):
            payload["crossingTime"] = _now()

        cloud_path = "/api/timing/crossing"
        self._forward_or_cache(payload, cloud_path,
                               log_tag=str(payload.get("rfidNumber")),
                               log_extra=f"moto={payload.get('motoId')}")

    # ── Native reader handler (Impinj R700 / Zebra FX7500) ─────────────────
    def _handle_native(self, reader: str):
        payload = self._read_json()
        if payload is None:
            return

        if reader == "impinj-r700":
            cloud_path = f"/api/timing/impinj-crossing?eventId={self.event_id}"
            tag_count = len([e for e in payload.get("events", [])
                             if e.get("type") == "tagInventoryEvent"])
            log_tag = f"[{tag_count} tag(s)]"
        else:  # zebra-fx7500
            cloud_path = f"/api/timing/zebra-crossing?eventId={self.event_id}"
            tags = payload.get("data", {}).get("tags", payload.get("tags", []))
            log_tag = f"[{len(tags)} tag(s)]"

        self._forward_or_cache(payload, cloud_path,
                               log_tag=log_tag,
                               log_extra=f"event={self.event_id}")

    # ── Forward or cache ─────────────────────────────────────────────────────
    def _forward_or_cache(self, payload: dict, cloud_path: str,
                          log_tag: str, log_extra: str):
        received_at = _now()

        if forward_to_cloud(self.api_url, cloud_path, payload):
            log.info("→ LIVE   tag=%-20s  %s", log_tag, log_extra)
            self._reply(200, {"ok": True, "via": "live"})
        else:
            with self.db_lock:
                self.db.execute(
                    "INSERT INTO crossings (payload, cloud_path, received_at) VALUES (?, ?, ?)",
                    (json.dumps(payload), cloud_path, received_at),
                )
                self.db.commit()
                pending = count_pending(self.db)

            log.warning("✗ CACHED tag=%-20s  %s  [%d pending]", log_tag, log_extra, pending)
            self._reply(200, {"ok": True, "via": "cache", "pending": pending})

    # ── JSON body reader ─────────────────────────────────────────────────────
    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            self._reply(400, {"error": "invalid JSON"})
            return None

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

        color  = "#f59e0b" if pending else "#22c55e"
        status = f"{pending} PENDING" if pending else "All synced ✓"

        reader_labels = {
            "generic":      "Generic / Custom",
            "impinj-r700":  "Impinj R700",
            "zebra-fx7500": "Zebra FX7500",
        }
        reader_label = reader_labels.get(self.reader_mode, self.reader_mode)

        if self.reader_mode == "impinj-r700":
            local_endpoint = f"http://localhost:{self.local_port}/timing/impinj-crossing?eventId={self.event_id}"
        elif self.reader_mode == "zebra-fx7500":
            local_endpoint = f"http://localhost:{self.local_port}/timing/zebra-crossing?eventId={self.event_id}"
        else:
            local_endpoint = f"http://localhost:{self.local_port}/timing/crossing"

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
             padding: 1.5rem 2rem; min-width: 380px; }}
    .card h2 {{ font-size: 0.75rem; text-transform: uppercase;
                letter-spacing: 0.15em; color: #666; margin-bottom: 1rem; }}
    .row {{ display: flex; justify-content: space-between; gap: 1rem;
            padding: 0.4rem 0; border-bottom: 1px solid #222; flex-wrap: wrap; }}
    .row:last-child {{ border: none; }}
    .val {{ font-weight: bold; text-align: right; }}
    .status {{ font-size: 1.5rem; font-weight: bold; color: {color}; }}
    code {{ background: #111; border: 1px solid #333; border-radius: 4px;
            padding: 0.5rem 1rem; display: block; margin-top: 0.5rem;
            font-size: 0.85rem; color: #a3e635; word-break: break-all; }}
    .dim {{ color: #555; font-size: 0.8rem; text-align: center; }}
    .reader-badge {{ background: #1e3a5f; color: #93c5fd; border: 1px solid #2563eb;
                     border-radius: 4px; padding: 0.15rem 0.5rem;
                     font-size: 0.75rem; font-weight: bold; }}
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
    <div class="row"><span>Reader mode</span> <span class="reader-badge">{reader_label}</span></div>
    {f'<div class="row"><span>Event ID</span> <span class="val">{self.event_id}</span></div>' if self.event_id else ''}
  </div>
  <div class="card">
    <h2>Reader Endpoint</h2>
    <p style="color:#aaa;font-size:0.85rem">Point your {reader_label}&apos;s HTTP output to:</p>
    <code>{local_endpoint}</code>
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
    parser.add_argument(
        "--reader",
        default=os.getenv("RMMX_READER", "generic"),
        choices=["generic", "impinj-r700", "zebra-fx7500"],
        metavar="MODEL",
        help="Reader mode: generic (default), impinj-r700, or zebra-fx7500",
    )
    parser.add_argument(
        "--event-id",
        default=os.getenv("RMMX_EVENT_ID", ""),
        metavar="N",
        help="Event ID — required for impinj-r700 and zebra-fx7500 reader modes",
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

    if args.reader in ("impinj-r700", "zebra-fx7500") and not args.event_id:
        print()
        print(f"ERROR: --event-id is required when using --reader {args.reader}")
        print()
        print(f"Example:")
        print(f"  python rfid_bridge.py --api-url https://your-app.replit.app \\")
        print(f"                        --reader {args.reader} \\")
        print(f"                        --event-id 12")
        print()
        sys.exit(1)

    reader_labels = {
        "generic":      "Generic / Custom",
        "impinj-r700":  "Impinj R700",
        "zebra-fx7500": "Zebra FX7500",
    }

    if args.reader == "impinj-r700":
        local_endpoint = f"http://localhost:{args.port}/timing/impinj-crossing?eventId={args.event_id}"
    elif args.reader == "zebra-fx7500":
        local_endpoint = f"http://localhost:{args.port}/timing/zebra-crossing?eventId={args.event_id}"
    else:
        local_endpoint = f"http://localhost:{args.port}/timing/crossing"

    log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log.info("  RMMX Local RFID Bridge")
    log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log.info("  Cloud API  : %s", args.api_url)
    log.info("  Reader mode: %s", reader_labels.get(args.reader, args.reader))
    if args.event_id:
        log.info("  Event ID   : %s", args.event_id)
    log.info("  Local port : %d", args.port)
    log.info("  Cache file : %s", args.db)
    log.info("  Retry every: %ds", args.retry)
    log.info("")
    log.info("  Reader endpoint → %s", local_endpoint)
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
    BridgeHandler.reader_mode = args.reader
    BridgeHandler.event_id = args.event_id
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
