# Streaming-card Pin provenance recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Recover safe streaming-card Pin ownership from Feishu for restart and disable cleanup.

**Architecture:** A strict paginated Lark wrapper returns raw Pin provenance. Worker-pool freezes local candidates, intersects them with same-app records in the existing per-bot FIFO, then reuses per-message mutation queues for restore or cleanup.

**Tech Stack:** TypeScript, Lark Node SDK, Vitest, Bun 1.4.0.

## Global Constraints

- Authorization requires a frozen local candidate and exact same-app operator provenance.
- Successful create status is insufficient: the returned Pin must repeat the requested message id and exact same-app provenance.
- Never infer provenance from author, content, or message-id shape.
- Every Unpin requires fresh exact same-app proof immediately before deletion; list failure skips all destructive cleanup.
- Ordinary disable, close, and transfer target process-owned ids only, then revalidate them remotely before Unpin.
- Recovery discovery and immediate pre-delete validation are separate lists; Feishu's unconditional Unpin leaves a residual post-list API race.
- Startup/configuration remain non-blocking and fail-open.
- apiOnly/HTTP virtual/no-transport paths make zero Pin API calls.
- Reuse existing per-bot FIFO and per-message queues; cap actual Pin/Unpin mutations at 20 process-wide, with destructive cleanup re-proven in waves of at most 20.
- Use TDD and commit/push each independently reviewable task.

---

### Task 1: Paginated Lark Pin list wrapper

**Files:** src/im/lark/client.ts; test/lark-pin-message.test.ts

**Interfaces:** Produce LarkPinRecord, pinMessage(larkAppId, messageId): Promise<LarkPinRecord | null>, and listChatPins(larkAppId, chatId): Promise<LarkPinRecord[]>.

- [ ] Add failing tests for exact first/next payload and normalized records.
- [ ] Add failing tests for non-zero/missing code, SDK errors, and missing/repeated token.
- [ ] Implement strict explicit pagination with page size 50.
- [ ] Return normalized create-response provenance instead of a success boolean.
- [ ] Run focused tests, commit feat(card): 封装群内 Pin 来源分页查询, and push.

### Task 2: Provenance-aware worker reconciliation

**Files:** src/core/worker-pool.ts; test/streaming-card-pinning.test.ts; close test only if needed.

**Interfaces:** Consume listChatPins. Produce reconcileRestoredStreamingCardPins(larkAppId): void.

- [ ] Add failing restart recovery and operator/candidate filtering tests.
- [ ] Add failing current-collision, list-to-create race, ordinary disable, close, transfer, and explicit bot/chat off tests.
- [ ] Add failing tests for one discovery list per chat plus fresh pre-delete validation, partial failure, no-transport, and FIFO ordering.
- [ ] Extend reconcile requests with frozen candidates, process-owned ids, and remote-discovery intent.
- [ ] Implement per-chat discovery, exact intersection, enabled ownership restore without duplicate create, provenance-checked create, and disabled cleanup.
- [ ] Keep restored-worker silent ready from independently re-pinning before the list proof completes.
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
