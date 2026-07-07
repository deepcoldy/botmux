#!/usr/bin/env python3
"""Generate realtime voice protobuf golden vectors from reference Python pb2 modules.

Usage:
  python3 scripts/generate-vc-realtime-golden.py --reference-dir /path/to/reference-protos

The reference directory must contain frontier_pb2.py and meeting_realtime_pb2.py.
If your system Python does not have protobuf, install it in a throwaway target:
  python3 -m pip install --target /tmp/protobuf-6.31.1 protobuf==6.31.1
  PYTHONPATH=/tmp/protobuf-6.31.1 python3 scripts/generate-vc-realtime-golden.py --reference-dir ...
"""

from __future__ import annotations

import argparse
import pathlib
import sys


FRONTIER_SERVICE = 33555721
FRONTIER_METHOD = 1
FRAME_TYPE_NORMAL = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-dir", required=True, help="Directory containing reference pb2 modules")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    reference_dir = pathlib.Path(args.reference_dir).resolve()
    sys.path.insert(0, str(reference_dir))

    try:
        import frontier_pb2  # type: ignore[import-not-found]
        import meeting_realtime_pb2 as mr  # type: ignore[import-not-found]
    except ImportError as exc:
        raise SystemExit(f"failed to import reference pb2 modules from {reference_dir}: {exc}") from exc

    fmt = mr.AudioFormat(type="audio/pcm", encoding="s16le", sample_rate=24000)
    session = mr.Session(
        media=mr.Media(
            audio_upstream_format=fmt,
            audio_downstream_format=fmt,
        )
    )

    create = mr.ClientEvent(
        type="session.create",
        event_id="11111111-2222-3333-4444-555555555555",
        session_id=0,
        created_at="2026-07-01T00:00:00Z",
        session_create=mr.SessionCreate(session=session),
    )
    print("SESSION_CREATE_HEX", create.SerializeToString().hex())
    print("FRONTIER_SESSION_CREATE_HEX", wrap(frontier_pb2, create, 1).hex())

    server = mr.ServerEvent(
        type="session.created",
        event_id="server-event-id",
        session_id=12345,
        created_at="2026-07-01T00:00:01Z",
        session_created=mr.SessionCreated(client_event_id=create.event_id, session=session),
    )
    print("SERVER_SESSION_CREATED_FRONTIER_HEX", wrap(frontier_pb2, server, 2).hex())

    append = mr.ClientEvent(
        type="audio.upstream.append",
        event_id="",
        session_id=12345,
        created_at="2026-07-01T00:00:02Z",
        audio_upstream_append=mr.AudioUpstreamAppend(delta=b"abc"),
    )
    print("AUDIO_APPEND_HEX", append.SerializeToString().hex())

    close = mr.ClientEvent(
        type="session.close",
        event_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        session_id=12345,
        created_at="2026-07-01T00:00:03Z",
        session_close=mr.SessionClose(reason=mr.USER_LEFT),
    )
    print("SESSION_CLOSE_HEX", close.SerializeToString().hex())
    return 0


def wrap(frontier_pb2, event, seq_id: int) -> bytes:
    frame = frontier_pb2.Frame()
    frame.SeqID = seq_id
    frame.LogID = 0
    frame.service = FRONTIER_SERVICE
    frame.method = FRONTIER_METHOD
    frame.payload_encoding = "binary"
    frame.payload_type = "application/x-protobuf"
    frame.payload = event.SerializeToString()
    frame.LogIDNew = ""
    frame.msg_id = event.event_id or ""
    frame.frame_type = FRAME_TYPE_NORMAL
    return frame.SerializeToString()


if __name__ == "__main__":
    raise SystemExit(main())
