# Claude Code after a web terminal resized its tmux pane

Recorded from a real Claude Code 2.1.322 (fake local API, private tmux server)
driven like a botmux tmux session:

- the pane was created at 160x50, the size the worker's long-lived renderer is
  built with, and `pipe-pane -O` copied every byte it wrote;
- after one turn the pane was resized to 214x62 with `resize-window` — what a
  writable web terminal does to a tmux pipe session (`TmuxPipeBackend.resize`);
- three more turns with long replies followed; Claude left its prompt
  suggestion greyed out in the empty input box.

| file | content |
|---|---|
| `pipe-stream-160x50-then-214x62.raw` | every byte the pane wrote, from launch to the moment of the capture |
| `pane-capture-214x62.txt` | `tmux capture-pane -e -p` of the pane at that moment |

Replaying the stream into a 160x50 renderer does not reproduce the pane: the
input box is gone from it, while the capture shows the empty, framed input box
(holding only the dim suggestion). The conversation is the probe's own filler
text; nothing else was typed.
