# FAQ / Troubleshooting

> Compiled from the README and high-frequency questions in the community group, and continuously expanded. For more pitfalls, see [Common Pitfalls](/en/pitfalls).

## The bot receives no messages at all — what do I do?

Check these in order (PersonalAgent comes configured correctly by default; normally you don't need to touch it):

1. **Event subscription**: Open Platform → Events & Callbacks → you should subscribe to `im.message.receive_v1` + `card.action.trigger`, with the delivery method set to "Long connection (WebSocket)", and the daemon must be running.
2. **Bot capability**: Open Platform → App Features → Bot should already be enabled.
3. **Release**: The app must have a version created and published (availability "visible only to myself" passes automatically).
4. **Exclusive long connection**: Confirm this bot isn't having its long connection grabbed by another app at the same time.
5. After confirming, run `botmux restart` (from a clean shell).

## The bot has output in the terminal, but nothing was sent to Lark?

Terminal stdout ≠ sent to Lark. You must explicitly run `botmux send` (with one of `--mention-back` / `--mention` / `--no-mention`) for the group to see it. If the model only `echo`s/`print`s or forgets to call `botmux send`, nothing goes out. Use a heredoc for multi-line content; don't write it as `"line one\nline two"`.

## `botmux history` reports 400 / Lark gateway 411?

- **400**: Usually a missing Lark bot permission (such as missing `im:message.group_msg`) → enable the full permission JSON.
- **411**: The Lark gateway is stricter about "GET requests with an empty body"; older SDKs attach a `{}` body to GET, which triggers it → upgrading to a newer version fixes it.

## How do I resolve `Please run /login · API Error: 403`?

First figure out which `/login` it is:

- **Lark-side App Token rejected when calling the API**: Send `/login` in the topic → click the authorization link → copy the callback URL the browser redirects to (`http://127.0.0.1:9768/callback?...`; it's normal for the page not to load) back into the topic.
- **Model-gateway-side 403**: This is unrelated to Lark authorization and is usually an environment-variable / gateway-token issue. A common root cause is bash users putting variables in `.bash_profile` where `bash -i` doesn't read them (see [Common Pitfalls](/en/pitfalls)).

## Does it support Lark (international, larksuite.com)?

Yes. Both Feishu (feishu.cn) and Lark (international, larksuite.com) work: when you scan to create an app, the tenant type (China / international) is **detected automatically** and remembered; when you paste the AppID/Secret manually, it asks you to choose once. Each bot independently connects to the corresponding domain based on its edition, and the same machine can run Feishu and Lark bots simultaneously, with login credentials isolated per app and not interfering with each other.

## How do multiple bots collaborate with each other?

First run `@botA @botB /introduce` to register each other's open_id; afterwards, use `botmux send --mention <the other's open_id>` to explicitly trigger the other bot. Without `--mention`, the other bot won't be triggered.

## Does restarting the daemon lose context?

With **tmux** installed, no — the CLI process stays resident in a tmux session, and after `botmux restart` the next message automatically re-attaches, with no need for `--resume`. Without tmux, it runs in pty mode, and a restart reloads everything.

## Does a session keep running if I don't close it? Is there automatic reclamation?

It keeps running, and there is **currently no idle-TTL automatic reclamation**. Use `/close`, batch-close via the Dashboard, or `botmux delete stopped`/`all` to clean up.

## Wrong working directory / repository selection?

- `workingDir` searches for git repositories **downward** from that directory (up to 3 levels) and doesn't scan upward. Pointing it at a collection root (such as `~/projects`) lists them all; pointing it at a single repository lists only that repository (including worktrees).
- To switch directories temporarily, use `/cd <path>`; to skip the selection card and connect directly to a repository, use `defaultWorkingDir` (note the side effect described in the pitfalls).
- Don't set `workingDir` to `~`, as it will traverse too many folders. `/repo` numbers drift, so use `/repo <project-name>` to specify.

## How are permissions divided? Who can operate it?

Three layers: `allowedChatGroups` / `globalGrants` grant **conversation rights** (everyone in the group can ask); `allowedUsers` grants **operation rights** (only the owner can `/cd`, `/restart`, `/close`, click buttons). When `allowedChatGroups` is configured, `allowedUsers` must have at least one owner.

## Can I ask a follow-up / interrupt a running session?

By default it doesn't interrupt the current turn; new messages are queued (type-ahead) and entered in order after the current turn ends. To correct course immediately: first click `Esc` in the card / Web Terminal to interrupt, then ask.

## Can I launch the CLI with ccr / a custom gateway / various wrappers?

Yes. For any "native CLI + wrapper / gateway" combination, write a wrapper script that passes `"$@"` through, then set `cliPathOverride` to that script's path when editing the bot in `botmux setup`.

## Can a bot added to a new group see the earlier chat history?

Yes. Just tell it "look at the chat history", or quote a specific message. The prerequisite is that the Lark bot's permissions are fully enabled (including group message reading).

## Are Chinese characters / emoji rendered as boxes in screenshots?

Missing CJK fonts. On Debian/Ubuntu the daemon will try to auto-install `fonts-noto-cjk fonts-noto-color-emoji` (requires passwordless sudo or root); on other Linux distributions, install Noto CJK + Noto Color Emoji manually and restart the daemon.

## A regular group has too many messages — can I switch it to a topic group?

Yes, but it requires action by the group owner / admin: Group Settings → Group Management → Group Message Format → select "Topic messages". A bot cannot change the group's settings on your behalf.

## Does it work on Windows?

It hasn't been verified on native Windows, but WSL2 should be fine.

## How do I upgrade?

`botmux upgrade`. The `botmux` wrapper version inside sessions always stays in sync with the daemon, so it doesn't need to be upgraded separately.

## CoCo loses messages while busy?

Upgrade to **CoCo ≥ 0.120.32** — type-ahead (messages received while busy go into CoCo's own queue) depends on that version's behavior.
