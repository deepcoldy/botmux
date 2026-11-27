"""Credential-free fixed operation client for a managed bytedcli wrapper."""
import base64
import json
import re
import subprocess
import tempfile
from functools import lru_cache
from urllib.parse import urlparse
from .models import ClientError


@lru_cache(maxsize=1)
def managed_mode():
    try:
        result = subprocess.run(["bytedcli", "--botmux-skill-api-contract"], capture_output=True, text=True, timeout=5, check=False)
        return result.returncode == 0 and result.stdout.strip() == "botmux.skill-api.v1"
    except (OSError, subprocess.TimeoutExpired):
        return False


def managed_request(method, url, body=None, headers=None):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "eops.bytedance.net" or parsed.query or parsed.fragment:
        raise ClientError("Managed MindAI only supports the fixed service; no credential fallback")
    operations = {
        ("GET", "/mindai/wiki/apiai/feishuHasAuth"): "mindai.auth.status",
        ("POST", "/mindai/deep_research/api/tasks"): "mindai.tasks.create",
        ("POST", "/mindai/deep_research/api/tasks/resume"): "mindai.tasks.resume",
        ("POST", "/mindai/deep_research/api/tasks/events"): "mindai.tasks.events",
        ("POST", "/mindai/wiki/apiai/uploadAttachment"): "mindai.attachment.upload",
    }
    operation = operations.get((method, parsed.path))
    if not operation:
        raise ClientError("Unsupported managed MindAI operation")
    request = dict(body or {})
    if operation == "mindai.tasks.events":
        request["lastEventId"] = (headers or {}).get("Last-Event-ID", "")
    if operation == "mindai.attachment.upload":
        attachment = request.get("attachment", {})
        match = re.fullmatch(r"data:([^;]+);base64,([A-Za-z0-9+/=]*)", attachment.get("content", ""))
        if not match:
            raise ClientError("Unsupported managed attachment")
        request = {"name": attachment.get("key"), "mimeType": match[1], "dataBase64": match[2]}
    try:
        encoded = json.dumps(request, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > 2 * 1024 * 1024:
            raise ClientError("Managed request exceeds the 2 MiB input limit")
        with tempfile.NamedTemporaryFile(mode="w+", encoding="utf-8", prefix="managed-skill-", suffix=".json") as staged:
            staged.write(encoded)
            staged.flush()
            result = subprocess.run(["bytedcli", "--json", "skill-api", operation, "--body-file", staged.name], capture_output=True, text=True, timeout=180, check=False)
        payload = json.loads(result.stdout)
        if result.returncode != 0 or payload.get("status") != "success":
            raise ValueError()
        return payload["data"]
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError):
        raise ClientError("Managed Skill API failed; no token export fallback or automatic retry") from None
