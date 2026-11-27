"""HTTP and SSE helpers."""

from __future__ import annotations

from .managed import managed_mode, managed_request

import json
import socket
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .models import ChartConfig, ClientError, JsonObject, JsonValue
from .utils import sanitize_error_detail

AddressInfo = tuple[int, int, int, str, tuple[Any, ...]]


def prefer_ipv4_addrinfos(addrinfos: Sequence[AddressInfo]) -> list[AddressInfo]:
    return sorted(addrinfos, key=addrinfo_family_priority)


def addrinfo_family_priority(addrinfo: AddressInfo) -> int:
    family = addrinfo[0]
    if family == socket.AF_INET:
        return 0
    if family == socket.AF_INET6:
        return 1
    return 2


@contextmanager
def prefer_ipv4_resolution() -> Iterator[None]:
    original_getaddrinfo = socket.getaddrinfo

    def getaddrinfo(*args: Any, **kwargs: Any) -> list[AddressInfo]:
        return prefer_ipv4_addrinfos(original_getaddrinfo(*args, **kwargs))

    socket.getaddrinfo = getaddrinfo  # type: ignore[assignment]
    try:
        yield
    finally:
        socket.getaddrinfo = original_getaddrinfo  # type: ignore[assignment]


def open_url(request: Request, timeout: int):
    with prefer_ipv4_resolution():
        return urlopen(request, timeout=timeout)  # noqa: S310


def header_map(headers: Mapping[str, str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, value in headers.items():
        if value:
            result[key] = value
    return result


def request_headers(config: ChartConfig, extra: Mapping[str, str] | None = None) -> dict[str, str]:
    headers = header_map(config.headers)
    headers.setdefault("Accept", "application/json")
    headers.setdefault("User-Agent", "mindai-chart-generation-p0/0.1")
    if extra:
        headers.update({key: value for key, value in extra.items() if value})
    return headers


def http_json(
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: JsonObject | None = None,
    timeout: int = 30,
) -> JsonObject:
    data: bytes | None = None
    if managed_mode():
        return managed_request(method, url, body, headers)
    request_headers_map = dict(headers)
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request_headers_map["Content-Type"] = "application/json"
    request = Request(url=url, data=data, headers=request_headers_map, method=method)  # noqa: S310
    try:
        with open_url(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = sanitize_error_detail(exc.read().decode("utf-8", errors="replace"))
        raise ClientError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except URLError as exc:
        raise ClientError(f"Cannot reach {url}: {exc}") from exc
    if not payload.strip():
        return {}
    try:
        raw = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ClientError(f"Non-JSON response from {url}: {sanitize_error_detail(payload, limit=500)}") from exc
    if not isinstance(raw, dict):
        raise ClientError(f"JSON response from {url} must be an object.")
    return raw


def http_sse(
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: JsonObject | None,
    timeout: int,
) -> Iterator[JsonObject]:
    if managed_mode():
        current_headers = dict(headers)
        while True:
            payload = managed_request(method, url, body, current_headers)
            event_lines = []
            for line in payload.get("events", "").splitlines():
                if not line:
                    event = parse_sse_event(event_lines)
                    event_lines = []
                    if event is not None:
                        if event.get("id") is not None:
                            current_headers["Last-Event-ID"] = str(event["id"])
                        yield event
                else:
                    event_lines.append(line)
            if not payload.get("continued", False):
                event = parse_sse_event(event_lines)
                if event is not None:
                    yield event
                return
            # Give the existing overall-watch deadline a chance to run even
            # when the host returned a bounded idle batch.
            yield {"type": "heartbeat"}
    request_headers_map = dict(headers)
    request_headers_map.setdefault("Accept", "text/event-stream")
    request_headers_map.setdefault("Cache-Control", "no-cache")
    data: bytes | None = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request_headers_map["Content-Type"] = "application/json"
    request = Request(url=url, data=data, headers=request_headers_map, method=method)  # noqa: S310
    try:
        with open_url(request, timeout=timeout) as response:
            event_lines: list[str] = []
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line:
                    event = parse_sse_event(event_lines)
                    event_lines = []
                    if event is not None:
                        yield event
                    continue
                event_lines.append(line)
            event = parse_sse_event(event_lines)
            if event is not None:
                yield event
    except HTTPError as exc:
        detail = sanitize_error_detail(exc.read().decode("utf-8", errors="replace"))
        raise ClientError(f"HTTP {exc.code} while watching {url}: {detail}") from exc
    except URLError as exc:
        raise ClientError(f"Cannot watch {url}: {exc}") from exc


def parse_sse_event(lines: Sequence[str]) -> JsonObject | None:
    data_parts: list[str] = []
    event_id: str | None = None
    event_name: str | None = None
    retry: str | None = None
    for line in lines:
        if line.startswith(":"):
            continue
        if ":" in line:
            field, value = line.split(":", 1)
            if value.startswith(" "):
                value = value[1:]
        else:
            field, value = line, ""
        if field == "id":
            event_id = value
        elif field == "event":
            event_name = value
        elif field == "data":
            data_parts.append(value)
        elif field == "retry":
            retry = value
    if not data_parts:
        return None
    payload = "\n".join(data_parts)
    try:
        raw: JsonValue = json.loads(payload)
    except json.JSONDecodeError:
        raw = {"type": "message", "message": payload}
    if not isinstance(raw, dict):
        raw = {"type": "message", "data": raw}
    if event_id is not None and "id" not in raw:
        raw["id"] = event_id
    if event_name and "event" not in raw:
        raw["event"] = event_name
    if retry and "retry" not in raw:
        raw["retry"] = retry
    return raw
