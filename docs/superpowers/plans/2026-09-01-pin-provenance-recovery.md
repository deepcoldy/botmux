# Streaming-card Pin provenance recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Recover safe streaming-card Pin ownership from Feishu for restart and disable cleanup.

**Architecture:** A strict paginated Lark wrapper returns raw Pin provenance. Worker-pool freezes local candidates, intersects them with same-app records in the existing per-bot FIFO, then reuses per-message mutation queues for restore or cleanup.

**Tech Stack:** TypeScript, Lark Node SDK, Vitest, Bun 1.4.0.

## Global Constraints

- Authorization requires a frozen local candidate and exact same-app operator provenance.
- Never infer provenance from author, content, or message-id shape.
- Discovery augments existing transition authority; list failure cannot suppress it.
- Startup/configuration remain non-blocking and fail-open.
- apiOnly/HTTP virtual/no-transport paths make zero Pin API calls.
- Reuse existing per-bot FIFO, per-message queues, and batch size 20.
- Use TDD and commit/push each independently reviewable task.

---

### Task 1: Paginated Lark Pin list wrapper

**Files:** src/im/lark/client.ts; test/lark-pin-message.test.ts

**Interfaces:** Produce LarkPinRecord and listChatPins(larkAppId, chatId): Promise<LarkPinRecord[]>.

- [ ] Add failing tests for exact first/next payload and normalized records.
- [ ] Add failing tests for non-zero/missing code, SDK errors, and missing/repeated token.
- [ ] Implement strict explicit pagination with page size 50.
- [ ] Run focused tests, commit feat(card): 封装群内 Pin 来源分页查询, and push.

### Task 2: Provenance-aware worker reconciliation

**Files:** src/core/worker-pool.ts; test/streaming-card-pinning.test.ts; close test only if needed.

**Interfaces:** Consume listChatPins. Produce reconcileRestoredStreamingCardPins(larkAppId): void.

- [ ] Add failing restart recovery and operator/candidate filtering tests.
- [ ] Add failing tests for one list per chat, partial failure, no-transport, and FIFO ordering.
- [ ] Extend reconcile requests with frozen candidates and remote-discovery intent while preserving existing cleanup authority.
- [ ] Implement per-chat discovery, exact intersection, enabled ownership restore, and disabled cleanup.
- [ ] Add the maintainer-requested comment for opt-out exclusion and remote-proof retry.
- [ ] Run Pin/close/transfer/worker-ready tests, commit feat(card): 恢复重启后的 Pin 清理来源, and push.

### Task 3: Non-blocking startup wiring and docs

**Files:** src/daemon.ts; create test/pin-streaming-card-recovery-wiring.test.ts; update English/Chinese cards and bots-json docs.

**Interfaces:** Consume reconcileRestoredStreamingCardPins.

- [ ] Add a failing wiring test proving scheduling occurs after restore without delaying readiness.
- [ ] Wire one fire-and-forget recovery for the current daemon bot.
- [ ] Document same-app Pin-list recovery and strict local-id intersection.
- [ ] Run the focused Pin matrix, Bun build, and diff check.
- [ ] Commit docs(card): 说明 Pin 来源恢复边界 and push.
