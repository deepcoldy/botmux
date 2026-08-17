# Agent Workbench UI

Status: implemented, browser-verified and production-built on `feat/agent-workbench`. The full integration, API, security and manual Feishu validation guide is in agent-workbench-implementation.md.

## Entry surfaces

| Surface | Hash route | Contract |
|---|---|---|
| Full Workbench | #/agent-workbench[/<encoded-session-id>] | Primary appCenter UI: grouped session list, single-terminal workspace, and a mobile drill-down with 终端/网页/信息 pages. |
| Quick Dock | #/agent-workbench-dock[/<encoded-session-id>] | Standalone sidebar helper for widths of at least 350px; session list plus summary and link actions, no pane iframes. |

Both entries are lazy routes. The Dock route is matched before the Full route, so prefix matching cannot misclassify it. H5 login returnTo validation accepts only these normalized same-site route families.

Authenticated GET /api/workbench/h5-context exposes enabled, appId, brand and entryPath only. App Secret and the allowlist never cross this projection.

The client tracks local management authority separately from narrow Workbench authority. H5/platform identities can use the server-scoped Terminal and Preview leases without gaining Dashboard management controls; expected management 401s do not masquerade as an expired Workbench login.

## Components and state

- agent-workbench-view.tsx owns the full appCenter surface: responsive derivation, rail resize and collapse, per-session layout plus rail/unread persistence, the single-terminal workspace and the mobile drill-down stack.
- agent-workbench-dock-view.tsx owns the narrow sidebar helper and its summary and link actions.
- agent-workbench-session-list.tsx implements six grouping dimensions, collapsible groups, search, unread markers, fixed-height virtualization (54px desktop rows, 84px touch rows, 30px group headers) and keyboard navigation; each row carries the chat anchor plus 定位/终端/接管 actions.
- agent-workbench-panes.tsx provides TerminalPane, WebPane and WorkbenchInfo. The desktop workspace hosts a single TerminalPane; WebPane and WorkbenchInfo render as mobile drill-down pages. Chat stays a Feishu-controlled external surface and is never drawn in-page.
- agent-workbench-model.ts contains browser-safe routes, DTOs, grouping and attention/unread classification, layout clamps, responsive derivation and the terminal/preview href guards.
- agent-workbench-storage.ts persists versioned browser-local primitives only: per-session layout, shared rail prefs, the seen/unread ledger, the grouping dimension and collapsed group keys.
- agent-workbench-chat.ts builds the safe chat/open and web_app/open AppLinks and the H5 login URL. The legacy openWorkbenchChat JSAPI chain and lazy SDK loader remain as tested utilities, but no Workbench surface calls them.
- agent-workbench-api.ts strictly validates terminal-control, terminal view-link, Preview interaction and H5 context responses, and surfaces locate rate limits (429 retry-after) as typed errors.

The terminal pane is keyed by sessionId and control intent. Control and Preview mutations use monotonic request generations so an old response cannot overwrite an explicit Lock, a new session or an unmounted pane.

## Layout

- Rail: 300px default, 176–460px resize range, 40px collapsed width. Collapsing is the user's own choice at every desktop width (the toggle is offered at the ≥1280px full step); narrowing the window never force-collapses the list.
- Workspace: at most one Terminal pane, opened from a row's 终端 (read-only) or 接管 (auto-takeover) button and closed from the workspace header; while it is closed the session list fills the page. There is no in-page split, layout-level badge, info drawer or chat widget.
- Web preview: WebPane renders on the mobile 网页 page only. Desktop reaches the same /preview/<encoded-session-id>/ URL through the Dock's 网页链接 action or by opening it directly; the same-origin guard shell enforces the overlay there.
- Desktop responsive steps full / rail-collapsed / focus / chat-jump derive at 1280/1120/960px and surface as data-responsive-step; with the single-terminal workspace and anchor-based chat they no longer change the page structure.
- Below 620px: the mobile drill-down stack. The session list is the home level and always renders in full; tapping a row pushes a detail surface with 终端/网页/信息 segments (网页 only when the session has a registered preview) and an explicit ‹ 会话列表 back control.

The CSS uses semantic dark/light tokens, no gradients, explicit pixel radii no larger than 4px, focus-visible outlines, non-color state chips, 44px-plus touch targets (84px touch rows) and reduced-motion handling.

## Chat

Chat never renders inside the Workbench. Every chat entry is a real anchor — target="_blank" rel="noopener", href from the session's feishuChatLink or a built /client/chat/open?openChatId=… AppLink. A trusted user click on that anchor is the one dispatch the Feishu client honours with its standard chat placement; scripted variants (window.open, synthetic .click(), enterChat) are demoted to the narrow attached container. No surface calls toggleChat or enterChat — the browser harness asserts zero SDK calls — and chat/open links carry no sidebar/width parameters.

Dock web_app AppLinks use mode=sidebar, min_width=350 and max_width=520. Full Workbench handoff uses mode=appCenter.

## Preview and Terminal

Terminal starts READ ONLY (只读). 接管输入 calls the server-authoritative lease API; release, expiry or write-WebSocket disconnect returns it to read-only. Touch environments always use the read-only viewToken channel and hide the takeover control. The browser never receives a signed write grant.

Web accepts only the exact /preview/<encoded-session-id>/ descriptor for the selected session. It starts 预览 (PREVIEW), enters 可交互 (INTERACTIVE) only after explicit 开启交互, sends bounded activity updates and fails closed to Preview, relocking after 15 idle minutes. The visible security notice says the overlay prevents accidental interaction but is not an application security sandbox.

## Verification

Final results:

| Check | Result |
|---|---|
| Workbench direct boundary | 16 files, 262 tests passed. |
| Model runner | Passed: 320 sessions, 22 virtual items and four responsive degradation steps. |
| Component runner | Passed: 21 checks and 14 rendered session options. |
| Browser harness | 13 scenarios passed across 1440×900, 1280×800, 390×844 and 375×800. |
| pnpm build | Passed; build id 5f17015159ac (pre-merge acceptance build). |
| Full unit project | 963 files / 15,668 tests passed, 1 file / 16 tests skipped, 0 failed (pre-merge acceptance run). |

The full suite was run serially in a clean PID namespace because this checkout is itself inside an active Botmux workflow and process-discovery tests must not observe unrelated same-UID workers. A normal checkout can use the ordinary commands:

~~~bash
pnpm exec vitest run --project unit test/agent-workbench-*.test.ts \
  test/dashboard-auth.test.ts \
  test/dashboard-h5-auth.test.ts \
  test/dashboard-login-ui.test.ts \
  test/dashboard-preview-wiring.test.ts \
  test/dashboard-public-redact.test.ts \
  test/session-preview.test.ts \
  test/session-preview-proxy.test.ts \
  test/terminal-control.test.ts
pnpm exec tsc --noEmit
pnpm build
pnpm test -- --maxWorkers=1 --no-file-parallelism
pnpm exec tsx scripts/verify-agent-workbench.ts
pnpm exec tsx scripts/verify-agent-workbench-components.ts
pnpm exec tsx scripts/verify-agent-workbench-browser.ts
~~~

The pre-merge acceptance build emitted the lazy chunks agent-workbench-page-4FMJKB3O.js (23,752 bytes) and agent-workbench-dock-page-WGMQQKSK.js (3,947 bytes); chunk hashes change with every build.

## Screenshot

The checked-in screenshot is docs/assets/agent-workbench-dark.png (1440×900). It uses synthetic data and local same-origin fixtures; it contains no credential or live session data.

The sidecar metrics report 320 sessions, 18 rendered virtual rows at the 54px row height, 2 group headers, the terminal chip in its writable「◆可输入」state and the full responsive step. Browser scenario evidence is in docs/assets/agent-workbench-browser-results.json.
