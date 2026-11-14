import { describe, expect, it } from 'vitest';

import { validateScheduleChildOneShot } from '../src/core/schedule-child-one-shot.js';
import type { ScheduleAuthorityRecord } from '../src/services/schedule-authority-store.js';

const NOW = Date.parse('2026-11-14T00:00:00.000Z');
const RUN_AT = '2026-11-14T10:00:00.000Z';

function parent(overrides: Partial<ScheduleAuthorityRecord> = {}): ScheduleAuthorityRecord {
  return {
    kind: 'direct',
    state: 'active',
    task: {
      id: 'parent01', name: 'parent', schedule: '0 0 * * *',
      parsed: { kind: 'cron', expr: '0 0 * * *', display: 'daily' },
      prompt: 'parent', workingDir: '/repo', chatId: 'oc_chat',
      larkAppId: 'cli_app', ownerOpenId: 'ou_owner', ownerUnionId: 'on_owner',
      enabled: true, createdAt: '2026-11-01T00:00:00.000Z',
    },
    controlOpenId: 'ou_owner',
    controlUnionId: 'on_owner',
    runScopes: [],
    selfManage: false,
    ...overrides,
  };
}

function decision(options: {
  parent?: ScheduleAuthorityRecord;
  task?: Record<string, unknown>;
  parsed?: { kind: 'once' | 'interval' | 'cron'; runAt?: string; display: string };
  policy?: Record<string, unknown>;
  nowMs?: number;
} = {}) {
  return validateScheduleChildOneShot({
    policy: {
      childOneShotEnabled: true,
      childOneShotMaxDelayMinutes: 24 * 60,
      childOneShotMaxTasksPerTurn: 1,
      ...options.policy,
    },
    parent: options.parent ?? parent(),
    task: {
      chatId: 'oc_chat', rootMessageId: 'om_root', workingDir: '/repo',
      larkAppId: 'cli_app', executionPosition: 'topic', deliver: 'origin',
      ...options.task,
    },
    parsed: options.parsed ?? { kind: 'once', runAt: RUN_AT, display: 'once' },
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    workingDir: '/repo',
    nowMs: options.nowMs ?? NOW,
  });
}

describe('scheduled one-shot child scope', () => {
  it('accepts one bounded child in the exact current topic', () => {
    expect(decision()).toEqual({ ok: true, value: {
      runAtMs: Date.parse(RUN_AT), maxTasksPerTurn: 1,
    } });
  });

  it('is disabled by default and while delegated execution is emergency-stopped', () => {
    expect(decision({ policy: { childOneShotEnabled: false } })).toEqual({
      ok: false, error: 'schedule_child_one_shot_disabled',
    });
    expect(decision({ policy: { runEnabled: false } })).toEqual({
      ok: false, error: 'schedule_child_one_shot_disabled',
    });
  });

  it('requires a direct or migrated parent with an exact controller', () => {
    expect(validateScheduleChildOneShot({
      policy: { childOneShotEnabled: true, childOneShotMaxDelayMinutes: 60,
        childOneShotMaxTasksPerTurn: 1 },
      parent: undefined,
      task: { chatId: 'oc_chat', rootMessageId: 'om_root', workingDir: '/repo',
        larkAppId: 'cli_app', executionPosition: 'topic' },
      parsed: { kind: 'once', runAt: RUN_AT, display: 'once' },
      larkAppId: 'cli_app', chatId: 'oc_chat', rootMessageId: 'om_root',
      workingDir: '/repo', nowMs: NOW,
    })).toEqual({ ok: false, error: 'schedule_child_one_shot_parent_ineligible' });
    expect(decision({ parent: parent({ kind: 'delegated' }) })).toEqual({
      ok: false, error: 'schedule_child_one_shot_descendant_denied',
    });
    expect(decision({ parent: parent({ controlOpenId: 'ou_other' }) })).toEqual({
      ok: false, error: 'schedule_child_one_shot_parent_ineligible',
    });
  });

  it.each([
    [{ larkAppId: 'cli_other' }, 'other bot'],
    [{ chatId: 'oc_other' }, 'other chat'],
    [{ rootMessageId: 'om_other' }, 'other topic'],
    [{ workingDir: '/repo/subdir' }, 'different workdir'],
    [{ executionPosition: 'top-level' }, 'top level'],
    [{ followActive: true }, 'follow active'],
    [{ topicTitle: 'new' }, 'topic title'],
    [{ calendar: 'cn' }, 'calendar'],
    [{ untilDone: {} }, 'until done'],
    [{ notify: ['failing'] }, 'notifications'],
    [{ deliver: 'local' }, 'local delivery'],
  ])('rejects scope expansion: %s (%s)', (task, _label) => {
    expect(decision({ task })).toEqual({
      ok: false, error: 'schedule_child_one_shot_scope_invalid',
    });
  });

  it('accepts only a future once schedule inside the configured horizon', () => {
    expect(decision({ parsed: { kind: 'cron', display: 'daily' } })).toEqual({
      ok: false, error: 'schedule_child_one_shot_requires_once',
    });
    expect(decision({ parsed: { kind: 'once', runAt: new Date(NOW).toISOString(), display: 'now' } }))
      .toEqual({ ok: false, error: 'schedule_child_one_shot_in_past' });
    expect(decision({ parsed: { kind: 'once', runAt: new Date(NOW + 24 * 60 * 60_000 + 1).toISOString(),
      display: 'late' } })).toEqual({
      ok: false, error: 'schedule_child_one_shot_horizon_exceeded',
    });
  });
});
