/**
 * Source-level guard for the raw_input + follow-up ATOMIC delivery contract
 * (PR #157 review blocker, round 2).
 *
 * Why source-level: worker.ts is a process script with no exports, so its
 * IPC handler can't be unit-tested directly. The race it guards against:
 * `process.on('message', async ...)` handlers do NOT serialize — the
 * raw_input branch awaits 200ms between sendText and Enter, and a separate
 * `message` IPC handled in that window writes into the PTY first (type-ahead
 * adapters flush immediately), interleaving the follow-up into the slash
 * command. The fix makes the follow-up ride on the raw_input IPC itself and
 * the worker enqueue it strictly after the Enter.
 *
 * Daemon-side single-IPC behavior is covered in
 * test/worker-ready-display-mode.test.ts; this file pins the worker-side
 * ordering and the daemon-side "never a second IPC" structure in source.
 *
 * Run: pnpm vitest run test/raw-input-followup-atomicity.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSrc = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8');
const poolSrc = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf-8');

function caseRegion(src: string, marker: string, span = 3000): string {
  const start = src.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThanOrEqual(0);
  return src.slice(start, start + span);
}

describe('worker raw_input handler', () => {
  const region = caseRegion(workerSrc, "case 'raw_input':");

  it('queues through an owned restart until the replacement prompt, while preserving normal busy delivery', () => {
    const gateIdx = region.indexOf(
      'if (cliRestartInProgress || rawInputRestartGate || sessionRenameInFlight',
    );
    const queueIdx = region.indexOf('freshnessInputQueue.enqueueRaw(msg)');
    const deliverIdx = region.indexOf('await deliverRawInput(msg)');

    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(queueIdx).toBeGreaterThan(gateIdx);
    expect(deliverIdx).toBeGreaterThan(queueIdx);
    // isPromptReady is false while an active CLI is busy, so gating on it would
    // break /btw-style passthrough. The restart-only latch preserves that path.
    expect(region).not.toContain('isPromptReady');
    expect(region).not.toContain('sendRawCommandLine(');
  });

  it('also defers behind the TUI injection fence: mid-injection (injectionFlushing) and queued cwd barrier (shouldDeferUserFlush) both queue instead of busy-delivering', () => {
    // PR #441 二审阻塞项：raw_input 曾绕过注入 barrier——/cd 注入的 quiescence
    // 等待期间（Serially 只互斥 text→Enter 短窗口）或 barrier 尚未开始时，
    // passthrough 会直送、执行在旧 cwd 的 CLI 里。两个围栏必须与 restart/rename
    // 同在入队条件里。
    const gate = region.slice(
      region.indexOf('if (cliRestartInProgress'),
      region.indexOf('freshnessInputQueue.enqueueRaw(msg)'),
    );
    expect(gate).toContain('injectionFlushing');
    expect(gate).toContain('shouldDeferUserFlush(pendingInjections)');
  });

  it('also defers across the bounded launch-settle window and while the bare-shell hold is active', () => {
    // PR #570 二审阻塞项：detectBareShellLaunch() 采到裸 shell 后 await
    // settleLaunchComm() 让出事件循环最长 2s；IPC handler 不串行，raw_input
    // 若在此窗口放行会打进尚未 `exec <cli>` 的临时 shell。isFlushing 挡不住它
    // （raw_input 刻意保留 busy 直送）——须用专用 bareShellCheckInProgress latch
    // 覆盖“检查进行中”，并用 bareShellLaunchBlocked 覆盖“仍停在裸 shell”。
    const gate = region.slice(
      region.indexOf('if (cliRestartInProgress'),
      region.indexOf('freshnessInputQueue.enqueueRaw(msg)'),
    );
    expect(gate).toContain('bareShellCheckInProgress');
    expect(gate).toContain('bareShellLaunchBlocked');

    // The latch must be held ACROSS the settle await (set before, cleared in a
    // finally), otherwise the raw gate's check races the window it guards.
    const detect = caseRegion(workerSrc, 'async function detectBareShellLaunch()', 1400);
    const set = detect.indexOf('bareShellCheckInProgress = true');
    const await_ = detect.indexOf('await settleLaunchComm(', set);
    const clear = detect.indexOf('bareShellCheckInProgress = false', await_);
    const finallyIdx = detect.lastIndexOf('finally', clear);
    expect(set).toBeGreaterThanOrEqual(0);
    expect(await_).toBeGreaterThan(set);
    expect(clear).toBeGreaterThan(await_);
    expect(finallyIdx).toBeGreaterThan(await_);
    expect(finallyIdx).toBeLessThan(clear);
  });
});

describe('worker raw_input delivery', () => {
  const region = caseRegion(workerSrc, 'async function deliverRawInput', 2600);

  it('enqueues followUpContent strictly AFTER the awaited command send (incl. Enter)', () => {
    const sendIdx = region.indexOf('await sendRawCommandLineSerially(targetBackend, msg.content)');
    const followIdx = region.indexOf('msg.followUpContent');
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThan(sendIdx);
  });

  it('routes the follow-up through sendToPty (normal busy-queue semantics)', () => {
    expect(region).toContain('sendToPty(msg.followUpContent, msg.followUpTurnId, {');
    expect(region).toContain('codexAppInput: msg.followUpCodexAppInput');
  });

  it('rotates or revokes the marker immediately before writing the raw command', () => {
    const bindIdx = region.indexOf('currentBotmuxTurnId = msg.turnId');
    const markerIdx = region.indexOf('writeCliPidMarker()');
    const capabilityIdx = region.indexOf('publishSandboxRelayCapability()');
    const sendIdx = region.indexOf('await sendRawCommandLineSerially(targetBackend, msg.content)');
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeGreaterThan(bindIdx);
    expect(capabilityIdx).toBeGreaterThan(markerIdx);
    expect(sendIdx).toBeGreaterThan(capabilityIdx);
  });

  it('holds ordinary prompt flushes only for the text-to-Enter critical window', () => {
    const flush = caseRegion(workerSrc, 'async function flushPending()', 9000);
    expect(flush).toContain('if (commandLineWritesPending > 0) return');
    expect(region).not.toContain('if (!isPromptReady)');
    expect(region).not.toContain('if (isPromptReady)');
  });

  it('surfaces an ambiguous terminal and user notice when the literal command write fails', () => {
    const catchIdx = region.indexOf('catch (err');
    const terminalIdx = region.indexOf(
      "emitTurnTerminal(failedTurnId, 'ambiguous', 'raw_input_write_failed')",
      catchIdx,
    );
    const notifyIdx = region.indexOf("type: 'user_notify'", catchIdx);

    expect(catchIdx).toBeGreaterThanOrEqual(0);
    expect(terminalIdx).toBeGreaterThan(catchIdx);
    expect(notifyIdx).toBeGreaterThan(terminalIdx);
  });
});

describe('worker command-line write mutex', () => {
  const serialized = caseRegion(workerSrc, 'async function sendRawCommandLineSerially', 1200);

  it('serializes concurrent raw command keystrokes without waiting for turn idle', () => {
    expect(serialized).toContain('const previous = commandLineWriteTail');
    expect(serialized).toContain('commandLineWritesPending += 1');
    expect(serialized).toContain('await previous');
    expect(serialized).toContain('await sendRawCommandLine(be, content)');
    expect(serialized).toContain('release()');
  });
});

describe('worker sendRawCommandLine helper', () => {
  const helper = caseRegion(workerSrc, 'async function sendRawCommandLine', 3000);

  it('generic CLIs: literal text → 200ms beat → Enter in order (slash-picker safe)', () => {
    const textIdx = helper.indexOf('sendText(content)');
    expect(textIdx).toBeGreaterThanOrEqual(0);
    // Anchor the beat/Enter lookups AFTER the text write so the CoCo branch's own
    // 200ms beat (which precedes the generic path) can't be mistaken for this one.
    const beatIdx = helper.indexOf('setTimeout(r, 200)', textIdx);
    const enterIdx = helper.indexOf("sendSpecialKeys('Enter')", beatIdx);
    expect(beatIdx).toBeGreaterThan(textIdx);
    expect(enterIdx).toBeGreaterThan(beatIdx);
  });

  it('CoCo: types char-by-char (throttled) before a single Enter (paste-coalescing safe)', () => {
    const cocoIdx = helper.indexOf("cliId === 'coco'");
    expect(cocoIdx, 'CoCo branch present').toBeGreaterThanOrEqual(0);
    const genericTextIdx = helper.indexOf('sendText(content)');
    // The CoCo branch fully precedes the generic one-shot path.
    expect(cocoIdx).toBeLessThan(genericTextIdx);
    // Per-char keystrokes spaced by the throttle — a one-shot write coalesces into
    // a paste on CoCo, which skips command mode + the slash picker.
    const charIdx = helper.indexOf('sendText(ch)', cocoIdx);
    const throttleIdx = helper.indexOf('COCO_SLASH_TYPE_THROTTLE_MS', cocoIdx);
    expect(charIdx).toBeGreaterThan(cocoIdx);
    expect(charIdx).toBeLessThan(genericTextIdx);
    expect(throttleIdx).toBeGreaterThan(cocoIdx);
    // Exactly one Enter, after the beat (a stray 2nd Enter would confirm a /model
    // selector pick); the branch returns immediately after.
    const cocoEnterIdx = helper.indexOf("sendSpecialKeys('Enter')", throttleIdx);
    const returnIdx = helper.indexOf('return;', throttleIdx);
    expect(cocoEnterIdx).toBeGreaterThan(throttleIdx);
    expect(cocoEnterIdx).toBeLessThan(genericTextIdx);
    expect(returnIdx).toBeGreaterThan(cocoEnterIdx);
    expect(returnIdx).toBeLessThan(genericTextIdx);
  });

  it('fails before Enter when a backend explicitly rejects the generic text write', () => {
    const textIdx = helper.indexOf('sendText(content)');
    const rejectionIdx = helper.indexOf("throw new Error('backend rejected command text input')", textIdx);
    const beatIdx = helper.indexOf('setTimeout(r, 200)', textIdx);
    const enterIdx = helper.indexOf("sendSpecialKeys('Enter')", textIdx);

    expect(helper.slice(textIdx - 30, rejectionIdx)).toContain('=== false');
    expect(rejectionIdx).toBeGreaterThan(textIdx);
    expect(rejectionIdx).toBeLessThan(beatIdx);
    expect(rejectionIdx).toBeLessThan(enterIdx);
  });

  it('stops CoCo typing immediately on rejection and also checks the submit key', () => {
    const cocoIdx = helper.indexOf("cliId === 'coco'");
    const charIdx = helper.indexOf('sendText(ch)', cocoIdx);
    const charRejectionIdx = helper.indexOf("throw new Error('backend rejected command text input')", charIdx);
    const throttleIdx = helper.indexOf('COCO_SLASH_TYPE_THROTTLE_MS', charIdx);
    const enterIdx = helper.indexOf("sendSpecialKeys('Enter')", throttleIdx);
    const enterRejectionIdx = helper.indexOf("throw new Error('backend rejected command submit key')", enterIdx);

    expect(helper.slice(charIdx - 30, charRejectionIdx)).toContain('=== false');
    expect(charRejectionIdx).toBeGreaterThan(charIdx);
    expect(charRejectionIdx).toBeLessThan(throttleIdx);
    expect(helper.slice(enterIdx - 30, enterRejectionIdx)).toContain('=== false');
    expect(enterRejectionIdx).toBeGreaterThan(enterIdx);
  });
});

describe('daemon prompt_ready dispatch', () => {
  const region = caseRegion(poolSrc, "case 'prompt_ready':", 2000);

  it('bundles the follow-up onto the raw_input IPC instead of a second message IPC', () => {
    expect(region).toContain('followUpContent: followUp?.cliInput');
    // A separate `message` IPC here would reopen the race — must not exist.
    expect(region).not.toContain("type: 'message'");
  });
});

describe('post-settle restart fence', () => {
  // PR #570 三审阻塞项:detectBareShellLaunch() 的 settle await 会让出事件循环
  // 最长 2s;tmux restart 的 250–1999ms jitter 期间 cliRestartInProgress 已 true
  // 而旧 backend 仍存活。两条持锁 flush(message / injection)在 await 返回后只
  // 复查 backend(jitter 内非 null),不复查 restart fence,会把输入写进即将销毁的
  // 旧 CLI。改前 detector 同步、入口 restart check 与写入间无让出,故是本次
  // async 化扩出的第二个窗口。三处 source-level 顺序断言钉死修复。

  it('flushPending re-checks cliRestartInProgress AFTER the awaited detector, BEFORE any write', () => {
    const flush = caseRegion(workerSrc, 'async function flushPending()', 15000);
    const detector = flush.indexOf('if (await detectBareShellLaunch())');
    const fence = flush.indexOf('if (cliRestartInProgress) return;', detector);
    const startup = flush.indexOf('await runStartupCommands()', detector);
    const rawShift = flush.indexOf('freshnessInputQueue.takeRaw()', detector);
    const writeStructuredInput = flush.indexOf('cliAdapter.writeStructuredInput(', detector);
    const writeInput = flush.indexOf('cliAdapter.writeInput(', detector);
    expect(detector).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(detector);
    // Fence must precede every downstream write/shift the settle await exposed.
    expect(startup).toBeGreaterThan(fence);
    expect(rawShift).toBeGreaterThan(fence);
    expect(writeStructuredInput).toBeGreaterThan(fence);
    expect(writeInput).toBeGreaterThan(fence);
  });

  it('flushPendingInjections re-checks cliRestartInProgress AFTER the awaited detector, BEFORE the shift', () => {
    const inj = caseRegion(workerSrc, 'async function flushPendingInjections()', 3000);
    const detector = inj.indexOf('if (await detectBareShellLaunch()) return');
    const fence = inj.indexOf('if (cliRestartInProgress) return;', detector);
    const shift = inj.indexOf('pendingInjections.shift()', detector);
    expect(detector).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(detector);
    expect(shift).toBeGreaterThan(fence);
  });

  it('detectBareShellLaunch skips bare-shell classification when a restart began during settle', () => {
    const detect = caseRegion(workerSrc, 'async function detectBareShellLaunch()', 2400);
    const settle = detect.indexOf('await settleLaunchComm(');
    const restartCheck = detect.indexOf('if (cliRestartInProgress) return false;', settle);
    const classify = detect.indexOf('isBareShellComm(comm)', restartCheck);
    const block = detect.indexOf('bareShellLaunchBlocked = true', restartCheck);
    expect(settle).toBeGreaterThanOrEqual(0);
    // The restart short-circuit must sit after the await and before the
    // bare-shell verdict / persistent block, so a torn-down pane isn't
    // misdiagnosed as a failed launch.
    expect(restartCheck).toBeGreaterThan(settle);
    expect(classify).toBeGreaterThan(restartCheck);
    expect(block).toBeGreaterThan(restartCheck);
  });
});

describe('late bare-shell launch recovery', () => {
  it('releases the launch block only after PTY readiness and a non-shell pane leaf', () => {
    const helper = caseRegion(workerSrc, 'function recoverBareShellLaunchFromPty(observedBackend:', 1600);
    const generationFence = helper.indexOf('if (backend !== observedBackend)');
    const read = helper.indexOf('readPaneLeafComm(observedBackend)');
    const rejectBare = helper.indexOf('if (!comm || isBareShellComm(comm))', read);
    const release = helper.indexOf('bareShellLaunchBlocked = false', rejectBare);

    expect(generationFence).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(generationFence);
    expect(rejectBare).toBeGreaterThan(read);
    expect(release).toBeGreaterThan(rejectBare);

    const ptyReady = caseRegion(workerSrc, 'function markPromptReadyFromPty(observedBackend:', 600);
    const recover = ptyReady.indexOf('if (!recoverBareShellLaunchFromPty(observedBackend)) return;');
    const mark = ptyReady.indexOf('markPromptReady()', recover);
    expect(recover).toBeGreaterThanOrEqual(0);
    expect(mark).toBeGreaterThan(recover);
  });

  it('turns an injection-first shell verdict back into a non-ready state', () => {
    const detect = caseRegion(workerSrc, 'async function detectBareShellLaunch()', 4300);
    const block = detect.indexOf('bareShellLaunchBlocked = true');
    const clearReady = detect.indexOf('isPromptReady = false', block);
    const resetIdle = detect.indexOf('idleDetector?.reset()', clearReady);
    const notify = detect.indexOf("type: 'user_notify'", resetIdle);

    expect(block).toBeGreaterThanOrEqual(0);
    expect(clearReady).toBeGreaterThan(block);
    expect(resetIdle).toBeGreaterThan(clearReady);
    expect(notify).toBeGreaterThan(resetIdle);
  });

  it('generation-fences PTY data before it can feed the active idle detector', () => {
    const wiring = caseRegion(workerSrc, 'const observedBackend = backend;', 2300);
    const onData = wiring.indexOf('observedBackend.onData((data) =>');
    const fence = wiring.indexOf('if (backend !== observedBackend) return;', onData);
    const feed = wiring.indexOf('onPtyData(data)', fence);
    const ptyReady = wiring.indexOf('markPromptReadyFromPty(observedBackend)');

    expect(onData).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(onData);
    expect(feed).toBeGreaterThan(fence);
    expect(ptyReady).toBeGreaterThanOrEqual(0);
  });

  it('keeps non-PTY ready sources from stranding a blocked launch', () => {
    const markReady = caseRegion(workerSrc, 'function markPromptReady(): void', 900);
    const block = markReady.indexOf('if (bareShellLaunchBlocked)');
    const duplicateReadyGuard = markReady.indexOf('if (isPromptReady) return', block);
    expect(block).toBeGreaterThanOrEqual(0);
    expect(duplicateReadyGuard).toBeGreaterThan(block);
  });

  it('reports an unresolved same-shell launch as delayed instead of naming stale causes', () => {
    const detect = caseRegion(workerSrc, 'async function detectBareShellLaunch()', 5200);
    expect(detect).toContain('启动时间较长');
    expect(detect).toContain('检测到真实输入框后会自动继续投递');
    expect(detect).toContain('仅凭进程仍是');
    expect(detect).not.toContain('Oh My Zsh 升级提示');
    expect(detect).not.toContain('GIT_TERMINAL_PROMPT');
    expect(detect).not.toContain('可执行文件不在 PATH');
    expect(detect).toContain('turnId: pendingTurn?.turnId ?? currentBotmuxTurnId');
    expect(detect).toContain('dispatchAttempt: pendingTurn?.dispatchAttempt ?? currentBotmuxDispatchAttempt');
  });
});
