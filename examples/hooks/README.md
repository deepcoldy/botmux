# botmux hook examples

These scripts are minimal hook commands you can copy and adapt. botmux runs hook
commands without a shell, writes one JSON payload to stdin, and sets
`BOTMUX_HOOK_EVENT` to the current event name.

## Quick start

```bash
chmod +x examples/hooks/*.sh
HOOK_CMD="$(pwd)/examples/hooks/echo-to-log.sh"
mkdir -p ~/.botmux/data
cat > ~/.botmux/data/hooks.json <<JSON
[
  {
    "event": "session.requires_attention",
    "command": "$HOOK_CMD",
    "timeoutMs": 5000
  }
]
JSON
```

Then trigger a matching event and inspect `/tmp/botmux-hook.log`.

## Scripts

| Script | What it does |
|--------|--------------|
| `echo-to-log.sh` | Appends every payload to `/tmp/botmux-hook.log` |
| `osascript-notify.sh` | Shows a macOS Notification Center alert |
| `http-webhook.sh` | POSTs the stdin payload to an HTTP endpoint |
| `prompt-gate.sh` | **Synchronous** pre-submit check: allows or denies a message before it reaches the CLI |

## Synchronous gate hooks

The scripts above are asynchronous notifications — nothing reads their result.
`prompt-gate.sh` is different: configured on the `prompt.submit` event with
`"mode": "sync"`, the daemon waits for it and uses its verdict to decide whether
the message is submitted to the CLI at all.

```json
[
  {
    "event": "prompt.submit",
    "mode": "sync",
    "command": "/absolute/path/to/prompt-gate.sh",
    "timeoutMs": 3000,
    "onError": "allow"
  }
]
```

Print `{"decision":"deny","reason":"..."}` on stdout to reject (the reason is
shown to the user), or `{"decision":"allow"}` to permit. A script that prints no
JSON falls back to its exit code: 0 allows, non-zero denies.

Keep `timeoutMs` small — the wait lands directly on the inbound message path.
A hook that times out or cannot be spawned follows `onError`, which defaults to
`allow` so a broken checker cannot brick the bot. Full contract:
`docs-site/docs/en/hooks.md`.

Use absolute paths in `hooks.json`. If the command needs configuration, pass it
as command arguments or environment variables inherited by the botmux daemon.
