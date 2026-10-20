import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const pool = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');

describe('credentialsSourceDir daemon → worker cold-spawn wiring', () => {
  // 源码结构护栏(K2)：credentialsSourceDir 是「一台机器多账号」的凭据隔离，设计上 fail-closed、
  // 绝不回退共享登录（bfada7e10，docs/file-sandbox.md）。检查散在 worker.ts 冷启动巨型闭包与
  // worker-pool 的 initMsg 组装里，没有可调用的 seam（纯判定 planCredentialSource /
  // readCredentialSource 已由 test/cli-credential-source.test.ts 行为覆盖），只能钉住：daemon 把
  // 字段送进 init、计划先于任何 provisioning 且 refuse / 来源不可读即抛、共享登录 seed 被抑制、
  // 拷贝与「无残留认证覆盖」复查都在 per-bot 锁内且复查失败即抛。
  it('fails closed before provisioning the per-bot home and never falls back to the shared login', () => {
    const initStart = pool.indexOf('initMsg = {');
    const init = pool.slice(initStart, pool.indexOf('worker.send(initMsg)', initStart));
    expect(initStart).toBeGreaterThan(-1);
    expect(init).toContain('credentialsSourceDir');

    const plan = worker.indexOf('planCredentialSource({');
    const gate = worker.indexOf('if (willRedirectCliData) {', plan);
    expect(plan).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(plan);
    const planBlock = worker.slice(plan, gate);
    expect(planBlock).toMatch(/kind === 'refuse'\)\s*\{\s*throw\b/);
    expect(planBlock).toMatch(/readCredentialSource\([^)]*\);\s*\}\s*catch\b[^{]*\{\s*throw\b/);

    // provisionIsolatedBotHome must not seed the shared (or profile) login over a configured source.
    expect(worker).toMatch(/=\s*claudeCredFromSource\s*\?\s*null\s*:/);

    const start = worker.indexOf('const provisionBotHome = (): void => {');
    const locked = worker.indexOf('withFileLockSync(provisionLock, provisionBotHome)', start);
    expect(start).toBeGreaterThan(gate);
    expect(locked).toBeGreaterThan(start);
    const body = worker.slice(start, locked);
    const order = [
      body.indexOf('provisionIsolatedBotHome('),
      body.indexOf('Object.entries(credentialSourceFiles)'),
      body.search(/if \(overrides\.length\)\s*\{\s*throw\b/),
    ];
    expect(order.every(i => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // 源码结构护栏(K2)：持久 pane 保留它启动时的登录。来源戳不一致时必须杀 pane 冷启，且在
  // 「确认已杀 / 不再 reattach」之前拒启——否则配置了账号 B 的 bot 会继续跑在账号 A 的 pane 里
  // （bfada7e10）。判定在 worker.ts spawn 闭包里，无行为 seam。
  it('never reattaches a persistent pane launched with a different credential source', () => {
    const gate = worker.indexOf('readCredentialSourceStamp(');
    const stamp = worker.indexOf('writeCredentialSourceStamp(', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(gate);
    const block = worker.slice(gate, stamp);
    expect(block).toContain('credentialSourceDir');
    expect(block).toMatch(/postKillProbe !== 'missing'\)\s*\{\s*throw\b/);
    expect(block).toMatch(/if \(willReattachPersistent\)\s*\{\s*throw\b/);
    // The stamp is written only for a cold spawn.
    expect(worker.slice(stamp - 120, stamp)).toContain('if (!willReattachPersistent) {');
  });
});
