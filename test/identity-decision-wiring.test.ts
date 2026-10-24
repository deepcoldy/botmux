/**
 * 源码结构护栏(K3)：F3 执行身份单一事实源的接线，纯行为测试够不到的部分。
 *
 * 行为测试已覆盖（见 identity-spawn-matrix / identity-decision-report /
 * worker-turn-idle）：五格矩阵的真 bwrap 探针、daemon 只读上报值、PTY
 * spawn 真发 session_identity_decision。剩下三处只能在接线层钉死：
 *
 *  1. worker 有且仅有两个决策上站点（PTY spawnCli 与 Codex RPC engage），
 *     各自都把决策经私有 IPC 上报——RPC 分支没有便宜的真进程夹具；
 *  2. daemon 的 identityStorageModelForDaemonSession 内不再出现第二条沙盒
 *     推导（ds.session.sandbox / BOTMUX_SANDBOX），只消费上报；
 *  3. 三处沙盒构造器的 net 入参统一来自 resolveSpawnNetworkShape，模型决策
 *     与 bwrap argv 用同一个事实，不存在各算各的。
 *
 * 这些是 fail-closed 安全接线：少一个上报站点或多出一条推导路径，行为是
 * 「工具恒 77 / 明文落盘」，回归代价高且不在常规执行路径上显形。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');

// 源码结构护栏(K3)：F3 的三处 fail-closed 接线（两个 spawn 站点都上报、daemon
// 无第二条沙盒推导、net 事实只有一个来源）行为测试只能间接覆盖，少一根线的
// 表现是工具恒 77/明文落盘，不在常规路径显形，故在源码文本上钉死。
describe('F3 identity decision wiring (source structure guard)', () => {
  it('reports the decision from exactly the PTY and RPC decision sites', () => {
    const occurrences = workerSource.match(/type: 'session_identity_decision'/g) ?? [];
    expect(occurrences).toHaveLength(2);
    // One lives in the PTY child path, one in the RPC engine path.
    expect(workerSource).toContain('model: engineIdentityModel');
    expect(workerSource).toContain('model: childIdentityModel');
  });

  it('the daemon accessor holds no second sandbox derivation', () => {
    const accessor = workerPoolSource
      .slice(workerPoolSource.indexOf('export function identityStorageModelForDaemonSession'))
      .split(/\n}\n/)[0];
    expect(accessor).not.toContain('ds.session.sandbox');
    expect(accessor).not.toContain('BOTMUX_SANDBOX');
    expect(accessor).not.toContain('resolveIdentityStorageModel');
    expect(accessor).toContain('reportedIdentityModel');
  });

  it('every sandbox constructor net flag comes from the resolved spawn shape', () => {
    expect(workerSource).not.toContain('net: cfg.sandboxNetworkPolicy');
    expect(workerSource).not.toContain('net: cfg.sandboxNetwork !== false');
    expect(workerSource).toContain('net: spawnNetworkShape.netEnabled');
    // The shape itself is built from the resolved mode (env override already
    // applied) and is the input to the worker-side model decision.
    expect(workerSource).toContain('const spawnNetworkShape = resolveSpawnNetworkShape({');
    expect(workerSource).toContain('sandboxEngaged: spawnNetworkShape.sandboxEngaged');
    expect(workerSource).toContain('loopbackShared: spawnNetworkShape.loopbackShared');
  });
});
