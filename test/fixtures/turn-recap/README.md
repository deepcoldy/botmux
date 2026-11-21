# 本轮回顾 — real CLI samples

- `claude-away-summary.jsonl`: two `type:"system", subtype:"away_summary"`
  records copied from a live Claude Code 2.1.322 session transcript (one with
  the `(disable recaps in /config)` hint Claude Code appends to its first few
  summaries, one without). `cwd` was replaced and one repository name in the
  second summary was generalized; everything else is as written.
- `claude-away-summary-2.1.326.jsonl`: one such record from a live Claude Code
  2.1.326 session, whose hint reads `(turn off recaps in /config)` (the
  wording since 2.1.326). `cwd` was replaced; everything else is as written.
- `claude-tool-calls.jsonl`: six assistant `tool_use` records (Bash, Read,
  Write, Edit) from a live Claude Code session working in this repository.
  The checkout path was replaced with `/work/app`, edit and write bodies with
  `…`, and fields the recap does not read were dropped. Used as records that
  are not a recap.
