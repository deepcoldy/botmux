# Claude Code prompt suggestion — live screen samples

Each `*-160x50.txt` is the output of `tmux capture-pane -e -p` (the viewport,
no scrollback) of a live Claude Code 2.1.3xx session running under botmux in a
160x50 pane on the alternate screen — the exact input `TmuxPipeBackend`
captures for the screen sampler.

Kept byte-exact: the input box (its two rules and the prompt row), everything
below it, and the transcript rows from the turn's `✻ … for …` line down. The
remaining transcript rows above were blanked (empty lines, same row count) so
no conversation content is published; the recognizer only reads the bottom.

| file | input row |
|---|---|
| `suggestion-160x50.txt` | a suggestion |
| `suggestion-titled-rule-160x50.txt` | a suggestion; the top rule carries the session title |
| `suggestion-under-cursor-160x50.txt` | a suggestion with the CLI's inverse cursor on its first character |
| `meta-no-response-160x50.txt` | the suggestion model's literal `<no response>` |
| `meta-parenthetical-160x50.txt` | the suggestion model's whole-line parenthetical (`（无建议：…）`) |
| `static-example-160x50.txt` | the static `Try "…"` example of a never-used input box |
| `empty-input-160x50.txt` | empty |
| `empty-input-cursor-160x50.txt` | empty, with the drawn cursor |

No live pane had a typed draft at capture time. The draft case in the test is
derived from `suggestion-160x50.txt` by removing SGR 2 from the input row —
typed text is the same cells without the dim attribute.
