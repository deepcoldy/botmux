import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleV3GateAction, isV3GateAction, type V3GateCardHandlerDeps } from '../src/im/lark/v3-gate-card-handler.js';
import { V3_GATE_APPROVE_ACTION, V3_GATE_REJECT_ACTION, v3GateCardNonce, type V3GateActionValue } from '../src/im/lark/v3-gate-card.js';

const VALUE: V3GateActionValue = {
  action: V3_GATE_APPROVE_ACTION, runId: 'r1', waitId: 'deploy-gate', nodeId: 'deploy',
  nonce: v3GateCardNonce('r1', 'deploy-gate'),
};

function deps(over: Partial<V3GateCardHandlerDeps> = {}): { deps: V3GateCardHandlerDeps; driveRun: ReturnType<typeof vi.fn> } {
  const driveRun = vi.fn();
  return {
    driveRun,
    deps: { baseDir: '/tmp/x', driveRun, ...over },
  };
}

describe('isV3GateAction', () => {
  it('只认 v3_gate_approve/reject', () => {
    expect(isV3GateAction(V3_GATE_APPROVE_ACTION)).toBe(true);
    expect(isV3GateAction(V3_GATE_REJECT_ACTION)).toBe(true);
    expect(isV3GateAction('wf_approve')).toBe(false);
    expect(isV3GateAction(undefined)).toBe(false);
  });
});

describe('handleV3GateAction', () => {
  it('Saved Workflow 无 grill 时从 run.json 读取 binding 做权限校验', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'v3-gate-envelope-'));
    try {
      const runDir = join(baseDir, 'r1');
      mkdirSync(runDir, { recursive: true });
      const digest = `sha256:${'a'.repeat(64)}`;
      writeFileSync(join(runDir, 'run.json'), JSON.stringify({
        schemaVersion: 1,
        engine: 'workflow-v3',
        runId: 'r1',
        createdAt: '2026-07-10T08:00:00.000Z',
        chatBinding: { larkAppId: 'cli_test', chatId: 'oc_saved' },
        source: {
          kind: 'saved_definition',
          workflowId: 'wf_0123456789abcdef0123456789abcdef',
          revisionId: `rev_${'b'.repeat(64)}`,
          humanVersion: 1,
        },
        artifacts: {
          dag: { path: 'dag.json', sha256: digest },
          spec: { path: 'spec.json', sha256: digest },
          botSnapshots: { path: 'bots.snapshot.json', sha256: digest },
          resolvedParams: { path: 'params.resolved.json', sha256: digest },
          definitionSnapshot: { path: 'definition.snapshot.json', sha256: digest },
        },
        authorization: {
          kind: 'published_revision',
          authorizedAt: '2026-07-10T08:01:00.000Z',
          workflowId: 'wf_0123456789abcdef0123456789abcdef',
          revisionId: `rev_${'b'.repeat(64)}`,
          definitionSnapshotSha256: digest,
          dagSha256: digest,
          specSha256: digest,
        },
      }));
      const canResolve = vi.fn(() => true);
      const resolveClick = vi.fn(() => ({ kind: 'resolved', resolution: 'approved' } as const));
      const { deps: d } = deps({ baseDir, canResolve, resolveClick: resolveClick as any });
      await handleV3GateAction(VALUE, 'ou_user', d);
      expect(canResolve).toHaveBeenCalledWith(
        { larkAppId: 'cli_test', chatId: 'oc_saved' },
        'ou_user',
      );
      expect(resolveClick).toHaveBeenCalled();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('resolved → 返回冻结卡（green header / 已通过）+ driveRun 被调一次', async () => {
    const resolveClick = vi.fn(() => ({ kind: 'resolved', resolution: 'approved' } as const));
    const { deps: d, driveRun } = deps({ resolveClick: resolveClick as any });
    const res = await handleV3GateAction(VALUE, 'ou_user', d) as any;
    expect(resolveClick).toHaveBeenCalledWith('/tmp/x', 'r1', {
      waitId: 'deploy-gate',
      selected: 'approve',
      by: 'ou_user',
    });
    expect(driveRun).toHaveBeenCalledWith('r1');
    expect(res.header.template).toBe('green');
    expect(res.header.title.content).toContain('已通过');
  });

  it('reject resolved → 红卡 已拒绝 + driveRun（rejected 节点 fail-fast 由 redrive 处理）', async () => {
    const { deps: d, driveRun } = deps({ resolveClick: () => ({ kind: 'resolved', resolution: 'rejected' }) });
    const res = await handleV3GateAction({ ...VALUE, action: V3_GATE_REJECT_ACTION }, 'ou_user', d) as any;
    expect(driveRun).toHaveBeenCalledWith('r1');
    expect(res.header.template).toBe('red');
  });

  it('already-settled approved → toast + 幂等重驱（防上次 driveRun 没落地）', async () => {
    const { deps: d, driveRun } = deps({ resolveClick: () => ({ kind: 'already-settled', status: 'approved' }) });
    const res = await handleV3GateAction(VALUE, 'ou_user', d) as any;
    expect(driveRun).toHaveBeenCalledWith('r1');
    expect(res.toast.content).toContain('通过');
  });

  it('already-settled rejected → toast，不 driveRun（拒绝是终态）', async () => {
    const { deps: d, driveRun } = deps({ resolveClick: () => ({ kind: 'already-settled', status: 'rejected' }) });
    const res = await handleV3GateAction(VALUE, 'ou_user', d) as any;
    expect(driveRun).not.toHaveBeenCalled();
    expect(res.toast.content).toContain('拒绝');
  });

  it('stale-run terminal → toast 已结束，不 driveRun', async () => {
    const { deps: d, driveRun } = deps({ resolveClick: () => ({ kind: 'stale-run', reason: 'terminal' }) });
    const res = await handleV3GateAction(VALUE, 'ou_user', d) as any;
    expect(driveRun).not.toHaveBeenCalled();
    expect(res.toast.content).toContain('已结束');
  });

  it('canResolve 拒绝 → 权限 toast，不 resolve 不 driveRun', async () => {
    const resolveClick = vi.fn();
    const { deps: d, driveRun } = deps({ canResolve: () => false, resolveClick: resolveClick as any });
    const res = await handleV3GateAction(VALUE, 'ou_stranger', d) as any;
    expect(resolveClick).not.toHaveBeenCalled();
    expect(driveRun).not.toHaveBeenCalled();
    expect(res.toast.content).toContain('权限');
  });

  it('core unauthorized → 审批人名单 toast，不 driveRun', async () => {
    const { deps: d, driveRun } = deps({ resolveClick: () => ({ kind: 'unauthorized' }) });
    const res = await handleV3GateAction(VALUE, 'ou_stranger', d) as any;
    expect(driveRun).not.toHaveBeenCalled();
    expect(res.toast.content).toContain('审批人');
  });

  it('resolveClick throw（append 失败）→ error toast，不假装成功（codex #5）', async () => {
    const { deps: d, driveRun } = deps({ resolveClick: () => { throw new Error('journal append failed'); } });
    const res = await handleV3GateAction(VALUE, 'ou_user', d) as any;
    expect(driveRun).not.toHaveBeenCalled();
    expect(res.toast.type).toBe('error');
  });

  it('nonce 不匹配（篡改/外来卡）→ stale toast，不 resolve（codex medium）', async () => {
    const resolveClick = vi.fn();
    const { deps: d, driveRun } = deps({ resolveClick: resolveClick as any });
    const res = await handleV3GateAction({ ...VALUE, nonce: 'bogus' }, 'ou_user', d) as any;
    expect(resolveClick).not.toHaveBeenCalled();
    expect(driveRun).not.toHaveBeenCalled();
    expect(res.toast.content).toContain('nonce');
  });
});
