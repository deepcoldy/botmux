# Web Terminal (interactive)

<video src="../img/video-v2-daily-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

Every session has a browser-based terminal: open it to watch the CLI live, and if you have permission, type into it directly. It works on desktop, tablet, and phone.

The one exception is the ZMX backend, which has no Web Terminal. Run `botmux list` or `zmx attach` on the host instead; see [ZMX backend](/en/zmx).

![Web Terminal](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033301701_web_terminal.gif)

## How to open it

| You want to | Do this | You get |
|------|------|------|
| See what the CLI is doing | Click "🖥️ Open Web Terminal" on the terminal status card | Read-only terminal |
| Operate the CLI yourself | Click "🔑 Get Write Link" on the card | Writable terminal, sent to you privately |
| The card isn't handy | Send `/term` in the topic | Writable terminal, sent to you privately |
| Look from the Dashboard | "Open read-only terminal" / "Take over terminal" on the Sessions page | See [Dashboard](/en/dashboard) |

A write link **never shows up in the group**: in a regular group you get a "visible only to you" card; in topic groups, direct chats, or if that fails, it's sent to you by direct message. Clicking the button shows a "write link sent privately" toast; with `/term`, if it went by DM, the topic gets a short note saying so. Only people with operate permission (usually the bot admins) can get one; anyone else sees a "no permission" toast. See [Permissions](/en/permissions).

## Read-only vs writable

| | Read-only terminal | Writable terminal |
|------|------|------|
| Watch live output, scroll back | Yes | Yes |
| Type, press keys, pick menu items | No (a "read-only" banner shows at the top) | Yes |
| Who can open it | Anyone who has the link can watch | Anyone who has the link can operate, so don't share it |
| Still works after a restart | Yes, links on old cards keep working | Yes |

Notes:

- The link carries an access credential, so **forwarding a link hands over view (or operate) access**.
- To let everyone in a group operate the terminal directly, enable `writableTerminalLinkInCard` on the bot. The card then gets a "🖥️ Open Writable Web Terminal" button that anyone who can see the card can use. Only turn it on in trusted groups; see [Cards](/en/cards).

## Using it on a phone

When you open a writable terminal on a phone or tablet, an input bar appears at the bottom:

- **Shortcut row** (swipe sideways): `Paste`, `Ctrl+C`, `Esc`, `Tab`, arrow keys, `⌫`, `Enter`, `Shift+Tab`. Use it to pick menu items, confirm permissions in Claude Code, or interrupt a run.
- **Input box**, with a button on the left that switches between two input modes:

| Mode (on-screen label) | While you type | Button on the right | Good for |
|------|------|------|------|
| Buffer (缓冲, default) | Text stays in the input box | 上屏 ("put on screen"): places the text in the CLI's input box **without submitting**; press `Enter` when it looks right | Longer text, IME input |
| Live (实时) | Every keystroke goes straight to the terminal | 发送 ("send"): sends and presses Enter | Key-by-key work, interactive menus |

The chosen mode is saved on the server: the same session opens in the same mode on any device, and new sessions start with the most recent choice.

## Three-way sync

The Lark topic, the Web Terminal, and the host's tmux all show the **same** CLI process. Typing in tmux on your computer, typing in the Web Terminal on your phone, and sending a message in Lark all have the same effect. To enter a session on the host, see [tmux backend](/en/tmux).

## If you see a status page

| Message | Meaning | What to do |
|------|------|------|
| Terminal is starting | The session is restoring its terminal | Wait and refresh, or reopen from the latest card |
| Session suspended | The session is asleep, and a read-only link won't wake it | Send a message in the Lark topic, or sign in and reopen |
| Terminal unavailable | The session still exists, but its terminal can't be restored right now | Try again later, or send `/restart` in the Lark topic to restart the CLI |
| Terminal link expired | The credential in the link no longer matches | Go back to Lark and reopen from the session's **latest card** |
| This session is closed | The session has ended | Can't be viewed anymore; start a new topic if needed |
| Session not found | The link is wrong, or the session was deleted | Check the link |

## Works on networks without internet access {#self-hosted-xterm}

Automatic, nothing to configure. The xterm.js library and its add-ons used by the terminal page are served by botmux itself from the same origin (bundled with botmux) instead of an external CDN, so the terminal opens fine on internal networks that can't reach the internet. They are public open-source library files and carry no session data. If the terminal page fails to start, only the first error is shown, which makes it easier to pin down.

## Remote access (when your phone is on another network)

By default a terminal link looks like `http://<host LAN IP>:<port>/s/<session ID>` and only works from the same subnet. To open it from elsewhere, pick the option that fits:

| Your setup | Do this | The link becomes |
|------|------|------|
| Connected to the central platform (remote access on and bound) | Nothing extra | `https://t-<machineId>.<platform domain>/s/<session ID>` |
| You reverse-proxy the Dashboard to a domain with nginx or similar | Set `BOTMUX_PUBLIC_URL` | `<your domain>/s/<session ID>` |
| botmux runs on a cloud host with a public address | Set `WEB_EXTERNAL_HOST` | `http://<public address>:<port>/s/<session ID>` |
| botmux runs locally and you forward through a relay host | See "Forwarding through a relay host" below | `http://<relay address>:<port>/s/<session ID>` |

If more than one applies, the order is: central platform > `BOTMUX_PUBLIC_URL` > Devbox private short link > local address.

Through the central platform you sign in with single sign-on first: if you're recognized as the owner you can operate right away; everyone else gets read-only, and the read-only page shows an "owner sign in to operate →" link.

Environment variables go in `~/.botmux/.env`; run `botmux restart` afterwards. Full reference: [Environment variables](/en/env).

### Forwarding through a relay host

Use this when botmux runs on your local machine and there's another machine both sides can reach (a cloud host or a corporate-intranet machine).

```bash
# 1. Point terminal links at the relay host (write to ~/.botmux/.env, then botmux restart)
WEB_EXTERNAL_HOST=<relay host domain or IP>

# 2. On the machine running botmux, open a reverse tunnel to the relay host
autossh -M 0 -f -N -R 18800:localhost:8800 user@relay-host

# 3. On the relay host, bridge the public port onto the tunnel
#    (sshd usually disables GatewayPorts by default, so bridge in user space with socat)
socat TCP-LISTEN:8800,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:18800
```

How ports map:

- Each bot has one terminal entry port: the 1st bot uses `8800`, the 2nd `8801`, and so on (change the base with `BOTMUX_WEB_PROXY_BASE_PORT`). By default the link uses that port, so **the relay host must listen on the same port number** (both ends use `8800` above).
- To expose a different port on the relay host (e.g. `8800` locally, `9000` on the relay): set `WEB_EXTERNAL_PORT=9000` and `botmux restart`; links switch to `9000` and the socat line becomes `TCP-LISTEN:9000`. With several bots it's also a base: the Nth bot uses `9000 + index`, matching the local ports one-to-one, and the relay bridges each one.
- The terminal page's WebSocket is same-origin with the page, so TCP-level forwarding passes it through with no extra config.

Before opening the port to a wider network, think about who can reach it: anyone with a read-only link can watch the terminal, and anyone with a write link can operate it.
