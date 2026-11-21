# Feishu Doc Comment Watching (/watch-comment)

Let the bot "live" in a Feishu/Lark cloud doc: ask a question or make a request in a doc comment, the AI reads the doc and does the work, then posts its answer straight back into **that comment's thread**. No need to leave the doc or switch to a group.

Good for:

- Asking "does this section match the code?" while reading a design doc
- Having the AI rewrite, extend, or review a passage in the doc
- Letting the AI pre-read a doc before a meeting, so everyone can ask in comments during the meeting

## Quickest start: @ the bot in a comment

No command needed. Open any Feishu doc the bot can access and `@the bot` in a comment with your question.

- When the bot picks it up, it adds a "Typing" reaction to your comment and removes it once the answer is posted.
- The answer is posted as the **bot's identity** in the original comment thread, and `@`s the person who asked.
- The doc is automatically registered as a "reply only when @ the bot" watch, so later `@bot` comments in the same doc are handled too.
- **Each comment thread in the doc gets its own session**, so conversations don't mix.

If the person mentioning the bot is not the bot owner, the bot still **replies right away**, but only after it manages to DM the owner a notice: who mentioned it, in which doc. If that notice can't be sent (or the bot has no owner configured), the bot doesn't reply and the auto-registration is undone. This is "notify, don't approve": the owner always knows, but replies don't wait for approval. To stop replying in a doc, the owner sends `/watch-comment off <doc link>`.

> This zero-command path relies on Feishu pushing the comment event to the bot. If the first mention gets no response, check "One-time setup" below, or register explicitly with `/watch-comment`.

## Bind to a topic: /watch-comment

To have comments share one AI session with a Feishu topic (for example, a topic already discussing this project), send this in that topic:

```
/watch-comment <Feishu doc link> [--dir <local project path>] [--all | --mentions-only | --owner-mentions]
```

After that:

1. If the topic has no AI session yet, one is created and the CLI starts right away;
2. The AI reads the doc first to build context, then waits for comments;
3. Matching comments in the doc are fed into this session, and answers go back to the original comment thread;
4. Status cards, terminal links, and other cards still go to this topic.

To answer with local code in mind, pass a project directory with `--dir`. Without it, the topic session's current working directory is used. If there is none, the AI answers from the doc alone, and the receipt reminds you that you can add one with `/cd <project dir>`.

> Every form of `/watch-comment` (register, `list`, `off`) is **bot-owner only**. Everyone else can only trigger replies by `@`-ing the bot in the doc.

### Commands

| Command | What it does |
|---------|--------------|
| `/watch-comment <doc link> [--dir <path>] [mode]` | Register a watch and bind it to the current topic session |
| `/watch-comment list` | Inside a session: docs watched by this session. Without a session: all doc watches of this bot |
| `/watch-comment off <doc link>` | Stop watching this doc |
| `/watch-comment off` or `off all` | Stop every watch in the current scope (this session / this bot) |

Supports Feishu cloud docs (docx) and Wiki links.

## Which comments trigger: three modes

| Mode | Flag | Who triggers the AI | Good for |
|------|------|---------------------|----------|
| Only @ the bot (default) | `--mentions-only` | Comments that `@` the bot | Most docs, the quietest |
| Reply when the owner is @-ed (stand-in) | `--owner-mentions` | Comments that `@` the watch owner (whoever ran `/watch-comment`) or `@` the bot | Letting the bot answer questions people `@` you with |
| Every new comment | `--all` | Any new comment in the doc, no `@` needed | Bot-dedicated docs |

Notes:

- The stand-in and every-comment modes find new comments by **reading the comment list about every 5 seconds**, so there can be a few seconds of delay. Comments that really `@` the bot still arrive instantly, and the two paths never handle the same comment twice.
- When switching to one of those two modes, the bot only handles comments posted **afterwards**. It won't dig up old comments and answer them again.
- Auto-registration (the zero-command path) always uses "only @ the bot". To change the mode, run `/watch-comment <link> --all` (or another flag) again, or change it in the Dashboard. The Dashboard only offers "only @ the bot" and "every new comment"; the stand-in mode can only be set with the command.
- Use at most one mode flag. Passing several is an error.

### Set the default mode

The default mode for new watches is set per bot in **Dashboard → Bot Config** under "Doc subscription trigger (default)": "Only when a comment @s me" or "Every new comment".

The matching `bots.json` field is `docSubscribeDefaultMode`: `"all"` means every new comment; leave it out for only @ the bot.

### Pin a project directory to a doc

To have a doc always work in a fixed project directory, set `docRepoMap` in `bots.json`. Keys are doc tokens, values are absolute local paths:

```json
{
  "docRepoMap": {
    "<doc token>": "/home/me/my-repo"
  }
}
```

`docRepoMap` only applies to watches **not bound to a topic** (zero-command auto-registrations and watches registered in the Dashboard). A watch bound to a topic uses the topic session's working directory; to change it, use `--dir` or `/cd` in the topic.

## Manage it in the Dashboard

The Dashboard sidebar has a **"Doc watches"** page where you can manage everything without commands:

- **See the list**: every watched doc, its bot, working directory, and trigger mode;
- **See how it's running**: last activity, last delivery, total deliveries, and "why the latest comment wasn't answered";
- **Change mode / stop**: switch the trigger range right on the card ("only @ the bot" or "every new comment"), or click "Stop watching";
- **Register a new doc**: paste a doc link (or token), pick a bot and a trigger range, optionally fill in a working directory, then click "Start watching". A new doc isn't bound to any topic; a session is created when the first matching comment arrives. For a doc already bound to a topic, this only updates the mode and working directory, and comments still go back to that topic;
- **Spot the origin**: watches auto-created by someone else `@`-ing the bot are marked, so the owner can review them.

When comments fail to be handled, a "Document comment failures" panel appears at the top of the Dashboard overview and sessions pages. Expand it to see why, and jump to "Doc watches". In the doc itself, an `@` the bot couldn't handle also gets an error reaction, so the person asking knows to retry.

## What the AI sees

Each comment is handed to the AI together with:

- the doc link;
- for an inline comment (one made on selected text), the selected source text;
- earlier discussion in the same comment thread.

When the question needs the full body, the AI is told to read the doc with an available Feishu doc tool first instead of guessing.

## How answers get back to the doc

- By default, the answer is posted as the **bot** in the original comment thread, with the first part `@`-ing the person who asked;
- Long answers are split into several comments automatically;
- A few comments (for example resolved ones, or docs whose settings block replies) can't take replies. The bot then **creates a new whole-doc comment** as the answer, so it always lands in the comment area;
- If the bot itself has no access to the doc, it falls back to posting as the authorized user. To keep answers showing as the bot, share the doc with the bot;
- Doc comments are a plain-text channel. Buttons, cards, and terminal links still go through the Feishu topic (doc sessions auto-created by the zero-command path post no cards and only reply in comments).

## One-time setup (Feishu Open Platform)

`/watch-comment` needs no User Token. The bot reads comments and posts replies with its app identity. You only need to do two things for the app in the **Feishu Open Platform console**:

1. **Permissions**: enable `docs:document.comment:read` (read comments) and `docs:document.comment:create` (post comments/replies), plus `wiki:wiki:readonly` for Wiki docs, then publish a version;
2. **Event subscriptions**: add the `drive.notice.comment_add_v1` (doc comment added) event, using long-connection delivery.

Once the bot has doc watches, its startup self-check verifies these permissions and DMs the admin if any are missing. Feishu can't auto-detect event subscriptions, so the self-check only reminds you to confirm it.

## Lifecycle

- `/close` on a topic session also removes the doc watches bound to it;
- After a daemon restart, watches and the reading progress of the every-comment / stand-in modes are restored automatically, without re-answering old comments;
- **A doc binds to only one session at a time**: running `/watch-comment` for the same doc in another topic moves it there, and the receipt tells you so;
- One session can watch several docs at once.

## Legacy command: /subscribe-lark-doc

`/subscribe-lark-doc` is the earlier approach, kept for those who need it. It requires a doc-scoped **User Token**, calls Feishu's per-file subscribe API, and binds the subscription to the current session. If the token is missing, the command gives you an authorization link; authorize and retry.

| Command | What it does |
|---------|--------------|
| `/subscribe-lark-doc <doc link>` | Subscribe to this doc with a User Token and bind it to the current session |
| `/subscribe-lark-doc list` | List docs subscribed by this session |
| `/subscribe-lark-doc off` | Unsubscribe all docs of this session |

Prefer `/watch-comment` for new setups. You only need `/subscribe-lark-doc` when the zero-command path receives no events and you want to force Feishu's per-file subscription. Docs subscribed this way are unsubscribed through the Feishu API on `/close`.
