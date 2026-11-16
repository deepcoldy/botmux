# 本轮回顾 — real CLI samples

- `claude-away-summary.jsonl`: two `type:"system", subtype:"away_summary"`
  records copied from a live Claude Code 2.1.322 session transcript (one with
  the `(disable recaps in /config)` hint Claude Code appends to its first few
  summaries, one without). `cwd` was replaced and one repository name in the
  second summary was generalized; everything else is as written.
- `claude-p-recap.json`, `claude-p-recap-heading.json`: stdout of the
  optional model recap (`CLAUDE_RECAP_MODEL` in `src/adapters/cli/claude-code.ts`,
  Claude Code 2.1.325) run on two real turn records. The second answer opens
  with a markdown heading although the instructions ask for plain text. A bot
  name in the first answer was generalized.
- `claude-p-model-error.json`: stdout of the same print mode for a model the
  account cannot use (`is_error: true`, exit status 1).
- `claude-tool-calls.jsonl`: six assistant `tool_use` records (Bash, Read,
  Write, Edit) from a live Claude Code session working in this repository.
  The checkout path was replaced with `/work/app`, edit and write bodies with
  `…`, and fields the recap does not read were dropped.
- `codex-exec-command.jsonl`: two `exec_command` function calls from a live
  Codex rollout; the home directory in them was replaced with `/home/user`.
