/**
 * raw_input / literal slash-command delivery.
 *
 * Behaviour of the literal command writer (src/core/raw-command-writer.ts) is
 * exercised directly below. The adopt queue/composer ordering contract lives in
 * test/async-serial-queue.test.ts (runAdoptRawInputSequence), and the daemon
 * bundling the follow-up ONTO the raw_input IPC is covered behaviourally in
 * test/worker-ready-display-mode.test.ts. Background on that race:
 * `process.on('message', async ...)` handlers do NOT serialize — the raw_input
 * branch awaits ~200ms between the text and Enter, so a second `message` IPC
 * handled in that window could interleave its text into the slash command.
 *
 * The two source guards at the bottom pin input fences that only exist inside
 * worker.ts, a process script with no exports.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  finalizeRawCommandDelivery,
  writeRawCommandLine,
} from '../src/core/raw-command-writer.js';

describe('raw command backend acceptance', () => {
  const immediateDelay = vi.fn(async () => {});

  it('uses pasteText before Enter when pasteLine is enabled', async () => {
    const calls: string[] = [];
    const write = vi.fn(() => true);
    const sendText = vi.fn((text: string) => {
      calls.push(`sendText:${text}`);
      return true;
    });
    const pasteText = vi.fn((text: string) => {
      calls.push(`pasteText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });
    const fake = { supportsRawCommandPasteLine: true, write, sendText, sendSpecialKeys, pasteText };
    const pasteLineOptions = { pasteLine: true, pasteSettleMs: 300, delay };

    await expect(writeRawCommandLine(
      fake,
      '/mr-review-team 127',
      pasteLineOptions,
    )).resolves.toBe(true);

    expect(pasteText).toHaveBeenCalledOnce();
    expect(pasteText).toHaveBeenCalledWith('/mr-review-team 127');
    expect(sendText).not.toHaveBeenCalled();
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(delay).toHaveBeenCalledWith(300);
    expect(calls).toEqual([
      'pasteText:/mr-review-team 127',
      'delay:300',
      'sendSpecialKeys:Enter',
    ]);
  });

  it('falls back to sendText when pasteLine is enabled but the backend has no paste-line contract', async () => {
    const calls: string[] = [];
    const write = vi.fn(() => true);
    const sendText = vi.fn((text: string) => {
      calls.push(`sendText:${text}`);
      return true;
    });
    const pasteText = vi.fn((text: string) => {
      calls.push(`pasteText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });
    const fake = { write, sendText, sendSpecialKeys, pasteText };

    await expect(writeRawCommandLine(
      fake,
      '/mr-review-team 127',
      { pasteLine: true, pasteSettleMs: 300, delay },
    )).resolves.toBe(true);

    expect(pasteText).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('/mr-review-team 127');
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(calls).toEqual([
      'sendText:/mr-review-team 127',
      'delay:200',
      'sendSpecialKeys:Enter',
    ]);
  });

  it('falls back to sendText plus Enter when pasteLine is enabled without pasteText', async () => {
    const calls: string[] = [];
    const write = vi.fn(() => true);
    const sendText = vi.fn((text: string) => {
      calls.push(`sendText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });
    const fake = { write, sendText, sendSpecialKeys };
    const pasteLineOptions = { pasteLine: true, pasteSettleMs: 300, delay };

    await expect(writeRawCommandLine(
      fake,
      '/mr-review-team 127',
      pasteLineOptions,
    )).resolves.toBe(true);

    expect(sendText).toHaveBeenCalledWith('/mr-review-team 127');
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(calls).toEqual([
      'sendText:/mr-review-team 127',
      'delay:200',
      'sendSpecialKeys:Enter',
    ]);
  });

  it('uses pasteText with Enter when pasteLine is enabled even without sendText', async () => {
    const calls: string[] = [];
    const write = vi.fn(() => {
      calls.push('write');
      return true;
    });
    const pasteText = vi.fn((text: string) => {
      calls.push(`pasteText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });
    const fake = { supportsRawCommandPasteLine: true, write, sendSpecialKeys, pasteText };

    await expect(writeRawCommandLine(
      fake,
      '/mr-review-team 127',
      { pasteLine: true, delay },
    )).resolves.toBe(true);

    expect(pasteText).toHaveBeenCalledWith('/mr-review-team 127');
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(write).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'pasteText:/mr-review-team 127',
      'delay:200',
      'sendSpecialKeys:Enter',
    ]);
  });

  it('keeps CoCo char-by-char sendText precedence when pasteLine is enabled', async () => {
    const calls: string[] = [];
    const write = vi.fn(() => true);
    const sendText = vi.fn((text: string) => {
      calls.push(`sendText:${text}`);
      return true;
    });
    const pasteText = vi.fn((text: string) => {
      calls.push(`pasteText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });
    const fake = { supportsRawCommandPasteLine: true, write, sendText, sendSpecialKeys, pasteText };
    const pasteLineOptions = {
      coco: true,
      cocoThrottleMs: 7,
      pasteLine: true,
      pasteSettleMs: 300,
      delay,
    };

    await expect(writeRawCommandLine(
      fake,
      '/mr-review-team 127',
      pasteLineOptions,
    )).resolves.toBe(true);

    expect(pasteText).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes('/mr-review-team 127'.length);
    expect(sendText).toHaveBeenNthCalledWith(1, '/');
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(delay).toHaveBeenCalledWith(7);
    expect(calls.at(-1)).toBe('sendSpecialKeys:Enter');
  });

  it('fails closed when the text write is rejected', async () => {
    const sendText = vi.fn(() => false);
    const sendSpecialKeys = vi.fn(() => true);
    await expect(writeRawCommandLine({
      write: vi.fn(), sendText, sendSpecialKeys,
    }, '/goal x', { delay: immediateDelay })).resolves.toBe(false);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('fails closed when Enter is rejected after accepted text', async () => {
    const sendText = vi.fn(() => true);
    const sendSpecialKeys = vi.fn(() => false);
    await expect(writeRawCommandLine({
      write: vi.fn(), sendText, sendSpecialKeys,
    }, '/goal x', { delay: immediateDelay })).resolves.toBe(false);
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });

  it('fails closed when a PTY-style backend disappears before either write', async () => {
    const write = vi.fn(() => false);
    await expect(writeRawCommandLine({ write }, '/goal x', {
      delay: immediateDelay,
    })).resolves.toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not ACK or enqueue a follower after rejected Enter and retires the durable generation', async () => {
    const accepted = await writeRawCommandLine({
      write: vi.fn(),
      sendText: vi.fn(() => true),
      sendSpecialKeys: vi.fn(() => false),
    }, '/goal x', { delay: immediateDelay });
    const onActivationAck = vi.fn();
    const onFollowUp = vi.fn();
    const onDurableFailure = vi.fn();

    expect(finalizeRawCommandDelivery({
      accepted,
      durableActivation: true,
      acknowledgeActivation: true,
      hasFollowUp: true,
      onAccepted: vi.fn(),
      onFollowUp,
      onActivationAck,
      onDurableFailure,
    })).toBe(false);
    expect(onActivationAck).not.toHaveBeenCalled();
    expect(onFollowUp).not.toHaveBeenCalled();
    expect(onDurableFailure).toHaveBeenCalledOnce();
  });

  it('CoCo: types char-by-char with the throttle, then exactly one Enter after the submit beat', async () => {
    // A one-shot write coalesces into a paste on CoCo, skipping command mode and
    // the slash picker; a stray second Enter would confirm a /model selector pick.
    const calls: string[] = [];
    const backend = {
      write: vi.fn(() => { calls.push('write'); return true; }),
      sendText: vi.fn((text: string) => { calls.push(`text:${text}`); return true; }),
      sendSpecialKeys: vi.fn((key: string) => { calls.push(`key:${key}`); return true; }),
    };
    const delay = vi.fn(async (ms: number) => { calls.push(`delay:${ms}`); });

    await expect(writeRawCommandLine(backend, '/model x', {
      coco: true,
      cocoThrottleMs: 5,
      delay,
    })).resolves.toBe(true);

    expect(calls).toEqual([
      ...[...'/model x'].flatMap(ch => [`text:${ch}`, 'delay:5']),
      'delay:200',
      'key:Enter',
    ]);
  });

  it('CoCo: stops typing at the first rejected keystroke and reports a rejected Enter', async () => {
    let keystrokes = 0;
    const sendText = vi.fn(() => ++keystrokes < 3);
    const sendSpecialKeys = vi.fn(() => true);
    await expect(writeRawCommandLine({ write: vi.fn(), sendText, sendSpecialKeys }, '/model x', {
      coco: true,
      delay: immediateDelay,
    })).resolves.toBe(false);
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(sendSpecialKeys).not.toHaveBeenCalled();

    const rejectEnter = vi.fn(() => false);
    await expect(writeRawCommandLine({
      write: vi.fn(), sendText: vi.fn(() => true), sendSpecialKeys: rejectEnter,
    }, '/model x', { coco: true, delay: immediateDelay })).resolves.toBe(false);
    expect(rejectEnter).toHaveBeenCalledWith('Enter');
  });
});

describe('worker input fences', () => {
  const workerSrc = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8');

  /** A top-level worker.ts function: from its declaration to the next column-0 `}`. */
  function topLevelBody(marker: string): string {
    const start = workerSrc.indexOf(marker);
    expect(start, `${marker} not found`).toBeGreaterThanOrEqual(0);
    return workerSrc.slice(start, workerSrc.indexOf('\n}\n', start));
  }

  /** After the awaited bare-shell detector (a settle poll of up to 2s that yields
   *  the event loop), the restart fence must be re-checked before the first write. */
  function expectRestartFenceAfterDetector(body: string, firstWrite: RegExp): void {
    const awaited = body.search(/await detectBareShellLaunch\(\)/);
    expect(awaited).toBeGreaterThanOrEqual(0);
    const tail = body.slice(awaited);
    const fence = tail.search(/if \(cliRestartInProgress\) return\b/);
    expect(fence).toBeGreaterThan(0);
    expect(tail.search(firstWrite)).toBeGreaterThan(fence);
  }

  // 源码结构护栏(K3)：CLI 重启期间（tmux 拆旧 pane 前有 250–1999ms jitter）旧 backend 仍存活，
  // 任何直写路径都必须在写入前复查 cliRestartInProgress，否则用户输入写进即将销毁的旧 CLI 后丢失。
  // raw_input 绕过忙时队列直写，两条 flush 在 await detectBareShellLaunch() 之后才写。worker.ts 无导出，
  // 竞态窗口没有行为 seam。来历：#570（fix(worker): 防止 CoCo 启动竞争导致会话失声）补的 post-settle fence。
  it('re-checks the CLI restart fence on every direct-write path before writing', () => {
    const rawCase = workerSrc.slice(
      workerSrc.indexOf("case 'raw_input':"),
      workerSrc.indexOf("case 'rename_session':"),
    );
    const rawGate = rawCase.slice(0, rawCase.indexOf('deliverRawInput('));
    expect(rawGate).toMatch(/\bcliRestartInProgress\b[\s\S]*\.enqueueRaw\(/);

    expectRestartFenceAfterDetector(
      topLevelBody('async function flushPending()'),
      /runStartupCommands\(|\.takeRaw\(|\.writeStructuredInput!?\(|\.writeInput\(/,
    );
    expectRestartFenceAfterDetector(
      topLevelBody('async function flushPendingInjections()'),
      /pendingInjections\.shift\(/,
    );
  });

  // 源码结构护栏(K3)：CLI 没起来、pane 停在裸 shell 时，用户消息打进去会被 shell 当命令解析
  // （#314：rcfile `exec zsh` 顶替启动，首条 prompt 报 parse error 丢失）。#662 把永久锁改成可恢复 hold，
  // 唯一解锁器必须同 backend 代 + 重读 leaf comm 已非 shell 才放行（fail-closed），非 PTY 的 ready 来源
  // 不得绕过 hold 标记就绪。逻辑在 worker.ts 闭包里，没有行为 seam。
  it('keeps the bare-shell launch hold fail-closed until the pane leaf is no longer a shell', () => {
    expect(topLevelBody('function recoverBareShellLaunchFromPty('))
      .toMatch(/backend !== observedBackend[\s\S]*isBareShellComm\([\s\S]*bareShellLaunchBlocked = false/);

    const markReady = topLevelBody('function markPromptReady(): void');
    const hold = markReady.search(/if \(bareShellLaunchBlocked\)/);
    expect(hold).toBeGreaterThanOrEqual(0);
    expect(markReady.indexOf('isPromptReady = true')).toBeGreaterThan(hold);
  });
});
