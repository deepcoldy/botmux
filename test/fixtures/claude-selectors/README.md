# Claude Code selectors and pickers — bottom rows of live screens

Plain text (attributes dropped) of the bottom 12 rows of a real Claude Code
2.1.328 pane (fake local API, private tmux), captured with `capture-pane -p`
while each selector was open:

| file | screen |
|---|---|
| `ask-user-question-first.txt` | AskUserQuestion, cursor on the first option |
| `ask-user-question-type-something.txt` | cursor on "Type something." |
| `ask-user-question-chat-about-this.txt` | cursor on "Chat about this", the row right under a plain rule |
| `rewind.txt` | Esc Esc rewind picker |
| `model-picker.txt` | `/model` |
| `history-search.txt` | Ctrl-R history search |

An Enter on any of them answers it, so none may be taken for the input box.
The question and options are the probe's own text.
