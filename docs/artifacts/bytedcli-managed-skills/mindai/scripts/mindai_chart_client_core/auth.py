"""Authentication and config CLI commands."""

from __future__ import annotations

from .managed import managed_mode, managed_request

import argparse
import os
import re
import subprocess
import time
from contextlib import suppress

from .constants import (
    BYTEDCLI_GET_JWT_COMMAND,
    BYTEDCLI_INSTALL_COMMAND,
    BYTEDCLI_LOGIN_COMMAND,
    DEFAULT_AUTH_PROVIDER,
    DEFAULT_BASE_URL,
    GATEWAY_FEISHU_AUTH_PATH,
    GET_JWT_COMMAND,
    MINDAI_CHAT_URL,
)
from .http_client import http_json, request_headers
from .models import ChartConfig, ClientError, JsonObject
from .storage import config_path, load_config, save_config
from .utils import as_int, as_str, join_url, print_json, redacted_headers, sanitize_error_detail

JWT_PATTERN = re.compile(r"\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
MIRA_ENVIRONMENT_KEY_MARKER = "X-MIRA"


def feishu_auth_status(config: ChartConfig, timeout: int = 30) -> JsonObject:
    url = join_url(config.base_url, GATEWAY_FEISHU_AUTH_PATH)
    payload = http_json("GET", url, resolve_request_headers(config, timeout=timeout), timeout=timeout)
    if is_token_refresh_needed(payload):
        payload = http_json("GET", url, resolve_request_headers(config, timeout=timeout), timeout=timeout)
    return payload


def ensure_feishu_auth_ready(config: ChartConfig, timeout: int = 30) -> JsonObject:
    payload = feishu_auth_status(config, timeout=timeout)
    if as_int(payload.get("code")) == 0 and payload.get("auth") is True:
        return payload
    raise ClientError(feishu_auth_failure_guidance(payload))


def command_auth_status(args: argparse.Namespace) -> int:
    payload = feishu_auth_status(load_config(args), timeout=args.timeout)
    print_json(payload)
    return 0


def token_from_text(raw: str) -> str | None:
    match = JWT_PATTERN.search(raw.strip())
    return match.group(0) if match else None


def run_token_command(command: list[str], *, timeout: int = 60) -> str:
    try:
        completed = subprocess.run(  # noqa: S603 - command argv is selected from fixed auth providers.
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise ClientError(f"Required executable not found: {command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ClientError(
            f"Timed out while obtaining a ByteCloud JWT. Run `{BYTEDCLI_GET_JWT_COMMAND}` manually."
        ) from exc
    output = f"{completed.stdout}\n{completed.stderr}".strip()
    token = token_from_text(completed.stdout)
    if completed.returncode == 0 and token:
        return token
    raise ClientError(f"Could not obtain a ByteCloud JWT. Command output: {sanitize_error_detail(output)}")


def get_bytedcli_jwt(*, timeout: int = 60) -> str:
    command = ["bytedcli", "auth", "get-bytecloud-jwt-token"]
    try:
        return run_token_command(command, timeout=timeout)
    except ClientError as exc:
        if "not found" not in str(exc).lower():
            raise
        install_bytedcli(timeout=max(timeout, 120))
        try:
            return run_token_command(command, timeout=timeout)
        except ClientError as retry_exc:
            raise ClientError(f"Installed bytedcli, but could not obtain a ByteCloud JWT. {retry_exc}") from retry_exc


def install_bytedcli(*, timeout: int = 120) -> None:
    command = [
        "npm",
        "install",
        "-g",
        "@bytedance-dev/bytedcli@latest",
        "--registry",
        "https://bnpm.byted.org",
    ]
    try:
        completed = subprocess.run(  # noqa: S603 - fixed npm install command for the bytedcli dependency.
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise ClientError("Could not run npm to install bytedcli. Please install Node.js/npm first.") from exc
    except subprocess.TimeoutExpired as exc:
        raise ClientError(f"Timed out while installing bytedcli. Run `{BYTEDCLI_INSTALL_COMMAND}` manually.") from exc
    if completed.returncode != 0:
        output = f"{completed.stdout}\n{completed.stderr}".strip()
        raise ClientError(
            f"Could not install bytedcli with `{BYTEDCLI_INSTALL_COMMAND}`. "
            f"Output: {sanitize_error_detail(output)}"
        )


def bytecloud_jwt_headers(*, timeout: int = 60) -> dict[str, str]:
    try:
        return {"X-Jwt-Token": get_bytedcli_jwt(timeout=timeout)}
    except ClientError as exc:
        raise ClientError(bytedcli_jwt_failure_guidance(exc)) from exc


def is_mira_environment() -> bool:
    return any(MIRA_ENVIRONMENT_KEY_MARKER in key.upper() for key in os.environ)


def bytedcli_jwt_failure_guidance(error: ClientError) -> str:
    message = str(error)
    return (
        "Could not obtain a ByteCloud JWT with bytedcli. "
        f"Run `{BYTEDCLI_LOGIN_COMMAND}` to start non-blocking ByteCloud Auth login, "
        "finish the QR/browser authorization, complete the login with the returned token, "
        "then retry the MindAI chart command. "
        f"bytedcli output: {message[:1000]}"
    )


def resolve_request_headers(
    config: ChartConfig,
    extra: dict[str, str] | None = None,
    *,
    timeout: int = 60,
) -> dict[str, str]:
    if managed_mode():
        return dict(extra or {})
    provider_headers = bytecloud_jwt_headers(timeout=timeout)
    effective_headers = dict(config.headers)
    effective_headers.update(provider_headers)
    effective_config = ChartConfig(
        base_url=config.base_url,
        headers=effective_headers,
        auth_provider=config.auth_provider,
        created_at=config.created_at,
    )
    return request_headers(effective_config, extra)


def command_login(args: argparse.Namespace) -> int:
    headers: dict[str, str] = {}
    auth_provider = args.provider or DEFAULT_AUTH_PROVIDER

    base_url = args.base_url or os.getenv("MINDAI_CHART_BASE_URL") or DEFAULT_BASE_URL
    if not base_url:
        raise ClientError("Could not infer base_url. Pass --base-url.")
    config = ChartConfig(
        base_url=base_url.rstrip("/"),
        headers=headers,
        auth_provider=auth_provider,
        created_at=int(time.time()),
    )
    save_config(config_path(args), config)
    if not args.no_validate:
        try:
            status_payload = ensure_feishu_auth_ready(config, timeout=args.timeout)
        except ClientError as exc:
            raise ClientError(f"Saved login, but validation failed: {exc}") from exc
        print_json({"ok": True, "config": str(config_path(args)), "feishu_auth": status_payload})
    else:
        print_json(
            {
                "ok": True,
                "config": str(config_path(args)),
                "auth_provider": config.auth_provider,
            }
        )
    return 0


def command_logout(args: argparse.Namespace) -> int:
    path = config_path(args)
    with suppress(FileNotFoundError):
        path.unlink()
    print_json({"ok": True, "config": str(path), "message": "Logged out"})
    return 0


def command_config(args: argparse.Namespace) -> int:
    config = load_config(args)
    headers: JsonObject = {}
    for key, value in redacted_headers(config.headers).items():
        headers[key] = value
    payload: JsonObject = {
        "base_url": config.base_url,
        "auth_provider": config.auth_provider,
        "default_run_mode": config.default_run_mode,
        "default_continue_mode": config.default_continue_mode,
        "created_at": config.created_at,
        "headers": headers,
        "config_path": str(config_path(args)),
    }
    print_json(payload)
    return 0


def is_token_refresh_needed(payload: JsonObject) -> bool:
    code = as_int(payload.get("code"))
    message = as_str(payload.get("message")).lower()
    return code in {1001, 1002} or (
        "token" in message
        and any(marker in message for marker in ("not exist", "invalid", "expire", "expired", "过期"))
    )


def feishu_auth_failure_guidance(payload: JsonObject) -> str:
    code = as_int(payload.get("code"))
    message = as_str(payload.get("message")) or "unknown auth failure"
    detail = f"feishuHasAuth returned code={code}, auth={payload.get('auth')!r}, message={message!r}."
    if is_token_refresh_needed(payload):
        return (
            f"{detail} The ByteCloud JWT is missing, invalid, or expired. "
            f"Run `{GET_JWT_COMMAND}` to get a fresh token. "
            f"If that cannot refresh silently, run `{BYTEDCLI_LOGIN_COMMAND}`."
        )
    if code == 0 and payload.get("auth") is False:
        return (
            f"{detail} MindAI Feishu authorization is not ready. "
            f"Visit {MINDAI_CHAT_URL} once to finish MindAI initialization and Feishu authorization, then retry."
        )
    return (
        f"{detail} MindAI authorization is not ready. "
        f"Visit {MINDAI_CHAT_URL} once to finish initialization and authorization, then retry."
    )
