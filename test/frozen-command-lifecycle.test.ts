import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupFrozenCommand } from '../src/services/frozen-command.js';
import {
  cancelFrozenCommandTransition,
  confirmFrozenCommandTransition,
  evaluateFrozenCommandLifecycle,
  listFrozenCommandLifecycleAudit,
  listFrozenCommandLifecycleRecords,
  prepareFrozenCommandTransition,
  reconcileFrozenCommandLifecycleAtStartup,
} from '../src/services/frozen-command-lifecycle.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';

const roots: string[] = [];
const BOT = 'cli_lifecycle_test';
const ACTOR = { openId: 'ou_user', unionId: 'on_user' };
const ACTIVE = `
schemaVersion: 2
name: 生命周期测试
description: 生命周期测试命令
executor: builtin.data-mcp.readonly
params:
  - name: value
    type: integer
    min: 1
    max: 90
    default: 7
input:
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
    actorIsAdmin: true,
    reason: action === 'retire' ? '口径已迁移' : action === 'restore' ? '误操作恢复' : '合规清理',
    replacement: action === 'retire' ? '/新命令' : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Frozen Command lifecycle ledger', () => {
  it('rejects an incompatible process executor contract before staging approval or restore', () => {
    const root = join(tmpdir(), `botmux-frozen-contract-${process.pid}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const dataDir = join(root, 'data');
    const script = join(root, 'executor.mjs');
    const registry = join(root, 'executors.yaml');
    writeFileSync(script, 'console.log(JSON.stringify({value:"ok"}));\n');
    const canonicalScript = realpathSync(script);
    const registryYaml = (maxLength: number) => `
schemaVersion: 1
executors:
  - id: test.contract
    kind: script
    executable: { realpath: ${JSON.stringify(process.execPath)} }
    fixedArgs: [${JSON.stringify(canonicalScript)}]
    scriptArtifacts: [${JSON.stringify(canonicalScript)}]
    arguments:
      value:
        type: string
        required: true
        maxLength: ${maxLength}
        pattern: "^[a-z]+$"
        accepts: [param]
    policy: { risk: read, schedulable: true, allowHandoff: false, timeoutMs: 5000, maxOutputBytes: 65536 }
    output: { format: json, exposeFields: [value] }
`;
    writeFileSync(registry, registryYaml(100));
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', registry);
    const candidate = `
schemaVersion: 2
name: contract
description: contract test
executor: test.contract
params:
  - { name: word, type: string, maxLength: 100, pattern: "^[a-z]+$" }
input: { value: "{{word}}" }
output: { text: "{{result.value}}" }
onError: fail
`;
    writeFileSync(registry, registryYaml(32));
    expect(() => prepareFrozenCommandTransition({
      dataDir, targetBotId: BOT, workingDir: root, command: '/contract', action: 'approve',
      actor: ACTOR, reason: 'reject incompatible approval', candidateYaml: candidate,
    })).toThrowError(/长度上限 100.*执行器 32/);

    writeFileSync(registry, registryYaml(100));
    const approved = prepareFrozenCommandTransition({
      dataDir, targetBotId: BOT, workingDir: root, command: '/contract', action: 'approve',
      actor: ACTOR, reason: 'approve compatible definition', candidateYaml: candidate,
    });
    confirmFrozenCommandTransition({ dataDir, targetBotId: BOT, token: approved.token, actor: ACTOR });
    const retired = prepareFrozenCommandTransition({
      dataDir, targetBotId: BOT, workingDir: root, command: '/contract', action: 'retire',
      actor: ACTOR, reason: 'retire before restore check',
    });
    confirmFrozenCommandTransition({ dataDir, targetBotId: BOT, token: retired.token, actor: ACTOR });
    writeFileSync(registry, registryYaml(32));
    expect(() => prepareFrozenCommandTransition({
      dataDir, targetBotId: BOT, workingDir: root, command: '/contract', action: 'restore',
      actor: ACTOR, reason: 'reject incompatible restore',
    })).toThrowError(/长度上限 100.*执行器 32/);
  });

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
    const created = confirmFrozenCommandTransition({
      dataDir, targetBotId: BOT, token: pending.token, actor: ACTOR,
    });
    expect(created.ownerUnionId).toBe(ACTOR.unionId);
    expect(readFileSync(file, 'utf8')).toBe(ACTIVE);
  });

  it('rejects creation when a same-name definition appears on disk before confirmation', () => {
    const root = join(tmpdir(), `botmux-frozen-create-race-${process.pid}-${Math.random().toString(36).slice(2)}`);
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
    const unexpected = ACTIVE.replace('SELECT {{value}} AS probe_value', 'SELECT 999 AS probe_value');
    mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
    writeFileSync(file, unexpected);

    expect(() => confirmFrozenCommandTransition({
      dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
    })).toThrowError(/同名命令在确认前已出现/);
    expect(readFileSync(file, 'utf8')).toBe(unexpected);
  });

  it('backfills an existing ledger owner from the earliest approval audit', () => {
    const root = join(tmpdir(), `botmux-frozen-owner-migration-${process.pid}-${Math.random().toString(36).slice(2)}`);
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
      reason: '创建待迁移命令',
      candidateYaml: ACTIVE,
    });
    confirmFrozenCommandTransition({ dataDir, targetBotId: BOT, token: pending.token, actor: ACTOR });

    const db = openDatabaseSyncOrThrow(join(dataDir, 'frozen-commands', 'approvals.sqlite'));
    try {
      db.prepare('UPDATE command_lifecycle SET owner_union_id = NULL').run();
      db.prepare('UPDATE command_audit SET owner_union_id = NULL').run();
    } finally {
      db.close();
    }

    const [migrated] = listFrozenCommandLifecycleRecords({ dataDir, targetBotId: BOT, workingDir: root });
    expect(migrated?.ownerUnionId).toBe(ACTOR.unionId);
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
      actorIsAdmin: true,
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
      actorIsAdmin: true,
      reason: '批准初版',
    });
    const initial = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: first.token,
      actor: ACTOR,
      actorIsAdmin: true,
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
    expect(updated.ownerUnionId).toBe(ACTOR.unionId);
    expect(updated.state).toBe('active');
    expect(readFileSync(input.file, 'utf8')).toBe(candidate);
  });

  it('blocks a non-owner but lets an admin override without transferring ownership', () => {
    const root = join(tmpdir(), `botmux-frozen-owner-${process.pid}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const dataDir = join(root, 'data');
    const create = prepareFrozenCommandTransition({
      dataDir,
      targetBotId: BOT,
      workingDir: root,
      command: '/生命周期测试',
      action: 'approve',
      actor: ACTOR,
      reason: 'owner 创建',
      candidateYaml: ACTIVE,
    });
    confirmFrozenCommandTransition({ dataDir, targetBotId: BOT, token: create.token, actor: ACTOR });
    const other = { openId: 'ou_other', unionId: 'on_other' };
    const candidate = ACTIVE.replace('SELECT {{value}}', 'SELECT {{value}} + 9');

    expect(() => prepareFrozenCommandTransition({
      dataDir,
      targetBotId: BOT,
      workingDir: root,
      command: '/生命周期测试',
      action: 'approve',
      actor: other,
      reason: '越权覆盖',
      candidateYaml: candidate,
    })).toThrowError(/owner/);

    const override = prepareFrozenCommandTransition({
      dataDir,
      targetBotId: BOT,
      workingDir: root,
      command: '/生命周期测试',
      action: 'approve',
      actor: other,
      actorIsAdmin: true,
      reason: '管理员纠正',
      candidateYaml: candidate,
    });
    const updated = confirmFrozenCommandTransition({
      dataDir,
      targetBotId: BOT,
      token: override.token,
      actor: other,
      actorIsAdmin: true,
    });
    expect(updated.ownerUnionId).toBe(ACTOR.unionId);
  });

  it('reserves irreversible revoke for an admin even when the actor is the owner', () => {
    const root = join(tmpdir(), `botmux-frozen-owner-revoke-${process.pid}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const dataDir = join(root, 'data');
    const create = prepareFrozenCommandTransition({
      dataDir,
      targetBotId: BOT,
      workingDir: root,
      command: '/生命周期测试',
      action: 'approve',
      actor: ACTOR,
      reason: 'owner 创建',
      candidateYaml: ACTIVE,
    });
    confirmFrozenCommandTransition({ dataDir, targetBotId: BOT, token: create.token, actor: ACTOR });
    const retire = prepareFrozenCommandTransition({
      dataDir,
      targetBotId: BOT,
      workingDir: root,
      command: '/生命周期测试',
      action: 'retire',
      actor: ACTOR,
      reason: 'owner 废弃',
    });
    confirmFrozenCommandTransition({ dataDir, targetBotId: BOT, token: retire.token, actor: ACTOR });

    expect(() => prepareFrozenCommandTransition({
      dataDir,
      targetBotId: BOT,
      workingDir: root,
      command: '/生命周期测试',
      action: 'revoke',
      actor: ACTOR,
      reason: 'owner 尝试彻底撤销',
    })).toThrowError(/管理员/);
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
      actorIsAdmin: true,
      reason: '候选更新',
      candidateYaml: ACTIVE.replace('SELECT {{value}}', 'SELECT {{value}} + 2'),
    });

    const cancelled = cancelFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
      actorIsAdmin: true,
    });
    expect(cancelled).toMatchObject({ command: '生命周期测试', action: 'approve' });
    expect(readFileSync(input.file, 'utf8')).toBe(ACTIVE);
    expect(() => confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
      actorIsAdmin: true,
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
      actorIsAdmin: true,
    });
    expect(retired.state).toBe('retired');

    expect(() => confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
      actorIsAdmin: true,
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
      actorIsAdmin: true,
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
      actorIsAdmin: true,
      reason: '批准 A',
    });
    const approved = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: approval.token,
      actor: ACTOR,
      actorIsAdmin: true,
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
    writeFileSync(input.file, ACTIVE.replace('schemaVersion: 2', 'schemaVersion: 2\nstatus: active'));
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
      actorIsAdmin: true,
      reason: '批准新定义',
    });
    const approved = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
      actorIsAdmin: true,
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
      actorIsAdmin: true,
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
      actorIsAdmin: true,
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
      actorIsAdmin: true,
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
    confirmFrozenCommandTransition({ dataDir: input.dataDir, targetBotId: BOT, token: pending.token, actor: ACTOR, actorIsAdmin: true });
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
    confirmFrozenCommandTransition({ dataDir: input.dataDir, targetBotId: BOT, token: pending.token, actor: ACTOR, actorIsAdmin: true });
    pending = prepare(input, 'restore');
    const restored = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
      actorIsAdmin: true,
    });

    expect(restored.state).toBe('active');
    expect(restored.executorRevision).toBe(pending.executorRevision);
    expect(restored.executorRevision).toMatch(/^[a-f0-9]{64}$/);
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
    confirmFrozenCommandTransition({ dataDir: input.dataDir, targetBotId: BOT, token: pending.token, actor: ACTOR, actorIsAdmin: true });
    pending = prepare(input, 'revoke');
    const revoked = confirmFrozenCommandTransition({
      dataDir: input.dataDir,
      targetBotId: BOT,
      token: pending.token,
      actor: ACTOR,
      actorIsAdmin: true,
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
