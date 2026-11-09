# Streaming Cards

<video src="../img/video-v2-daily-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

Botmux uses Lark cards to show what the CLI is doing, and lets you control it right from your phone. This page goes from most common to advanced: first what shows up during a turn, then the status card, dynamic single cards and the switches, and finally the features for scripts and integrators.

## What shows up in the chat during a turn

| Layer | What it is | How to turn it off |
|-------|------------|--------------------|
| **Terminal status card** | One card per turn with a live terminal screenshot and session controls | Bot-level `disableStreamingCard`, or `/card off` in this chat |
| **Thinking process (CoT)** | The CLI's thinking text and tool calls, streamed as a native Lark CoT message | Bot-level `cotEnabled: false`, or `/cot off` in this chat |
| **Message status marks** | Only in chats with the status card off: a "GoGoGo" reaction on your message when work starts, swapped for ✅ when it ends | Bot-level `silentTurnReactions: true` |
| **Replies** | Answers, images, files and cards the agent sends with `botmux send` | Sent on demand, no switch |

A few notes:

- Status marks and the status card are **either/or**: with the status card on, no reactions are added; with it off, the reaction is the only lightweight progress signal. Swap the two emoji with `receivedReactionEmoji` / `doneReactionEmoji` (see [bots.json](/en/bots-json)).
- The thinking process needs Lark PC ≥ 7.70 or mobile ≥ 7.74, and only appears for CLIs that emit thinking (Claude Code, Codex, TraeX, Pi, Kimi and others).
- To get "one card per turn" instead, see the "Dynamic single cards" section below.

## Terminal status card

![Streaming card](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419090587_img_v3_0212a_553ca347-4a93-491f-a2ef-30d00a374cdg.jpg)

The card body is a **live screenshot** of the terminal: xterm renders the CLI's interface in the background as an image (borders and colors included), instead of converting output to text.

### The header color is the status

| Status | Color | When |
|--------|-------|------|
| Starting… | Yellow | The CLI is still starting |
| Working | Blue | The turn is in progress |
| Analyzing… | Purple | Analysis in progress |
| Awaiting input / ✓ Turn ended · Awaiting input | Green | The turn is done; send the next message |
| ✓ Turn ended (AI determined no reply was needed) · Awaiting input | Green | The AI decided this turn needs no answer; see below |
| ⏳ Main turn ended · background tasks running (N) | Light blue | The main agent has answered, but background work it started (background agents, `run_in_background` Bash, Monitor, Grok background tasks) is still running; N matches the web terminal, and the turn only counts as done once all of it finishes |
| No recent progress | Red | No progress seen for a long time |
| Limit reached | Red | The model quota is used up; turns green "Ready to retry" once a retry is possible |
| Interrupted | Orange | The turn was interrupted |

### "No reply needed" and timing {#no-reply-needed}

- **No reply needed**: when the AI decides a message needs no answer (say, a status line someone posted in the group), no reply card is sent and the status card header reads "✓ Turn ended (AI determined no reply was needed) · Awaiting input", so you can tell it apart from a stuck turn. Automatic, nothing to configure. If the message explicitly @mentioned the bot, an automatic receipt is posted too; to force an answer, @mention it again and ask for a reply explicitly.
- **Waiting / execution time**: off by default; see [Showing timing](#showing-timing) below to turn it on.

### Card buttons

Frequently used buttons sit on the card's main row. The low-frequency buttons marked "More Actions" below live in the "More Actions" collapsible panel under the main row; tap the panel title to open it.

| Button | What it does |
|--------|--------------|
| 📖 Show Output / 📕 Hide Output | More Actions. Expand or collapse the terminal screenshot; when expanded the panel also has 📝 Export Text and 🔃 Refresh |
| ⌨️ Terminal Keys ▾ / ▴ | Appears when output is shown; shows or hides the terminal keys at the bottom of the card (see [Interrupting or correcting a turn](#interrupting-or-correcting-a-turn) below) |
| 🖥️ Open Web Terminal | **Read-only** terminal view |
| 🔑 Get Write Link | More Actions. Get a **writable** terminal link. Flat groups first try a "visible only to you" card; topics, private chats, or a failed send fall back to a DM |
| 🗜️ Compact | Send `/compact` to the CLI to compress context (shown only when the CLI supports it) |
| ⏲️ Idle auto-compact: on/off | More Actions. Compact automatically after the session sits idle, same as [`/idlecompact`](/en/slash-commands) |
| ⏹ Stop | Interrupt the current turn (same as ^C); the session stays. Only shown while the turn is still running |
| ❌ Close Session | Close the session; adopted sessions show "⏏ Disconnect" here |
| 🔁 Retry Last Task | Appears when the quota recovers and the status becomes "Ready to retry" |
| Reasoning effort dropdown | Codex sessions (tmux backend, no sandbox, not using RPC input) can change reasoning effort while running; it applies from the next turn |

You can hide buttons you don't need in the Dashboard (see "Hiding card buttons" below).

### Interrupting or correcting a turn

**You don't have to wait for it to finish.** With output shown, tap "⌨️ Terminal Keys ▾" and a set of terminal keys appears at the bottom of the card: × (Esc), ^C, ⇥ (Tab), ␣ (Space), ↵ (Enter), arrow keys, ▲ half page up, ▼ half page down. Tapping × presses Esc in the terminal; after interrupting, just send a new instruction.

- The terminal keys are only available when **output is shown**, and remote backends (Riff / Mojo) don't have them. They start hidden; once you show them, later cards of the same session keep them shown until you hide them again.
- By default, messages you send while a turn is running are queued and fed in after it ends. To correct course immediately, tap × (Esc) or ⏹ Stop first.

### Card lifecycle

- **A new card each turn**: the previous card freezes as an archive, so history stays easy to follow. After a session is moved to another chat with [`/relay`](/en/relay), the original card also freezes and loses its buttons.
- **Resumable after close**: the close card has a "▶️ Resume Session" button. When the CLI supports native resume, it also shows the native command (e.g. `claude --resume <id>`) for manual recovery.
- Management buttons such as "🔄 Restart" live on the session card, not on each turn's status card.

## Cards that need a click from you

Besides the status card, Botmux posts cards when it needs you to decide something. These three are the most common.

### Repo picker card

When a new topic needs a repo, a "📁 Project Repository" card appears: pick a repo from the dropdown, type any directory by hand, or press "▶️ Start Session Directly" to use the default directory.

To open a new worktree from a repo, use the "🌿 Open a repo as a new worktree" dropdown. When 2 or more repos are found, a "🔀 Multi-repo" button sits next to it:

- Press it to switch to the **multi-repo picker**, where you can tick several repos and get one worktree each; press "🔀 Single-repo" to switch back.
- The switch is written to the bot setting `worktreeMultiPicker`, so it **applies to all of this bot's future sessions**, not just this card. That's why only admins can press it.
- You can also set it directly: `/botconfig set worktreeMultiPicker on|off`.

### AI question cards

When the agent asks with `botmux ask`, or Claude Code / Codex asks a question on its own, a question card appears in the chat. Its "Can answer" field tells you who can answer.

| What you see | What to do |
|--------------|------------|
| Single / multiple choice | Press an option; for multi-select pick as many as you like, then press "Submit". Submitting with nothing selected needs a second "Confirm empty submit" |
| Several questions on one card | Each is labeled "Question 1", "Question 2", ...; answer them all, then "Submit" once |
| Text / number fields | Fill them in; required fields can't be blank, and numbers must stay within any given range |
| Options already selected | These are the asker's recommended defaults, only a draft. Nothing counts as an answer until you press "Submit", and you can change them |
| "Other / custom answer" | Most questions have their own input box (unless the asker turned it off, or the card has text / number fields). Write your own answer when no option fits; it replaces only that question. Up to 1000 characters per question, 2000 per card |
| "Can answer" @-mentions one person | The asker named an answerer with `--answerer`, and only that person can submit (questions routed in from another app show "designated member only" instead). It only limits who can answer; it is not a business approval |

Without a designated answerer, anyone in the chat who can talk to the bot can answer. If no option fits, you can also just reply in the topic with text. See [CLI commands](/en/cli-commands) for the flags.

### Terminal permission card (Claude Code)

Some Claude Code actions pop a confirmation dialog in the terminal, for example a risky `rm` caught by a built-in safety check, which appears even when permission prompts are skipped. Lark can't see that dialog, so the session would hang. Botmux turns it into a question card showing the tool name and the command or file path, with buttons labeled 「允许执行」 (allow) and 「拒绝」 (deny). The card text and buttons are currently Chinese only.

- Allow lets Claude run it; deny tells Claude no, and it continues another way.
- It **waits 10 minutes by default**. If no one presses anything, it counts as denied and Claude is told it timed out.
- A text reply in the topic also counts as **denied**; your words are passed to Claude as the reason.
- If the card can't be delivered (for example, the daemon is unreachable), it is denied too, instead of falling back to a terminal dialog no one can press.
- Change the wait with the environment variable `BOTMUX_PERMISSION_TIMEOUT_MS` (milliseconds). It is clamped to between 1 second and 14 minutes (see [Environment variables](/en/env)).

## Dynamic single cards: one reply card per turn (preview)

![Dynamic single card illustration: in progress and finished](/img/unified-reply-card-preview.png)

The image is an illustration (in Chinese); the real look follows the Lark client.

By default, the status card, the thinking process and the final answer are separate messages. **Dynamic single card mode** puts the turn's progress, process, questions and final answer into one card that updates in place; the next turn starts a new card, and the previous answer stays.

### Turning it on

- Dashboard: Bot config → Task Cards → **Reply presentation**, choose "Dynamic single card".
- Or an admin sends in a chat: `/botconfig set replyCardMode unified`; switch back with `/botconfig set replyCardMode legacy`.
- It takes effect from the **next turn**.

Want only one card? Choose dynamic single card and turn off "**Show a separate status card**" (on by default). The terminal status card is then no longer posted automatically while the reply card keeps updating; use `/card` to open one when you need it. `disableStreamingCard` and `/card off` also turn off this separate status card. The old `final-only` value is treated as "dynamic single card + separate status card off".

### Which sessions are supported

- Supported: ordinary Lark conversations with Claude Code, Codex, Grok, TraeX, Pi and Kimi **without a file sandbox** (both regular groups and topics).
- Kimi's process comes from its local session log, which Kimi writes once per completed model step: thinking and tools update step by step rather than token by token, and the closing answer is delivered by `botmux send` rather than repeated in the process.
- Not supported, still using the default mode: file-sandbox sessions (including `readIsolation` and global `BOTMUX_SANDBOX=1`), API-only, non-Lark channels, remote Riff/Mojo, adopt, local terminal sync, doc comments, video meetings, scheduled tasks, and v3 workflows.
- Sandbox state is fixed when the session starts; changing the bot's sandbox switch does not affect running sessions.

### What the card contains

- **Title**: the current phase plus elapsed time, such as ⏳ Queued, 💭 Working, ✅ Completed, ❌ Failed, ⏹ Stopped; while a question is pending it shows "Waiting for your response".
- **Process**: thinking text or summaries the CLI emitted, tool calls, progress notes and Q&A records in order, folded into a 📋 section when the turn ends. Internal thinking the CLI never printed cannot be shown.
  - `/cot off` in the chat or bot-level `cotEnabled: false` hides the process; progress and Q&A records stay.
  - To hide only tool calls: turn off "Show tool calls" in the Dashboard, or `/botconfig set replyCardShowTools off`. Thinking summaries and progress still show, and `/cot show` won't reveal hidden tools. This switch only applies to dynamic single cards.
- **⏹ Stop**: also on the reply card while it runs; it only stops the current turn, and an old card cannot stop a new task. Codex RPC input mode has no Stop button.
- **Width**: adapts to the chat window.

### Questions (Ask) live in the card too

`botmux ask` in the same turn, and Claude Code / Codex questions, open right inside the reply card with a "Waiting for your response" title. Once answered, timed out or expired, they fold into the process; multiple questions show one after another without overwriting each other. Multi-select, text answers and answering from the Dashboard all work as usual.

Large forms with more than 16 options or question content over 3000 bytes are still sent as separate cards. Approval / authorization cards are also sent separately.

### Working with `botmux send`

- `botmux send` counts as progress by default; send the final answer with `botmux send --response-kind final "full answer"`.
- Repeated sends may return the same `messageId`. If a script needs a separate message each time, use the default mode or `--response-kind auxiliary`.
- Replying with an @ to this turn's asker (`--mention-back`) still updates the same card; mentioning others, custom cards, images and files, and cross-session delivery are sent separately.

### Limits

- The whole card is bound by Lark's 30 KB update limit. Only when it is exceeded is the process truncated, keeping the final answer and pending questions first, with a note on how much was omitted.
- Very long answers become a Markdown attachment, with a note in the card.
- A withdrawn card is not rebuilt automatically; there is no typewriter animation.

## Switches at a glance

### Bot-level defaults vs per-chat overrides

| Layer | Bot-level default (Dashboard "Bot config → Task Cards") | Per-chat override (send in the chat) | Default |
|-------|---------------------------------------------------------|--------------------------------------|---------|
| Separate status card | `disableStreamingCard` | `/card off` / `/card on`; bare `/card` summons one now | On |
| Thinking process | `cotEnabled` | `/cot off` / `/cot on`; `/cot show` for one look; `/cot` shows status | On |
| Message status marks | `silentTurnReactions` | None | Automatic in card-off chats; `true` stops them |
| Card buttons | `hiddenStreamingCardButtons` | None | All shown |
| Pin status card | `pinStreamingCard` | `/card pin off｜on｜status` | Off |

- Per-chat settings win over the bot-level default and only affect that chat. `/card on` only clears the chat-level off; a bot-level off still applies.
- **`/card` and `/cot` are admin-only (`allowedUsers`)**, status queries included. Lark cards can't show different views to different people, so one change affects everyone in the chat.
- `silentTurnReactions` also hides Codex App's "follow-up instruction received" receipt.

**Quiet preset**: one click in the Dashboard writes "thinking off, status marks silenced, status card off" at once, for chats that just want the conclusion. It is a one-time write; turning the preset off later does **not** revert the three switches, so turn each one back on yourself.

### Hiding card buttons

![Live card button switches](/img/streaming-card-button-settings.png)

Toggle each one under "Live card buttons" in the Dashboard, or:

```bash
/botconfig set hiddenStreamingCardButtons writeLink close
```

Values: `output` (show output, export text, refresh), `terminal`, `writeLink`, `compact` (including idle auto-compact), `stop`, `close`. `/botconfig unset hiddenStreamingCardButtons` shows them all again.

### Other card-related switches

| Setting | What it does | Default |
|---------|--------------|---------|
| `writableTerminalLinkInCard` | Puts a writable terminal button in the card; anyone who sees the card can operate the terminal, so only enable it in trusted chats | Off |
| `privateCard` | In regular groups, `/card` sends an admin-only static snapshot (it does not keep updating) | Off |
| `replyCardActions` | Shows an "Open terminal / Switch model / Close session" menu at the bottom right of ordinary reply cards | Off |

All of these can be changed in the Dashboard or with `/botconfig set <setting> on|off`.

## Pinning the current status card

With `pinStreamingCard` on, Botmux pins the **current public status card** to the top of the chat so the terminal and close buttons are always within reach.

- Per bot, off by default. Change it in the Dashboard or with `/botconfig set pinStreamingCard on|off`; existing sessions try to follow right away.
- Only the current public status card is pinned. Repo pickers, private `/card` snapshots, reply cards, the thinking process, close cards and so on are never pinned.
- Lark pins are per chat: with several topics or bots running in one chat, you may see several pins at once.
- To stop pinning in one chat: `/card pin off`; to restore: `/card pin on`; `/card pin status` tells you whether it's off at the bot level, off for this chat, or active.
- Pinning is best-effort: failures never affect posting, closing, relaying or anything else, and during errors you may briefly see no pin or an extra one. Botmux only removes pins it created itself, never pins from people or other apps.

## Reply card footer

![Reply card footer settings](/img/reply-footer-settings.png)

The footer at the bottom of the final reply card can show the items below; toggle each under "Reply card footer" in the Dashboard:

| Setting | Content | Default |
|---------|---------|---------|
| `replyFooterEnabled` | Master switch; when off the whole footer is hidden and the item settings are kept | On |
| `replyFooterBrand` | Brand signature (customize the text with `brandLabel`) | On |
| `replyFooterModel` | Model name, reasoning effort, backend spec | On |
| `replyFooterUsage` | Usage | On |
| `replyFooterRecipients` | Recipients and their @ notifications; when off the footer no longer @-mentions anyone, while explicit @ in the body is unaffected | On |
| `replyFooterVoice` | Voice summary button | On |
| `showReplyTiming` | Waiting and execution time | Off |

### Where usage is shown

The usage line looks like `ctx 23% · 5h 18% · 7d 5% · This turn ↑12k ↓3k · Total ↑1.2M ↓80k · Cache hit 92%`. Missing items are simply left out.

`usageDisplay` decides where it goes:

| Value | Location |
|-------|----------|
| `streaming` (default) | In the status card body, with full usage |
| `footer` | In the final reply footer, context and account quotas only |
| `off` | Not shown |

This only affects display, not usage accounting.

### Showing timing

Off by default. Turn it on in the Dashboard under **Bot Config → Message cards → Task Cards → Waiting and execution time**, or send `/botconfig set showReplyTiming on` (`showReplyTiming` in `bots.json`). Once on, the final reply footer shows "waited 3.2s · ran 23.4s", starting with newly received messages.

- **Waiting**: from Botmux accepting the message to actually handing it to the CLI, including queueing and cold start.
- **Execution**: from handing it to the CLI to seeing the final output. Codex App uses its own completion time.

Neither includes Lark delivery time. When timing can't be determined reliably (retries, restored old sessions, messages the model sent early via `botmux send`), it is not shown rather than guessed.

### Appending your own text to the usage line

Want gateway quotas, build status or who's on call after the usage line? Configure a command on the bot in bots.json:

```json
"cardFooterExtension": {
  "command": "~/.botmux/scripts/quota.sh",
  "refreshSeconds": 60
}
```

The command prints one segment per line, or JSON `{"segments": ["…", "…"]}`. For example, this output:

```
01 5h 2% 7d 2%
02 5h 4% 7d 2%
```

renders as `ctx 14% · 01 5h 2% 7d 2% · 02 5h 4% 7d 2%`.

Rules:

- At most 4 segments of at most 40 characters each, shown as plain text (Markdown is escaped).
- Run with `/bin/sh -c`, 3-second timeout, stdin closed, non-zero exit counts as failure. The environment includes `BOTMUX_LARK_APP_ID`, `BOTMUX_CLI_ID` and `BOTMUX_BOT_NAME` (the bot's configured CLI).
- No timer: a background refresh starts only while cards are rendered and the result is older than `refreshSeconds` (default 60, range 10–3600); rendering never waits for the command. All of a bot's sessions share one result.
- On failure the last good result is kept; once the last success is older than 10 minutes nothing is shown.
- Works for every CLI; follows `usageDisplay` and is hidden with it under `off`.

## Automatic-recovery failure card

When an ordinary Claude message hits a transient model failure (API unreachable, DNS outage, dropped stream, ...), Botmux continues it automatically, at most twice. If it still fails in the end, a failure card is posted in the original chat (or topic). It is the only notice for that message:

- It @-mentions the original sender, states the cause in one sentence (no raw error text), and adds an excerpt of the message, the time and how many continuations ran.
- **🔁 Retry** sends the message again as the original sender; the answer still goes to the original chat or topic. Only the original sender (while they can still talk to the bot) or a bot admin can press it. Each card can be retried successfully once, then shows who retried. The retried message asks the AI to check the current state first and avoid repeating work already done.
- A continuation that never produces a result (terminal idle for about a minute) also counts as failed, instead of staying "in progress" forever.
- If the Lark API is also down when the card is due, it keeps retrying (up to 24 hours) and lands exactly once; a daemon restart won't send it twice.
- Failed scheduled tasks get the card too, without a Retry button; run the task again manually if needed.

## Stop, retry and spend {#stop-retry-cost}

- **⏹ Stop**: there by default, shown on the status card only while the turn is still running. It is the same as pressing ^C and keeps the session; `/stop` in the topic does the same. Codex App sessions and sessions with `codexRpcInput` on can't be stopped this way; pressing it only suggests `/close`. To hide the button: `/botconfig set hiddenStreamingCardButtons stop`, or switch it off under the Dashboard's live card buttons (see [Hiding card buttons](#hiding-card-buttons) above).
- **🔁 Retry**: available on failure cards by default; the original sender or a bot admin can press it (see [Automatic-recovery failure card](#automatic-recovery-failure-card) above). For other failed or interrupted turns, send `/retry` in the topic.
- **Spend**: botmux only converts token usage into CNY after you set `pricing` for the bot in `bots.json` (the simplest is `"pricing": { "usdCny": 7.2 }`, which uses the built-in price table); without it the amount stays 0. In the current version the amount feeds monthly budget alerts (`budget`) and is not shown on cards; see [Spend and budget](/en/bots-json#budget). What the cards do show is the token usage line, see [Where usage is shown](#where-usage-is-shown) above.

## Richer messages with `botmux send`

Messages the agent sends with `botmux send` are separate messages that can carry images, files, videos and @ mentions. See [CLI commands](/en/cli-commands) for all flags. These are the ones most related to cards.

### Custom cards

`--card-file` / `--card-json` send raw Lark interactive card JSON.

> ⚠️ Custom cards allow **display-only content and open_url buttons only**. Any callback control (buttons with a `value`, dropdowns, person pickers, date pickers, inputs, form submits) is rejected, so custom cards can't forge interactive callbacks.

### Videos, @mentions, urgent pings and dry runs {#send-rich}

These are all `botmux send` flags. The agent in the session calls them as needed; there is nothing to switch on:

| Want to | Flags |
|---|---|
| Send a video with a preview | `--videos <mp4>` plus `--video-covers <image>`, paired in order, both repeatable |
| Send a custom card | `--card-json '<json>'` or `--card-file <path>` (display-only content and open_url buttons, see above) |
| @mention someone | `--mention <open_id>` (repeatable; with `allowArbitraryMention` on for the bot, a full email / phone / union_id also works, as long as the person is in the group); `--mention-back` @mentions this turn's sender. Every reply must pick one of `--mention`, `--mention-back` or `--no-mention` |
| Send an urgent ping | `--urgent` (in-app, default), `--urgent=sms` or `--urgent=phone`, targeting this turn's sender; **must be used with `--mention-back`**. The app needs the matching `im:message.urgent*` permission; SMS / phone consume tenant quota |
| Check before sending | `--dry-run` renders the body as a card and prints JSON plus warnings without sending (no image / file uploads, no @ resolution) |

See `botmux send --help` for the full list.

### Semantic reply headers (`--layout`)

At key moments you can give a reply a colored header and tag:

```bash
botmux send --layout result --mention-back "Build passed and deployed to staging"
```

Choose `result`, `progress`, `risk` (needs confirmation), `blocked` or `handoff`. Without `--layout` it's an ordinary reply card. It does not apply to custom cards or voice messages.

In the Dashboard under "Bot config → Reply Style" you can set whether the five writing recipes are injected for the agent, whether `--layout` may add headers, the theme (default / minimal / vivid), and each header's color and tag. Running sessions pick up the new settings after a restart.

### Charts in messages (vega-lite)

A ` ```vega-lite ` block in the body renders as a native Lark chart:

````markdown
```vega-lite
{
  "mark": "bar",
  "data": {"values": [{"day": "Mon", "n": 3}, {"day": "Tue", "n": 5}]},
  "encoding": {
    "x": {"field": "day", "type": "nominal", "title": "Day"},
    "y": {"field": "n", "type": "quantitative", "title": "Count"}
  }
}
```
````

What's supported:

- Inline `data.values` only, at most 500 rows; values are string / number / boolean / null.
- `mark`: `bar` (horizontal when only x is quantitative), `line`, `area`, `point`, `arc` (pie; `innerRadius > 0` for a donut). A pie takes only `theta` (value) and `color` (category); no `x` / `y`, and `theta` has no `title`.
- Encoding channels: `x`, `y`, `color` (series), `theta`; each accepts only `field`, `type`, `title`. `x` / `y` titles become axis titles and the `color` title becomes the legend title.
- `type: temporal` is not parsed as a date; values show as categories in the given order, so sort them first.
- At most 5 charts per card. The whole message must fit Lark's 30 KB; when it doesn't, charts step down "chart → 50-row table → 10-row table → note only".

For safety, Botmux rebuilds charts from the fields it recognizes and rejects `data.url`, `transform`, `params`, `expr`, `signal`, `datasets`, `layer` and similar. Unsupported or oversized charts become a one-line note plus a plain data table, the reason is printed on stderr, and the message is still sent.

**Preview before sending**: `botmux send --dry-run` sends nothing and needs no session; it prints `{dryRun, bytes, fits, diagnostics, card}`, where `bytes` is the real Lark request size. It renders the body only: no image/file upload, no @ resolution, no footer.

### Updating a card in place after sending (card patch)

A successful `botmux send --card-file/--card-json` prints `{"success":true,"messageId":"om_...",...}`. With that messageId, `botmux card patch` **updates the same card in place** without sending a new message, which suits progress cards:

```bash
# 1. Send an "in progress" card and pull out the messageId with jq
MID=$(botmux send --card-file /tmp/progress.json --no-mention | jq -r .messageId)

# 2. Update it to 50%
botmux card patch --message-id "$MID" --card-json '{"schema":"2.0","header":{"template":"blue","title":{"tag":"plain_text","content":"Deploy progress"}},"body":{"direction":"vertical","elements":[{"tag":"markdown","content":"Progress: 50%"}]}}'

# 3. Update once more when done
botmux card patch --message-id "$MID" --card-json '{"schema":"2.0","header":{"template":"green","title":{"tag":"plain_text","content":"Deploy done"}},"body":{"direction":"vertical","elements":[{"tag":"markdown","content":"✅ Shipped"}]}}'
```

- The updated card goes through the same safety check as sending (display-only + open_url).
- The `send` example passes `--no-mention`: every reply must pick one of `--mention` / `--mention-back` / `--no-mention`, or it is blocked (exit 2).
- The bot identity comes from the current session. Errors such as a withdrawn message, missing permission or a non-card target are reported as-is (exit 1); usage errors exit 2. On success stdout is a single line of JSON.

## Signed button: the clicker starts a turn as themselves (integrators)

A local integration can have the bot post a **single-use button card** into a chat. Whoever clicks the button starts the turn, just as if they had sent a message themselves. With `triggerUserAuth` on (`credentialSource: local`), credentials are issued for the clicker too, never falling back to the session owner.

### How to post one

Call the daemon's local IPC endpoint `POST /api/cards/click-turn` (same local HMAC auth as `/api/sessions/spawn`; not a public route). Request body:

| Field | Meaning |
| --- | --- |
| `prompt` | Required. Becomes this turn's user input when clicked, at most 1500 characters |
| `chatId` / `sessionId` | Exactly one. A chat's chat-scope session, or an existing session |
| `postChatId` | Which chat to post the card in; defaults to `chatId`, required when only `sessionId` is given |
| `workingDir` | Optional existing absolute path. Required when the click would create a session |
| `chatType` | Optional, `group` or `p2p` |
| `ttlMs` | Optional, 1 minute to 7 days, default 1 hour |
| `buttonLabel` / `title` | Optional |

Success returns `{ ok, messageId, exp }`; if the bot is not in the target chat you get 403 `bot_not_in_chat`.

### Safety rules

- The daemon signs the button and **each button works once**; tampered, expired and repeated clicks are rejected, and a restart doesn't make it reusable.
- The clicker must both be allowed to talk to the bot and have operate rights (admin). People with talk-only grants can't use it; with `restrictGrantCommands` on, people whose talk access comes only from a per-user grant (chat guest `chatGrants` or global guest `globalGrants`) can't either; members of a fully opened group are not affected by this rule.
- A bot or app clicking does not start a turn and never falls back to the owner.
- A `sessionId` only matches an active session of this bot; a miss is rejected rather than spawning a new one. If the `chatId` has no session yet, one is created with the clicker as owner; an existing session whose working directory differs from the signed one is rejected.
- A new session without a signed `chatType` is treated as a group; private chats must be signed `p2p`.
- In sessions with cross-person interruption (`crossPrincipalInterruption`) or per-person lanes, clicks are rejected with a message explaining why.

After a click Lark first shows "starting"; once the CLI actually accepts the input, the chat gets "Started this turn as you". If delivery fails, the turn's changes are rolled back and a failure notice is posted instead.
