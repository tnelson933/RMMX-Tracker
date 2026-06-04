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
  • Optionally exposes a local RMonitor TCP server (port 50000) so scoreboards,
    announcer laptops, and the Race Monitor app get live lap data.

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
QUICK START — RMonitor live output (scoreboards / Race Monitor)
────────────────────────────────────────────────────────────────────────────────

Add --rmonitor 50000 and --event-id N to any of the above commands:

       python rfid_bridge.py --api-url https://your-app.replit.app \
                             --event-id 12 \
                             --rmonitor 50000

Then point your scoreboard or announcer software to:
       tcp://YOUR-LAPTOP-IP:50000

Compatible software: Race Monitor, AMBrc, Orbits, any RMonitor TCP client.

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
              impinj-r700 and zebra-fx7500 modes; also required for
              --rmonitor)

RMonitor output flags:
  --rmonitor N
              Enable RMonitor TCP server on local port N (default 0 = disabled).
              Requires --event-id. Scoreboards connect to tcp://YOUR-IP:N.

Environment variables (alternative to flags):
  RMMX_API_URL      Cloud API base URL
  RMMX_PORT         Local port
  RMMX_DB           Cache file path
  RMMX_READER       Reader mode
  RMMX_EVENT_ID     Event ID for native reader mode / RMonitor
  RMMX_RMONITOR     RMonitor TCP port (0 = disabled)
────────────────────────────────────────────────────────────────────────────────
"""

import argparse
import json
import logging
import os
import socket
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
    bridge_mode: str = "race"       # "race" | "practice"
    event_id: str = ""              # required for native reader modes in race mode
    club_id: str = ""               # required for practice mode
    db: sqlite3.Connection = None   # type: ignore
    db_lock: threading.Lock = threading.Lock()
    rmonitor_server: "RMonitorServer | None" = None  # set by main() if --rmonitor is on

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

        # Ensure crossingTime is set — prefer reader's hardware timestamp
        if not payload.get("crossingTime"):
            payload["crossingTime"] = _now()

        if self.bridge_mode == "practice":
            rfid = payload.get("rfidNumber") or payload.get("transponder")
            if not rfid:
                self._reply(400, {"error": "rfidNumber is required"})
                return
            practice_payload = {
                "rfidNumber": rfid,
                "crossingTime": payload["crossingTime"],
            }
            cloud_path = f"/api/practice/active/crossing?clubId={self.club_id}"
            self._forward_or_cache(practice_payload, cloud_path,
                                   log_tag=str(rfid),
                                   log_extra=f"club={self.club_id} [practice]")
        else:
            if not payload.get("rfidNumber") or not payload.get("motoId"):
                self._reply(400, {"error": "rfidNumber and motoId are required"})
                return
            cloud_path = "/api/timing/crossing"
            self._forward_or_cache(payload, cloud_path,
                                   log_tag=str(payload.get("rfidNumber")),
                                   log_extra=f"moto={payload.get('motoId')}")

    # ── Native reader handler (Impinj R700 / Zebra FX7500) ─────────────────
    def _handle_native(self, reader: str):
        payload = self._read_json()
        if payload is None:
            return

        # In practice mode: extract individual tags and send each to the active
        # practice session endpoint.  The hardware timestamp is preserved per-tag.
        if self.bridge_mode == "practice":
            if reader == "impinj-r700":
                tags = [e.get("tagInventoryEvent", {})
                        for e in payload.get("events", [])
                        if e.get("type") == "tagInventoryEvent"]
                for tag in tags:
                    rfid = (tag.get("epcHex") or "").upper()
                    if not rfid:
                        continue
                    ts = tag.get("firstSeenTime") or _now()
                    practice_payload = {"rfidNumber": rfid, "crossingTime": ts}
                    cloud_path = f"/api/practice/active/crossing?clubId={self.club_id}"
                    self._forward_or_cache(practice_payload, cloud_path,
                                           log_tag=rfid,
                                           log_extra=f"club={self.club_id} [practice]")
            else:  # zebra-fx7500
                tags = payload.get("data", {}).get("tags", payload.get("tags", []))
                for tag in tags:
                    rfid = ((tag.get("idHex") or tag.get("epc")) or "").upper()
                    if not rfid:
                        continue
                    ts = tag.get("firstSeenTimestamp") or _now()
                    practice_payload = {"rfidNumber": rfid, "crossingTime": ts}
                    cloud_path = f"/api/practice/active/crossing?clubId={self.club_id}"
                    self._forward_or_cache(practice_payload, cloud_path,
                                           log_tag=rfid,
                                           log_extra=f"club={self.club_id} [practice]")
            self._reply(200, {"ok": True, "mode": "practice"})
            return

        # Race mode: forward the full native payload to the timing endpoint
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
        mode_label = "Practice" if self.bridge_mode == "practice" else "Race"

        if self.bridge_mode == "practice":
            if self.reader_mode == "impinj-r700":
                local_endpoint = f"http://localhost:{self.local_port}/timing/impinj-crossing?eventId=OPTIONAL"
            elif self.reader_mode == "zebra-fx7500":
                local_endpoint = f"http://localhost:{self.local_port}/timing/zebra-crossing?eventId=OPTIONAL"
            else:
                local_endpoint = f"http://localhost:{self.local_port}/timing/crossing"
        elif self.reader_mode == "impinj-r700":
            local_endpoint = f"http://localhost:{self.local_port}/timing/impinj-crossing?eventId={self.event_id}"
        elif self.reader_mode == "zebra-fx7500":
            local_endpoint = f"http://localhost:{self.local_port}/timing/zebra-crossing?eventId={self.event_id}"
        else:
            local_endpoint = f"http://localhost:{self.local_port}/timing/crossing"

        rmonitor_clients = self.rmonitor_server.client_count if self.rmonitor_server else 0
        rmonitor_port    = self.rmonitor_server.port        if self.rmonitor_server else 0
        rmonitor_card = ""
        if self.rmonitor_server:
            rm_color = "#22c55e" if rmonitor_clients else "#6b7280"
            rm_status = f"{rmonitor_clients} connected" if rmonitor_clients else "Waiting for clients"
            rmonitor_card = f"""
  <div class="card">
    <h2>RMonitor Live Output</h2>
    <div class="row"><span>TCP port</span> <span class="val">{rmonitor_port}</span></div>
    <div class="row"><span>Scoreboard clients</span> <span class="val" style="color:{rm_color}">{rm_status}</span></div>
    <p style="color:#aaa;font-size:0.85rem;margin-top:0.75rem">Connect your scoreboard or Race Monitor to:</p>
    <code>tcp://YOUR-LAPTOP-IP:{rmonitor_port}</code>
  </div>"""

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
    <div class="row"><span>Bridge mode</span> <span class="reader-badge" style="background:#1a3a1f;color:#86efac;border-color:#16a34a">{mode_label}</span></div>
    <div class="row"><span>Reader mode</span> <span class="reader-badge">{reader_label}</span></div>
    {f'<div class="row"><span>Club ID</span> <span class="val">{self.club_id}</span></div>' if self.bridge_mode == "practice" else ''}
    {f'<div class="row"><span>Event ID</span> <span class="val">{self.event_id}</span></div>' if self.event_id and self.bridge_mode != "practice" else ''}
  </div>
  <div class="card">
    <h2>Reader Endpoint</h2>
    <p style="color:#aaa;font-size:0.85rem">Point your {reader_label}&apos;s HTTP output to:</p>
    <code>{local_endpoint}</code>
  </div>
  {rmonitor_card}
  <p class="dim">Page refreshes every 5 seconds</p>
</body>
</html>"""

        data = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


# ── RMonitor TCP server ────────────────────────────────────────────────────────
# Accepts connections from scoreboards, announcer software, and Race Monitor.
# Each connected client receives all RMonitor protocol lines pushed by the cloud
# via the SSE feed.  The bridge acts as the protocol bridge:
#
#   Cloud SSE  →  rfid_bridge (this script)  →  TCP :50000  →  scoreboard/app

class RMonitorServer:
    """Local TCP server that re-exposes the cloud RMonitor SSE feed on a TCP port."""

    def __init__(self, port: int, api_url: str, event_id: str):
        self.port = port
        self.api_url = api_url
        self.event_id = event_id
        self._clients: list = []
        self._lock = threading.Lock()

    def start(self, stop: threading.Event):
        """Start the TCP accept loop and SSE listener in background threads."""
        threading.Thread(
            target=self._accept_loop, args=(stop,),
            daemon=True, name="rmonitor-tcp",
        ).start()
        threading.Thread(
            target=self._sse_loop, args=(stop,),
            daemon=True, name="rmonitor-sse",
        ).start()

    # ── TCP accept loop ─────────────────────────────────────────────────────
    def _accept_loop(self, stop: threading.Event):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("0.0.0.0", self.port))
        srv.listen(16)
        srv.settimeout(1.0)
        log.info("RMonitor: TCP server listening on port %d", self.port)
        while not stop.is_set():
            try:
                conn, addr = srv.accept()
                threading.Thread(
                    target=self._handle_client, args=(conn, addr),
                    daemon=True,
                ).start()
            except socket.timeout:
                continue
            except Exception as e:
                if not stop.is_set():
                    log.warning("RMonitor: accept error: %s", e)
        try:
            srv.close()
        except Exception:
            pass

    def _handle_client(self, conn: socket.socket, addr):
        log.info("RMonitor: client connected  %s:%d", *addr)
        with self._lock:
            self._clients.append(conn)
        try:
            # Send snapshot so the client gets current race state immediately
            snapshot_lines = self._fetch_snapshot()
            for line in snapshot_lines:
                conn.sendall((line + "\r\n").encode("ascii", errors="ignore"))
            # Keep open — the client rarely sends anything but we poll to
            # detect disconnection quickly.
            conn.settimeout(2.0)
            while True:
                try:
                    data = conn.recv(64)
                    if not data:
                        break  # graceful close
                except socket.timeout:
                    continue  # just checking if still alive
                except Exception:
                    break
        except Exception:
            pass
        finally:
            with self._lock:
                if conn in self._clients:
                    self._clients.remove(conn)
            try:
                conn.close()
            except Exception:
                pass
            log.info("RMonitor: client disconnected  %s:%d", *addr)

    def _fetch_snapshot(self) -> list:
        url = f"{self.api_url.rstrip('/')}/api/timing/rmonitor-snapshot?eventId={self.event_id}"
        try:
            with urllib.request.urlopen(url, timeout=6) as resp:
                data = json.loads(resp.read().decode())
                return data.get("lines", [])
        except Exception as e:
            log.warning("RMonitor: failed to fetch snapshot: %s", e)
            return []

    # ── SSE listener ────────────────────────────────────────────────────────
    def _sse_loop(self, stop: threading.Event):
        url = f"{self.api_url.rstrip('/')}/api/timing/rmonitor-feed?eventId={self.event_id}"
        while not stop.is_set():
            try:
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=90) as resp:
                    log.info("RMonitor: subscribed to cloud SSE feed (event %s)", self.event_id)
                    buf = ""
                    while not stop.is_set():
                        chunk = resp.read(4096)
                        if not chunk:
                            break  # server closed stream
                        buf += chunk.decode("utf-8", errors="ignore")
                        # SSE events are separated by double newline
                        while "\n\n" in buf:
                            event_block, buf = buf.split("\n\n", 1)
                            for line in event_block.split("\n"):
                                if line.startswith("data: "):
                                    raw = line[6:].strip()
                                    try:
                                        msg = json.loads(raw)
                                        lines = msg.get("lines", [])
                                        if lines and not msg.get("heartbeat"):
                                            self._broadcast(lines)
                                    except Exception:
                                        pass
            except Exception as e:
                if not stop.is_set():
                    log.warning("RMonitor: SSE disconnected — %s  (reconnect in 5s)", e)
                    time.sleep(5)

    def _broadcast(self, lines: list):
        if not lines:
            return
        data = "".join(line + "\r\n" for line in lines).encode("ascii", errors="ignore")
        with self._lock:
            dead = []
            for conn in list(self._clients):
                try:
                    conn.sendall(data)
                except Exception:
                    dead.append(conn)
            for conn in dead:
                if conn in self._clients:
                    self._clients.remove(conn)

    @property
    def client_count(self) -> int:
        with self._lock:
            return len(self._clients)


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
        help="Event ID — required for impinj-r700 and zebra-fx7500 reader modes; also required for --rmonitor",
    )
    parser.add_argument(
        "--mode",
        default=os.getenv("RMMX_MODE", "race"),
        choices=["race", "practice"],
        metavar="MODE",
        help="Bridge mode: 'race' (default) routes crossings to race moto timing; "
             "'practice' routes crossings to the active practice session for --club-id.",
    )
    parser.add_argument(
        "--club-id",
        default=os.getenv("RMMX_CLUB_ID", ""),
        metavar="N",
        help="Club ID — required when --mode practice. Find yours in the organizer portal URL.",
    )
    parser.add_argument(
        "--rmonitor",
        type=int,
        default=int(os.getenv("RMMX_RMONITOR", "0")),
        metavar="PORT",
        help="Enable RMonitor TCP server on this local port (default 0 = disabled). "
             "Scoreboards/announcers connect to tcp://YOUR-IP:PORT. Requires --event-id.",
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

    if args.mode == "practice" and not args.club_id:
        print()
        print("ERROR: --club-id is required when using --mode practice")
        print()
        print("Find your Club ID in the organizer portal URL (e.g. /organizer/clubs/3 → club ID is 3).")
        print()
        print("Example:")
        print("  python rfid_bridge.py --api-url https://your-app.replit.app \\")
        print("                        --mode practice \\")
        print("                        --club-id 1")
        print()
        sys.exit(1)

    if args.mode == "race" and args.reader in ("impinj-r700", "zebra-fx7500") and not args.event_id:
        print()
        print(f"ERROR: --event-id is required when using --reader {args.reader} in race mode")
        print()
        print(f"Example:")
        print(f"  python rfid_bridge.py --api-url https://your-app.replit.app \\")
        print(f"                        --reader {args.reader} \\")
        print(f"                        --event-id 12")
        print()
        sys.exit(1)

    if args.rmonitor and not args.event_id:
        print()
        print("ERROR: --event-id is required when using --rmonitor")
        print()
        print("Example:")
        print("  python rfid_bridge.py --api-url https://your-app.replit.app \\")
        print("                        --event-id 12 \\")
        print("                        --rmonitor 50000")
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
    log.info("  Bridge mode: %s", args.mode.upper())
    log.info("  Reader mode: %s", reader_labels.get(args.reader, args.reader))
    if args.mode == "practice":
        log.info("  Club ID    : %s", args.club_id)
        log.info("  → Crossings route to active practice session for club %s", args.club_id)
    elif args.event_id:
        log.info("  Event ID   : %s", args.event_id)
    log.info("  Local port : %d", args.port)
    log.info("  Cache file : %s", args.db)
    log.info("  Retry every: %ds", args.retry)
    if args.rmonitor:
        log.info("  RMonitor   : tcp://YOUR-LAPTOP-IP:%d  (scoreboards / Race Monitor)", args.rmonitor)
    log.info("")
    log.info("  Reader endpoint → %s", local_endpoint)
    log.info("  Status page     → http://localhost:%d", args.port)
    if args.rmonitor:
        log.info("  RMonitor TCP    → connect scoreboard to tcp://YOUR-LAPTOP-IP:%d", args.rmonitor)
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
    BridgeHandler.bridge_mode = args.mode
    BridgeHandler.event_id = args.event_id
    BridgeHandler.club_id = args.club_id
    BridgeHandler.db = db
    BridgeHandler.db_lock = db_lock

    # ── Start RMonitor TCP server (optional) ──────────────────────────────────
    rmonitor_server: "RMonitorServer | None" = None
    if args.rmonitor:
        rmonitor_server = RMonitorServer(args.rmonitor, args.api_url, args.event_id)
        rmonitor_server.start(stop_event)
    BridgeHandler.rmonitor_server = rmonitor_server

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
