# Streaming Cards

Every conversation turn produces a live-updating Lark card, your primary window for **perceiving and controlling the CLI** on your phone or in Lark.

![Streaming card](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419090587_img_v3_0212a_553ca347-4a93-491f-a2ef-30d00a374cdg.jpg)

- **Live screenshots of the terminal refreshed onto the card**: xterm renders headlessly into an image that **faithfully reproduces the CLI's TUI** (borders, colors, and cursor are all there), instead of converting output to Markdown. One click to "Show / Hide output," "Export text," and "Scroll up / down."
- **Live status indicator**: 🟡 Starting → Analyzing → 🔵 Working / Executing → 🟢 Waiting for input; when the quota is used up, it shows "Limit reached · Retryable."
- **Operate directly from the card**: open a (writable) terminal, 🔑 grab an operation link, restart / close / adopt the session, and resend the last task.
- **A fresh card per turn**: the previous card freezes as an archive, keeping conversation history clear and traceable; after a session is moved to another group with [`/relay`](/en/relay), the original card also automatically freezes as an archive.
- **An "recoverable" card on close**: it includes the CLI's native resume command, so you can click back in to continue anytime.

> The card body is a **live screenshot (image)** of the terminal, not text rendering. Messages the CLI proactively sends (via `botmux send`) are separate rich-text / image-and-text messages that can carry images, files, and @mentions; for fully custom display cards, `--card-file` / `--card-json` can send raw interactive card JSON (display + open_url only — any callback-firing control, such as callback buttons, dropdowns, inputs, or form submits, is rejected).
