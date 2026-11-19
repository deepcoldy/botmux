# Stop sending when the topic is unavailable

While the AI is working in a topic, someone may withdraw the original topic message. By default, Botmux keeps its existing delivery rules: for example, if the quoted message was withdrawn, the reply is posted to the top level of the chat instead.

If you don't want replies to "move somewhere else", turn on the **Stop sending** policy for the bot. Before each send, Botmux checks that the original topic still exists. If it is gone or can't be verified, nothing is sent, and nothing is redirected.

## How to turn it on

Pick one:

- **Dashboard**: open **Bot Config**, select the bot, and in the **Reply Delivery** section set **When the original topic is unavailable** to **Stop sending**. It takes effect as soon as you save.
- **Slash command**: send this to the bot in Feishu:

  ```sh
  /botconfig set topicUnavailablePolicy stop
  ```

To go back to the default, run either of these:

```sh
/botconfig set topicUnavailablePolicy legacy
/botconfig unset topicUnavailablePolicy
```

The setting is per bot and is stored as the `topicUnavailablePolicy` field of that bot in `bots.json`.

## The two policies

| Policy | Shown in Dashboard | Behavior |
| --- | --- | --- |
| `legacy` (default) | Default | Keeps the existing delivery rules with no extra topic lookup. Existing fallbacks, such as a withdrawn quote, still post to the chat's top level. |
| `stop` | Stop sending | Looks up the original topic before sending. If it is withdrawn or can't be verified, sending stops. It never redirects to the top level, another chat, or a new topic. |

## What gets checked

With `stop` on, these sends check the original topic first:

- `botmux send` run by the AI inside a session, and the automatic final reply at the end of a turn
- An explicit destination topic given with `--into` is checked too
- Explicitly sending to the chat's top level or another topic **still checks the original topic** first, so it can't be used as a workaround
- Updating a card or message that was already sent (for example, a streaming card refresh) checks the topic it lives in

No extra lookup happens when:

- A broadcast has no source topic, so there is nothing to check
- A message that was already delivered is replayed: the earlier receipt is reused, with no new lookup and no resend

## What you see when a send is blocked

| Error code | Meaning | What to do |
| --- | --- | --- |
| `TOPIC_SEND_BLOCKED` | The original topic was withdrawn (including Feishu error code `230011`) | Don't retry, and don't send it somewhere else |
| `TOPIC_SEND_CHECK_FAILED` | The lookup failed, or the message status couldn't be confirmed | You can retry the lookup on the same topic later. It doesn't mean the topic is gone, and it is not permission to send elsewhere |

- On the command line you get `botmux send refused: …` and exit code `2`.
- When the automatic final reply hits `TOPIC_SEND_BLOCKED`, retries stop immediately and the reply stays undelivered. Since the original topic can't receive a notice, Botmux puts the session in the Dashboard's **Needs You** column with the reason. No notice is posted to any other conversation.
- A `session.requires_attention` event (reason `topic_send_blocked`) also fires, so you can forward it to your own channel with [Hooks](/en/hooks).

## Good to know

- This policy only decides whether to send. It doesn't cancel a running task, and it doesn't mean the original task content should be deleted.
- Lookups are cached briefly: within one send, a successful "available" result is reused for at most 1 second. Failed or unknown results are never cached.
- Even if the pre-send check passes, if Feishu reports at send time that the quoted message was withdrawn, `stop` mode still stops instead of falling back to the chat's top level.
