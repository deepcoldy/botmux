# Web Terminal (interactive)

Every session comes with an xterm.js-based Web Terminal, at an address like `http://<WEB_EXTERNAL_HOST>:<port>`.

![Web Terminal](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033301701_web_terminal.gif)

## Two kinds of links

| Link | Source | Capability |
|------|------|------|
| **Read-only link** | Automatically shown on the streaming card | Check progress anytime, can't type |
| **Operation link** | Click "🔑 Get operation link" on the card, sent via direct message | Operate the CLI directly in the browser |

## Mobile

On tablets/phones, a **floating shortcut toolbar** is provided: `Esc`, `Ctrl+C`, `Tab`, arrow keys, and more, so you can smoothly control the CLI on your phone too (for example, selecting menus or confirming permissions in Claude Code).

## Three-way sync

The Lark topic, the Web Terminal, and the local tmux all show the real-time state of the **same** CLI process. Typing in tmux on your computer, typing in the Web Terminal on your phone, and sending a message in Lark all have the same effect.

## Remote access (public / intranet domains)

By default the link uses an auto-detected LAN IP, reachable only on the same subnet. When your phone isn't on the same network as the machine running botmux, point the link at a host both sides can reach:

**Case 1: botmux runs directly on a cloud host**

Set `WEB_EXTERNAL_HOST=<cloud host public domain or IP>` in `~/.botmux/.env`, then `botmux restart` — the terminal links on the cards become externally reachable.

**Case 2: botmux runs locally, forwarded through a relay host** (a cloud host or a corporate-intranet machine both work)

```bash
# 1. Point the terminal links at the relay host (write to ~/.botmux/.env, then botmux restart)
WEB_EXTERNAL_HOST=<relay host domain or IP>

# 2. Reverse tunnel from this machine → relay host (run on the machine running botmux)
autossh -M 0 -f -N -R 18800:localhost:8800 user@relay-host

# 3. Relay host bridges its public port onto the tunnel (sshd often disables GatewayPorts, so bridge in user space)
socat TCP-LISTEN:8800,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:18800
```

Notes:

- The port in the link defaults to the port the local terminal proxy actually listens on (`8800 + botIndex`), so the **relay host must listen on the same port number** (both ends use `8800` in the example above).
- To have the relay host expose a **different port number** (e.g. the local proxy is on `8800` but the relay host should use `9000`), set `WEB_EXTERNAL_PORT=9000` in `~/.botmux/.env` and `botmux restart` — the card links switch to that port (the `socat` above becomes `TCP-LISTEN:9000`). In a multi-bot deployment it's the **base port**: the Nth bot uses `WEB_EXTERNAL_PORT + botIndex`, mapping one-to-one to the local `8800 + botIndex`, and the relay host bridges each port accordingly.
- The Web Terminal's WebSocket connects same-origin with the page address, so TCP-level forwarding passes it through with no extra config.
- The read-only link needs no credentials to view; assess your exposure before opening a port to a wider network — write operations always require the token in the 🔑 link.
