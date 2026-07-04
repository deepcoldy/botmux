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

Use absolute paths in `hooks.json`. If the command needs configuration, pass it
as command arguments or environment variables inherited by the botmux daemon.
