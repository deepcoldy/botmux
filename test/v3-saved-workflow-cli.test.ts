import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessStartIdentity } from '../src/core/session-marker.js';

import {
  assertAgentFacingAppendScope,
  assertAgentFacingSaveScope,
  assertDaemonManagedRunBaseDir,
  collectSavedWorkflowRawParams,
  contextFromEnv,
  formatSavedWorkflowCliList,
  formatSavedWorkflowCliShow,
} from '../src/cli/saved-workflow.js';

describe('Saved Workflow CLI param parsing', () => {
  it('accepts explicit and bare key=value inputs into an own-property-only map', () => {
    const parsed = collectSavedWorkflowRawParams([
      'weekly-report',
      '--param',
      'city=上海',
      '--param=dry_run=true',
      'note=a=b',
    ]);

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed).toEqual({
      city: { kind: 'string', value: '上海' },
      dry_run: { kind: 'string', value: 'true' },
      note: { kind: 'string', value: 'a=b' },
    });
  });

  it('does not treat option values containing equals signs as params', () => {
    const parsed = collectSavedWorkflowRawParams([
      'weekly-report',
      '--library-dir',
      '/tmp/library=staging',
      '--base-dir=/tmp/runs=staging',
      '--run-id',
      'run=id',
      'city=上海',
    ]);

    expect(Object.keys(parsed)).toEqual(['city']);
    expect(parsed.city).toEqual({ kind: 'string', value: '上海' });
  });

  it('parses object/array values only through --param-json', () => {
    const parsed = collectSavedWorkflowRawParams([
      'weekly-report',
      '--param-json',
      'filters={"region":"cn"}',
      '--param-json=tags=["a","b"]',
    ]);
    expect(parsed.filters).toEqual({ kind: 'json', value: { region: 'cn' } });
    expect(parsed.tags).toEqual({ kind: 'json', value: ['a', 'b'] });
    expect(() => collectSavedWorkflowRawParams([
      'weekly-report', '--param-json', 'filters={broken',
    ])).toThrow(/--param-json filters 不是有效 JSON/);
  });

  it.each(['bad-name=x', '9starts_with_digit=x', '__proto__=x', 'prototype=x', 'constructor=x'])(
    'rejects unsafe parameter name %s',
    (pair) => {
      expect(() => collectSavedWorkflowRawParams(['weekly-report', pair])).toThrow(/参数名非法/);
    },
  );

  it('rejects duplicate params across explicit and bare forms', () => {
    expect(() => collectSavedWorkflowRawParams([
      'weekly-report',
      '--param',
      'city=上海',
      'city=北京',
    ])).toThrow(/参数重复：city/);
  });
});

describe('Saved Workflow CLI current-turn authentication', () => {
  it('uses session.lastCallerOpenId and durable routing, never static owner/env routing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'saved-workflow-turn-'));
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      const procStart = readProcessStartIdentity(process.pid);
      if (!procStart) throw new Error('test process start identity unavailable');
      writeFileSync(
        join(dataDir, '.botmux-cli-pids', String(process.pid)),
        JSON.stringify({ sessionId: 'sess-1', turnId: 'turn-b', procStart }),
      );
      writeFileSync(join(dataDir, 'sessions-cli_real.json'), JSON.stringify({
        'sess-1': {
          sessionId: 'sess-1',
          status: 'active',
          scope: 'thread',
          larkAppId: 'cli_real',
          chatId: 'oc_real',
          rootMessageId: 'om_real',
          ownerOpenId: 'ou_owner_a',
          lastCallerOpenId: 'ou_caller_b',
          quoteTargetId: 'turn-b',
        },
      }));

      expect(contextFromEnv({
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sess-1',
        BOTMUX_OWNER_OPEN_ID: 'ou_owner_a',
        BOTMUX_LARK_APP_ID: 'cli_stale',
        BOTMUX_CHAT_ID: 'oc_stale',
        BOTMUX_ROOT_MESSAGE_ID: 'om_stale',
      } as NodeJS.ProcessEnv, process.pid)).toEqual({
        actor: { larkAppId: 'cli_real', openId: 'ou_caller_b' },
        chatId: 'oc_real',
        rootMessageId: 'om_real',
        sessionId: 'sess-1',
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a stale marker even when inherited owner/session env looks valid', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'saved-workflow-turn-'));
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      const procStart = readProcessStartIdentity(process.pid);
      if (!procStart) throw new Error('test process start identity unavailable');
      writeFileSync(
        join(dataDir, '.botmux-cli-pids', String(process.pid)),
        JSON.stringify({ sessionId: 'sess-1', turnId: 'turn-old', procStart }),
      );
      writeFileSync(join(dataDir, 'sessions-cli_real.json'), JSON.stringify({
        'sess-1': {
          sessionId: 'sess-1', status: 'active', scope: 'thread',
          larkAppId: 'cli_real', chatId: 'oc_real', rootMessageId: 'om_real',
          ownerOpenId: 'ou_owner_a', lastCallerOpenId: 'ou_caller_b', quoteTargetId: 'turn-new',
        },
      }));

      expect(() => contextFromEnv({
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sess-1',
        BOTMUX_OWNER_OPEN_ID: 'ou_owner_a',
      } as NodeJS.ProcessEnv, process.pid)).toThrow(/turn-old.*turn-new/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('Saved Workflow CLI daemon-managed run root', () => {
  it('rejects a custom run root that the daemon cannot resolve', () => {
    expect(() => assertDaemonManagedRunBaseDir('/tmp/custom-runs', '/tmp/canonical-runs'))
      .toThrow(/不支持自定义 --base-dir/);
    expect(() => assertDaemonManagedRunBaseDir('/tmp/canonical-runs/.', '/tmp/canonical-runs'))
      .not.toThrow();
  });
});

describe('Saved Workflow CLI scope authorization', () => {
  const context = {
    actor: { openId: 'ou_actor', larkAppId: 'cli_current' },
    chatId: 'oc_current',
  };

  it('keeps agent-facing saves chat-scoped and delegates global authorization to IM', () => {
    expect(() => assertAgentFacingSaveScope(['last', '周报'])).not.toThrow();
    expect(() => assertAgentFacingSaveScope(['last', '周报', '--global']))
      .toThrow(/飞书中显式发送.*daemon 校验 canOperate/);
    expect(() => assertAgentFacingSaveScope(['last', '周报', '--ack-unsafe']))
      .toThrow(/agent 不能代替用户确认.*用户在飞书中显式发送/);
    expect(() => assertAgentFacingSaveScope(['last', '周报', '--distill']))
      .toThrow(/参数蒸馏必须由用户在飞书中显式发送.*提案卡片中确认/);
    expect(() => assertAgentFacingSaveScope(['last', '周报', '--distill=true']))
      .toThrow(/参数蒸馏必须由用户在飞书中显式发送/);
    expect(() => assertAgentFacingSaveScope(['last', '周报', '--distil']))
      .not.toThrow();
    expect(() => assertAgentFacingSaveScope(['last', '周报', '--workflow-id']))
      .toThrow(/--workflow-id 缺少值/);
    expect(() => assertAgentFacingSaveScope([
      'last', '周报', '--workflow-id=wf_test', '--allow-draft', '--json',
    ])).not.toThrow();
  });

  it('rejects appending a revision to an existing global definition', async () => {
    const resolveVisible = vi.fn(async () => ({ scope: { kind: 'global' as const } }));
    await expect(assertAgentFacingAppendScope(
      '/tmp/library', 'wf_deadbeef', context, resolveVisible as any,
    ))
      .rejects.toThrow(/不能修改当前 Bot 全局 Saved Workflow.*canOperate/);
    expect(resolveVisible).toHaveBeenCalledWith({
      dataDir: '/tmp/library',
      ref: 'wf_deadbeef',
      context,
      includeDrafts: true,
    });
  });

  it('allows appending a revision to a chat-scoped definition', async () => {
    const resolveVisible = async () => ({ scope: { kind: 'chat' as const, chatId: 'oc_current' } });
    await expect(assertAgentFacingAppendScope(
      '/tmp/library', 'wf_deadbeef', context, resolveVisible as any,
    ))
      .resolves.toBeUndefined();
  });

  it('does not unwrap cross-app/chat not-found results before the visibility boundary', async () => {
    const hidden = Object.assign(new Error('not found'), { code: 'not_found' });
    const resolveVisible = vi.fn(async () => { throw hidden; });
    await expect(assertAgentFacingAppendScope(
      '/tmp/library', 'wf_hidden', context, resolveVisible as any,
    )).rejects.toBe(hidden);
  });
});

describe('Saved Workflow CLI list privacy', () => {
  const listed = {
    entries: [{
      workflowId: 'wf_0123456789abcdef0123456789abcdef',
      displayName: 'Shared report',
      owner: { openId: 'ou_private_owner', larkAppId: 'cli_private_app' },
      scope: { kind: 'global' as const },
      status: 'active' as const,
      publishedRevision: `rev_${'a'.repeat(64)}`,
      aliases: ['private-alias'],
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:01:00.000Z',
    }],
    invalid: [],
  } as any;

  it('emits a safe current-bot catalog for non-owner JSON readers', () => {
    const output = formatSavedWorkflowCliList(listed, true);
    expect(output).toContain('当前 Bot 全局');
    expect(output).toContain('Shared report');
    expect(output).not.toContain('ou_private_owner');
    expect(output).not.toContain('cli_private_app');
    expect(output).not.toContain('owner');
    expect(output).not.toContain('chatId');
    expect(output).not.toContain('private-alias');
    expect(output).not.toContain('createdAt');
  });

  it('uses the same unambiguous scope label in human output', () => {
    expect(formatSavedWorkflowCliList(listed, false)).toContain('\t当前 Bot 全局\t');
  });
});

describe('Saved Workflow CLI show privacy', () => {
  const owner = { openId: 'ou_owner', larkAppId: 'cli_current' };
  const loaded = {
    metadata: {
      displayName: 'Shared report',
      workflowId: 'wf_0123456789abcdef0123456789abcdef',
      owner,
      scope: { kind: 'global' as const },
      status: 'active' as const,
    },
    revision: {
      revisionId: `rev_${'a'.repeat(64)}`,
      payload: {
        humanVersion: 2,
        inputs: { region: { type: 'string' } },
        sourceRunId: 'private-project-person-260714',
        dagTemplate: { nodes: [{ goal: 'private project detail' }] },
      },
    },
  } as any;

  it('returns only a sanitized summary by default', () => {
    const summary = formatSavedWorkflowCliShow(loaded, {
      actor: { openId: 'ou_reader', larkAppId: 'cli_current' },
      chatId: 'oc_other',
    }, false);
    expect(summary).toContain('scope: 当前 Bot 全局');
    expect(summary).toContain('params: region');
    expect(summary).not.toContain('sourceRunId');
    expect(summary).not.toContain('private-project-person');
    expect(summary).not.toContain('private project detail');
  });

  it('limits raw definition output to the immutable owner tuple', () => {
    expect(() => formatSavedWorkflowCliShow(loaded, {
      actor: { openId: 'ou_reader', larkAppId: 'cli_current' },
    }, true)).toThrow(/owner/);
    expect(formatSavedWorkflowCliShow(loaded, { actor: owner }, true))
      .toContain('private project detail');
  });
});
