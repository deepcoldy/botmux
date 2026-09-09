# Subagent Wait Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Botmux from showing DONE/complete while a parent coding agent is interactable but still waiting for active child agents.

**Architecture:** Extend Claude-family busy evidence with the structured active-task row rendered by Claude Code. Preserve Codex and TraeX structured terminal authority and add regression guards proving screen idle alone cannot terminate their turns.

**Tech Stack:** TypeScript, Vitest, existing CLI adapters and IdleDetector.

---

### Task 1: Claude-family active subagent signal

**Files:**
- Modify: `test/cli-adapters.test.ts`
- Modify: `src/adapters/cli/claude-code.ts:586-594,1195-1214`

- [ ] Add failing tests to the existing `busyPattern` describe block:

```ts
it('claude-code treats active task-panel agents as busy but ignores non-running rows and prose', () => {
  const claude = createCliAdapterSync('claude-code');
  const busy = claude.busyPattern!;
  expect(busy.test('  ◯ Explore  Checking plugin aliases              6m 8s · ↓ 3.5k tokens')).toBe(true);
  expect(busy.test('  ◯ reviewer  Inspecting edge cases              42s · ↑ 810 tokens')).toBe(true);
  expect(busy.test('  ✔ Explore  Checking plugin aliases')).toBe(false);
  expect(busy.test('  ◻ Explore  Checking plugin aliases')).toBe(false);
  expect(busy.test('The symbol ◯ and 6m 8s are examples in this paragraph.')).toBe(false);
  expect(createCliAdapterSync('seed').busyPattern!.source).toBe(busy.source);
  expect(createCliAdapterSync('relay').busyPattern!.source).toBe(busy.source);
});
```

- [ ] Run `./node_modules/.bin/vitest run --project unit test/cli-adapters.test.ts` and confirm the active rows fail.

- [ ] Add a narrowly anchored task-row arm and compose it with the existing footer arm:

```ts
const CLAUDE_ACTIVE_AGENT_ROW_RE = /^\s*◯\s+\S(?:.*\S)?\s{2,}\d+(?:h|m|s)(?:\s+\d+(?:m|s))?\s*(?:·\s*[↓↑]\s*[\d.]+[kKmM]?\s+tokens)?\s*$/m;
const CLAUDE_BUSY_PATTERN = new RegExp(
  `${CLAUDE_BUSY_FOOTER_RE.source}|${CLAUDE_ACTIVE_AGENT_ROW_RE.source}`,
  'm',
);
```

Assign `CLAUDE_BUSY_PATTERN` to both `busyPattern` and `idleToBusyPattern`. Keep `CLAUDE_BUSY_FOOTER_RE` unchanged so existing footer tests remain meaningful.

- [ ] Re-run the adapter test and confirm pass.

### Task 2: IdleDetector aggregate-state regression

**Files:**
- Modify: `test/idle-detector.test.ts`

- [ ] Add a test using the real Claude adapter that feeds a composer plus an active agent row, advances fake timers beyond quiescence, and asserts no idle callback.

```ts
const cli = createCliAdapterSync('claude-code');
const detector = new IdleDetector(cli);
const onIdle = vi.fn();
detector.onIdle(onIdle);
detector.feed('❯\n  ◯ Explore  Checking aliases  6m 8s · ↓ 3.5k tokens');
await vi.advanceTimersByTimeAsync(5_000);
expect(onIdle).not.toHaveBeenCalled();
```

Then feed a redraw containing only the idle composer and assert idle after the normal quiescence window.

- [ ] Run `./node_modules/.bin/vitest run --project unit test/idle-detector.test.ts`; confirm RED before changing detector code.

- [ ] If the test stays RED after Task 1 because `busyPattern` is only checked in worker viewport probes, add no generic detector behavior. Instead add a focused worker busy-probe test using the existing worker test harness. Do not make every `busyPattern` a static latch: Codex/TraeX already separate static queue semantics explicitly.

- [ ] Run the resulting focused test and confirm pass.

### Task 3: Codex and TraeX completion contracts

**Files:**
- Modify: `test/cli-adapters.test.ts`
- Modify: an existing structured-terminal test such as `test/worker-turn-terminal-contract.test.ts` or the closest current equivalent found by `rg reliableTurnTerminal test`.

- [ ] Add adapter assertions:

```ts
expect(createCliAdapterSync('codex').reliableTurnTerminal).toBe(true);
expect(createCliAdapterSync('traex').reliableTurnTerminal).toBe(true);
```

- [ ] Add/extend a worker test proving that, for a reliable-terminal adapter, a screen idle while the structured turn is unfinished does not emit completion/DONE, and the later `turn_terminal` does.

- [ ] Run the focused structured lifecycle tests and confirm pass. If existing tests already prove the exact behavior, document the test names in the PR rather than duplicate them.

- [ ] Do not change Codex/TraeX production patterns unless this test exposes an actual premature terminal.

### Task 4: Verification and PR update

**Files:**
- Modify PR metadata only after code verification.

- [ ] Run:

```bash
./node_modules/.bin/vitest run --project unit \
  test/cli-adapters.test.ts \
  test/idle-detector.test.ts \
  test/turn-reactions.test.ts \
  test/worker-ready-display-mode.test.ts
bun run build
git diff --check
```

- [ ] Commit implementation with:

```bash
git add src/adapters/cli/claude-code.ts test/cli-adapters.test.ts test/idle-detector.test.ts <structured-terminal-test>
git commit -m "fix(adapter): 子代理运行期间保持任务工作态

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] Merge latest `origin/master` into the feature branch, rerun focused tests and build, then push.

- [ ] Update PR #956 title/body to cover the worktree lifecycle, PM2 safety fix, passthrough reactions, and subagent-wait status; include exact verification and known unrelated local-suite failures.

- [ ] Wait for all GitHub checks to complete successfully, then change Draft to Ready for review and report remaining approval requirements.
