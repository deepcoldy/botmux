# Dashboard per-chat Pin override implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a safe Group Manage control for the existing per-chat streaming-card Pin override.

**Architecture:** A daemon publishes and mutates authoritative chat policy through narrow IPC. Dashboard aggregates those fields, proxies writes, and uses one shared Pin toggle presentation on the Bot Defaults and Group Manage surfaces.

**Tech Stack:** TypeScript, React, Node HTTP, Vitest, Bun 1.4.0.

## Global Constraints

- pinStreamingCard stays default-off and only literal true enables it.
- Per-chat state is a negative override and cannot force-enable the master.
- Reuse setChatStreamingCardPin; Dashboard never writes bots.json directly.
- Anonymous group payloads never expose Pin configuration.
- Use TDD and commit/push each independently reviewable task.

---

### Task 1: Daemon group policy contract

**Files:** src/core/dashboard-ipc-server.ts; test/dashboard-ipc.test.ts

**Interfaces:** Consume setChatStreamingCardPin. Produce three group-row booleans and PUT /api/chat-pin-streaming-card/:chatId.

- [ ] Add failing row-state tests for master/chat/effective combinations.
- [ ] Add failing PUT tests for success, malformed body, and store failure.
- [ ] Implement the row projection and narrow route.
- [ ] Run the focused test, commit feat(dashboard): 暴露按群实时卡片置顶策略, and push.

### Task 2: Dashboard aggregation and real proxy

**Files:** src/dashboard.ts; src/dashboard/groups-action-helpers.ts; src/dashboard/public-redact.ts; related helper, HTTP-route, aggregation, and redaction tests.

**Interfaces:** Consume Task 1 fields/route. Produce PUT /api/groups/:chatId/pin-streaming-card/:appId and populated memberBots fields.

- [ ] Add a failing real HTTP route test for exact decoding/body forwarding/status preservation/cache invalidation.
- [ ] Add failing aggregation and anonymous-redaction assertions.
- [ ] Implement one action helper, external route, and field propagation.
- [ ] Run focused tests, commit feat(dashboard): 代理按群实时卡片置顶配置, and push.

### Task 3: Shared toggle and Group Manage UI

**Files:** create src/dashboard/web/streaming-card-pin-toggle.tsx; modify bot-defaults-page.tsx, groups-api.ts, groups-page.tsx, i18n.ts, style.css; add UI tests.

**Interfaces:** Consume GroupMemberBot policy fields and Task 2 proxy. Produce a shared accessible Pin toggle and per-bot Group Manage row.

- [ ] Add failing tests for on/off/master-off presentation and interaction.
- [ ] Implement shared toggle and replace the Bot Defaults inline Pin toggle.
- [ ] Implement Group Manage rows, localized text, exact PUT, rollback, and force reload.
- [ ] Run UI tests, the existing Bot Defaults tests, Bun build, and diff check.
- [ ] Commit feat(dashboard): 添加群级实时卡片置顶开关 and push.
