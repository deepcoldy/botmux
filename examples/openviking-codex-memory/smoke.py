#!/usr/bin/env python3
"""Verify native TUI capture, extraction, indexing, recall, and project scope."""

import json
from pathlib import Path
import shlex
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT / "evidence"
RUNTIME = json.loads((ROOT / "runtime.json").read_text())
SESSIONS = Path(RUNTIME["codex_home"]) / "sessions"
CLIENT = json.loads(Path(RUNTIME["client_config"]).read_text())
PLUGIN = "openviking-memory@openviking"
PREFIX = "墨桐已验收"
MARKER = "验收标签：紫杉-6419"
QUERY = "请按照墨桐项目此前约定的格式写一份发布摘要，内容是修复登录页面错误。只输出摘要，不调用工具、读取文件或发送外部消息。"


def api(path, peer, body=None):
    headers = {
        "X-OpenViking-Account": CLIENT["account"],
        "X-OpenViking-User": CLIENT["user"],
        "X-OpenViking-Actor-Peer": peer,
        "Content-Type": "application/json",
    }
    if CLIENT.get("api_key"):
        headers["Authorization"] = "Bearer " + CLIENT["api_key"]
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(CLIENT["url"] + path, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result.get("status") != "ok":
        raise RuntimeError(result)
    return result["result"]


def write_evidence(name, data):
    (EVIDENCE / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def read_turn(path):
    session_id, completed, answer, context, calls = "", False, "", [], []
    try:
        lines = path.read_text().splitlines()
    except FileNotFoundError:
        return None
    for line in lines:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = record.get("payload", {})
        if record.get("type") == "session_meta":
            session_id = payload["id"]
        if record.get("type") == "response_item":
            if payload.get("type") in ("function_call", "custom_tool_call"):
                calls.append(payload.get("name"))
            if payload.get("role") == "developer":
                for part in payload.get("content", []):
                    text = part.get("text", "")
                    if "<openviking-context>" in text:
                        context.append(text)
        if record.get("type") == "event_msg" and payload.get("type") == "task_complete":
            completed = True
            answer = payload.get("last_agent_message") or ""
    if not completed:
        return None
    return {"session_id": session_id, "answer": answer, "injected_context": context,
            "tool_calls": calls, "rollout_path": str(path)}


def run_turn(label, project, prompt, enabled=True):
    project.mkdir(parents=True, exist_ok=True)
    before = set(SESSIONS.rglob("rollout-*.jsonl"))
    pane = "ov-smoke-" + uuid.uuid4().hex[:12]
    command = json.loads(subprocess.check_output(["node", str(ROOT / "botmux-command.mjs"), str(project)], text=True))
    args = [command["bin"], *command["args"],
            "-c", "memories.use_memories=false", "-c", "memories.generate_memories=false",
            "-c", 'projects={' + json.dumps(str(project)) + '={trust_level="trusted"}}',
            "-c", 'model_reasoning_effort="low"']
    if not enabled:
        args += ["-c", f"plugins.{PLUGIN}.enabled=false"]
    args.append(prompt)
    subprocess.run(["tmux", "new-session", "-d", "-s", pane, "-x", "130", "-y", "40",
                    "-e", "BOTMUX_LARK_APP_ID=" + RUNTIME["bot_app_id"],
                    "-e", "CODEX_HOME=" + RUNTIME["codex_home"]], check=True)
    subprocess.run(["tmux", "set-option", "-w", "-t", pane, "remain-on-exit", "on"], check=True)
    subprocess.run(["tmux", "respawn-pane", "-k", "-t", pane, shlex.join(args)], check=True)
    finished = False
    try:
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            dead = subprocess.run(["tmux", "display-message", "-p", "-t", pane, "#{pane_dead}"],
                                  capture_output=True, text=True)
            if dead.stdout.strip() == "1":
                screen = subprocess.run(["tmux", "capture-pane", "-p", "-t", pane],
                                        capture_output=True, text=True).stdout
                raise RuntimeError(f"{label}: Codex exited before completing a turn: {screen.strip()}")
            for path in set(SESSIONS.rglob("rollout-*.jsonl")) - before:
                first = path.open().readline()
                try:
                    cwd = json.loads(first).get("payload", {}).get("cwd", "")
                except json.JSONDecodeError:
                    continue
                if Path(cwd).resolve() != project.resolve():
                    continue
                result = read_turn(path)
                if result:
                    write_evidence(label + ".json", result)
                    if not result["answer"].strip():
                        raise RuntimeError(f"{label} completed without an answer")
                    if result["tool_calls"]:
                        raise RuntimeError(f"{label} unexpectedly invoked tools: {result['tool_calls']}")
                    time.sleep(1)
                    subprocess.run(["tmux", "send-keys", "-t", pane, "-l", "/quit"], check=True)
                    time.sleep(0.3)
                    subprocess.run(["tmux", "send-keys", "-t", pane, "Enter"], check=True)
                    for _ in range(20):
                        dead = subprocess.run(["tmux", "display-message", "-p", "-t", pane, "#{pane_dead}"],
                                              capture_output=True, text=True)
                        if dead.returncode or dead.stdout.strip() == "1":
                            subprocess.run(["tmux", "kill-session", "-t", pane],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                            finished = True
                            print(json.dumps({"stage": label, "session_id": result["session_id"],
                                              "answer": result["answer"]}, ensure_ascii=False), flush=True)
                            return result
                        time.sleep(0.5)
                    raise TimeoutError(f"{label}: TUI did not exit normally")
            time.sleep(1)
        raise TimeoutError(f"{label}: no completed turn")
    finally:
        if not finished:
            screen = subprocess.run(["tmux", "capture-pane", "-p", "-t", pane, "-S", "-80"],
                                    capture_output=True, text=True)
            (EVIDENCE / (label + ".screen.txt")).write_text(screen.stdout)
            subprocess.run(["tmux", "kill-session", "-t", pane],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_extraction(session_id, peer):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        tasks = api("/api/v1/tasks?" + urllib.parse.urlencode({"resource_id": session_id}), peer)
        if tasks:
            task = tasks[0]
            if task["status"] in ("failed", "cancelled"):
                write_evidence("extraction.json", task)
                raise RuntimeError(task)
            if task["status"] == "completed":
                write_evidence("extraction.json", task)
                if sum(task["result"].get("memories_extracted", {}).values()) < 1:
                    raise RuntimeError("Extraction completed without creating memory")
                uri = task["result"]["memory_diff_uri"]
                diff = api("/api/v1/content/read?" + urllib.parse.urlencode({"uri": uri}), peer)
                write_evidence("memory-diff.json", diff)
                return task
        time.sleep(2)
    raise TimeoutError("Memory extraction did not complete")


def main():
    EVIDENCE.mkdir(exist_ok=True)
    nonce = uuid.uuid4().hex[:10]
    temporary = tempfile.TemporaryDirectory(prefix="botmux-openviking-")
    project = Path(temporary.name) / "project"
    peer = "botmux-pilot-" + nonce
    (project / ".openviking").mkdir(parents=True)
    (project / ".openviking/config.json").write_text(json.dumps({"version": 1, "peer": {"id": peer}}))
    baseline = run_turn("baseline", project, QUERY, enabled=False)
    if MARKER in baseline["answer"] or baseline["injected_context"]:
        raise RuntimeError("Baseline was contaminated by memory")
    seed = run_turn("seed", project,
        "本轮不要调用任何工具、读取文件或发送外部消息。请记住墨桐项目的长期发布摘要约定："
        f"每份发布摘要必须以‘{PREFIX}’开头，最后一行必须是‘{MARKER}’。"
        "这条约定只用于墨桐项目，不用于其他项目。本轮只回复‘已记住墨桐项目的发布摘要约定’。")
    task = wait_extraction("cx-" + seed["session_id"], peer)
    found = api("/api/v1/search/find", peer, {
        "query": "墨桐项目发布摘要格式约定", "target_uri": "viking://user/" + CLIENT["user"],
        "context_type": "memory", "limit": 5, "read_content": True,
    })
    write_evidence("indexed-search.json", found)
    if not any(MARKER in item.get("content", "") for item in found.get("memories", [])):
        raise RuntimeError("Extracted memory is not retrievable from the index")
    recall = run_turn("recall", project, QUERY)
    if not recall["answer"].startswith(PREFIX) or recall["answer"].splitlines()[-1].strip() != MARKER:
        raise RuntimeError("New session did not follow recalled format")
    if not any(MARKER in block and "viking://" in block for block in recall["injected_context"]):
        raise RuntimeError("Missing memory injection evidence")
    other = Path(temporary.name) / "other-project"
    (other / ".openviking").mkdir(parents=True)
    (other / ".openviking/config.json").write_text(json.dumps({"version": 1, "peer": {"id": "other-" + nonce}}))
    negative = run_turn("other-project", other, QUERY)
    if MARKER in negative["answer"] or any(MARKER in block for block in negative["injected_context"]):
        raise RuntimeError("Project-scoped memory leaked into a different peer")
    summary = {"passed": True, "capture": True, "extraction": True, "indexed_retrieval": True,
               "new_session_recall": True, "other_project_scope": True, "builtin_memory_disabled": True,
               "installed_botmux_adapter_verified": True, "lark_end_to_end_verified": False,
               "task_id": task["task_id"], "seed_session_id": seed["session_id"],
               "recall_session_id": recall["session_id"], "peer": peer,
               "codex_version": subprocess.check_output([str(ROOT / "bin/codex-openviking"), "--version"], text=True).strip()}
    write_evidence("summary.json", summary)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
