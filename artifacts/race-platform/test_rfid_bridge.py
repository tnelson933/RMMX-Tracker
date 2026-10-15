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


if __name__ == "__main__":
    unittest.main()