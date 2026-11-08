import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The pure builder (`buildWrappedLaunch`) is covered behaviorally in
 * cli-selection.test.ts, but it deliberately keeps its degraded no-crash return
 * when `requireAidenCodexShim` is absent — it cannot know whether the session
 * carries identity. The gate therefore lives in the worker spawn closure, where
 * the trigger-user-auth / Lark-tool-binding condition is known.
 */
const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('worker → aiden codex identity-bearing launch fails closed', () => {
  // 源码结构护栏(K2)：shim 是 trigger-user auth / Lark tool binding 身份进入 Codex 工具 shell 的唯一通道，
  // 丢掉它会让工具 shell 静默以机器 owner 身份运行。门禁条件在 worker 巨型 spawn 闭包里，没有行为 seam；
  // 守的不变量：身份条件由 triggerUserAuth / boundLark 推出，shim 安装失败时按该条件 throw（不是降级），
  // 且同一条件作为 requireAidenCodexShim 传入 buildWrappedLaunch（#1913）。
  it('gates the shim-install failure and buildWrappedLaunch on the session identity condition', () => {
    const spawnBlock = region(workerSource, 'buildEffectiveChildEnv({', 'if (launch.bin) {');
    const cond = /const (\w+) = ([^;]+);/g;
    let identityVar: string | undefined;
    for (const m of spawnBlock.matchAll(cond)) {
      if (m[2].includes('triggerUserAuth') && m[2].includes('boundLark')) { identityVar = m[1]; break; }
    }
    expect(identityVar, 'identity condition derived from triggerUserAuth + boundLark').toBeDefined();

    const catchIdx = spawnBlock.indexOf('} catch (e) {');
    expect(catchIdx).toBeGreaterThan(-1);
    const afterCatch = spawnBlock.slice(catchIdx);
    const gateIdx = afterCatch.indexOf(`if (${identityVar}) {`);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(afterCatch.indexOf('throw new Error(', gateIdx)).toBeGreaterThan(gateIdx);

    expect(spawnBlock).toMatch(new RegExp(`requireAidenCodexShim:\\s*${identityVar}\\b`));
  });
});
