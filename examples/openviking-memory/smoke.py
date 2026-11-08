#!/usr/bin/env python3
"""Verify automatic writes and agent-directed memory retrieval in native TUI."""

import json
from pathlib import Path
import re
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
QUERY = "请按照墨桐项目此前约定的格式写一份发布摘要，内容是修复登录页面错误。只输出摘要，不读取本地文件或发送外部消息。"


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
    session_id, completed, answer, context, calls, tool_results, invocations = "", False, "", [], [], [], []
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
                invocations.append({"name": payload.get("name"), "input": payload.get("input", payload.get("arguments", ""))})
            if payload.get("type") in ("function_call_output", "custom_tool_call_output"):
                output = payload.get("output", "")
                tool_results.append(output if isinstance(output, str) else json.dumps(output, ensure_ascii=False))
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
            "tool_calls": calls, "tool_results": tool_results, "tool_invocations": invocations,
            "rollout_path": str(path)}


def memory_search_was_called(result):
    for invocation in result["tool_invocations"]:
        name, body = invocation["name"], invocation["input"]
        if "openviking" in name.lower() and name.endswith(("find", "search")):
            return True
        if name == "exec" and re.search(r"tools\.[\w]*openviking[\w]*_(?:find|search)\s*\(", body, re.I):
            return True
        if "memory.mjs" in body and re.search(r"\b(?:find|search)\b", body):
            return True
    return False


def validate_other_project(result, original_peer, marker):
    if marker in result["answer"]:
        raise RuntimeError("Agent applied another project's formatting rule")
    if any(f"/peers/{original_peer}/" in block for block in result["tool_results"]):
        raise RuntimeError("Default memory search returned another project's peer subtree")


def run_turn(label, project, prompt, enabled=True, allow_memory_tools=False):
    project.mkdir(parents=True, exist_ok=True)
    before = set(SESSIONS.rglob("rollout-*.jsonl"))
    pane = "ov-smoke-" + uuid.uuid4().hex[:12]
    command = json.loads(subprocess.check_output(["node", str(ROOT / "botmux-command.mjs"), str(project)], text=True))
    args = [command["bin"], *command["args"],
            "-c", "memories.use_memories=false", "-c", "memories.generate_memories=false",
            "-c", 'projects={' + json.dumps(str(project)) + '={trust_level="trusted"}}',
            "-c", 'model_reasoning_effort="low"']
    if not enabled:
        args[0:1] = [RUNTIME["codex"], "--no-daemon"]
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
                    if result["injected_context"]:
                        raise RuntimeError(f"{label}: memory was injected automatically")
                    if result["tool_calls"] and not allow_memory_tools:
                        raise RuntimeError(f"{label} unexpectedly invoked tools: {result['tool_calls']}")
                    if allow_memory_tools:
                        for invocation in result["tool_invocations"]:
                            name = invocation["name"]
                            if "openviking" in name.lower() or "tool_search" in name.lower():
                                continue
                            if "memory.mjs" in invocation["input"] and re.search(r"\b(?:search|find|read)\b", invocation["input"]):
                                continue
                            if "write_stdin" in name and memory_search_was_called(result):
                                continue
                            if name == "exec":
                                nested = re.findall(r"tools\.([\w]+)\s*\(", invocation["input"])
                                if all("openviking" in tool.lower() or "tool_search" in tool.lower() for tool in nested):
                                    continue
                            raise RuntimeError(f"{label}: unexpected non-memory tool: {name}")
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
                                              "answer": result["answer"], "tools": result["tool_calls"]}, ensure_ascii=False), flush=True)
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
    global PREFIX, MARKER, QUERY
    EVIDENCE.mkdir(exist_ok=True)
    (EVIDENCE / "summary.json").unlink(missing_ok=True)
    nonce = uuid.uuid4().hex[:10]
    project_name = "墨桐-" + nonce
    PREFIX = project_name + "已验收"
    MARKER = "验收标签：紫杉-" + nonce
    QUERY = f"请按照{project_name}项目此前约定的格式写一份发布摘要，内容是修复登录页面错误。只输出摘要，不读取本地文件或发送外部消息。"
    temporary = tempfile.TemporaryDirectory(prefix="botmux-openviking-")
    project = Path(temporary.name) / "project"
    peer = "botmux-pilot-" + nonce
    (project / ".openviking").mkdir(parents=True)
    (project / ".openviking/config.json").write_text(json.dumps({"version": 1, "peer": {"id": peer}}))
    baseline = run_turn("baseline", project, QUERY, enabled=False, allow_memory_tools=True)
    if MARKER in baseline["answer"] or baseline["injected_context"]:
        raise RuntimeError("Baseline was contaminated by memory")
    seed = run_turn("seed", project,
        f"本轮不要调用任何工具、读取文件或发送外部消息。请记住{project_name}项目的长期发布摘要约定："
        f"每份发布摘要必须以‘{PREFIX}’开头，最后一行必须是‘{MARKER}’。"
        f"这条约定只用于{project_name}项目，不用于其他项目。本轮只回复‘已记住项目的发布摘要约定’。")
    task = wait_extraction("cx-" + seed["session_id"], peer)
    found = api("/api/v1/search/find", peer, {
        "query": project_name + "项目发布摘要格式约定", "target_uri": "viking://user/" + CLIENT["user"],
        "context_type": "memory", "limit": 5, "read_content": True,
    })
    write_evidence("indexed-search.json", found)
    if not any(MARKER in item.get("content", "") for item in found.get("memories", [])):
        raise RuntimeError("Extracted memory is not retrievable from the index")
    ordinary = run_turn("ordinary", project, "2 + 2 等于多少？仅回复数字。")
    if ordinary["answer"].strip() != "4":
        raise RuntimeError("Ordinary task did not produce the expected answer")
    recall = run_turn("recall", project, QUERY, allow_memory_tools=True)
    if not memory_search_was_called(recall):
        raise RuntimeError("Agent did not invoke a memory search tool")
    if not recall["answer"].startswith(PREFIX) or recall["answer"].splitlines()[-1].strip() != MARKER:
        raise RuntimeError("New session did not follow recalled format")
    if not any(MARKER in block and "viking://" in block for block in recall["tool_results"]):
        raise RuntimeError("Missing memory tool response evidence")
    other = Path(temporary.name) / "other-project"
    (other / ".openviking").mkdir(parents=True)
    (other / ".openviking/config.json").write_text(json.dumps({"version": 1, "peer": {"id": "other-" + nonce}}))
    negative = run_turn("other-project", other, QUERY.replace(project_name, "另一个项目-" + nonce), allow_memory_tools=True)
    validate_other_project(negative, peer, MARKER)
    summary = {"passed": True, "capture": True, "extraction": True, "indexed_retrieval": True,
               "agent_directed_search": True, "automatic_memory_injection": False,
               "ordinary_task_without_search": True, "new_session_recall": True,
               "other_project_scope": True, "builtin_memory_disabled": True,
               "installed_botmux_adapter_verified": True, "lark_end_to_end_verified": False,
               "task_id": task["task_id"], "seed_session_id": seed["session_id"],
               "recall_session_id": recall["session_id"], "peer": peer,
               "codex_version": subprocess.check_output([str(ROOT / "bin/codex-openviking"), "--version"], text=True).strip()}
    write_evidence("summary.json", summary)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
