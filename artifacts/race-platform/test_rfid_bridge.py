import importlib.util
from datetime import datetime, timezone
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location(
    "rfid_bridge", Path(__file__).parent / "public" / "rfid_bridge.py")
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


@unittest.skipIf(bridge.ZoneInfo is None, "zoneinfo unavailable")
class LocalDecoderTimeTests(unittest.TestCase):
    def decode(self, zone, receipt, hour, minute, second=0, centis=12):
        value = ((hour * 3600 + minute * 60 + second) * 100) + centis
        return bridge._decode_local_centiseconds(
            value, datetime.fromisoformat(receipt), bridge.ZoneInfo(zone))

    def test_supported_host_zones_and_centiseconds(self):
        cases = [
            ("America/Denver", "2025-01-15T17:00:00.120+00:00"),
            ("America/New_York", "2025-01-15T15:00:00.120+00:00"),
            ("America/Los_Angeles", "2025-01-15T18:00:00.120+00:00"),
            ("UTC", "2025-01-15T10:00:00.120+00:00"),
            ("Asia/Kathmandu", "2025-01-15T04:15:00.120+00:00"),
            ("Australia/Eucla", "2025-01-15T01:15:00.120+00:00"),
        ]
        for zone, receipt in cases:
            with self.subTest(zone=zone):
                self.assertEqual(
                    self.decode(zone, receipt, 10, 0),
                    datetime.fromisoformat(receipt))

    def test_midnight_rollover_selects_nearest_date(self):
        self.assertEqual(
            self.decode(
                "America/Denver", "2025-01-16T07:00:02.120+00:00",
                0, 0, 1).isoformat(),
            "2025-01-16T07:00:01.120000+00:00",
        )

    def test_dst_ambiguity_uses_receipt_proximity(self):
        self.assertEqual(
            self.decode(
                "America/New_York", "2025-11-02T06:30:00.120+00:00",
                1, 30).isoformat(),
            "2025-11-02T06:30:00.120000+00:00",
        )

    def test_nonexistent_and_wrong_clocks_fall_back_to_receipt(self):
        spring_receipt = "2025-03-09T07:30:00.120+00:00"
        self.assertEqual(
            self.decode("America/New_York", spring_receipt, 2, 30),
            datetime.fromisoformat(spring_receipt),
        )
        receipt = "2025-01-15T17:00:00.120+00:00"
        self.assertEqual(
            self.decode("America/Denver", receipt, 12, 0),
            datetime.fromisoformat(receipt))
        self.assertEqual(
            self.decode("America/Denver", receipt, 4, 0),
            datetime.fromisoformat(receipt))



class CloudForwardAuthTests(unittest.TestCase):
    """forward_to_cloud sends the reader token and keeps auth failures queued."""

    def serve(self, status):
        import http.server
        import threading
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                seen.append((self.path, self.headers.get("Authorization")))
                self.send_response(status)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}", seen

    def setUp(self):
        self.addCleanup(setattr, bridge, "READER_TOKEN", bridge.READER_TOKEN)

    def test_sends_bearer_token_when_configured(self):
        bridge.READER_TOKEN = "tok-123"
        url, seen = self.serve(200)
        self.assertTrue(bridge.forward_to_cloud(url, "/api/timing/crossing", {"rfidNumber": "A"}))
        self.assertEqual(seen, [("/api/timing/crossing", "Bearer tok-123")])

    def test_omits_header_without_token(self):
        bridge.READER_TOKEN = ""
        url, seen = self.serve(200)
        self.assertTrue(bridge.forward_to_cloud(url, "/api/timing/crossing", {"rfidNumber": "A"}))
        self.assertEqual(seen, [("/api/timing/crossing", None)])

    def test_auth_failures_stay_queued(self):
        for status in (401, 403):
            with self.subTest(status=status):
                url, _ = self.serve(status)
                self.assertFalse(bridge.forward_to_cloud(url, "/api/timing/crossing", {"rfidNumber": "A"}))

    def test_permanent_rejections_still_marked_done(self):
        url, _ = self.serve(409)
        self.assertTrue(bridge.forward_to_cloud(url, "/api/timing/crossing", {"rfidNumber": "A"}))


if __name__ == "__main__":
    unittest.main()