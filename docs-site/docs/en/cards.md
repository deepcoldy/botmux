# Streaming Cards

Every conversation turn produces a live-updating Lark card, your primary window for **perceiving and controlling the CLI** on your phone or in Lark.

![Streaming card](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419090587_img_v3_0212a_553ca347-4a93-491f-a2ef-30d00a374cdg.jpg)

- **Live screenshots of the terminal refreshed onto the card**: xterm renders headlessly into an image that **faithfully reproduces the CLI's TUI** (borders and colors are all there), instead of converting output to Markdown. One click to "Show / Hide output," "Export text," and "Half-page up / down."
- **Live status indicator**: the card's header color *is* the status (a Lark card template, not an emoji dot in the body) — **Starting…** (yellow) → **Working** (blue) → **Waiting for input** (green); when the quota is used up it shows **Limit reached** (red), turning to **Retryable** (green) when it can retry.
- **Operate directly from the card**: open the Web terminal, 🔑 grab an operation link, close the session, and — when the quota is retryable — "🔁 Resend last task."
- **A fresh card per turn**: the previous card freezes as an archive, keeping conversation history clear and traceable; after a session is moved to another group with [`/relay`](/en/relay), the original card also automatically freezes as an archive (buttons removed).
- **A "recoverable" card on close**: it carries a "▶️ Resume session" button to click back in anytime; **if the CLI supports native resume** (the adapter implements `buildResumeCommand` and a native session id exists), it also includes the native command (e.g. `claude --resume <id>`) for manual recovery; when unsupported, only botmux's resume button plus a short note is shown.

> **Open terminal = read-only**: the card's main "🖥️ Open Web Terminal" button is read-only viewing; for **writable** control, tap "🔑 Get operation link" — delivered **privately**: a flat group prefers an in-chat "visible-to-you" ephemeral card (so you never leave the conversation), falling back to a DM only for topic/thread or p2p chats, or when the ephemeral card fails. Management buttons like "🔄 Restart" and "apply profile" live on the **session card**, not on each turn's streaming card.

## Interrupting / correcting a running turn

To stop or correct it mid-turn, **don't wait for it to finish**: in screenshot mode the card carries a row of quick keys at the bottom — **Esc, ^C, Tab, Space, Enter, arrow keys, ⇞ Half-page up / ⇟ Half-page down**. Tapping `Esc` writes the ESC byte straight into the live terminal (exactly like pressing Esc locally); `^C` likewise. After interrupting, just add a new instruction.

> This quick-key row only appears when **output is shown (screenshot mode)** and the backend isn't `riff` — "Show output" first, then Esc is available. The default behavior is not to interrupt the current turn; new messages queue (type-ahead) and are fed in after the turn ends. To correct immediately, use Esc to break first.

## Messages the CLI proactively sends

The card body is a **live screenshot (image)** of the terminal, not text rendering. Messages the CLI proactively sends (via `botmux send`) are separate rich-text / image-and-text messages that can carry images, files, and @mentions; for fully custom display, `--card-file` / `--card-json` can send raw interactive card JSON.

> ⚠️ Raw cards allow **display-only elements + open_url buttons only**: any callback-firing control — callback buttons (with a `value`), dropdown / person selects, date-time pickers, inputs, form submits — is rejected. This prevents custom cards from forging interactive callbacks.
