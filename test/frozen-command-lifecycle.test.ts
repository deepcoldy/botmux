import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lookupFrozenCommand } from '../src/services/frozen-command.js';
import {
  cancelFrozenCommandTransition,
  confirmFrozenCommandTransition,
  evaluateFrozenCommandLifecycle,
  listFrozenCommandLifecycleAudit,
  prepareFrozenCommandTransition,
  reconcileFrozenCommandLifecycleAtStartup,
} from '../src/services/frozen-command-lifecycle.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';

const roots: string[] = [];
const BOT = 'cli_lifecycle_test';
const ACTOR = { openId: 'ou_user', unionId: 'on_user' };
const ACTIVE = `
schemaVersion: 1
name: 生命周期测试
description: 生命周期测试命令
params:
  - name: value
    type: integer
    min: 1
    max: 90
    default: 7
sql: SELECT {{value}} AS probe_value
output:
  prefix: "result: "
  maxChars: 20000
onError: fail
`;

function setup(): { root: string; dataDir: string; file: string } {
  const root = join(tmpdir(), `botmux-frozen-lifecycle-${process.pid}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const dataDir = join(root, 'data');
  const file = join(root, '.botmux', 'commands', '生命周期测试.yaml');
  mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
  writeFileSync(file, ACTIVE);
  return { root, dataDir, file };
}

function prepare(input: ReturnType<typeof setup>, action: 'retire' | 'restore' | 'revoke') {
  return prepareFrozenCommandTransition({
    dataDir: input.dataDir,
    targetBotId: BOT,
    workingDir: input.root,
    command: '/生命周期测试',
    action,
    actor: ACTOR,
    reason: action === 'retire' ? '口径已迁移' : action === 'restore' ? '误操作恢复' : '合规清理',
    replacement: action === 'retire' ? '/新命令' : undefined,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Frozen Command lifecycle ledger', () => {
  it('creates the live command directory only after candidate confirmation', () => {
    const root = join(tmpdir(), `botmux-frozen-create-${process.pid}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const dataDir = join(root, 'data');
    const pending = prepareFrozenCommandTransition({
      dataDir,
      targetBotId: BOT,
      workingDir: root,
      command: '/生命周期测试',
      action: 'approve',
      actor: ACTOR,
      reason: '创建新命令',
      candidateYaml: ACTIVE,
    });
    const file = join(root, '.botmux', 'commands', '生命周期测试.yaml');
    expect(() => readFileSync(file, 'utf8')).toThrow();
    confirmFrozenCommandTransition({ dataDir, targetBotId: BOT, token: pending.token, actor: ACTOR });
    expect(readFileSync(file, 'utf8')).toBe(ACTIVE);
  });

  it('rejects a candidate when the command directory escapes through a symlink', () => {
    if (process.platform === 'win32') return;
    const root = join(tmpdir(), `botmux-frozen-contained-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const outside = join(tmpdir(), `botmux-frozen-outside-${process.pid}-${Math.random().toString(36).slice(2)}`);
    roots.push(root, outside);
    mkdirSync(join(root, '.botmux'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, '.botmux', 'commands'));
    expect(() => prepareFrozenCommandTransition({
      dataDir: join(root, 'data'),
      targetBotId: BOT,
      workingDir: root,
      command: '/生命周期测试',
      action: 'approve',
      actor: ACTOR,
      reason: '越界候选',
      candidateYaml: ACTIVE,
    })).toThrowError(/越出当前工作目录/);
  });

  it('stages an update without touching the approved file until the same human confirms', () => {
    const input = setup();
    const first = prepareFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
      action: 'approve',
      actor: ACTOR,
      reason: '批准初版',
    });
    const initial = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: first.token,
      actor: ACTOR,
    });
    const candidate = ACTIVE.replace('SELECT {{value}} AS probe_value', 'SELECT {{value}} + 1 AS probe_value');
    const pending = prepareFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
      action: 'approve',
      actor: ACTOR,
      reason: '更新口径',
      candidateYaml: candidate,
    });

    expect(pending.expectedRevisionId).toBe(initial.stateRevisionId);
    expect(pending.previousSpecHash).toBe(initial.specHash);
    expect(pending.specHash).not.toBe(initial.specHash);
    expect(readFileSync(input.file, 'utf8')).toBe(ACTIVE);

    expect(() => confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: { openId: 'ou_other', unionId: 'on_other' },
    })).toThrowError(/同一真人/);
    expect(readFileSync(input.file, 'utf8')).toBe(ACTIVE);

    const updated = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    });
    expect(updated.state).toBe('active');
    expect(readFileSync(input.file, 'utf8')).toBe(candidate);
  });

  it('cancels a staged update without changing the current command and consumes the token', () => {
    const input = setup();
    const pending = prepareFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
      action: 'approve',
      actor: ACTOR,
      reason: '候选更新',
      candidateYaml: ACTIVE.replace('SELECT {{value}}', 'SELECT {{value}} + 2'),
    });

    const cancelled = cancelFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    });
    expect(cancelled).toMatchObject({ command: '生命周期测试', action: 'approve' });
    expect(readFileSync(input.file, 'utf8')).toBe(ACTIVE);
    expect(() => confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    })).toThrowError(/不存在|不属于/);
  });

  it('rejects a repeated confirmation after the first click consumes the token', () => {
    const input = setup();
    const pending = prepare(input, 'retire');

    const retired = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    });
    expect(retired.state).toBe('retired');

    expect(() => confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    })).toThrowError(/不存在|不属于/);
  });

  it('requires the same real actor to confirm and leaves the active file untouched on denial', () => {
    const input = setup();
    const pending = prepare(input, 'retire');
    expect(() => confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: { openId: 'ou_other', unionId: 'on_other' },
    })).toThrowError(/同一真人/);
    expect(readFileSync(input.file, 'utf8')).toBe(ACTIVE);
  });

  it('binds confirmation to the exact definition hash shown at preparation time', () => {
    const input = setup();
    const pending = prepare(input, 'retire');
    writeFileSync(input.file, ACTIVE.replace('SELECT {{value}}', 'SELECT {{value}} + 1'));

    expect(() => confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    })).toThrowError(/确认前已变化/);
    expect(readFileSync(input.file, 'utf8')).toContain('+ 1');
  });

  it('rejects retiring a tampered active definition and cannot reach restore without retirement', () => {
    const input = setup();
    const approval = prepareFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
      action: 'approve',
      actor: ACTOR,
      reason: '批准 A',
    });
    const approved = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: approval.token,
      actor: ACTOR,
    });
    expect(approved.state).toBe('active');
    expect(approved.sourceYaml).toBe(ACTIVE);

    const tampered = ACTIVE.replace('SELECT {{value}}', 'SELECT {{value}} + 1');
    writeFileSync(input.file, tampered);
    expect(evaluateFrozenCommandLifecycle({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
    }).kind).toBe('fail_closed');

    expect(() => prepare(input, 'retire')).toThrowError(/已批准版本/);
    expect(() => prepare(input, 'restore')).toThrowError(/不是 retired/);
    expect(readFileSync(input.file, 'utf8')).toBe(tampered);

    const db = openDatabaseSyncOrThrow(join(input.dataDir, 'frozen-commands', 'approvals.sqlite'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS count FROM pending_transitions').get() as { count: number }).count).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS count FROM command_audit').get() as { count: number }).count).toBe(1);
      const row = db.prepare('SELECT state, spec_hash, source_yaml FROM command_lifecycle').get() as {
        state: string; spec_hash: string; source_yaml: string;
      };
      expect(row.state).toBe('active');
      expect(row.spec_hash).toBe(approved.specHash);
      expect(row.source_yaml).toBe(ACTIVE);
    } finally {
      db.close();
    }
  });

  it('fails closed for explicit active definitions until their exact spec hash is approved', () => {
    const input = setup();
    writeFileSync(input.file, ACTIVE.replace('schemaVersion: 1', 'schemaVersion: 1\nstatus: active'));
    expect(evaluateFrozenCommandLifecycle({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
    })).toMatchObject({ kind: 'fail_closed', reason: expect.stringContaining('尚未完成宿主批准') });

    const pending = prepareFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
      action: 'approve',
      actor: ACTOR,
      reason: '批准新定义',
    });
    const approved = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    });
    expect(approved.state).toBe('active');
    expect(evaluateFrozenCommandLifecycle({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
    }).kind).toBe('active');

    writeFileSync(input.file, readFileSync(input.file, 'utf8').replace('SELECT {{value}}', 'SELECT {{value}} + 1'));
    expect(evaluateFrozenCommandLifecycle({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
    })).toMatchObject({ kind: 'fail_closed', reason: expect.stringContaining('不一致') });
  });

  it('commits retirement and audit before replacing the definition with a durable tombstone', () => {
    const input = setup();
    const pending = prepare(input, 'retire');
    const record = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    });

    expect(record.state).toBe('retired');
    expect(record.specHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.tombstoneHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.tombstonePayload).toMatchObject({
      status: 'retired',
      by: 'on_user',
      reason: '口径已迁移',
      replacement: '/新命令',
      revisionId: record.stateRevisionId,
    });
    const tombstone = readFileSync(input.file, 'utf8');
    expect(tombstone).toContain('status: retired');
    expect(tombstone).not.toContain('SELECT');
    expect(evaluateFrozenCommandLifecycle({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
    }).kind).toBe('retired');
    expect(listFrozenCommandLifecycleAudit({
      dataDir: input.dataDir,
      targetBotId: BOT,
      command: '/生命周期测试',
    })).toHaveLength(1);
  });

  it('reconciles the safe crash window from committed retired state to the tombstone', () => {
    const input = setup();
    const pending = prepare(input, 'retire');
    confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    });
    // Simulate a crash after the DB commit but before the tombstone rename.
    writeFileSync(input.file, ACTIVE);

    const reconciled = reconcileFrozenCommandLifecycleAtStartup({ dataDir: input.dataDir, targetBotId: BOT });
    expect(reconciled).toMatchObject({ inspected: 1, repaired: 1, errors: [] });
    expect(readFileSync(input.file, 'utf8')).toContain('status: retired');
  });

  it('fails closed instead of overwriting an unrelated file during reconciliation', () => {
    const input = setup();
    const pending = prepare(input, 'retire');
    confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    });
    writeFileSync(input.file, ACTIVE.replace('SELECT {{value}}', 'SELECT {{value}} + 100'));

    const gate = evaluateFrozenCommandLifecycle({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
    });

    expect(gate.kind).toBe('fail_closed');
    expect(readFileSync(input.file, 'utf8')).toContain('+ 100');
  });

  it('detects tombstone payload tampering instead of trusting copied hash fields', () => {
    const input = setup();
    const pending = prepare(input, 'retire');
    confirmFrozenCommandTransition({ dataDir: input.dataDir, targetBotId: BOT, token: pending.token, actor: ACTOR });
    writeFileSync(input.file, readFileSync(input.file, 'utf8').replace('口径已迁移', '伪造原因'));

    const gate = evaluateFrozenCommandLifecycle({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
    });

    expect(gate.kind).toBe('fail_closed');
    expect(readFileSync(input.file, 'utf8')).toContain('伪造原因');
  });

  it('restores only through a new confirmation and verifies the approved spec hash', () => {
    const input = setup();
    let pending = prepare(input, 'retire');
    confirmFrozenCommandTransition({ dataDir: input.dataDir, targetBotId: BOT, token: pending.token, actor: ACTOR });
    pending = prepare(input, 'restore');
    const restored = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    });

    expect(restored.state).toBe('active');
    expect(readFileSync(input.file, 'utf8')).toBe(ACTIVE);
    const lookup = lookupFrozenCommand({ workingDir: input.root, command: '/生命周期测试' });
    expect(lookup.kind).toBe('found');
    expect(evaluateFrozenCommandLifecycle({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
      ...(lookup.kind === 'found' ? { snapshot: lookup.snapshot } : {}),
    }).kind).toBe('active');
    expect(listFrozenCommandLifecycleAudit({ dataDir: input.dataDir, targetBotId: BOT })).toHaveLength(2);
  });

  it('revokes DB-first, removes the tombstone, and remains fail-closed after deletion', () => {
    const input = setup();
    let pending = prepare(input, 'retire');
    confirmFrozenCommandTransition({ dataDir: input.dataDir, targetBotId: BOT, token: pending.token, actor: ACTOR });
    pending = prepare(input, 'revoke');
    const revoked = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    });

    expect(revoked.state).toBe('revoked');
    expect(() => readFileSync(input.file, 'utf8')).toThrow();
    expect(evaluateFrozenCommandLifecycle({
      dataDir: input.dataDir,
      targetBotId: BOT,
      workingDir: input.root,
      command: '/生命周期测试',
    }).kind).toBe('revoked');
    expect(listFrozenCommandLifecycleAudit({ dataDir: input.dataDir, targetBotId: BOT })).toHaveLength(2);

    writeFileSync(input.file, 'unrelated replacement');
    const reconcile = reconcileFrozenCommandLifecycleAtStartup({ dataDir: input.dataDir, targetBotId: BOT });
    expect(reconcile.errors).toHaveLength(1);
    expect(readFileSync(input.file, 'utf8')).toBe('unrelated replacement');
  });

  it('rejects a symlinked authority database', () => {
    const input = setup();
    const dbDir = join(input.dataDir, 'frozen-commands');
    mkdirSync(dbDir, { recursive: true });
    const outside = join(input.root, 'outside.sqlite');
    writeFileSync(outside, 'not a database');
    symlinkSync(outside, join(dbDir, 'approvals.sqlite'));

    expect(() => prepare(input, 'retire')).toThrowError(/符号链接/);
    expect(readFileSync(input.file, 'utf8')).toBe(ACTIVE);
  });
});
