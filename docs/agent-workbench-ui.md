# Agent Workbench UI

Status: implemented and browser-verified on `feat/agent-workbench`. Code-level verification is green, but final operational isolation is not accepted because this host's global wrapper and existing live daemons use the feature checkout; one audit-closeout build also regenerated that checkout's `dist`. The full integration, API, security, incident note and manual Feishu validation guide is in agent-workbench-implementation.md.

## Entry surfaces

| Surface | Hash route | Contract |
|---|---|---|
| Full Workbench | #/agent-workbench[/<encoded-session-id>] | Primary appCenter UI with Sessions, Terminal, Web, Info and native Chat controls. |
| Quick Dock | #/agent-workbench-dock[/<encoded-session-id>] | Standalone sidebar helper for widths of at least 350px; no pane tree or iframe. |

Both entries are lazy routes. The Dock route is matched before the Full route, so prefix matching cannot misclassify it. H5 login returnTo validation accepts only these normalized same-site route families.

Authenticated GET /api/workbench/h5-context exposes enabled, appId, brand and entryPath only. App Secret and the allowlist never cross this projection.

The client tracks local management authority separately from narrow Workbench authority. H5/platform identities can use the server-scoped Terminal and Preview leases without gaining Dashboard management controls; expected management 401s do not masquerade as an expired Workbench login.

## Components and state

- agent-workbench-view.tsx owns the full appCenter surface, responsive degradation, rail resize, per-session layout and native Chat bridge.
- agent-workbench-dock-view.tsx owns the narrow sidebar helper and appCenter/fallback actions.
- agent-workbench-session-list.tsx implements unread completion state, six grouping dimensions, collapsible groups, search, fixed desktop/touch row metrics and keyboard navigation over 300+ rows.
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

The CSS uses semantic dark/light tokens, no gradients, explicit pixel radii no larger than 4px, focus-visible outlines, non-color state labels, 44px mobile targets and reduced-motion handling.

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
| Workbench direct boundary | 23 files, 324 tests passed. |
| Model runner | Passed: 320 sessions, 22 virtual items and four responsive degradation steps. |
| Component runner | Passed: 9 checks and 14 rendered session options. |
| Browser harness | 12 scenarios passed across 1440×900, 1280×800, 390×844 and 375×800. |
| pnpm build | Passed; build id 17a04ba168ae. |
| Full unit project | Composite unique result: 962 files / 15,588 tests passed, 1 file / 16 tests skipped, 0 product failures. The sole nested-namespace timeout passed in a complete 33/33 normal-process-view file rerun. |

The authoritative full suite is run serially from an exact-source isolated checkout with a private PID view and short bind-mounted paths. An accidental feature-checkout build during this audit is recorded separately as an operational-isolation failure in the implementation guide. A normal, non-live checkout can use the ordinary commands:

~~~bash
pnpm exec vitest run --project unit test/agent-workbench-api.test.ts \
  test/agent-workbench-chat.test.ts \
  test/agent-workbench-components.test.ts \
  test/agent-workbench-model.test.ts \
  test/agent-workbench-preview-race.test.ts \
  test/agent-workbench-route.test.ts \
  test/agent-workbench-storage.test.ts \
  test/agent-workbench-style.test.ts \
  test/dashboard-auth.test.ts \
  test/dashboard-h5-auth.test.ts \
  test/dashboard-login-ui.test.ts \
  test/dashboard-preview-wiring.test.ts \
  test/dashboard-public-redact.test.ts \
  test/ipc-preview-route.test.ts \
  test/preview-cli.test.ts \
  test/preview-guard-page.test.ts \
  test/preview-interaction.test.ts \
  test/session-preview-proxy.test.ts \
  test/session-preview.test.ts \
  test/session-store.test.ts \
  test/terminal-control.test.ts \
  test/terminal-front-proxy.test.ts \
  test/worker-terminal-read-auth.integration.test.ts
pnpm exec tsc --noEmit
pnpm build
pnpm test -- --maxWorkers=1 --no-file-parallelism
pnpm exec tsx scripts/verify-agent-workbench-browser.ts
~~~

The final lazy chunks are agent-workbench-page-PFUFPODV.js (28,571 bytes) and agent-workbench-dock-page-4Y3L7XRK.js (3,947 bytes).

## Screenshot

The checked-in screenshot is docs/assets/agent-workbench-dark.png (1440×900). It uses synthetic data and local same-origin fixtures; it contains no credential or live session data.

The sidecar reports 320 sessions, 18 rendered virtual rows, split pane mode and full responsive state. Browser scenario evidence is in docs/assets/agent-workbench-browser-results.json.
