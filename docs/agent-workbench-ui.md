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

Operation entries render from the server-projected minimal capability set (GET /api/workbench/capabilities → canLocate/canControl/canInteract), parsed strictly with a fail-closed all-false fallback. `authenticated` alone never shows an operation button: 定位 follows canLocate, the pane takeover button (接管输入 — the only takeover entry; the row-level shortcut was removed by product decision) follows canControl, and the Preview unlock follows canInteract — layered on top of (not replacing) the existing touch read-only restrictions.

## Components and state

- agent-workbench-view.tsx owns the full appCenter surface: responsive derivation, rail resize and collapse, per-session layout plus rail/unread persistence, the single-terminal workspace and the mobile drill-down stack.
- agent-workbench-dock-view.tsx owns the narrow sidebar helper and its summary and link actions.
- agent-workbench-session-list.tsx implements six grouping dimensions, collapsible groups, search, unread markers, fixed-height virtualization (54px desktop rows, 84px touch rows, 30px group headers) and keyboard navigation; each row carries the chat anchor plus 定位/终端 actions (no row-level takeover — that entry lives in the terminal pane titlebar).
- agent-workbench-panes.tsx provides TerminalPane, WebPane and WorkbenchInfo. The desktop workspace hosts a single TerminalPane; WebPane and WorkbenchInfo render as mobile drill-down pages. Chat stays a Feishu-controlled external surface and is never drawn in-page.
- agent-workbench-model.ts contains browser-safe routes, DTOs, grouping and attention/unread classification, layout clamps, responsive derivation and the terminal/preview href guards.
- agent-workbench-storage.ts persists versioned browser-local primitives only: per-session layout, shared rail prefs, the seen/unread ledger, the grouping dimension and collapsed group keys.
- agent-workbench-chat.ts builds the safe chat/open and web_app/open AppLinks and the H5 login URL. The legacy openWorkbenchChat JSAPI chain and lazy SDK loader remain as tested utilities, but no Workbench surface calls them.
- agent-workbench-api.ts strictly validates terminal-control, terminal view-link, Preview interaction and H5 context responses, and surfaces locate rate limits (429 retry-after) as typed errors.

The terminal pane is keyed by sessionId and control intent. Control and Preview mutations use monotonic request generations so an old response cannot overwrite an explicit Lock, a new session or an unmounted pane.

## Layout

- Rail: 300px default, 176–460px resize range, 40px collapsed width. Collapsing is the user's own choice at every desktop width (the toggle is offered at the ≥1280px full step); narrowing the window never force-collapses the list.
- Workspace: at most one Terminal pane, opened read-only from a row's 终端 button (which also demotes a taken-over pane back to read-only, then closes it) and closed from the workspace header; takeover happens in the pane titlebar (接管输入); while it is closed the session list fills the page. There is no in-page split, layout-level badge, info drawer or chat widget.
- Web preview: WebPane renders on the mobile 网页 page only. Desktop reaches the same /preview/<encoded-session-id>/ URL through the Dock's 网页链接 action or by opening it directly; that URL is the dashboard-origin guard shell, which enforces the overlay and frames the agent app in an opaque-origin sandbox.
- Desktop responsive steps full / rail-collapsed / focus / chat-jump derive at 1280/1120/960px and surface as data-responsive-step; with the single-terminal workspace and anchor-based chat they no longer change the page structure.
- Below 620px: the mobile drill-down stack. The session list is the home level and always renders in full; tapping a row pushes a detail surface with 终端/网页/信息 segments (网页 only when the session has a registered preview) and an explicit ‹ 会话列表 back control.

The CSS uses semantic dark/light tokens, no gradients, explicit pixel radii no larger than 4px, focus-visible outlines, non-color state chips, 44px-plus touch targets (84px touch rows) and reduced-motion handling.

## Chat

Chat never renders inside the Workbench. Every chat entry is a real anchor — target="_blank" rel="noopener", href from the session's feishuChatLink or a built /client/chat/open?openChatId=… AppLink. A trusted user click on that anchor is the one dispatch the Feishu client honours with its standard chat placement; scripted variants (window.open, synthetic .click(), enterChat) are demoted to the narrow attached container. No surface calls toggleChat or enterChat — the browser harness asserts zero SDK calls — and chat/open links carry no sidebar/width parameters.

Dock web_app AppLinks use mode=sidebar, min_width=350 and max_width=520. Full Workbench handoff uses mode=appCenter.

## Preview and Terminal

Terminal starts READ ONLY (只读). 接管输入 calls the server-authoritative lease API; release, expiry or write-WebSocket disconnect returns it to read-only. Control state is a single explicit machine — loading / taking-over / controlled / releasing / unknown — with separate epochs for observation polls and writes, so a 15s poll can never discard an in-flight write result, and a failed write lands in 未知 (masking the possibly-writable frame and re-reading the server) instead of optimistically claiming read-only.

Touch environments use the viewToken channel and hide the takeover control, because that channel carries no lease to take over. It is not unconditionally read-only: a verified platform owner opening a viewToken link still receives the signed WRITE grant the front proxy mints for that identity (#960), so the pane reports what the framed terminal page's ESTABLISHED WebSocket actually got (`wsHasWrite`, latched from an out-of-band first frame) rather than asserting "phones are read-only" — and it says *unknown* until that socket has spoken, because the page's own HTTP verdict is a separate authorization that an iOS WebView routinely fails to reproduce on the upgrade. Trusted platform owners have a fixed, always-writable role instead of a lease, so their rows collapse to a single 终端 toggle and never claim to open a read-only terminal.

Web accepts only the exact /preview/<encoded-session-id>/ descriptor for the selected session. It starts 预览 (PREVIEW), enters 可交互 (INTERACTIVE) only after explicit 开启交互, sends bounded activity updates and fails closed to Preview, relocking after 15 idle minutes. The visible security notice says the overlay prevents accidental interaction but is not an application security sandbox — the actual trust boundary is the opaque origin the app is framed in, which is what keeps it away from the dashboard DOM, cookies and management APIs.

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

The sidecar metrics report 320 sessions, 18 rendered virtual rows at the 54px row height, 2 group headers, the terminal chip in its writable「◆可输入」state and the full responsive step.

Two classes of browser evidence exist and they are not interchangeable:

- **component harness** — docs/assets/agent-workbench-browser-results.json (`harnessType: "component"`). The page under test is scripts/fixtures/agent-workbench-browser.tsx, which mounts the Workbench components directly with hardcoded sessions, auth state and capabilities. It proves component behavior and the server-module contracts it exercises; it does NOT exercise the production entry, the store bootstrap or the real auth flow.
- **production e2e** — docs/assets/workbench-production-e2e-results.json (`harnessType: "production-e2e"`). The page is the real esbuild output of src/dashboard/web/app.tsx, the identity is a real Feishu H5 session cookie, and the mobile run uses a real `hasTouch` device profile.
