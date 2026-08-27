# F2000 beep latency test

Use this procedure with a real F2000/Feibot reader after connecting it through either RM Tracker Desktop or RM Connect.

1. Synchronize the F2000 clock, start a moto, and leave the organizer Motos page open.
2. Open the browser developer console. In development builds, filter for `timing-latency`.
3. Pass one active transponder over the enabled loop once.
4. Confirm one beep occurs immediately, followed by the normal leaderboard update.
5. Keep the tag over the loop or pass it again inside the debounce window. Confirm there is no second beep and no extra lap.
6. Record a manual lap. Confirm its optimistic click beep occurs once and its accepted event/snapshot do not add another beep.
7. Repeat through both Desktop/local-server and RM Connect/cloud.

The `crossing accepted` diagnostic separates:

- `deviceToReaderMs`: F2000 crossing timestamp to desktop/connector packet receipt (requires a synchronized reader clock).
- `readerToServerMs`: desktop/connector packet receipt through local/network delivery to server ingest.
- `ingestToAckMs`: server ingest through acceptance and persistence.
- `ackToBrowserMs`: server acceptance event to browser receipt.
- `browserAudioScheduledMonotonicMs`: browser monotonic time when audio scheduling began.

The following `leaderboard snapshot` diagnostic reports acceptance-to-snapshot and snapshot-to-browser time. Official lap timestamps continue to use the F2000 crossing timestamp; diagnostics do not alter scoring.