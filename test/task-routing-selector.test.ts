import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BotRuntimeSnapshot } from '../src/core/task-routing/model.js';
import {
  buildSemanticMatcherPrompt,
  parseSemanticMatcherOutput,
  runBotOneShotMatcher,
} from '../src/core/task-routing/bot-matcher.js';
import { evaluateCandidates, selectBotForTask } from '../src/core/task-routing/selector.js';
import { resolveTaskRoutingBotRef } from '../src/core/task-routing/probe.js';
import type { BotConfig } from '../src/bot-registry.js';

const NOW = 1_800_000_000_000;

function makeBot(overrides: Partial<BotRuntimeSnapshot> & { larkAppId: string; name: string }): BotRuntimeSnapshot {
  const { profile, runtime, ...rest } = overrides;
  return {
    cliId: 'claude-code',
    isSteward: false,
    apiOnly: false,
    configOrder: 0,
    ...rest,
    profile: {
      enabled: true,
      costTier: 'medium',
      ...profile,
    },
    runtime: {
      online: true,
      probeStatus: 'ok',
      larkConnected: true,
      workingCount: 0,
      queuedCount: 0,
      residentCount: 0,
      maxLiveWorkers: null,
      limitedCount: 0,
      ...runtime,
    },
  };
}

describe('task-routing Stage-1 rule filtering and baseline ranking', () => {
  it('returns empty pool by default when no bot opts in, recording clear exclusion reasons', () => {
    const bots = [
      makeBot({ larkAppId: 'cli_a', name: 'BotA', profile: { enabled: false, costTier: 'low' } }),
      makeBot({ larkAppId: 'cli_steward', name: 'Steward', isSteward: true, profile: { enabled: true, costTier: 'low' } }),
      makeBot({ larkAppId: 'cli_api', name: 'ApiBot', apiOnly: true, profile: { enabled: true, costTier: 'low' } }),
    ];

    const { eligible, excluded } = evaluateCandidates(bots, {}, NOW);
    expect(eligible).toHaveLength(0);
    expect(excluded.map(e => [e.larkAppId, e.exclusionCode])).toEqual([
      ['cli_a', 'not_participating'],
      ['cli_steward', 'steward_bot'],
      ['cli_api', 'api_only'],
    ]);
  });

  it('always excludes steward and apiOnly bots even when explicitly named via --only', () => {
    const bots = [
      makeBot({ larkAppId: 'cli_steward', name: 'Steward', isSteward: true, profile: { enabled: true, costTier: 'low' } }),
      makeBot({ larkAppId: 'cli_api', name: 'ApiBot', apiOnly: true, profile: { enabled: true, costTier: 'low' } }),
    ];

    const { eligible, excluded } = evaluateCandidates(bots, { only: ['cli_steward', 'cli_api'] }, NOW);
    expect(eligible).toHaveLength(0);
    expect(excluded.map(e => e.exclusionCode)).toEqual(['steward_bot', 'api_only']);
  });

  it('excludes offline, disconnected, full-capacity, agy-exhausted, cooldown, budget-exceeded, and caller-excluded bots', () => {
    const bots = [
      makeBot({ larkAppId: 'cli_ok', name: 'Healthy', configOrder: 0, profile: { enabled: true, costTier: 'medium' } }),
      makeBot({ larkAppId: 'cli_off', name: 'Offline', configOrder: 1, runtime: { online: false, probeStatus: 'offline', larkConnected: 'unknown', workingCount: 'unknown', queuedCount: 'unknown', residentCount: 'unknown', maxLiveWorkers: null, limitedCount: 'unknown' } }),
      makeBot({ larkAppId: 'cli_disc', name: 'Disconnected', configOrder: 2, runtime: { online: true, probeStatus: 'ok', larkConnected: false, workingCount: 0, queuedCount: 0, residentCount: 0, maxLiveWorkers: null, limitedCount: 0 } }),
      makeBot({ larkAppId: 'cli_full', name: 'Full', configOrder: 3, runtime: { online: true, probeStatus: 'ok', larkConnected: true, workingCount: 2, queuedCount: 0, residentCount: 4, maxLiveWorkers: 4, limitedCount: 0 } }),
      makeBot({
        larkAppId: 'cli_agy',
        name: 'AgyEmpty',
        cliId: 'antigravity',
        configOrder: 4,
        runtime: {
          online: true, probeStatus: 'ok', larkConnected: true, workingCount: 0, queuedCount: 0, residentCount: 0, maxLiveWorkers: null, limitedCount: 0,
          agyAccounts: { managed: true, availableCount: 0, enabledCount: 3, earliestRecoveryMs: NOW + 42 * 60_000 },
        },
      }),
      makeBot({
        larkAppId: 'cli_cool',
        name: 'Cooldown',
        configOrder: 5,
        runtime: {
          online: true, probeStatus: 'ok', larkConnected: true, workingCount: 0, queuedCount: 0, residentCount: 1, maxLiveWorkers: null, limitedCount: 1,
          limitedUntilMs: NOW + 15 * 60_000, limitedKind: 'usage',
        },
      }),
      makeBot({
        larkAppId: 'cli_budget',
        name: 'OverBudget',
        configOrder: 6,
        runtime: {
          online: true, probeStatus: 'ok', larkConnected: true, workingCount: 0, queuedCount: 0, residentCount: 0, maxLiveWorkers: null, limitedCount: 0,
          budget: { monthlyCny: 100, spentCny: 120, percent: 120, hardStop: true, exceeded: true },
        },
      }),
      makeBot({ larkAppId: 'cli_ex', name: 'CallerExcluded', configOrder: 7 }),
    ];

    const { eligible, excluded } = evaluateCandidates(bots, { exclude: ['cli_ex'] }, NOW);
    expect(eligible.map(c => c.larkAppId)).toEqual(['cli_ok']);
    expect(Object.fromEntries(excluded.map(e => [e.larkAppId, e.exclusionCode]))).toEqual({
      cli_off: 'offline',
      cli_disc: 'lark_disconnected',
      cli_full: 'at_capacity',
      cli_agy: 'quota_exhausted',
      cli_cool: 'in_cooldown',
      cli_budget: 'budget_exceeded',
      cli_ex: 'excluded_by_caller',
    });
    const agyRow = excluded.find(e => e.larkAppId === 'cli_agy');
    expect(agyRow?.exclusionReason).toContain('3/3');
    expect(agyRow?.exclusionReason).toContain('42分钟');
  });

  it('orders eligible bots by --prefer -> lower live load -> lower cost tier -> config order', () => {
    const bots = [
      makeBot({ larkAppId: 'cli_high_idle', name: 'HighIdle', configOrder: 0, profile: { enabled: true, costTier: 'high' } }),
      makeBot({ larkAppId: 'cli_low_busy', name: 'LowBusy', configOrder: 1, profile: { enabled: true, costTier: 'low' }, runtime: { online: true, probeStatus: 'ok', larkConnected: true, workingCount: 1, queuedCount: 1, residentCount: 1, maxLiveWorkers: null, limitedCount: 0 } }),
      makeBot({ larkAppId: 'cli_low_idle', name: 'LowIdle', configOrder: 2, profile: { enabled: true, costTier: 'low' } }),
      makeBot({ larkAppId: 'cli_mid_idle', name: 'MidIdle', configOrder: 3, profile: { enabled: true, costTier: 'medium' } }),
    ];

    const base = evaluateCandidates(bots, {}, NOW);
    expect(base.eligible.map(c => c.larkAppId)).toEqual([
      'cli_low_idle',
      'cli_mid_idle',
      'cli_high_idle',
      'cli_low_busy',
    ]);

    const preferred = evaluateCandidates(bots, { prefer: 'cli_high_idle' }, NOW);
    expect(preferred.eligible[0]?.larkAppId).toBe('cli_high_idle');
  });
});

describe('task-routing Stage-2 semantic matcher and examples', () => {
  const threeBots = (): BotRuntimeSnapshot[] => [
    makeBot({
      larkAppId: 'cli_low',
      name: 'Bot-Low',
      configOrder: 0,
      profile: {
        enabled: true,
        costTier: 'low',
        strengths: '内部最便宜，擅长改文案、小修、补单测、文档、代码评审',
        limitations: '不擅长跨模块复杂架构重构',
      },
    }),
    makeBot({
      larkAppId: 'cli_mid_agy',
      name: 'Bot-Mid-Agy',
      cliId: 'antigravity',
      configOrder: 1,
      profile: {
        enabled: true,
        costTier: 'medium',
        strengths: '擅长复杂重构、鉴权链路设计与疑难排查',
        limitations: 'agy 账号额度有限，不要浪费在简单杂活上',
      },
      runtime: {
        online: true, probeStatus: 'ok', larkConnected: true, workingCount: 0, queuedCount: 0, residentCount: 0, maxLiveWorkers: null, limitedCount: 0,
        agyAccounts: { managed: true, availableCount: 2, enabledCount: 3 },
      },
    }),
    makeBot({
      larkAppId: 'cli_high',
      name: 'Bot-High',
      configOrder: 2,
      profile: {
        enabled: true,
        costTier: 'high',
        strengths: '高难度重构与兜底主力',
        limitations: '成本最高，仅在其他强模型不可用或复杂任务时使用',
      },
    }),
  ];

  it('Example 1 (copy tweak): selects cheapest idle bot in rule mode and in uncertain matcher fallback', async () => {
    const ruleDecision = await selectBotForTask({
      task: '把设置页按钮文案从「保存」改成「应用」',
      snapshots: threeBots(),
      nowMs: NOW,
    });
    expect(ruleDecision.selectedAppId).toBe('cli_low');
    expect(ruleDecision.matcherKind).toBe('rule');

    const lowConfDecision = await selectBotForTask({
      task: '把设置页按钮文案从「保存」改成「应用」',
      snapshots: threeBots(),
      matcherConfig: { mode: 'bot', botAppId: 'cli_low' },
      invokeMatcher: async () => ({
        ok: true,
        match: { selectedAppId: 'cli_high', confidence: 'low', reason: '不确定' },
      }),
      nowMs: NOW,
    });
    expect(lowConfDecision.selectedAppId).toBe('cli_low');
    expect(lowConfDecision.matcherKind).toBe('rule');
    expect(lowConfDecision.fallbackFromMatcher).toBeTruthy();
  });

  it('Example 2 (auth refactor): bot matcher picks Bot-Mid-Agy and records Bot-Low as profile_mismatch', async () => {
    const decision = await selectBotForTask({
      task: '重构整个飞书鉴权与 owner 校验链路，梳理边界并补齐回归测试',
      snapshots: threeBots(),
      matcherConfig: { mode: 'bot', botAppId: 'cli_low' },
      invokeMatcher: async req => {
        expect(req.candidates.map(c => c.larkAppId)).toEqual(['cli_low', 'cli_mid_agy', 'cli_high']);
        return {
          ok: true,
          match: {
            selectedAppId: 'cli_mid_agy',
            fallbackOrder: ['cli_mid_agy', 'cli_high'],
            unsuitable: [{ appId: 'cli_low', reason: '画像明确声明不擅长跨模块复杂架构重构' }],
            confidence: 'high',
            reason: '跨模块鉴权重构适合 Bot-Mid-Agy，且当前空闲、agy 2/3 可用，成本低于旗舰档',
          },
        };
      },
      nowMs: NOW,
    });

    expect(decision.selectedAppId).toBe('cli_mid_agy');
    expect(decision.matcherKind).toBe('bot');
    expect(decision.fallbackOrder).toEqual(['cli_mid_agy', 'cli_high']);
    expect(decision.excluded.some(e => e.larkAppId === 'cli_low' && e.exclusionCode === 'profile_mismatch')).toBe(true);
  });

  it('Example 3 (agy quota exhausted): excludes Bot-Mid-Agy at Stage 1 before matcher runs and selects Bot-High', async () => {
    const bots = threeBots();
    bots[1]!.runtime.agyAccounts = {
      managed: true,
      availableCount: 0,
      enabledCount: 3,
      earliestRecoveryMs: NOW + 40 * 60_000,
    };

    const seenByMatcher: string[] = [];
    const decision = await selectBotForTask({
      task: '重构整个飞书鉴权与 owner 校验链路',
      snapshots: bots,
      matcherConfig: { mode: 'bot', botAppId: 'cli_low' },
      invokeMatcher: async req => {
        seenByMatcher.push(...req.candidates.map(c => c.larkAppId));
        return {
          ok: true,
          match: {
            selectedAppId: 'cli_high',
            fallbackOrder: ['cli_high'],
            unsuitable: [{ appId: 'cli_low', reason: '不擅长跨模块鉴权重构' }],
            confidence: 'high',
            reason: '中档 agy 已耗尽，由旗舰兜底 Bot-High 承接复杂鉴权重构',
          },
        };
      },
      nowMs: NOW,
    });

    expect(seenByMatcher).toEqual(['cli_low', 'cli_high']);
    expect(decision.selectedAppId).toBe('cli_high');
    expect(decision.excluded.find(e => e.larkAppId === 'cli_mid_agy')?.exclusionCode).toBe('quota_exhausted');
    expect(decision.excluded.find(e => e.larkAppId === 'cli_low')?.exclusionCode).toBe('profile_mismatch');
  });

  it('refuses a matcher choice outside the Stage-1 eligible pool and falls back safely to baseline', async () => {
    const bots = threeBots();
    bots[1]!.runtime.online = false;
    bots[1]!.runtime.probeStatus = 'offline';

    const decision = await selectBotForTask({
      task: '排查线上异常',
      snapshots: bots,
      matcherConfig: { mode: 'bot', botAppId: 'cli_low' },
      invokeMatcher: async () => ({
        ok: true,
        match: { selectedAppId: 'cli_mid_agy', confidence: 'high', reason: '强行选了离线 bot' },
      }),
      nowMs: NOW,
    });

    expect(decision.selectedAppId).toBe('cli_low');
    expect(decision.matcherKind).toBe('rule');
    expect(decision.fallbackFromMatcher).toBeTruthy();
  });

  it('falls back to rule baseline when matcher times out or errors', async () => {
    const decision = await selectBotForTask({
      task: '整理测试夹具',
      snapshots: threeBots(),
      matcherConfig: { mode: 'bot', botAppId: 'cli_low', timeoutMs: 3_000 },
      invokeMatcher: async () => ({ ok: false, errorCode: 'matcher_timeout', detail: 'timeout after 3000ms' }),
      nowMs: NOW,
    });
    expect(decision.selectedAppId).toBe('cli_low');
    expect(decision.matcherKind).toBe('rule');
    expect(decision.fallbackFromMatcher).toContain('matcher_timeout');
  });
});

describe('bot one-shot matcher parsing and ref resolution', () => {
  it('parses matcher JSON even when wrapped in progress logs and markdown fences', () => {
    const noisyStdout = [
      '[2026-11-23T20:00:00Z] starting one-shot...',
      '{"debug":"ignored"}',
      '```json',
      '{"selectedAppId":"cli_mid","fallbackOrder":["cli_mid","cli_high"],"unsuitable":[{"appId":"cli_low","reason":"不擅长重构"}],"confidence":"high","reason":"中档更合适"}',
      '```',
    ].join('\n');
    const parsed = parseSemanticMatcherOutput(noisyStdout);
    expect(parsed).toEqual({
      selectedAppId: 'cli_mid',
      fallbackOrder: ['cli_mid', 'cli_high'],
      unsuitable: [{ appId: 'cli_low', reason: '不擅长重构' }],
      confidence: 'high',
      reason: '中档更合适',
    });
  });

  it('invokes local bot one-shot with security gate and parses valid JSON', async () => {
    const botCfg = {
      larkAppId: 'cli_judge',
      larkAppSecret: 'secret-never-leaked',
      cliId: 'claude-code',
      name: 'judge',
    } as BotConfig;

    const req = {
      task: '修复登录状态刷新',
      candidates: evaluateCandidates([
        makeBot({ larkAppId: 'cli_low', name: 'Low', profile: { enabled: true, costTier: 'low' } }),
        makeBot({ larkAppId: 'cli_high', name: 'High', profile: { enabled: true, costTier: 'high' } }),
      ], {}, NOW).eligible,
    };

    const prompt = buildSemanticMatcherPrompt(req);
    expect(prompt).toContain('<task>');
    expect(prompt).toContain('cli_low');

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const res = await runBotOneShotMatcher(req, {
      botConfig: botCfg,
      timeoutMs: 5_000,
      allowOneShot: () => true,
      runner: async opts => {
        capturedEnv = opts.env;
        expect(opts.timeoutMs).toBe(5_000);
        return {
          ok: true,
          stdout: JSON.stringify({ selectedAppId: 'cli_high', confidence: 'high', reason: '登录链路复杂' }),
        };
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.match.selectedAppId).toBe('cli_high');
    expect(capturedEnv?.BOTMUX_SESSION_ID).toBeUndefined();

    const blocked = await runBotOneShotMatcher(req, {
      botConfig: botCfg,
      allowOneShot: () => false,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.errorCode).toBe('matcher_bot_not_allowed');
  });

  it('resolves bot refs uniquely and fails closed on ambiguous names', () => {
    const list = [
      { larkAppId: 'cli_1', name: 'Worker', cliId: 'claude-code' },
      { larkAppId: 'cli_2', name: 'Worker', cliId: 'codex' },
      { larkAppId: 'cli_3', name: 'UniqueAgy', cliId: 'antigravity' },
    ];
    expect(resolveTaskRoutingBotRef('cli_1', list)).toEqual({ ok: true, larkAppId: 'cli_1' });
    expect(resolveTaskRoutingBotRef('@uniqueagy', list)).toEqual({ ok: true, larkAppId: 'cli_3' });
    expect(resolveTaskRoutingBotRef('Worker', list).ok).toBe(false);
    expect(resolveTaskRoutingBotRef('Missing', list).ok).toBe(false);
  });

  it('excludes managed agy pools with zero enabled accounts, limitedCount>0 without limitedUntilMs, and non-participating --prefer bots', () => {
    const snaps = [
      makeBot({
        larkAppId: 'cli_agy_zero',
        name: 'AgyZero',
        cliId: 'antigravity',
        profile: { enabled: true, costTier: 'medium' },
        runtime: {
          ...makeBot({ larkAppId: 'x', name: 'x' }).runtime,
          agyAccounts: { managed: true, availableCount: 0, enabledCount: 0 },
        },
      }),
      makeBot({
        larkAppId: 'cli_limited_no_ts',
        name: 'LimitedNoTs',
        profile: { enabled: true, costTier: 'low' },
        runtime: {
          ...makeBot({ larkAppId: 'x', name: 'x' }).runtime,
          limitedCount: 1,
        },
      }),
      makeBot({
        larkAppId: 'cli_opt_out',
        name: 'OptOut',
        profile: { enabled: false, costTier: 'low' },
      }),
      makeBot({
        larkAppId: 'cli_ok',
        name: 'OkBot',
        profile: { enabled: true, costTier: 'medium' },
      }),
    ];

    const res = evaluateCandidates(snaps, { prefer: 'cli_opt_out' }, NOW);
    expect(res.eligible.map(e => e.larkAppId)).toEqual(['cli_ok']);
    const codes = Object.fromEntries(res.excluded.map(e => [e.larkAppId, e.exclusionCode]));
    expect(codes).toEqual({
      cli_agy_zero: 'quota_exhausted',
      cli_limited_no_ts: 'in_cooldown',
      cli_opt_out: 'not_participating',
    });
  });

  it('parses matcher JSON even after unpaired quotes or braces in CLI log prefixes', () => {
    const withQuote = 'info: 12" display init\n{"selectedAppId":"cli_low","confidence":"high","reason":"ok"}';
    const withBrace = 'warn: {unclosed debug prefix\n{"selectedAppId":"cli_mid","confidence":"medium","reason":"ok2"}';
    expect(parseSemanticMatcherOutput(withQuote)?.selectedAppId).toBe('cli_low');
    expect(parseSemanticMatcherOutput(withBrace)?.selectedAppId).toBe('cli_mid');
  });

  it('rejects non-zero CLI crash stdout and reaps grandchild processes on matcher timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-matcher-proc-'));
    try {
      const req = {
        task: '测试进程清理',
        candidates: evaluateCandidates([
          makeBot({ larkAppId: 'cli_low', name: 'Low', profile: { enabled: true, costTier: 'low' } }),
          makeBot({ larkAppId: 'cli_high', name: 'High', profile: { enabled: true, costTier: 'high' } }),
        ], {}, NOW).eligible,
      };

      // 1. Non-zero exit after printing draft JSON must fail closed (matcher_exec_failed).
      const crashScript = join(dir, 'crash.sh');
      writeFileSync(
        crashScript,
        '#!/bin/sh\necho \'{"selectedAppId":"cli_high","confidence":"high","reason":"draft"}\'\nexit 137\n',
        { mode: 0o755 },
      );
      const crashRes = await runBotOneShotMatcher(req, {
        botConfig: { larkAppId: 'cli_j', larkAppSecret: 's', cliId: 'claude-code', cliPathOverride: crashScript } as BotConfig,
        timeoutMs: 3_000,
        allowOneShot: () => true,
      });
      expect(crashRes.ok).toBe(false);
      if (!crashRes.ok) {
        expect(crashRes.errorCode).toBe('matcher_exec_failed');
        expect(crashRes.detail).toContain('137');
      }

      // 2. Timeout kills the entire process group (wrapper ignoring SIGTERM + sleeping grandchild).
      if (process.platform !== 'win32') {
        const pidFile = join(dir, 'grandchild.pid');
        const hangScript = join(dir, 'hang.sh');
        writeFileSync(
          hangScript,
          `#!/bin/sh\ntrap '' TERM\nsleep 30 &\necho $! > "${pidFile}"\nwait\n`,
          { mode: 0o755 },
        );
        const timeoutRes = await runBotOneShotMatcher(req, {
          botConfig: { larkAppId: 'cli_j', larkAppSecret: 's', cliId: 'claude-code', cliPathOverride: hangScript } as BotConfig,
          timeoutMs: 1_000,
          allowOneShot: () => true,
        });
        expect(timeoutRes.ok).toBe(false);
        if (!timeoutRes.ok) expect(timeoutRes.errorCode).toBe('matcher_timeout');

        // Give the 1s SIGTERM->SIGKILL reap timer room to finish killing the process group.
        await new Promise(r => setTimeout(r, 1_300));
        expect(existsSync(pidFile)).toBe(true);
        const gpid = Number(readFileSync(pidFile, 'utf8').trim());
        expect(Number.isInteger(gpid) && gpid > 1).toBe(true);
        let alive = false;
        try { process.kill(gpid, 0); alive = true; } catch { alive = false; }
        expect(alive).toBe(false);

        // 3. Wrapper exits on SIGTERM while a stdio-detached grandchild ignores it:
        // early close must not cancel the pending SIGKILL escalation.
        const detachedPidFile = join(dir, 'detached-grandchild.pid');
        const earlyCloseScript = join(dir, 'early-close-wrapper.sh');
        writeFileSync(
          earlyCloseScript,
          `#!/bin/sh\ntrap 'exit 0' TERM\nsh -c 'trap "" TERM; echo $$ > "${detachedPidFile}"; exec sleep 30' </dev/null >/dev/null 2>&1 &\nwait $!\n`,
          { mode: 0o755 },
        );
        let detachedGpid = 0;
        try {
          const detachedRes = await runBotOneShotMatcher(req, {
            botConfig: { larkAppId: 'cli_j', larkAppSecret: 's', cliId: 'claude-code', cliPathOverride: earlyCloseScript } as BotConfig,
            timeoutMs: 1_000,
            allowOneShot: () => true,
          });
          expect(detachedRes.ok).toBe(false);
          await new Promise(r => setTimeout(r, 1_300));
          detachedGpid = Number(readFileSync(detachedPidFile, 'utf8').trim());
          let detachedAlive = false;
          try { process.kill(detachedGpid, 0); detachedAlive = true; } catch { detachedAlive = false; }
          expect(detachedAlive).toBe(false);
        } finally {
          if (detachedGpid > 1) {
            try { process.kill(detachedGpid, 'SIGKILL'); } catch { /* already reaped */ }
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
