# Agent Workbench

<video src="../img/video-v7-dashboard-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

The Workbench (shown as 驾驶舱, "Cockpit", in the Dashboard) is the part of the [Dashboard](/en/dashboard) built for **keeping an eye on many AI sessions at once**: the left side lists every session on this machine, the right side shows the terminal of the one you pick. You can see at a glance which session just finished and which one is stuck waiting for you.

The "Open Workbench" button on the Lark `/dashboard` card and the `工作台: …` link printed by `botmux dashboard` both open it.

![The Workbench: session list on the left, terminal on the right](/img/workbench-overview.png)

Good for:

- Running several topics at once and wanting to know **who's done and who's waiting on you**, without digging through Lark groups.
- Watching a session's **live terminal**, and typing into it when needed.
- A quick progress check from your phone.

## How to open it

| Entry | What to do | Notes |
|---|---|---|
| Dashboard sidebar | Click 驾驶舱 (Cockpit) | Keeps the Dashboard top bar and sidebar |
| Lark card | As an admin, send `/dashboard` in Lark; the bot DMs you an overview card. Click "Open Workbench" | On desktop it opens as a tab inside Lark (right-click to pin); on mobile it opens the web page |
| Command line | Run `botmux dashboard` on the machine and copy the `工作台: …` line | Handy as a bookmark |
| Standing link | In the Workbench's appearance menu, click "Standing link" and copy it | See "A long-term entry" below |

When opened from a **direct entry** like the card, the command line, or the standing link, the Workbench fills the whole screen without the Dashboard sidebar.

## The session list

By default the list is split into three groups by status:

| Group | What's in it |
|---|---|
| 待你处理 (Needs you) | Sessions that need you to act (see below), plus sessions the bot just finished that you haven't opened yet (marked "有新回复", new reply) |
| 进行中 (Active) | Sessions that are still alive |
| 最近 (Recent) | Sessions that ended or went dormant |

Common reasons a session lands in "Needs you":

| Shown on the row | Meaning |
|---|---|
| 有新回复 (New reply) | The bot finished and you haven't looked yet |
| Agent 请求协助 (Agent asks for help) | The AI is calling you |
| 需要选择仓库 (Pick a repo) | The session has no working directory yet |
| 终端有待确认的提示 (Prompt waiting in terminal) | The CLI is showing a confirmation and waiting for your choice |
| 待启动 (Queued) | Waiting in line, not started yet |
| 用量已达上限 (Usage limit hit) | The CLI ran out of quota |

Opening a session counts as seeing it, and "New reply" goes away.

Everyday actions:

- **Change grouping**: the dropdown at the top of the list offers status, bot, location, type, CLI, last active, and Worktree. Your choice is remembered.
- **Search**: press `/` to jump to the search box.
- **Move with the keyboard**: `j` / `k` or the arrow keys.
- **Resize / collapse the list**: drag the bar on the list's right edge, or click `«` to collapse it.

Each row has a few quick buttons on the right:

| Button | What it does |
|---|---|
| 聊天 (Chat) | Opens the chat this session lives in, in Lark |
| 定位 (Locate) | Topic sessions only. Has the bot @ you in the original topic so you can jump back from the Lark notification. After one use it's disabled for 30 seconds |
| 跳转 (Jump) | Topic sessions only, and only when the original topic link is known. Jumps straight to the topic in Lark |
| 终端 (Terminal) | Opens this session's terminal on the right (usually read-only, see below) |

## Watch the terminal, type into it

Click "Terminal" on a row and the right side shows that session's live terminal, the same view as the [Web terminal](/en/web-terminal).

- It starts **read-only**: you can watch without typing anything by accident.
- To type: click "接管输入" (Take over input) in the terminal title bar. The title bar then shows when your control expires; click "释放输入" (Release input) when you're done.
- Some identities aren't allowed to take over. In that case the button isn't shown and the hint says the current identity can't take over input.
- If you signed in through the central platform as the owner, you can type as soon as the terminal opens (the hint says so); no takeover needed.
- "新标签页打开" (Open in new tab) opens the terminal in its own browser tab.
- "关闭终端 ✕" (Close terminal) hides the terminal pane.

To chat with the AI the way you do in Lark, click "Chat" on the row and continue in Lark. The Workbench doesn't duplicate a chat box.

## On your phone

On narrow screens (like a phone), the Workbench turns into **one page at a time**:

1. You first see the session list.
2. Tap a session to open its detail page. The top bar switches between "终端" (Terminal) and "信息" (Info); if the session registered a web preview with `botmux preview <port>`, there's also "网页" (Web).
3. Tap "‹ 会话列表" (Session list) at the top left to go back.

![Session list on a phone](/img/workbench-mobile-list.png)

On the phone the terminal is a read-only view by default; to type, use a computer (a few identities can type on the phone too, and the terminal hint says so).

To put the Workbench on your home screen: open it in your phone's browser and choose "Add to Home Screen". The icon then opens straight into the session list.

### Session dock (slim view)

The session dock is a narrow version of the Workbench for tight spots such as a sidebar. Its address is `<your Dashboard address>/workbench/dock`. It has only the session list plus a few buttons: open the full Workbench, open the chat, terminal link, and web link. The terminal and web preview are viewed in the full Workbench or a new tab.

## Appearance

On desktop click `⋯` at the top right → "Appearance"; on the phone tap `◐` at the top of the list.

![Appearance menu](/img/workbench-appearance-menu.png)

| Option | Values | Notes |
|---|---|---|
| Theme | Ink, Slate, Graphite, Frost | Ink / Slate / Graphite are three dark themes; Frost is the light one |
| Light or dark | System, Light, Dark | Light always uses Frost; Dark uses the dark theme you picked; System switches between the two automatically |
| Terminal | Reader, Classic | Reader: muted colours and roomier line spacing for long sessions; Classic: the terminal exactly as it comes |

The default is Slate + Classic. The terminal title bar also has a Reader / Classic switch close at hand.

Appearance is saved in the current browser, so a different device or browser needs its own choice. The first time you open the Workbench, light/dark follows your Dashboard setting.

## A long-term entry: the standing link

For a Workbench link you can **bookmark and keep using**:

1. Sign in to the Dashboard with the link printed by `botmux dashboard` (this is the local admin identity).
2. Open the Workbench and click `⋯` → "Standing link" (on the phone it's in the `◐` panel).
3. Click "Copy" and save it as a browser bookmark.

Things to know:

- "Standing link" **only shows for the local admin**. Identities signed in through the central platform or Lark single sign-on don't see it.
- This link, like the link behind the card's "Open Workbench" button, carries the Dashboard's long-lived token: it doesn't expire, survives `botmux restart`, and can be opened again and again on desktop and phone.
- If you suspect it leaked, run `botmux dashboard rotate` on the machine. Once the token changes, every old link (including card buttons already sent) stops working immediately; just fetch the standing link again.
- If the small print under the card says the Dashboard credential is unavailable, that button link carries no sign-in and you'll need to log in after it opens.

## Phone won't load it? Use the self-check page

If the Workbench is blank on your phone or the terminal never shows up, while your computer works fine, open this in the phone's browser:

```
<your Dashboard address>/workbench-doctor
```

The page **needs no sign-in**. It runs a series of checks on its own, waiting at most 8 seconds for each:

| Check | What it tells you |
|---|---|
| Device info, page address, device time | Which browser and which address you're on |
| Service version | If it differs from what your computer sees, the phone is using a stale cache |
| Session list API | A failure means your sign-in (cookie) isn't being sent |
| Terminal link, terminal page | Whether the terminal address can be fetched and reached from the phone's network |
| Live connection (two paths) | Whether the WebSocket the terminal needs can be established |

When it's done, take a screenshot and send it to the bot or your maintainer; it shows whether the problem is the network, the sign-in, or a stale cache. The page never shows any token or secret, so the screenshot is safe to share.

To check one specific session, add `?session=<session ID>` to the address.

## FAQ

**The phone says the terminal's live connection couldn't be established?**
Lark's in-app browser on iOS often blocks unencrypted live connections. Tap `⋯` at the top right in Lark, choose "Open in browser", and try in the system browser, or look on a computer.

**No "Locate" or "Jump" on a row?**
Both only appear for topic sessions, and "Jump" also needs the bot to know the original topic link. Group and DM sessions only have "Chat" and "Terminal".

**The selected session says "会话不存在" (session not found)?**
It has ended or been cleaned up. Pick another one from the list.

**Why don't I see "Standing link"?**
Only the local admin, signed in with the link from `botmux dashboard` (or the card button), sees it.
