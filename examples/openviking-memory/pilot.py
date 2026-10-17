#!/usr/bin/env python3
"""Optional Codex dialogue capture adapter for shared OpenViking memory."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parent
USER_ROOT = Path.home().resolve()
OV_ROOT = USER_ROOT / ".openviking"
BOT_ROOT = USER_ROOT / ".botmux"
VENV = USER_ROOT / ".local/share/openviking/venv"
PLUGIN = "openviking-memory@openviking"


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def load_runtime():
    path = ROOT / "runtime.json"
    return json.loads(path.read_text()) if path.exists() else {}


def selected_bot(bots, app_id):
    matches = [(index, bot) for index, bot in enumerate(bots) if bot.get("larkAppId") == app_id]
    if len(matches) != 1:
        raise SystemExit("Selected Bot identity is missing or ambiguous.")
    index, bot = matches[0]
    if bot.get("cliId") != "codex" or len(bot.get("allowedUsers", [])) != 1:
        raise SystemExit("This example requires one existing Codex Bot with exactly one allowed user.")
    return index, bot


def configure(arguments):
    previous_runtime = load_runtime()
    bots_path = Path(arguments.bots_config or previous_runtime.get("bots_config")
                     or os.environ.get("BOTS_CONFIG") or BOT_ROOT / "bots.json").expanduser().resolve()
    bots = json.loads(bots_path.read_text())
    if arguments.bot_index is None:
        if not previous_runtime.get("bot_app_id"):
            raise SystemExit("Specify --bot-index explicitly; no Bot is selected or enabled by default.")
        index, bot = selected_bot(bots, previous_runtime["bot_app_id"])
    else:
        if arguments.bot_index < 0 or arguments.bot_index >= len(bots):
            raise SystemExit("--bot-index is outside the configured Bot list.")
        index, bot = selected_bot(bots, bots[arguments.bot_index]["larkAppId"])
        if previous_runtime.get("bot_app_id") not in (None, bot["larkAppId"]):
            raise SystemExit("This example directory is already configured for another Bot.")
    codex_home = Path(os.environ.get("CODEX_HOME") or USER_ROOT / ".codex").expanduser().resolve()
    codex_config = tomllib.loads((codex_home / "config.toml").read_text())
    model = arguments.vlm_model or codex_config.get("model")
    if not model:
        raise SystemExit("Provide --vlm-model or configure a Codex model before setup.")
    server = {
        "server": {
            "host": "127.0.0.1", "port": 1933,
            "user_config_defaults": {"auto_commit_policy": {
                "pending_token_threshold": 20000,
                "message_count_threshold": 100,
                "idle_timeout_seconds": 120,
                "keep_recent_count": 0,
                "min_commit_interval_seconds": 60,
            }},
        },
        "storage": {
            "workspace": str(OV_ROOT / "data"),
            "agfs": {"backend": "local"}, "vectordb": {"backend": "local"},
        },
        "embedding": {
            "max_concurrent": 2,
            "dense": {"provider": "local", "model": "bge-small-zh-v1.5-f16", "dimension": 512},
        },
        "vlm": {"provider": "openai-codex", "model": model,
                "reasoning_effort": "low", "max_concurrent": 2},
        "memory": {"session_auto_commit": {"enabled": True, "check_interval_seconds": 30}},
    }
    server_path = OV_ROOT / "ov.conf"
    if server_path.exists() and not previous_runtime and not arguments.use_existing_server:
        raise SystemExit("An existing OpenViking server config needs to be reconciled before this pilot.")
    if arguments.use_existing_server:
        server = json.loads(server_path.read_text())
        if server.get("server", {}).get("host") != "127.0.0.1" or server.get("server", {}).get("port") != 1933:
            raise SystemExit("This example expects a local OpenViking server on 127.0.0.1:1933.")
        model = server["vlm"]["model"]
    client_path = Path(previous_runtime.get("client_config")
                       or BOT_ROOT / "openviking" / bot["larkAppId"] / "ovcli.conf")
    previous_client = json.loads(client_path.read_text()) if client_path.exists() else {}
    memory_user = arguments.memory_user or previous_client.get("user")
    if not memory_user:
        raise SystemExit("Provide --memory-user explicitly; all coding agents should reuse this shared user.")
    client = {
        **previous_client,
        "url": previous_client.get("url") or "http://127.0.0.1:1933",
        "api_key": previous_client.get("api_key", ""),
        "account": previous_client.get("account") or "default", "user": memory_user,
        "peer": previous_client.get("peer") or {"source": ["{git_remote}", "{git_root}", "{cwd}"]},
        "plugin": {**previous_client.get("plugin", {}), "codex": {
            **previous_client.get("plugin", {}).get("codex", {}),
            "autoRecall": False, "noAutoInject": True, "resumeArchiveInject": False,
            "recallRewrite": "off", "recallPeerScope": "actor", "commitTokenThreshold": 20000,
            "commitKeepRecentCount": 10,
        }},
    }
    codex_candidate = arguments.codex or previous_runtime.get("codex") or shutil.which("codex")
    if not codex_candidate:
        raise SystemExit("Provide --codex or install Codex before setup.")
    codex = str(Path(codex_candidate).expanduser().resolve())
    help_text = subprocess.check_output([codex, "--help"], text=True)
    if "--no-daemon" not in help_text:
        raise SystemExit("Select a Codex release supporting --no-daemon so hook credentials stay scoped to this Bot.")
    version = subprocess.check_output([codex, "--version"], text=True).strip()
    botmux_root = Path(arguments.botmux_root or previous_runtime.get("botmux_installed") or ROOT.parents[1]).expanduser().resolve()
    if json.loads((botmux_root / "package.json").read_text()).get("name") != "botmux":
        raise SystemExit("--botmux-root must identify an installed Botmux package or a built checkout.")
    pm2 = arguments.pm2 or previous_runtime.get("pm2") or shutil.which("pm2")
    bundled_pm2 = botmux_root / "node_modules/pm2/bin/pm2"
    if not pm2 and bundled_pm2.is_file():
        pm2 = str(bundled_pm2)
    working_dir = bot.get("defaultWorkingDir")
    if not working_dir:
        directories = bot.get("workingDirs") or str(bot.get("workingDir") or "").split(",")
        working_dir = next((directory.strip() for directory in directories if directory.strip()), str(USER_ROOT))
    runtime = {
        "bot_app_id": bot["larkAppId"], "codex": codex, "codex_version": version,
        "plugin": PLUGIN, "client_config": str(client_path),
        "server_config": str(server_path), "vlm_model": model,
        "botmux_installed": str(botmux_root), "bots_config": str(bots_path),
        "bot_index": index, "codex_home": str(codex_home), "pm2": pm2,
        "working_dir": str(Path(working_dir).expanduser().resolve()),
    }
    if previous_runtime.get("plugin_root"):
        runtime["plugin_root"] = previous_runtime["plugin_root"]
    if not arguments.use_existing_server:
        write_json(server_path, server)
    write_json(client_path, client)
    write_json(ROOT / "runtime.json", runtime)
    (ROOT / "bin/codex-openviking").chmod(0o755)
    print(json.dumps({"configured": True, "embedding": server["embedding"]["dense"],
                      "vlm_model": model, "client_config": str(client_path),
                      "enabled": bot.get("cliPathOverride") == str(ROOT / "bin/codex-openviking"),
                      "next_step": "Review/install the native plugin, verify it, then run bind explicitly."}))


def service(action):
    runtime = load_runtime()
    if action == "health":
        with urllib.request.urlopen("http://127.0.0.1:1933/health", timeout=5) as response:
            print(response.read().decode())
        return
    if not runtime.get("pm2"):
        raise SystemExit("Provide --pm2 at configure time or manage openviking-server with your own supervisor.")
    pm2 = runtime["pm2"]
    environment = dict(os.environ, PM2_HOME=str(OV_ROOT / "pm2"))
    environment["PATH"] = str(VENV / "bin") + os.pathsep + environment.get("PATH", "")
    if action == "start":
        (OV_ROOT / "logs").mkdir(parents=True, exist_ok=True)
        spec = {"apps": [{
            "name": "openviking-memory", "script": str(VENV / "bin/openviking-server"),
            "args": ["--config", str(OV_ROOT / "ov.conf")], "interpreter": "none",
            "cwd": str(OV_ROOT), "autorestart": True, "kill_timeout": 10000,
            "env": {"OPENVIKING_CONFIG_FILE": str(OV_ROOT / "ov.conf"),
                    "OMP_NUM_THREADS": "4", "OPENBLAS_NUM_THREADS": "4"},
            "out_file": str(OV_ROOT / "logs/server.out.log"),
            "error_file": str(OV_ROOT / "logs/server.err.log"),
        }]}
        spec_path = OV_ROOT / "ecosystem.config.json"
        write_json(spec_path, spec)
        subprocess.run([pm2, "start", str(spec_path), "--only", "openviking-memory"],
                       env=environment, check=True)
        subprocess.run([pm2, "save"], env=environment, check=True)
    elif action == "stop":
        subprocess.run([pm2, "stop", "openviking-memory"], env=environment, check=True)


def bind():
    runtime = json.loads((ROOT / "runtime.json").read_text())
    path = Path(runtime["bots_config"])
    raw = path.read_bytes()
    bots = json.loads(raw)
    _, bot = selected_bot(bots, runtime["bot_app_id"])
    wrapper = str(ROOT / "bin/codex-openviking")
    backup = Path(runtime["client_config"]).parent / "bots.before-openviking.json"
    if not backup.exists():
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_bytes(raw)
        backup.chmod(0o600)
    previous = bot.get("cliPathOverride")
    if previous not in (None, wrapper):
        raise SystemExit("Pilot already has a different CLI wrapper; reconcile it before binding.")
    bot["cliPathOverride"] = wrapper
    if path.read_bytes() != raw:
        raise SystemExit("bots.json changed concurrently; retry after inspection.")
    write_json(path, bots)
    print(json.dumps({"bound": True, "wrapper": wrapper, "backup": str(backup)}))


def unbind():
    runtime = json.loads((ROOT / "runtime.json").read_text())
    path = Path(runtime["bots_config"])
    raw = path.read_bytes()
    bots = json.loads(raw)
    index, selected = selected_bot(bots, runtime["bot_app_id"])
    wrapper = str(ROOT / "bin/codex-openviking")
    if selected.get("cliPathOverride") != wrapper:
        raise SystemExit("The selected Bot no longer uses this wrapper; inspect its config before rollback.")
    original = json.loads((Path(runtime["client_config"]).parent / "bots.before-openviking.json").read_text())
    _, previous = selected_bot(original, runtime["bot_app_id"])
    if "cliPathOverride" in previous:
        selected["cliPathOverride"] = previous["cliPathOverride"]
    else:
        selected.pop("cliPathOverride", None)
    if path.read_bytes() != raw:
        raise SystemExit("bots.json changed concurrently; retry after inspection.")
    write_json(path, bots)
    print(json.dumps({"unbound": True, "restart_bot_index": index}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["configure", "bind", "unbind", "start", "stop", "health"])
    parser.add_argument("--codex", help="Pin a Codex executable for this pilot without changing the global CLI.")
    parser.add_argument("--bot-index", type=int, help="Select one existing single-user Codex Bot explicitly.")
    parser.add_argument("--bots-config", help="Path to bots.json (defaults to BOTS_CONFIG or ~/.botmux/bots.json).")
    parser.add_argument("--botmux-root", help="Installed package or built checkout used by the Bot's daemon.")
    parser.add_argument("--pm2", help="Optional PM2 executable for the OpenViking service only.")
    parser.add_argument("--vlm-model", help="Model supported by your Codex account for memory extraction.")
    parser.add_argument("--memory-user", help="Explicit shared OpenViking user reused by all coding agents.")
    parser.add_argument("--use-existing-server", action="store_true", help="Reuse ov.conf without overwriting it.")
    arguments = parser.parse_args()
    action = arguments.action
    if action == "configure":
        configure(arguments)
    elif action == "bind":
        bind()
    elif action == "unbind":
        unbind()
    else:
        service(action)


if __name__ == "__main__":
    main()
