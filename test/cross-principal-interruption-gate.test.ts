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
 * structure, in the same style as worker-durable-expiry-order.test.ts. The
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
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

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
  // worker.ts reads the switch through its own symbol, not the daemon's
  // `config.crossPrincipalInterruption`. Every gate below is pinned by its CALL
  // SITE, and those call sites stay textually intact even if this body stopped
  // consulting the shared accessor — so without this case a worker hardwired to
  // a constant passes the whole file. That failure mode is worse than the
  // config-cache skew the two sides can already have: a skew self-heals inside
  // the 2s TTL, a hardwired worker disagrees with the daemon forever.
  it('the worker gate delegates to the shared accessor rather than a constant', () => {
    const start = workerSource.indexOf('function crossPrincipalIsolationOn(): boolean {');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = workerSource.slice(start, workerSource.indexOf('\n}\n', start));
    expect(body).toContain('return isCrossPrincipalInterruptionEnabled();');
    expect(body).not.toMatch(/return\s+(?:true|false)\s*;/);
    // The import must be the real one, so the delegation cannot be satisfied by
    // a local stub that shadows the accessor's name.
    expect(workerSource).toMatch(
      /import \{[^}]*\bisCrossPrincipalInterruptionEnabled\b[^}]*\} from '\.\/global-config\.js';/s,
    );
  });

  it('activeTurnBlocks bypasses isolation only for inputs without the Oncall FIFO flag', () => {
    const start = workerSource.indexOf('function activeTurnBlocks(input: {');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = workerSource.slice(start, workerSource.indexOf('\n}\n', start));
    const gate = body.indexOf('if (!input.queueAfterActiveTurn && !crossPrincipalIsolationOn()) return false;');
    const consult = body.indexOf('activeTurnAuthority.blocks(');
    expect(gate).toBeGreaterThanOrEqual(0);
    // Order matters: the gate must precede the only call that can reject.
    expect(consult).toBeGreaterThan(gate);
  });

  it('markActiveTurnStarted adopts instead of throwing while the switch is off', () => {
    const start = workerSource.indexOf('function markActiveTurnStarted(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = workerSource.slice(start, workerSource.indexOf('\n}\n', start));
    const normal = body.indexOf('activeTurnAuthority.reserve(identity) && activeTurnAuthority.markStarted(identity)');
    const adopt = body.indexOf('adoptActiveTurnWhenIsolationOff(identity)');
    const thrown = body.indexOf('throw new Error(`turn authority mismatch before CLI write');
    expect(normal).toBeGreaterThanOrEqual(0);
    // The adoption path sits between the normal path and the throw: an
    // unenforced authority must never be the thing that raises.
    expect(adopt).toBeGreaterThan(normal);
    expect(thrown).toBeGreaterThan(adopt);
  });

  it('reserveActiveTurn offers adoption before logging a rejection', () => {
    const start = workerSource.indexOf('function reserveActiveTurn(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = workerSource.slice(start, workerSource.indexOf('\n}\n', start));
    const adopt = body.indexOf('adoptActiveTurnWhenIsolationOff(identity)');
    const rejectLog = body.indexOf('Rejected turn');
    expect(adopt).toBeGreaterThanOrEqual(0);
    expect(rejectLog).toBeGreaterThan(adopt);
  });

  it('adoption is itself gated, so an enforcing authority is never cleared', () => {
    const start = workerSource.indexOf('function adoptActiveTurnWhenIsolationOff(');
    const body = workerSource.slice(start, workerSource.indexOf('\n}\n', start));
    const gate = body.indexOf('if (crossPrincipalIsolationOn()) return false;');
    const fifoGate = body.indexOf('if (identity.queueAfterActiveTurn) return false;');
    const clear = body.indexOf('activeTurnAuthority.clear()');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(fifoGate).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(fifoGate);
    expect(clear).toBeGreaterThan(gate);
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

  it('clear-then-reserve hands the tuple to the turn that is really writing', () => {
    // The shape adoptActiveTurnWhenIsolationOff performs. The resulting
    // identity is what the MCP gateway signs and the sandbox relay publishes,
    // so it must describe B, not the stale A.
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'turn-a', caller: A });
    authority.clear();
    expect(authority.reserve({ turnId: 'turn-b', caller: B })).toBe(true);
    expect(authority.markStarted({ turnId: 'turn-b', caller: B })).toBe(true);
    expect(authority.identity()).toEqual({ turnId: 'turn-b', caller: B });
    expect(authority.snapshot()?.started).toBe(true);
  });
});

describe('XPI switch — daemon.ts ingress gates (source-pinned)', () => {
  it('the divert is conditioned on the switch before any principal comparison', () => {
    const idx = daemonSource.indexOf('config.crossPrincipalInterruption\n');
    expect(idx).toBeGreaterThanOrEqual(0);
    const clause = daemonSource.slice(idx, idx + 400);
    // The switch is the FIRST conjunct: with it off nothing else is evaluated
    // and the message falls through to the ordinary existing-owner route.
    expect(clause).toContain('activePrincipalTurn');
    expect(clause).toContain('sameTrustedPrincipal');
    expect(daemonSource.slice(idx - 200, idx)).toContain('const activePrincipalTurn');
  });

  it('a rejection arriving while the switch is off retries delivery instead of staging', () => {
    // A method on the ingress-callback object, not a free function.
    const start = daemonSource.indexOf('async onOrdinaryImInputRejected(ds, context) {');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = daemonSource.slice(start, start + 4000);
    const gate = body.indexOf('if (!config.crossPrincipalInterruption)');
    const staged = body.indexOf('stageCrossPrincipalInterruption');
    expect(gate).toBeGreaterThanOrEqual(0);
    // Returning false here re-enters delivery; staging must sit strictly after
    // the gate, otherwise the switch could still mint a stranded record.
    expect(body.slice(gate, gate + 400)).toContain('return false;');
    if (staged >= 0) expect(staged).toBeGreaterThan(gate);
  });
});

describe('XPI switch — cli.ts send hint', () => {
  it('advertises --as only while isolation is enforced, but still parses the flag', () => {
    const hint = cliSource.indexOf("t('xpi.send.as_needed_hint'");
    expect(hint).toBeGreaterThanOrEqual(0);
    // The advertisement is gated...
    expect(cliSource.slice(hint - 400, hint)).toContain('config.crossPrincipalInterruption');
    // ...but the flag itself keeps working, so a marked send is never silently
    // downgraded just because the host has the switch off.
    expect(cliSource).toContain("argValue(rest, '--as')");
    expect(cliSource).toContain('embedCrossPrincipalAsToken');
  });
});
