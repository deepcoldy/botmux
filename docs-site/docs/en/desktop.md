# macOS Desktop App

Botmux Desktop is the Mac app for botmux. It ships with its own runtime, so you **don't need Node or a global `botmux` command**. Double-click it to start the background service, browse the Dashboard, and read logs.

It's a good fit when:

- You run botmux on a Mac and want a window with start / stop buttons instead of remembering commands.
- You'd rather not deal with Node versions on your machine.
- You want botmux to start in the background when you log in to your Mac.

> For Linux servers or dev boxes, keep using the command-line install in [Quick Start](/en/quickstart). The desktop app is macOS only.

## How it relates to the CLI

| | Desktop app | CLI (curl / npm install) |
|---|---|---|
| Runtime | Bundled in the app, same version as the app | The `botmux` program you installed |
| Config, sessions, logs | All in `~/.botmux` | All in `~/.botmux` (**the same one**) |
| Bot processes | Started by the app's runtime | Started by `botmux start` |

Both sides read and write **the same `~/.botmux`**: bot config (`bots.json`), sessions, logs, and the background process records are shared. Moving from the CLI to the desktop app doesn't require reconfiguring your bots.

But **only one side can manage the bots at a time**. When the app opens it takes them over automatically; see [What happens when the app opens](#what-happens-when-the-app-opens).

## Install

1. Open [GitHub Releases](https://github.com/deepcoldy/botmux/releases) and find the latest stable release.
2. Download `Botmux-<version>-mac-universal.dmg` (or the `.zip` with the same name) from the assets.
   - It's a Universal build: works on both Intel and Apple silicon (M-series) Macs.
   - The package is signed and notarized by Apple, so macOS won't block it when you open it.
3. Open the DMG and drag **Botmux** into the Applications folder.
4. Launch Botmux from Applications or Launchpad.

> Only stable releases include the desktop package. Preview builds such as `-canary` or `-beta` are CLI only. The package is attached after the release is published, so it may not show up during the first few minutes.

**Before you start**: the AI CLIs you plan to use (such as `claude` or `codex`) still need to be installed and logged in from a terminal, and tmux is required by default. See [Prerequisites](/en/prerequisites). The app reads the PATH from your shell config (zsh / bash / fish profile and rc files), so any command your terminal can find, the app's bots can find too.

## First run

**You've used the CLI before**: just open the app. It picks up the bots already in `~/.botmux`, takes them over, and starts them.

**You've never configured a bot**: the bottom-left corner shows "Setup needed" and the dashboard can't load. Add your first bot first:

- Run `botmux setup` once from a terminal. A Feishu QR scan creates the app for you. This step needs the CLI installed first; see steps 1 and 2 of [Quick Start](/en/quickstart). Then go back to the app and click "Start".
- Or write `~/.botmux/bots.json` by hand following [bots.json](/en/bots-json) ("Open folder" in the app's top bar opens that directory).

Once the first bot exists and the service is running, you can add more bots with "Add bot" in the app's top bar.

## Everyday use

The app has three areas:

| Area | What it does |
|---|---|
| Left sidebar | Dashboard pages (Overview, Sessions, Groups, Schedules, Bot Profiles, etc.); at the bottom, the runtime status, "Start / Stop / Restart" buttons, and the "Launch app at login" switch |
| Top bar | Online daemons, items needing attention, configured bots; "Create session", "Add bot", "Docs", "Logs", "Open folder"; 中 / EN switch |
| Center | The embedded Dashboard, used exactly like in a browser; see [Dashboard](/en/dashboard) |

Common tasks:

| I want to… | Do this |
|---|---|
| Start / stop / restart all bots | The buttons in the bottom-left corner, or Start / Stop / Restart Botmux in the menu bar icon |
| Read logs | "Logs" in the top bar; pick a process in the drawer and copy with one click. "Open folder" opens `~/.botmux/logs` |
| Run automatically after logging in | Turn on "Launch app at login". The app starts quietly in the background and brings the bots up |
| Close the window | The red close button only **hides the window**; bots keep running. Click the menu bar icon to reopen it |

The menu bar icon's menu:

```
Show Console        Open the window
Start Botmux        Start
Stop Botmux         Stop
Restart Botmux      Restart
Open Logs           Open the logs folder
Open Botmux Home    Open ~/.botmux
Quit App            Quit the app
```

> "Quit App" only quits the app itself; it **does not stop the bots**. To stop them too, click "Stop" before quitting.

## What happens when the app opens

On launch, the app checks who is currently running the bots:

| Current state | What the app does |
|---|---|
| Nothing running | Starts them with the bundled runtime |
| Already run by the app | Nothing; it just shows the status |
| Started by the CLI `botmux start` (or a version different from the app's) | **Gracefully stops** those processes first, then brings them back up with the bundled runtime |

In the last case the bottom-left corner briefly shows a message saying it detected an external botmux runtime and is switching to the bundled one. This is a **normal handover**; your CLI install isn't being broken:

- Nothing in `~/.botmux` is deleted or changed.
- Like a regular `botmux restart`, sessions in progress are restored after the restart.
- Only botmux's own core processes are replaced; plugin services are left alone.

Also, **while the app is open**, if you run `botmux restart` / `botmux start` in a terminal, the app notices within a few seconds and takes the bots back. This keeps two versions from connecting to the same bots at once.

## Switching back to the CLI

To manage the bots with the `botmux` command in your terminal again:

1. Click "Stop" in the app (optional, but saves one restart).
2. Turn off "Launch app at login" so the app doesn't take over again at your next login.
3. Choose "Quit App" from the menu bar icon (or press ⌘Q).
4. In a terminal, run `botmux start` (if you stopped first) or `botmux restart` (if you didn't).

As long as the app isn't open, the CLI keeps managing the bots. If you open the app again later, it takes over using the rules above.

> If both autostarts are on (the app's "Launch app at login" and the CLI's `botmux autostart enable`), the CLI brings the bots up at login and then the app takes them over. It works, but costs an extra restart. Keep just one: if you use the app, run `botmux autostart disable`; if you use the CLI, turn off the app's switch.

## Upgrading

Download the new DMG, drag the new Botmux into Applications to replace the old one, and open the app.

When the app sees running processes from a different version, it restarts them once with the new version. Desktop upgrades follow the app only: `botmux update` or re-running the curl install script upgrades the CLI, not the app.

## FAQ

**The app keeps showing "Needs attention" and the dashboard won't load?**
Open "Logs" in the top bar first. Common causes: `~/.botmux/bots.json` is malformed (the bottom-left corner tells you which entry is wrong), or the app is still taking over from the CLI; wait a few seconds.

**Bots say they can't find `claude` / `codex`?**
The app uses the PATH from your shell config. First make sure `which claude` works in a freshly opened terminal. If you installed the CLI or changed your shell config after the app was opened: quit the app ("Quit App" in the menu bar), open it again, then click "Restart" so the bots pick up the new PATH. Reopening the app alone isn't enough, because quitting the app doesn't stop the running bots.

**The app quits right after opening?**
Usually the app bundle is incomplete (for example, an interrupted copy). Download the DMG again and reinstall over it.

**Bots still reply after I quit the app?**
That's expected. Quitting the app doesn't stop the service; click "Stop" first.

**Can I use the desktop app and the CLI together?**
You can keep both installed, and they share the same config, but only one runs the bots at a time. While the app is open, the app manages them; after you quit it, the CLI can. CLI commands that only look and don't change anything (such as `botmux status` or `botmux logs`) work any time.
