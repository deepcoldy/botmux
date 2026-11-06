# 5-minute quick setup

<video src="../img/video-v1-quickstart-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

Four steps and you're chatting with an AI coding CLI from Lark:

| Step | Command / action | What it does |
|---|---|---|
| 1. Install | `curl -fsSL .../install.sh \| sh` | Installs a single-file program; no Node needed |
| 2. Configure | `botmux setup` | One Lark QR scan: creates the app, sets permissions, and publishes a version for you |
| 3. Start | `botmux start` + `botmux autostart enable` | Starts the background service and enables start on boot |
| 4. Chat | Add the bot to a group and @ it | Pick a directory and the CLI gets to work |

**Before you start**: take a quick look at the [Prerequisites](/en/prerequisites). The CLI you want to use (e.g. `claude`, `codex`) must already be installed, signed in, and working in a terminal; tmux is also needed by default. Most "installed but won't connect" problems come from something missing here.

## Step 1 · Install

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
```

**Open a new terminal** afterwards and the `botmux` command is ready.

- Supports Linux / macOS (x64, arm64). On musl systems such as Alpine, the musl build is picked automatically. On Windows, install inside WSL2.
- Installs to `~/.botmux/bin/botmux`; set `BOTMUX_INSTALL_DIR` to change it. The script verifies the download's SHA-256 and adds that directory to your shell's startup file (zsh / bash / fish).
- botmux itself needs no Node. If your CLI is an npm package, installing that CLI still needs Node.

You can also install with npm: `npm install -g botmux` (this step needs Node ≥ 22). The npm package contains the same program and behaves exactly like the curl install.

On a Mac and want to start and stop the service with a click? You can also install the [macOS Desktop App](/en/desktop): it bundles its own runtime and shares the same `~/.botmux` config with the command-line install.

**Upgrading later**:

| Goal | Command |
|---|---|
| Upgrade to the latest (works for any install method) | Re-run the curl command above, then open a new terminal and run `botmux restart` |
| Already on v3.18.0 or later | You can also just run `botmux update`, then `botmux restart` |
| Install a specific version | `curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh \| BOTMUX_VERSION=v3.18.8 sh` |

> ⚠️ `BOTMUX_VERSION` only takes effect when placed before the `sh` on the right side of the pipe. For releases older than v3.18.0, upgrade only with curl; see [FAQ · How do I upgrade?](/en/faq#how-do-i-upgrade) for why.

## Step 2 · Configure the bot

```bash
botmux setup
```

This is an interactive wizard: use the arrow keys to choose and Enter to confirm. Pressing `Esc` cancels setup without writing any config. On first run it asks you the following:

**① Where the Lark app comes from**

| Option | Best for |
|---|---|
| **One-scan create new app** (recommended) | First-time users. Name the bot, then scan with the Lark app; botmux creates the app and retrieves the AppID/AppSecret |
| Select existing app | You've created apps before. After logging in, it lists your apps and fetches the credentials (Feishu tenants only) |
| Enter AppID/Secret manually | You already created an app in the [Open Platform](https://open.larkoffice.com/app). You'll first choose Feishu or Lark (international) |

> After one scan on this machine, the login is remembered. Next time you add a bot, just confirm the account; no new scan needed.

**② Pick a CLI**: choose the CLI this bot connects to, e.g. Claude Code or Codex. You can type to search. If the CLI isn't found on this machine, you'll be told to install it first.

**③ Where new topics start**

| Option | Effect | What to enter |
|---|---|---|
| **Pinned default directory** (recommended) | New topics start directly in this directory, no card | An existing directory, e.g. `~/projects/my-app` |
| Repo selection card | Each new topic first shows a card to pick one of the scanned git repos | Scan root(s), e.g. `~/projects` (searched 3 levels down; comma-separate several) |

> In repo-card mode, try not to use `~`; there are too many folders to scan.

**④ Admin (owner)**: when you create the app by scanning, the person who scanned becomes the admin automatically. When entering credentials manually, you fill it in yourself; a full work email is recommended, a phone number also works.

Once done, setup **configures the Open Platform automatically**: imports all permissions, sets the redirect URL, creates and publishes a version, then prints the result of each step.

> 🔧 **When you need to finish Open Platform config yourself**
> - You passed `botmux setup --no-open-platform-auto` (skip auto-config), or the auto-config failed.
> - setup then lists the remaining items (enable bot capability, long-connection event subscription, permissions, redirect URL, publish a version) with links; the full permission list is written to `~/.botmux/lark-scopes.json`.
> - Choosing availability "Visible to me only" usually gets the version approved automatically.

Running `botmux setup` on a machine that's already configured shows a menu: Add new bot, Edit existing bot, Delete bot, Reconfigure. When done, run `botmux restart` as prompted.

> Want to configure from a script or an AI agent instead of the interactive UI? Use the `botmux setup add` / `botmux setup list` subcommands; `botmux setup help` shows all options.

## Step 3 · Start

```bash
botmux start            # Start the background service (daemon)
botmux autostart enable # Start on boot (recommended; no sudo needed)
```

- Start on boot uses user systemd on Linux and launchd on macOS.
- The first `botmux start` asks which "feedback storage" to use. **Just press Enter for the default SQLite.** You can pick PostgreSQL here if you need it, and migrate later with `botmux feedback storage` (new tasks pause during migration; the original SQLite is kept, but botmux won't switch back automatically if PostgreSQL fails). See [Feedback storage and migration](/en/feedback-storage).
- Check status: `botmux status`; view logs: `botmux logs`.

## Step 4 · Create a group and start chatting

1. Create a **topic group** in Lark (regular groups work too).
2. Group settings → Group bots → add the bot you just created.
3. **@ the bot** with a message, e.g. "@bot how do I build this project?".
4. If you chose the repo selection card in step 2, a card asks you to pick a project first; with a pinned directory, the CLI starts there right away.

The bot replies with a card that updates as it works and shows the full answer when finished:

![Reply card: in progress and finished](/img/unified-reply-card-preview.png)

Common questions:

- **Do I always need to @ it?** In groups, the bot replies only when @-mentioned by default. In a group with just you and one bot, follow-ups inside a topic that's already started don't need the @. To go mention-free, see [Mention policy](/en/mention-mode).
- **Don't want a group?** Just **DM the bot**.
- **Want to create a group in one click?** Send `/g <group name>` in any chat, or open the "Groups" page in `botmux dashboard` and click "New Chat"; see [Create a Session Group in One Step](/en/group).

## Not receiving messages? Self-check first

Most "no response" cases are local config or network issues. Let your AI CLI troubleshoot: it reads the logs, checks the config, and gives you a verdict.

First save the diagnostic task in a variable:

```bash
DIAG='botmux is not receiving messages in the Lark group. Diagnose read-only (do NOT change anything), run these in order and give the most likely cause + fix: botmux status (is the daemon running); botmux logs --lines 150 --no-follow (look for WebSocket connection failures, token/auth errors, permission errors 401/403/411/400, CLI spawn failures); cat ~/.botmux/bots.json (check AppID/Secret/CLI config); judge whether the long-lived WebSocket is blocked by a corporate network/proxy/firewall. Conclude at the end.'
```

Then run the line for the CLI you have (all non-interactive; they print the verdict and exit):

```bash
claude -p "$DIAG" --allowedTools "Bash"   # Claude Code
codex exec "$DIAG"                         # Codex
coco  -p "$DIAG" --yolo                    # TRAE CLI 1.0 / CoCo (legacy)
cursor-agent -p "$DIAG"                    # Cursor
```

> The trailing `--allowedTools` / `--yolo` just let the agent run commands to read logs. `botmux logs` can pinpoint almost any problem.

Still stuck? Check by hand:

| Symptom / suspicion | How to check and fix |
|---|---|
| Daemon not running, or config changed without a restart | `botmux status` to check, `botmux restart` to restart |
| Message didn't @ the bot | Groups require an @ by default; see [Mention policy](/en/mention-mode) |
| Incomplete permissions, or a bot built from an old app (most common) | See [Common Pitfalls](/en/pitfalls); recreate via the latest `botmux setup` QR flow |
| Manually created app not fully configured | In the Open Platform: enable App features → Bot; receive events via long connection and subscribe to `im.message.receive_v1`, plus the `card.action.trigger` callback; publish a version |
| Long connection blocked (corporate network / proxy / firewall) | `botmux logs` will show connection errors |

Run `botmux restart` after fixing. See [FAQ / Troubleshooting](/en/faq) for more.

### Optional events: @ by editing, recall sync

Missing either of these **does not affect ordinary messages**; only the related small feature. New bots subscribe to them automatically; for older bots, botmux tries to add them at startup using this machine's existing Open Platform login.

| Event | Used for |
|---|---|
| `im.message.updated_v1` | Editing a message that didn't @ the bot to add the @, which then triggers a task |
| `im.message.recalled_v1` | In group context sharing (`/context-sharing`), marking recalled messages in the record. Only added when that feature is on |

Things to note:

- The startup top-up only adds events to the existing long-connection config. It does **not** change the delivery mode, change permissions, or publish a version. A log line saying the update request succeeded doesn't mean it's live. For production apps, review pending changes in the Open Platform, publish a version, then verify by editing a message that hasn't triggered the bot to add an @.
- If the sender's chat access comes from team membership, an edited message also needs a contact lookup to get their `union_id`. This requires contact read permission (the default permission list includes `contact:user.id:readonly`) and the sender must be within the app's visibility scope. If the lookup fails, access is judged only by the original author's `open_id`; the editor's identity is never borrowed.
