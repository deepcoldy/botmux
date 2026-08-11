# Agent Workbench UI

Status: implemented, browser-verified and production-built on `feat/agent-workbench`. The full integration, API, security and manual Feishu validation guide is in agent-workbench-implementation.md.

## Entry surfaces

| Surface | Hash route | Contract |
|---|---|---|
| Full Workbench | #/agent-workbench[/<encoded-session-id>] | Primary appCenter UI with Sessions, Terminal, Web, Info and native Chat controls. |
| Quick Dock | #/agent-workbench-dock[/<encoded-session-id>] | Standalone sidebar helper for widths of at least 350px; no pane tree or iframe. |

Both entries are lazy routes. The Dock route is matched before the Full route, so prefix matching cannot misclassify it. H5 login returnTo validation accepts only these normalized same-site route families.

Authenticated GET /api/workbench/h5-context exposes enabled, appId, brand and entryPath only. App Secret and the allowlist never cross this projection.

## Components and state

- agent-workbench-view.tsx owns the full appCenter surface, responsive degradation, rail resize, per-session layout and native Chat bridge.
- agent-workbench-dock-view.tsx owns the narrow sidebar helper and appCenter/fallback actions.
- agent-workbench-session-list.tsx implements grouped, searchable, variable-height virtualization with keyboard navigation.
- agent-workbench-panes.tsx renders only Terminal and Web. Info is outside the pane tree, and Chat remains a Feishu-controlled external slot.
- agent-workbench-model.ts contains browser-safe routes, DTOs, grouping, layout clamps, pane validation and responsive derivation.
- agent-workbench-storage.ts persists versioned layout primitives only.
- agent-workbench-chat.ts implements toggleChat, enterChat and AppLink fallback.
- agent-workbench-api.ts strictly validates terminal-control, Preview interaction and H5 context responses.

Pane state is keyed by sessionId. Control and Preview mutations use monotonic request generations so an old response cannot overwrite an explicit Lock, a new session or an unmounted pane.

## Layout

- Rail: 200px default, 176–280px resize range, 40px desktop collapse.
- L1: one focused Terminal or Web pane.
- L2: one owned pane plus requested native Chat.
- L3: Terminal and Web in a 28–72% split, optionally alongside native Chat.
- Below 1280px: collapsed rail.
- Below 1120px: Focus.
- Below 960px: Chat jump.
- Below 768px: fixed Sessions/Workspace/Info mobile stack with a full Sessions list.

The CSS uses semantic dark/light tokens, no gradients, explicit radii no larger than 2px, focus-visible outlines, non-color state labels and reduced-motion handling.

## Native Chat

The capability order is:

1. PC toggleChat({ openChatId }) when split Chat is appropriate.
2. enterChat({ openChatId }) when toggleChat is unavailable, fails or times out.
3. /client/chat/open?openChatId=… AppLink fallback.

Sidebar H5 AppLinks use mode=sidebar, min_width=350 and max_width=520. Full Workbench uses mode=appCenter. Chat is never drawn as a custom H5 pane.

## Preview and Terminal

Terminal starts READ ONLY. Take control calls the server-authoritative lease API; release, expiry or write-WebSocket disconnect returns it to read-only. The browser never receives a signed write grant.

Web accepts only the exact /preview/<encoded-session-id>/ descriptor for the selected session. It starts PREVIEW, enters INTERACTIVE only after explicit unlock, sends bounded activity updates and fails closed to Preview. The visible security notice says the overlay prevents accidental interaction but is not an application security sandbox.

## Verification

Final results:

| Check | Result |
|---|---|
| Workbench direct boundary | 22 files, 203 tests passed. |
| Model runner | Passed: 320 sessions, 19 virtual items and four responsive degradation steps. |
| Component runner | Passed: 9 checks and 12 rendered session options. |
| Browser harness | 12 scenarios passed across 1440×900, 1280×800, 390×844 and 375×800. |
| pnpm build | Passed; build id 20eef27b5357. |
| Full unit project | 742 files / 11,216 tests passed, 1 file / 5 tests skipped, 0 failed. |

The full suite was run serially in a clean PID namespace because this checkout is itself inside an active Botmux workflow and process-discovery tests must not observe unrelated same-UID workers. A normal checkout can use the ordinary commands:

~~~bash
pnpm exec vitest run --project unit test/agent-workbench-api.test.ts \
  test/agent-workbench-chat.test.ts \
  test/agent-workbench-components.test.ts \
  test/agent-workbench-model.test.ts \
  test/agent-workbench-preview-race.test.ts \
  test/agent-workbench-route.test.ts \
  test/agent-workbench-storage.test.ts \
  test/agent-workbench-style.test.ts
pnpm exec tsc --noEmit
pnpm build
pnpm test -- --maxWorkers=1 --no-file-parallelism
pnpm exec tsx scripts/verify-agent-workbench-browser.ts
~~~

The final lazy chunks are agent-workbench-page-YQTRZKGF.js (21,866 bytes) and agent-workbench-dock-page-35RTDMEP.js (4,068 bytes).

## Screenshot

The checked-in screenshot is docs/assets/agent-workbench-dark.png (1440×900). It uses synthetic data and local same-origin fixtures; it contains no credential or live session data.

The sidecar reports 320 sessions, 15 rendered virtual rows, split pane mode and full responsive state. Browser scenario evidence is in docs/assets/agent-workbench-browser-results.json.
