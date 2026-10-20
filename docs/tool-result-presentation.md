# Tool result presentation

`cotEnabled` remains the process-display master switch. The optional bot setting
`thinkingCardToolResult: false` omits tool result bodies while retaining tool
calls and their completion status. Missing or `true` keeps the default behavior.
The card-preferences API accepts the same field; saving `true` removes the
explicit override from `bots.json`.

The preference applies to legacy thinking bubbles and unified reply cards,
including `/cot show`. New unified tool snapshots omit result bodies before
being persisted. Existing records are not retroactively deleted, but rendering
also respects the preference. This is a display preference, not a mechanism for
erasing CLI transcripts or historical data.

This adds an optional body-verbosity preference to the single-switch design
introduced in #1477. It intentionally keeps the master switch, defaults and tool
completion events unchanged, at the cost of one additional bot preference.
