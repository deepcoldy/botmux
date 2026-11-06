/**
 * Experimental cross-principal interruption (XPI) kill-switch
 * (`dashboard.crossPrincipalInterruption` / `BOTMUX_XPI_ENABLED`, accessor
 * `isCrossPrincipalInterruptionEnabled`). Default OFF.
 *
 * XPI was introduced by #1348, which CREATED `core/active-turn-authority.ts`
 * and added every `activeTurnBlocks` call site in worker.ts. So "OFF" here has
 * a precise meaning: a message from a second principal is delivered the way it
 * was before that feature existed, instead of being diverted into a staged
 * `crossPrincipalInterruptions` record awaiting a classification that a Feishu
 * card round-trip cannot currently deliver.
 *
 * Every OFF assertion is paired with an ON one, so both a gate that never fires
 * and a gate that always fires turn a test red (reverse-mutation discipline).
 *
 * worker.ts and daemon.ts are process entrypoints — importing them installs IPC
 * and signal handlers in Vitest — so their two gates are pinned as source
 * structure. The
 * authority semantics those gates depend on are then exercised for real against
 * ActiveTurnAuthority itself.
 */
import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  globalConfigPath,
  invalidateGlobalConfigCache,
  isCrossPrincipalInterruptionEnabled,
  readGlobalConfig,
} from '../src/global-config.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import {
  buildBotmuxShellHints,
  buildBotmuxSystemPromptText,
} from '../src/adapters/cli/shared-hints.js';
import { renderBotmuxSendSkill } from '../src/skills/reply-style-guide.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

describe('XPI switch — accessor (config file + env override)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-xpi-gate-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('BOTMUX_XPI_ENABLED', '');
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(dashboard: unknown): void {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard }));
    invalidateGlobalConfigCache();
  }

  it('defaults OFF when the key is absent entirely', () => {
    writeConfig({});
    expect(isCrossPrincipalInterruptionEnabled()).toBe(false);
  });

  it('turns on only for a real boolean true', () => {
    writeConfig({ crossPrincipalInterruption: true });
    expect(isCrossPrincipalInterruptionEnabled()).toBe(true);
    writeConfig({ crossPrincipalInterruption: false });
    expect(isCrossPrincipalInterruptionEnabled()).toBe(false);
  });

  it('drops a non-boolean value instead of coercing it (stays OFF)', () => {
    // 'yes' is truthy in JS — a sanitizer that forwarded it would read as ON.
    writeConfig({ crossPrincipalInterruption: 'yes' });
    // Assert the sanitizer directly as well as through the accessor: the
    // accessor's `=== true` would mask a leaky sanitizer on its own, so
    // without this line a coercing sanitizer stays invisible.
    expect(readGlobalConfig().dashboard?.crossPrincipalInterruption).toBeUndefined();
    expect(isCrossPrincipalInterruptionEnabled()).toBe(false);
  });

  it('BOTMUX_XPI_ENABLED overrides the config file both ways', () => {
    writeConfig({ crossPrincipalInterruption: false });
    expect(isCrossPrincipalInterruptionEnabled()).toBe(false);
    for (const on of ['true', '1', 'yes', 'on', 'ON', ' True ']) {
      vi.stubEnv('BOTMUX_XPI_ENABLED', on);
      expect(isCrossPrincipalInterruptionEnabled()).toBe(true);
    }

    writeConfig({ crossPrincipalInterruption: true });
    vi.stubEnv('BOTMUX_XPI_ENABLED', 'false');
    expect(isCrossPrincipalInterruptionEnabled()).toBe(false);
    // Any non-truthy string ⇒ disabled, matching isWorkflowFeatureEnabled.
    vi.stubEnv('BOTMUX_XPI_ENABLED', 'garbage');
    expect(isCrossPrincipalInterruptionEnabled()).toBe(false);
    // A blank env is ignored: the config wins.
    vi.stubEnv('BOTMUX_XPI_ENABLED', '');
    expect(isCrossPrincipalInterruptionEnabled()).toBe(true);
  });

  it('is read live, so a dashboard flip applies without a daemon restart', () => {
    writeConfig({ crossPrincipalInterruption: false });
    expect(isCrossPrincipalInterruptionEnabled()).toBe(false);
    writeConfig({ crossPrincipalInterruption: true });
    expect(isCrossPrincipalInterruptionEnabled()).toBe(true);
  });
});

describe('XPI switch — agent-facing `--as` guidance', () => {
  afterEach(() => { delete process.env.BOTMUX_XPI_ENABLED; });

  it('shell hints and system prompt carry the --as line only when ON', () => {
    process.env.BOTMUX_XPI_ENABLED = 'true';
    for (const prompt of [
      buildBotmuxShellHints('zh').join('\n'),
      buildBotmuxSystemPromptText({ locale: 'zh' }),
    ]) {
      expect(prompt).toContain('--as independent');
      expect(prompt).toContain('--as suggestion');
    }

    process.env.BOTMUX_XPI_ENABLED = 'false';
    for (const prompt of [
      buildBotmuxShellHints('zh').join('\n'),
      buildBotmuxSystemPromptText({ locale: 'zh' }),
    ]) {
      expect(prompt).not.toContain('--as independent');
      expect(prompt).not.toContain('--as suggestion');
      // Surgical: the rest of the routing guidance survives.
      expect(prompt).toContain('botmux send');
      expect(prompt).toContain('--no-mention');
    }
  });

  it('drops the `--as` section from the botmux-send skill only when OFF', () => {
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const on = renderBotmuxSendSkill({});
    expect(on).toContain('### 对方正在执行任务时');
    expect(on).toContain('--as independent');

    process.env.BOTMUX_XPI_ENABLED = 'false';
    const off = renderBotmuxSendSkill({});
    expect(off).not.toContain('### 对方正在执行任务时');
    expect(off).not.toContain('--as independent');
    // The surrounding skill is intact — the section after it still renders, so
    // the strip cut at the right anchor instead of truncating the document.
    expect(off).toContain('### 引用串联（普通群）');
    expect(on.length).toBeGreaterThan(off.length);
  });
});

describe('XPI switch — worker.ts authority gates (source-pinned)', () => {
  function workerFn(name: string): string {
    const start = workerSource.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return workerSource.slice(start, workerSource.indexOf('\n}\n', start));
  }

  // 源码结构护栏(K3)：XPI 默认关闭（#1424）。开启态下第二个身份的消息被分流暂存，而飞书卡片往返交付不了分类结果，
  // 消息无法 settle、还会触发暂存提示的自激环；关闭态必须完全回到 #1348 之前的投递：worker 不拒绝、不抛
  // `turn authority mismatch`，而是接管 turn envelope。这些闸都在 worker.ts 入口模块（import 即安装 IPC/信号
  // 处理）的闭包里，没有行为 seam；接管语义本身由下方 'adoption semantics against the real authority' 覆盖。
  it('every worker authority gate yields to the live switch before rejecting or throwing', () => {
    // The switch is read live from the shared accessor, never hardwired (#1424 mutation gap).
    const isolationOn = workerFn('crossPrincipalIsolationOn');
    expect(isolationOn).toContain('isCrossPrincipalInterruptionEnabled()');
    expect(isolationOn).not.toMatch(/return\s+(?:true|false)\s*;/);
    expect(workerSource).toMatch(
      /import \{[^}]*\bisCrossPrincipalInterruptionEnabled\b[^}]*\} from '\.\/global-config\.js';/s,
    );
    // OFF: the only call that can reject an ordinary input is never reached.
    const blocks = workerFn('activeTurnBlocks');
    expect(blocks.indexOf('crossPrincipalIsolationOn()')).toBeGreaterThan(-1);
    expect(blocks.indexOf('crossPrincipalIsolationOn()')).toBeLessThan(blocks.indexOf('activeTurnAuthority.blocks('));
    // OFF: reserve / markStarted adopt before they reject or throw.
    const reserve = workerFn('reserveActiveTurn');
    expect(reserve.indexOf('adoptActiveTurnWhenIsolationOff(')).toBeGreaterThan(-1);
    expect(reserve.indexOf('adoptActiveTurnWhenIsolationOff(')).toBeLessThan(reserve.lastIndexOf('return false;'));
    const started = workerFn('markActiveTurnStarted');
    expect(started.indexOf('adoptActiveTurnWhenIsolationOff(')).toBeGreaterThan(-1);
    expect(started.indexOf('adoptActiveTurnWhenIsolationOff(')).toBeLessThan(started.indexOf('throw new Error('));
    // ON: adoption is itself gated, so an enforcing authority is never taken over.
    const adopt = workerFn('adoptActiveTurnWhenIsolationOff');
    expect(adopt.indexOf('crossPrincipalIsolationOn()')).toBeGreaterThan(-1);
    expect(adopt.indexOf('crossPrincipalIsolationOn()')).toBeLessThan(adopt.indexOf('adoptEnvelopePreservingPrincipal('));
  });
});

describe('XPI switch — adoption semantics against the real authority', () => {
  const A = {
    requestUserOpenId: 'ou_a',
    requestUserUnionId: 'on_a',
    requestLarkAppId: 'cli_app',
    senderType: 'user' as const,
  };
  const B = {
    requestUserOpenId: 'ou_b',
    requestUserUnionId: 'on_b',
    requestLarkAppId: 'cli_app',
    senderType: 'user' as const,
  };

  it('a second principal is refused by every entry point while A owns the turn', () => {
    // This is what the switch turns off — pinned so the OFF case below is
    // measured against a gate that demonstrably fires.
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'turn-a', caller: A });
    expect(authority.blocks({ turnId: 'turn-b', caller: B })).toBe(true);
    expect(authority.reserve({ turnId: 'turn-b', caller: B })).toBe(false);
    expect(authority.markStarted({ turnId: 'turn-b', caller: B })).toBe(false);
  });

  it('hands the envelope to B while keeping A as the trusted tool caller', () => {
    // Disabled isolation merges B's input into A's in-flight work. Reply/turn
    // attribution follows B's envelope, while the MCP gateway must keep signing
    // tools as A per the disabled-mode product contract.
    const authority = new ActiveTurnAuthority();
    const controllerA = {
      ...A,
      requestUserOpenId: 'ou_controller_a',
      requestUserUnionId: 'on_controller_a',
    };
    authority.reserve({ turnId: 'turn-a', caller: A, controller: controllerA });
    expect(authority.adoptEnvelopePreservingPrincipal({
      turnId: 'turn-b',
      dispatchAttempt: 2,
      caller: B,
      controller: B,
    }, 123)).toBe(true);
    expect(authority.markStarted({
      turnId: 'turn-b',
      dispatchAttempt: 2,
      caller: B,
    })).toBe(true);
    expect(authority.identity()).toEqual({
      turnId: 'turn-b',
      identityTurnId: 'turn-a',
      dispatchAttempt: 2,
      caller: A,
      controller: controllerA,
    });
    expect(authority.snapshot()?.started).toBe(true);
  });

  it('falls back to the incoming principal only when no active principal exists', () => {
    const authority = new ActiveTurnAuthority();

    expect(authority.adoptEnvelopePreservingPrincipal({
      turnId: 'turn-b',
      caller: B,
      controller: B,
    }, 456)).toBe(true);
    expect(authority.identity()).toEqual({
      turnId: 'turn-b',
      caller: B,
      controller: B,
    });
    expect(authority.snapshot()).toMatchObject({
      started: false,
      reservedAtMs: 456,
    });
  });
});

describe('XPI switch — daemon.ts ingress gates (source-pinned)', () => {
  // 源码结构护栏(K3)：同上（#1424），daemon 入口侧的两道关闭闸：开关是分流条件里先于任何身份比较的合取项；
  // 关闭时 worker 回来的身份拒绝一律交回 worker-pool 重投，绝不暂存——关闭态下暂存记录没有出口，消息会滞留。
  // daemon.ts 是进程入口，没有行为 seam。
  it('never diverts or stages a second principal while the switch is off', () => {
    const activeAt = daemonSource.indexOf('const activePrincipalTurn = ds.activeInteractiveTurn;');
    expect(activeAt).toBeGreaterThan(-1);
    const switchAt = daemonSource.indexOf('config.crossPrincipalInterruption', activeAt);
    expect(switchAt).toBeGreaterThan(activeAt);
    expect(switchAt).toBeLessThan(daemonSource.indexOf('sameTrustedPrincipal(', activeAt));

    const start = daemonSource.indexOf('onOrdinaryImInputRejected(ds, context) {');
    expect(start).toBeGreaterThan(-1);
    const body = daemonSource.slice(start, daemonSource.indexOf('\n    },\n', start));
    const gate = body.indexOf('!config.crossPrincipalInterruption');
    const staged = body.indexOf('stageCrossPrincipalInterruption(');
    expect(gate).toBeGreaterThan(-1);
    expect(staged).toBeGreaterThan(gate);
    expect(body.slice(gate, staged)).toContain('return false;');
  });
});
