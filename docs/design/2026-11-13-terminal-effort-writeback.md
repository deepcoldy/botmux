# Optional terminal effort writeback

The current session launch preference freezes effort at creation. Native effort
observations update cards, so a manual terminal change can be visible while a
later cold resume still launches the old preference.

`dashboard.terminalEffortWriteback` is a machine-wide experimental switch in
config.json, default false. It does not change bot defaults or agent settings.
The Dashboard settings API and experimental settings page expose the same switch.
A stored monotonic toggle epoch and enable time invalidate pending requests across
rapid off/on transitions; a stat/inode cache exposes these changes immediately
across processes rather than using the general two-second settings cache.

Enabled writeback requires an explicit terminal effort intent and a subsequent
matching native selection observation for the same worker, native session and
CLI process generation. The intent is a submitted effort command, or a selected
native effort menu row confirmed with Enter. Claude also records separate local
command/success records; these allow direct local TUI commands to be confirmed
without relying on a browser input stream. Records older than the current CLI
spawn are excluded. Startup values, uncorrelated environment overrides, and
uncorrelated model/effort fallback observations are never intents.

Only managed Claude Code, Codex, TraeX and Grok sessions are eligible. Antigravity
ACP exposes selected runtime configuration but no equivalent verified terminal
effort request, so it remains observation-only. Dispatch launch specifications
and adopted sessions are excluded. A model pin is preserved and retains its
existing launch priority; the terminal preference never edits/clears a pin.

Persistence uses mutateOwnedSessionsAtomically with nonblocking admission. It
compares fresh identity and preferences inside the transaction, updates
reasoningEffort and an existing cliLaunchSnapshot.reasoningEffort, synchronizes a
matching TraeX topic effort, and records the preference edit time/source. Terminal
intent captures the durable preference fingerprint (including the non-effort
launch-snapshot structure) and the enable epoch. Confirmed receipts are retained
until the commit ACK, so SQLite BUSY and a lost ACK can be retried. An earlier
terminal choice committing while a newer choice awaits confirmation is ordered by
request time; intervening explicit configuration edits still win. The writer updates
the caller cache only after commit. A concurrent explicit configuration edit,
generation replacement, failed transaction or duplicate receipt must not
overwrite a newer preference. Runtime/card observations remain independent of
whether saving a preference succeeded.

Regression coverage must exercise switch-off compatibility, confirmed choices
for all four CLIs, non-user observations, identity/epoch mismatches, transaction
failure and concurrent edits, pin/dispatch precedence, late Claude statusline versus command-success records, direct native commands
after a previous preference edit, and a durable reload whose
resolved launch arguments contain the saved effort.

A confirmed native Grok xhigh selection can precede the static Botmux model
catalog. With writeback enabled only, its persisted native-session/model/snapshot
receipt permits that exact cold resume to keep xhigh. It never edits the global
model catalog or changes switch-off launch validation.
